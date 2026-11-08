"use server";

import { z } from "zod";
import { computeBoxMarket, type BoxCandidate, type BoxMarketSummary } from "@/lib/box-market";
import { computeMarket, MARKET_CSV_MAX_BYTES, MARKET_CSV_URL, MARKET_SOURCE_NAME, MARKET_SOURCE_URL, parseMarketCsv, type CardMarketResult, type MarketSummary } from "@/lib/market-price";
import { createClient } from "@/lib/supabase/server";

/**
 * コレクションの取得相場（Stage 6G）、BOXの取得相場・取得状況の記録（Stage 7F）。ログイン必須・自世帯のみ（RLS）。
 * 出典はポケカ価格比較の公開CSV。利用者の操作で1回だけ取得し（定期取得はしない）、全カードを1回のCSVで照合する。
 * 手動の参考相場（card_prices・box_prices）には触れない。取得・検証に失敗したときは既存の価格を変更しない（失敗は実行履歴に残す）。
 * BOXも同じCSVを同じ1回の操作で照合する（BOX専用の追加アクセス・定期取得はしない）。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const uuid = z.uuid();

async function ctx() {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return null;
    return supabase;
  } catch {
    return null;
  }
}
type Db = NonNullable<Awaited<ReturnType<typeof ctx>>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
const any = (db: Db) => db as any;

export interface MarketUpdateResult {
  summary: MarketSummary;
  /** 保存した価格の件数（販売・買取の合計） */
  priceRows: number;
  csvRows: number;
  csvUpdatedAt: string | null;
  fetchedAt: string;
  /** BOXの照合結果（カード単体の更新では null） */
  box: { summary: BoxMarketSummary; priceRows: number; review: { productId: string; name: string; reason: string; candidates: BoxCandidate[] }[] } | null;
  /** 照合未確定のカード（利用者が候補から選べる） */
  ambiguous: { cardId: string; name: string; reason: string; variants: { key: string; name: string; rarity: string }[] }[];
  source: "download" | "upload";
}

const MIN_INTERVAL_MS = 5 * 60 * 1000;

type ErrKind = "network" | "http" | "format" | "save" | "other";
async function fetchCsv(): Promise<{ ok: true; text: string } | { ok: false; error: string; kind: ErrKind }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    const res = await fetch(MARKET_CSV_URL, { signal: ctl.signal, headers: { "User-Agent": "toremane-personal-app/1.0 (single user; manual refresh)", Accept: "text/csv" }, cache: "no-store", redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, kind: "http", error: `相場データを取得できませんでした（HTTP ${res.status}）。既存の価格は変更していません` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MARKET_CSV_MAX_BYTES) return { ok: false, kind: "format", error: "相場データが想定より大きいため取り込みを中止しました" };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MARKET_CSV_MAX_BYTES) return { ok: false, kind: "format", error: "相場データが想定より大きいため取り込みを中止しました" };
    return { ok: true, text: new TextDecoder("utf-8").decode(buf) };
  } catch {
    return { ok: false, kind: "network", error: "相場データを取得できませんでした（通信エラー）。既存の価格は変更していません" };
  }
}

/**
 * 登録済みのコレクション全体の取得相場を更新する。CSVは1回だけ取得（またはアップロード）し、全カードを照合する。
 * csvText を渡すと、取得せずそのCSVを使う（利用者が手動で取り込む場合）。cardId を渡すと、そのカードだけ更新する（照合の確定後）。
 */
export async function updateMarketPricesAction(opts: { csvText?: string; cardId?: string; productId?: string } = {}): Promise<R<{ result: MarketUpdateResult }>> {
  if (opts.csvText !== undefined && opts.csvText.length > MARKET_CSV_MAX_BYTES) return fail("CSVが大きすぎます（5MBまで）");
  if (opts.cardId !== undefined && !uuid.safeParse(opts.cardId).success) return fail("リクエストが不正です");
  if (opts.productId !== undefined && !uuid.safeParse(opts.productId).success) return fail("リクエストが不正です");
  if (opts.cardId && opts.productId) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const onlyCard = !!opts.cardId;
  const onlyBox = !!opts.productId;
  const c = await any(db).from("card_masters").select("id,household_id,name,set_code,card_number,rarity").is("archived_at", null).limit(5000);
  if (c.error) return fail("カードを取得できませんでした");
  const allCards = c.data as { id: string; household_id: string; name: string; set_code: string; card_number: string; rarity: string }[];
  let cards = allCards;
  if (onlyCard) cards = allCards.filter((x) => x.id === opts.cardId);
  if (onlyBox) cards = [];
  // BOXの照合対象（商品マスター・別名・確定済みの対応・BOXコレクションにある商品）
  const pr = onlyCard ? null : await any(db).from("products").select("id,household_id,official_name,product_code").is("archived_at", null).limit(5000);
  let products = ((pr && !pr.error ? pr.data : []) ?? []) as { id: string; household_id: string; official_name: string; product_code: string | null }[];
  if (onlyBox) products = products.filter((x) => x.id === opts.productId);
  if (cards.length === 0 && products.length === 0) return fail(onlyBox ? "商品が見つかりません" : "更新するカードがありません");
  const household = (cards[0] ?? products[0]).household_id;

  // 取得元への負荷を抑える: 全体の更新は数分あける
  if (opts.csvText === undefined && !onlyCard && !onlyBox) {
    const last = await any(db).from("card_market_prices").select("fetched_at").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
    if (last.data?.fetched_at && Date.now() - new Date(last.data.fetched_at as string).getTime() < MIN_INTERVAL_MS) return fail("直前に更新したばかりです。数分あけてからお試しください");
  }
  const source: "download" | "upload" = opts.csvText === undefined ? "download" : "upload";
  const logRun = async (ok: boolean, kind: ErrKind | null, message: string, csvRows: number | null, summary: Record<string, unknown> = {}) => {
    // 実行履歴（成功・失敗）。履歴の保存に失敗しても本体の結果は変えない。古い履歴は30件を残して削除
    if (onlyCard || onlyBox) return;
    try {
      await any(db).from("market_update_runs").insert({ household_id: household, ok, error_kind: kind, error_message: message.slice(0, 300), source, csv_rows: csvRows, summary });
      const old = await any(db).from("market_update_runs").select("id").eq("household_id", household).order("created_at", { ascending: false }).range(30, 200);
      const ids = ((old.data ?? []) as { id: string }[]).map((x) => x.id);
      if (ids.length > 0) await any(db).from("market_update_runs").delete().in("id", ids);
    } catch {
      /* 履歴の保存失敗は無視 */
    }
  };
  let text = opts.csvText;
  if (text === undefined) {
    const f = await fetchCsv();
    if (!f.ok) {
      await logRun(false, f.kind, f.error, null);
      return fail(f.error);
    }
    text = f.text;
  }
  const parsed = parseMarketCsv(text);
  if (!parsed.ok) {
    await logRun(false, "format", parsed.error, null);
    return fail(parsed.error);
  }

  const csvAt = parsed.value.updatedAt ? new Date(parsed.value.updatedAt).toISOString() : null;
  const fetchedAt = new Date().toISOString();
  const common = { source: MARKET_SOURCE_NAME, source_url: MARKET_SOURCE_URL, csv_updated_at: csvAt, fetched_at: fetchedAt };

  // ---- カード
  const hh = new Map(cards.map((x) => [x.id, x.household_id]));
  const upserts: Record<string, unknown>[] = [];
  const statusRows: Record<string, unknown>[] = [];
  let cardSummary: MarketSummary = { total: 0, updated: 0, unlisted: 0, ambiguous: 0, insufficient: 0, noPrice: 0 };
  let cardResults: CardMarketResult[] = [];
  if (cards.length > 0) {
    const lk = await any(db).from("card_market_links").select("card_id,match_key");
    const links: Record<string, string> = {};
    for (const r of (lk.error ? [] : lk.data) as { card_id: string; match_key: string }[]) links[r.card_id] = r.match_key;
    const comp = computeMarket(
      cards.map((x) => ({ id: x.id, setCode: x.set_code, cardNumber: x.card_number, rarity: x.rarity, name: x.name })),
      parsed.value,
      links,
    );
    cardSummary = comp.summary;
    cardResults = comp.results;
    const addStat = (r: CardMarketResult, kind: "sale" | "buyback", grade: "A" | "B" | "C" = "A") => {
      const st = grade !== "A" ? r.saleGrades?.[grade] : kind === "sale" ? r.sale : r.buyback;
      if (!st) return;
      upserts.push({ household_id: hh.get(r.cardId), card_id: r.cardId, kind, condition_grade: grade, median_yen: st.medianYen, low_yen: st.lowYen, high_yen: st.highYen, sample_count: st.samples, outlier_count: st.outliers, shops: st.shops.slice(0, 12), ...common, match_key: r.matchKey ?? "" });
    };
    for (const r of cardResults) {
      statusRows.push({ household_id: hh.get(r.cardId), subject: "card", subject_id: r.cardId, status: r.status, sale_ok: !!r.sale, buyback_ok: !!r.buyback, reason: (r.reason ?? "").slice(0, 200), checked_at: fetchedAt });
      if (r.status !== "updated") continue;
      addStat(r, "sale");
      addStat(r, "buyback");
      addStat(r, "sale", "B");
      addStat(r, "sale", "C");
    }
  }

  // ---- BOX
  const boxUpserts: Record<string, unknown>[] = [];
  let box: MarketUpdateResult["box"] = null;
  if (products.length > 0) {
    const [al, lk, lots] = await Promise.all([
      any(db).from("product_aliases").select("product_id,alias").limit(20000),
      any(db).from("box_market_links").select("csv_key,product_id").limit(5000),
      any(db).from("box_lots").select("product_id").is("archived_at", null).limit(5000),
    ]);
    const aliases = new Map<string, string[]>();
    for (const a of ((al.error ? [] : al.data) ?? []) as { product_id: string; alias: string }[]) aliases.set(a.product_id, [...(aliases.get(a.product_id) ?? []), a.alias]);
    const links: Record<string, string> = {};
    for (const l of ((lk.error ? [] : lk.data) ?? []) as { csv_key: string; product_id: string }[]) links[l.csv_key] = l.product_id;
    const review = new Set((((lots.error ? [] : lots.data) ?? []) as { product_id: string }[]).map((x) => x.product_id));
    if (onlyBox && opts.productId) review.add(opts.productId);
    const comp = computeBoxMarket(
      products.map((x) => ({ id: x.id, name: x.official_name, code: x.product_code, aliases: aliases.get(x.id) ?? [] })),
      parsed.value.rows,
      links,
      review,
    );
    const hp = new Map(products.map((x) => [x.id, x.household_id]));
    for (const r of comp.results) {
      statusRows.push({ household_id: hp.get(r.productId), subject: "box", subject_id: r.productId, status: r.status, sale_ok: r.prices.some((x) => x.kind === "sale"), buyback_ok: r.prices.some((x) => x.kind === "buyback"), reason: r.reason.slice(0, 200), checked_at: fetchedAt });
      for (const e of r.prices) {
        boxUpserts.push({ household_id: hp.get(r.productId), product_id: r.productId, kind: e.kind, basis: e.basis, median_yen: e.stat.medianYen, low_yen: e.stat.lowYen, high_yen: e.stat.highYen, sample_count: e.stat.samples, outlier_count: e.stat.outliers, shops: e.stat.shops.slice(0, 12), ...common, match_method: r.method ?? "name" });
      }
    }
    const nameOf = new Map(products.map((x) => [x.id, x.official_name]));
    box = { summary: comp.summary, priceRows: boxUpserts.length, review: comp.results.filter((r) => r.status === "ambiguous").map((r) => ({ productId: r.productId, name: nameOf.get(r.productId) ?? "", reason: r.reason, candidates: r.candidates })) };
  }

  // ---- 保存（既存の価格は上書きしない: 取得できた種類だけ更新し、取得できなかった種類は前回の価格を残す）
  const saveErr = async (m: string) => {
    await logRun(false, "save", m, parsed.value.rows.length);
    return fail(`${m}。既存の価格は変更していません`);
  };
  if (upserts.length > 0) {
    const { error } = await any(db).from("card_market_prices").upsert(upserts, { onConflict: "card_id,kind,condition_grade" });
    if (error) return saveErr("相場の保存に失敗しました");
  }
  if (boxUpserts.length > 0) {
    const { error } = await any(db).from("box_market_prices").upsert(boxUpserts, { onConflict: "product_id,kind,basis" });
    if (error) return saveErr("BOX相場の保存に失敗しました");
  }
  if (statusRows.length > 0) {
    // 取得状況は補助情報。保存に失敗しても価格の更新は成功として扱う
    await any(db).from("market_status").upsert(statusRows, { onConflict: "subject,subject_id" });
  }
  const nameOf = new Map(cards.map((x) => [x.id, x.name]));
  const result: MarketUpdateResult = {
    summary: cardSummary,
    priceRows: upserts.length,
    csvRows: parsed.value.rows.length,
    csvUpdatedAt: csvAt,
    fetchedAt,
    box,
    ambiguous: cardResults.filter((r) => r.status === "ambiguous").map((r) => ({ cardId: r.cardId, name: nameOf.get(r.cardId) ?? "", reason: r.reason ?? "", variants: r.variants ?? [] })),
    source,
  };
  await logRun(true, null, "", parsed.value.rows.length, { cards: cardSummary, box: box?.summary ?? null });
  return { ok: true, result };
}

/** BOXの照合を利用者が確定する: CSVの商品名 ⇔ トレマネの商品（同じCSV名は1つの商品にだけ対応させる。複数の表記を同じ商品に対応させてよい） */
export async function setBoxMarketLinkAction(productId: string, csvKey: string, csvName: string): Promise<R> {
  if (!uuid.safeParse(productId).success || csvKey.length < 1 || csvKey.length > 200 || csvName.length > 200) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const hh = await any(db).from("products").select("household_id").eq("id", productId).maybeSingle();
  if (!hh.data) return fail("商品が見つかりません");
  const { error } = await any(db).from("box_market_links").upsert({ household_id: hh.data.household_id, product_id: productId, csv_key: csvKey, csv_name: csvName }, { onConflict: "household_id,csv_key" });
  return error ? fail("保存できませんでした") : { ok: true };
}

/** 同じ番号に複数の候補があるとき、利用者が選んだ対応を保存する（次回以降も再利用） */
export async function setMarketLinkAction(cardId: string, matchKey: string): Promise<R> {
  if (!uuid.safeParse(cardId).success || matchKey.length < 1 || matchKey.length > 200) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const hh = await any(db).from("card_masters").select("household_id").eq("id", cardId).maybeSingle();
  if (!hh.data) return fail("カードが見つかりません");
  const { error } = await any(db).from("card_market_links").upsert({ household_id: hh.data.household_id, card_id: cardId, match_key: matchKey }, { onConflict: "card_id" });
  return error ? fail("保存できませんでした") : { ok: true };
}
