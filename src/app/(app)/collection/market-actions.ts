"use server";

import { z } from "zod";
import { computeMarket, MARKET_CSV_MAX_BYTES, MARKET_CSV_URL, MARKET_SOURCE_NAME, MARKET_SOURCE_URL, parseMarketCsv, type CardMarketResult, type MarketSummary } from "@/lib/market-price";
import { createClient } from "@/lib/supabase/server";

/**
 * コレクションの取得相場（Stage 6G）。ログイン必須・自世帯のみ（RLS）。
 * 出典はポケカ価格比較の公開CSV。利用者の操作で1回だけ取得し（定期取得はしない）、全カードを1回のCSVで照合する。
 * 手動の参考相場（card_prices）には触れない。取得・検証に失敗したときは既存の価格を変更しない。
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
  /** 照合未確定のカード（利用者が候補から選べる） */
  ambiguous: { cardId: string; name: string; reason: string; variants: { key: string; name: string; rarity: string }[] }[];
  source: "download" | "upload";
}

const MIN_INTERVAL_MS = 5 * 60 * 1000;

async function fetchCsv(): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    const res = await fetch(MARKET_CSV_URL, { signal: ctl.signal, headers: { "User-Agent": "toremane-personal-app/1.0 (single user; manual refresh)", Accept: "text/csv" }, cache: "no-store", redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `相場データを取得できませんでした（HTTP ${res.status}）。既存の価格は変更していません` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MARKET_CSV_MAX_BYTES) return { ok: false, error: "相場データが想定より大きいため取り込みを中止しました" };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MARKET_CSV_MAX_BYTES) return { ok: false, error: "相場データが想定より大きいため取り込みを中止しました" };
    return { ok: true, text: new TextDecoder("utf-8").decode(buf) };
  } catch {
    return { ok: false, error: "相場データを取得できませんでした（通信エラー）。既存の価格は変更していません" };
  }
}

/**
 * 登録済みのコレクション全体の取得相場を更新する。CSVは1回だけ取得（またはアップロード）し、全カードを照合する。
 * csvText を渡すと、取得せずそのCSVを使う（利用者が手動で取り込む場合）。cardId を渡すと、そのカードだけ更新する（照合の確定後）。
 */
export async function updateMarketPricesAction(opts: { csvText?: string; cardId?: string } = {}): Promise<R<{ result: MarketUpdateResult }>> {
  if (opts.csvText !== undefined && opts.csvText.length > MARKET_CSV_MAX_BYTES) return fail("CSVが大きすぎます（5MBまで）");
  if (opts.cardId !== undefined && !uuid.safeParse(opts.cardId).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const c = await any(db).from("card_masters").select("id,household_id,name,set_code,card_number,rarity").is("archived_at", null).limit(5000);
  if (c.error) return fail("カードを取得できませんでした");
  let cards = c.data as { id: string; household_id: string; name: string; set_code: string; card_number: string; rarity: string }[];
  if (opts.cardId) cards = cards.filter((x) => x.id === opts.cardId);
  if (cards.length === 0) return fail("更新するカードがありません");

  // 取得元への負荷を抑える: 全体の更新は数分あける
  if (opts.csvText === undefined && !opts.cardId) {
    const last = await any(db).from("card_market_prices").select("fetched_at").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
    if (last.data?.fetched_at && Date.now() - new Date(last.data.fetched_at as string).getTime() < MIN_INTERVAL_MS) return fail("直前に更新したばかりです。数分あけてからお試しください");
  }
  let text = opts.csvText;
  if (text === undefined) {
    const f = await fetchCsv();
    if (!f.ok) return fail(f.error);
    text = f.text;
  }
  const parsed = parseMarketCsv(text);
  if (!parsed.ok) return fail(parsed.error);

  const lk = await any(db).from("card_market_links").select("card_id,match_key");
  const links: Record<string, string> = {};
  for (const r of (lk.error ? [] : lk.data) as { card_id: string; match_key: string }[]) links[r.card_id] = r.match_key;
  const { results, summary } = computeMarket(
    cards.map((x) => ({ id: x.id, setCode: x.set_code, cardNumber: x.card_number, rarity: x.rarity, name: x.name })),
    parsed.value,
    links,
  );

  const hh = new Map(cards.map((x) => [x.id, x.household_id]));
  const csvAt = parsed.value.updatedAt ? new Date(parsed.value.updatedAt).toISOString() : null;
  const fetchedAt = new Date().toISOString();
  const upserts: Record<string, unknown>[] = [];
  const addStat = (r: CardMarketResult, kind: "sale" | "buyback", grade: "A" | "B" | "C" = "A") => {
    const s = grade !== "A" ? r.saleGrades?.[grade] : kind === "sale" ? r.sale : r.buyback;
    if (!s) return;
    upserts.push({ household_id: hh.get(r.cardId), card_id: r.cardId, kind, condition_grade: grade, median_yen: s.medianYen, low_yen: s.lowYen, high_yen: s.highYen, sample_count: s.samples, outlier_count: s.outliers, shops: s.shops.slice(0, 12), source: MARKET_SOURCE_NAME, source_url: MARKET_SOURCE_URL, csv_updated_at: csvAt, fetched_at: fetchedAt, match_key: r.matchKey ?? "" });
  };
  for (const r of results) {
    if (r.status !== "updated") continue;
    addStat(r, "sale");
    addStat(r, "buyback");
    addStat(r, "sale", "B");
    addStat(r, "sale", "C");
  }
  if (upserts.length > 0) {
    const { error } = await any(db).from("card_market_prices").upsert(upserts, { onConflict: "card_id,kind,condition_grade" });
    if (error) return fail("相場の保存に失敗しました。既存の価格は変更していません");
  }
  const nameOf = new Map(cards.map((x) => [x.id, x.name]));
  return {
    ok: true,
    result: {
      summary,
      priceRows: upserts.length,
      csvRows: parsed.value.rows.length,
      csvUpdatedAt: csvAt,
      fetchedAt,
      ambiguous: results.filter((r) => r.status === "ambiguous").map((r) => ({ cardId: r.cardId, name: nameOf.get(r.cardId) ?? "", reason: r.reason ?? "", variants: r.variants ?? [] })),
      source: opts.csvText === undefined ? "download" : "upload",
    },
  };
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
