/**
 * 手がかりの検証（Stage 9H-3P・固定ロジック）。AIの自己評価ではなく、取得したページの事実・既存データ・地域設定で、採用・保留・除外を決める。
 *   - 根拠: 報告された原文が、取得済みのページに実在すること
 *   - 同一抽選: 既存の収集・手動登録・今回の実行内の重複を見分け、先に持っていたものをAIの発見実績として数えない
 *   - 地域: 対象地域の外と確定したものだけ除外。不明・食い違いは除外せず、要確認として残す
 *   - 系列共通／店舗固有: 分けて保持（店舗選択式は店舗ごとに展開しない）
 *   - 人間が確認した既存の抽選は、更新しない（保護）
 * 不確実な項目は確定せず、attention（要確認）に残す。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { judgeRegion } from "@/lib/collector/region";
import type { DiscoveryWorld, ExistingLottery, KnownStore, LeadDecision, LeadInput } from "./types";

export const normText = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export const storeKeyOf = (s: string): string => normText(s).replace(/店$/, "");
const productKeyOf = (s: string): string => normText(s).replace(/[【\[（(][^】\]）)]*[】\]）)]/g, "");
export const urlKeyOf = (u: string): string => u.trim().replace(/#.*$/, "").replace(/\/+$/, "");

export interface VerifyContext {
  /** 取得に成功したページ（URL → 本文）。根拠は、ここにあるものだけ */
  pages: Map<string, { title: string; text: string }>;
  targetPrefectures: string[];
  knownStores: KnownStore[];
  world: Pick<DiscoveryWorld, "existing">;
  /** 今回の実行で採用・保留した手がかりのキー（重複の検出） */
  seen: Set<string>;
}

const hasLotteryWord = (t: string) => /抽選|応募|エントリー|予約受付|当選/.test(t);

/** 日付（YYYY-MM-DD）の月日が、原文にあるか（「12/3」「12月3日」「12/03」） */
export function dateInText(iso: string, text: string): boolean {
  const m = iso.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const mo = String(Number(m[1]));
  const da = String(Number(m[2]));
  const t = text.normalize("NFKC");
  return new RegExp(`${mo}\\s*[/月]\\s*0?${da}(?!\\d)`).test(t);
}

const sameProduct = (a: string[], b: string[]): boolean => a.some((x) => b.some((y) => productKeyOf(x) && productKeyOf(y) && (productKeyOf(x).includes(productKeyOf(y)) || productKeyOf(y).includes(productKeyOf(x)))));

export async function verifyLead(lead: LeadInput, ctx: VerifyContext): Promise<LeadDecision> {
  const attention: string[] = [];
  const base = (status: LeadDecision["status"], reason: string, extra: Partial<LeadDecision> = {}): LeadDecision => ({
    status,
    reason,
    attention,
    overlap: { kind: "none", existing: [] },
    credit: "none",
    region: { verdict: "unknown", prefecture: "", basis: "none" },
    fields: { chainCommon: { products: lead.products }, storeSpecific: { store: lead.store, url: lead.url, selectMode: lead.scope === "store_select" } },
    ...extra,
  });

  // 1. 根拠: 取得済みのページに、報告された原文が実在する
  const page = ctx.pages.get(urlKeyOf(lead.url));
  if (!page) return base("exclude", "根拠のURLを取得していません（取得したページだけが根拠になります）", { exclusion: "evidence_missing" });
  const body = `${page.title}\n${page.text}`;
  if (!lead.quote.trim() || !normText(body).includes(normText(lead.quote))) return base("exclude", "報告された原文が、取得したページに見つかりません", { exclusion: "evidence_missing" });
  if (!hasLotteryWord(body)) return base("exclude", "ページに抽選・応募に関する記載がありません", { exclusion: "not_a_lottery" });

  const q = normText(lead.quote);
  const all = normText(body);
  // 2. 識別: 系列・店舗・商品が根拠にあるか（無いものは確定せず保留）
  const chainOk = all.includes(normText(lead.chain)) || (chainCanonicalKey(lead.chain) !== "" && all.includes(chainCanonicalKey(lead.chain)));
  if (!chainOk) attention.push("系列名が根拠のページに見当たりません");
  const productOk = lead.products.length > 0 && lead.products.some((p) => all.includes(productKeyOf(p)) || all.includes(normText(p)));
  if (!productOk) attention.push("商品名が根拠のページで確認できません");
  const storeInQuote = !!lead.store && q.includes(normText(lead.store));
  const storeInPage = !!lead.store && all.includes(normText(lead.store));
  if (lead.scope === "store_specific") {
    if (!lead.store) return base("hold", "店舗が特定できていません（店舗不明のまま確定しません）", { credit: "none" });
    if (!storeInPage) return base("hold", "店舗名が根拠のページにありません（別店舗の告知を取り込まないため保留）", { credit: "none" });
    if (!storeInQuote) attention.push("店舗名は原文の抜粋ではなくページの別の箇所にあります");
  }

  // 3. 地域: 外と確定したものだけ除外。不明・食い違いは除外しない
  const master = ctx.knownStores.find((s) => lead.store && storeKeyOf(s.name) === storeKeyOf(lead.store));
  const rj = judgeRegion({ masterPrefecture: master?.prefecture ?? null, address: master?.address ?? null, storeName: lead.scope === "store_specific" ? lead.store : null, statedPrefecture: lead.statedPrefecture ?? null });
  const target = ctx.targetPrefectures;
  let verdict: "in" | "out" | "unknown" = "unknown";
  if (target.length === 0) verdict = "in";
  else if (rj.basis !== "none" && rj.basis !== "conflict" && rj.prefecture && !rj.multiStore) verdict = target.includes(rj.prefecture) ? "in" : "out";
  const region = { verdict, prefecture: rj.prefecture, basis: rj.basis };
  if (verdict === "out") return base("exclude", `対象地域の外（${rj.prefecture}。${rj.note}）`, { exclusion: "region_out", region });
  if (verdict === "unknown") attention.push(rj.basis === "conflict" ? "地域の根拠が食い違っています（除外せず確認）" : "店舗の地域を確認できていません（除外せず確認）");

  // 4. 既存との照合（従来の収集・手動登録）。先に持っていたものはAIの発見実績にしない
  const hits: ExistingLottery[] = await ctx.world.existing({ chain: lead.chain, store: lead.store, product: lead.products[0], url: lead.url });
  const mine = hits.filter((h) => chainCanonicalKey(h.chain) === chainCanonicalKey(lead.chain));
  const sameLottery = mine.filter((h) => (lead.store && storeKeyOf(h.store) === storeKeyOf(lead.store) && sameProduct(h.products, lead.products)) || h.sourceUrls.some((u) => urlKeyOf(u) === urlKeyOf(lead.url) && (!lead.store || storeKeyOf(h.store) === storeKeyOf(lead.store))));
  const otherStore = mine.filter((h) => !sameLottery.includes(h) && sameProduct(h.products, lead.products));
  const ref = (xs: ExistingLottery[]) => xs.map((h) => ({ lotteryId: h.lotteryId, origin: h.origin, humanConfirmed: h.humanConfirmed }));
  if (sameLottery.length > 0) {
    const overlap: LeadDecision["overlap"] = { kind: "same_lottery", existing: ref(sameLottery) };
    if (sameLottery.some((h) => h.humanConfirmed)) return base("exclude", "人間が確認済みの既存の抽選と同一のため、更新しません（保護）", { exclusion: "protected_human", overlap, credit: "already_known", region });
    const fill = lead.applyDeadline && sameLottery.every((h) => !h.applyDeadline) && dateInText(lead.applyDeadline, body);
    if (fill) attention.push("既存の登録に無い締切を補完できる可能性（人間が確認していない項目のみ）");
    return base("exclude", `既存の収集・登録にすでにあります（出どころ: ${sameLottery[0].origin}）。AIの新規発見としては数えません`, { exclusion: "already_collected", overlap, credit: "already_known", region });
  }
  const overlap: LeadDecision["overlap"] = otherStore.length > 0 ? { kind: "same_chain_product_other_store", existing: ref(otherStore) } : { kind: "none", existing: [] };

  // 5. 今回の実行内の重複
  const key = `${chainCanonicalKey(lead.chain)}|${lead.scope === "store_specific" ? storeKeyOf(lead.store ?? "") : lead.scope}|${lead.products.map(productKeyOf).sort().join("+")}`;
  if (ctx.seen.has(key)) return base("exclude", "今回の調査で同じ抽選をすでに記録しています", { exclusion: "duplicate_in_run", overlap, region });

  // 6. 日付: 根拠で確認できたものだけ項目に採用（確認できない日付は確定しない）
  const chainCommon: LeadDecision["fields"]["chainCommon"] = { products: lead.products };
  for (const f of ["applyStart", "applyDeadline"] as const) {
    const v = lead[f];
    if (!v) continue;
    if (dateInText(v, body)) chainCommon[f] = v;
    else attention.push(`${f === "applyStart" ? "応募開始" : "応募締切"}が根拠のページで確認できません（確定しません）`);
  }
  if (!chainCommon.applyDeadline && !attention.some((a) => a.startsWith("応募締切"))) attention.push("応募締切が不明です（続報で補完）");

  const fields: LeadDecision["fields"] = { chainCommon, storeSpecific: { store: lead.store, url: lead.url, selectMode: lead.scope === "store_select" } };
  if (lead.scope === "store_select") attention.push("店舗選択式: 店舗ごとの別の抽選として展開しません。選べる店舗は応募ページで確認");
  if (lead.scope === "chain_common") return base("hold", "系列共通の告知です。店舗ごとの開催・応募条件は個別に確認します（共通情報と店舗固有情報を混ぜません）", { overlap, region, fields, credit: "none" });
  const weak = !chainOk || !productOk;
  ctx.seen.add(key);
  if (weak) return base("hold", "識別の根拠が一部不足しているため、確定せず保留します", { overlap, region, fields, credit: "ai_new" });
  return base("adopt", attention.length ? "根拠を確認できた候補です（要確認の項目あり。自動で確定しません）" : "根拠を確認できた候補です", { overlap, region, fields, credit: "ai_new" });
}
