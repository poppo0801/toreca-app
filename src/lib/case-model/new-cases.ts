/**
 * 新規案件（過去の人間評価に含まれない抽選）の抽出・重複判定・パターン別の選定（Stage 9H-3F・純関数。本番へは接続しない。入力は読み取り専用の書き出し）。
 *  1. 候補プールを、同一抽選ごとにまとめる（異なるURL・店舗表記・商品表記でも、同一性の判定は統合処理と同じ。店舗別に独立した抽選は別件）
 *  2. 評価済みの抽選（同一・別バージョン・同じ企画・同じURL）を除く（除いたものと理由を保持）
 *  3. 検証パターンの偏りを抑えて選ぶ（パターンごとの枠→系列・商品の偏りを避けて補充）。足りなければ水増しせず、不足を報告する
 * 結果は凍結して保存し（plan）、実AIの検証の前に対象一覧を確定する。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { productKey } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";
import { judgeForm } from "@/lib/lottery-form";
import { matchIdentity, type IdentityFacts } from "./identity";

export interface PoolInput {
  chain: string;
  store: string;
  storeMode: string;
  selectable: string[];
  products: string[];
  applyStart: string | null;
  applyDeadline: string | null;
  resultDate: string | null;
  resultEnd: string | null;
  conditions: string;
  receiveMethod: string;
  applyMethod: string;
}
export interface PoolCandidate {
  id: string;
  status: string;
  triage: string | null;
  reasons: string[];
  kind: string;
  url: string | null;
  title: string;
  createdAt: string;
  viaList: boolean;
  failKind: string | null;
  input: PoolInput;
  evidence: { field: string; quote: string }[];
  region: string | null;
}

export type NewPattern =
  | "official_unreachable"
  | "official_direct"
  | "livepocket"
  | "x_main"
  | "store_select"
  | "store_independent"
  | "identity_unclear"
  | "date_conflict"
  | "region_exclude"
  | "expired"
  | "multi_source"
  | "livepocket_select"
  | "livepocket_independent"
  | "livepocket_unclear"
  | "chain_trend"
  | "trend_conflict"
  | "independent_diff"
  | "normal";

export const PATTERN_LABEL: Record<NewPattern, string> = {
  official_unreachable: "一次情報を取得できない",
  official_direct: "一次情報を直接取得できる",
  livepocket: "LivePocket",
  x_main: "Xが主な情報源",
  store_select: "店舗選択式",
  store_independent: "店舗ごとの独立抽選",
  identity_unclear: "系列・店舗が不明確",
  date_conflict: "応募期間・発表日に矛盾",
  region_exclude: "地域除外",
  expired: "期限切れ",
  multi_source: "複数情報源の統合が必要",
  livepocket_select: "LivePocket（店舗選択式に見える）",
  livepocket_independent: "LivePocket（店舗別の独立応募に見える）",
  livepocket_unclear: "LivePocket（応募形態が不明）",
  chain_trend: "系列の傾向を参照できる（過去の確認済みの実績あり）",
  trend_conflict: "系列の傾向（店舗選択式）と異なる形に見える（店舗を特定済み）",
  independent_diff: "同じ店舗で商品・応募期間が異なる独立抽選",
  normal: "特に問題のない通常抽選",
};

interface GroupFacts extends IdentityFacts {
  products: string[];
  selectable: string[];
}

export interface NewGroup {
  id: string;
  members: PoolCandidate[];
  facts: GroupFacts;
  patterns: NewPattern[];
}

const host = (u: string | null): string => {
  try {
    return new URL(u ?? "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
export const normUrl = (u: string | null): string => (u ?? "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

const factsOfCand = (c: PoolCandidate): GroupFacts => {
  const select = c.input.storeMode === "select_on_apply";
  return { chain: c.input.chain || undefined, store: select ? undefined : c.input.store || undefined, storeSelect: select, products: c.input.products, applyStart: c.input.applyStart ?? undefined, applyDeadline: c.input.applyDeadline ?? undefined, selectable: c.input.selectable };
};

/** 同じ抽選ごとにまとめる。店舗が一方だけ分かる候補・別の店舗の独立した抽選は、まとめない（統合処理と同じ方針） */
export function groupPool(cands: PoolCandidate[], opts: { refine?: boolean } = {}): NewGroup[] {
  const sorted = [...cands].sort((a, b) => a.id.localeCompare(b.id));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const f = sorted.map(factsOfCand);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (find(i) === find(j) || normUrl(sorted[i].url) === "" ) continue;
      const a = f[i];
      const b = f[j];
      const r = matchIdentity(a, b);
      const sameUrl = normUrl(sorted[i].url) !== "" && normUrl(sorted[i].url) === normUrl(sorted[j].url);
      const oneSide = !a.store !== !b.store && !a.storeSelect && !b.storeSelect;
      const sameChainKey = !!a.chain && !!b.chain && chainCanonicalKey(a.chain) === chainCanonicalKey(b.chain);
      const inList = (x: typeof a, y: typeof b) => sameChainKey && x.storeSelect && y.store && x.selectable.some((s) => normName(s).includes(normName(y.store!)) || normName(y.store!).includes(normName(s)));
      // 店舗別の告知: 店舗以外が一致し、店舗をまたぐ応募制限・店舗選択欄の記載がある（同じ企画）
      const storeOnly = r.verdict === "different" && r.mismatched.every((x) => x === "店舗");
      const campaign = storeOnly && judgeForm({ storeMode: "fixed", texts: [sorted[i].input.conditions, sorted[j].input.conditions], sourceUrls: [], perStorePages: true }).form === "store_select";
      if ((r.verdict === "same" && !oneSide) || sameUrl || campaign || inList(a, b) || inList(b, a)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, PoolCandidate[]>();
  sorted.forEach((c, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), c]));
  return [...groups.values()].flatMap((m) => (opts.refine === false ? [m] : refineMembers(m))).map((members) => ({ id: members[0].id, members, facts: factsOfCand(members[0]), patterns: [] }));
}

const dayOf = (s: string | null): string => (s ?? "").slice(0, 10);
const storeCompat = (a: string, b: string): boolean => {
  if (a === "(選択)" || b === "(選択)") return a === b;
  const x = normName(a);
  const y = normName(b);
  return x === y || (!!x && !!y && (x.includes(y) || y.includes(x)));
};

/**
 * 連鎖的な統合による誤統合を防ぐ再分割（9H-3F）。1つのまとまりの中を、系列・店舗・商品・応募締切（日）が互いに一致するものごとに分ける。
 *  - 商品が1つの候補を基準にする。商品が複数の候補は、基準の商品と重なる最初のまとまりに付けるだけで、まとまり同士はつなげない
 *  - 系列が不明な候補は単独（何にも付けない）。商品や日付が無い候補は、系列・店舗が合うまとまりが1つだけのときに付ける
 */
function refineMembers(members: PoolCandidate[]): PoolCandidate[][] {
  if (members.length <= 1) return [members];
  type Cluster = { chain: string; store: string; prod: string; day: string; members: PoolCandidate[] };
  const clusters: Cluster[] = [];
  const chainKey = (m: PoolCandidate) => (m.input.chain ? chainCanonicalKey(m.input.chain) : "");
  const prodKeys = (m: PoolCandidate) => m.input.products.map((p) => productKey(p)).filter(Boolean);
  const fits = (c: Cluster, m: PoolCandidate) => c.chain === chainKey(m) && storeCompat(c.store, m.input.storeMode === "select_on_apply" ? "(選択)" : m.input.store) && (!c.day || !dayOf(m.input.applyDeadline) || c.day === dayOf(m.input.applyDeadline));
  const singles = members.filter((m) => chainKey(m) && prodKeys(m).length === 1);
  const rest = members.filter((m) => !singles.includes(m));
  const lone: PoolCandidate[][] = [];
  for (const m of singles) {
    const hit = clusters.find((c) => fits(c, m) && c.prod === prodKeys(m)[0]);
    if (hit) {
      hit.members.push(m);
      if (!hit.day) hit.day = dayOf(m.input.applyDeadline);
    } else clusters.push({ chain: chainKey(m), store: m.input.storeMode === "select_on_apply" ? "(選択)" : m.input.store, prod: prodKeys(m)[0], day: dayOf(m.input.applyDeadline), members: [m] });
  }
  for (const m of rest) {
    if (!chainKey(m)) {
      lone.push([m]);
      continue;
    }
    const keys = prodKeys(m);
    const cands = clusters.filter((c) => fits(c, m) && (keys.length === 0 || keys.includes(c.prod)));
    if (keys.length >= 2) {
      if (cands.length) cands[0].members.push(m);
      else lone.push([m]);
    } else if (cands.length === 1) cands[0].members.push(m);
    else lone.push([m]);
  }
  return [...clusters.map((c) => c.members), ...lone].filter((x) => x.length);
}

/** 評価済みの抽選（系列・店舗・商品・締切・情報元URL）。除外の判定に使う */
export interface EvaluatedFacts {
  chain: string;
  store: string;
  products: string[];
  applyDeadline: string;
  storeSelect: boolean;
  urls: string[];
}

const dayGap = (a?: string | null, b?: string | null): number | null => {
  const x = a ? Date.parse(a.slice(0, 10)) : NaN;
  const y = b ? Date.parse(b.slice(0, 10)) : NaN;
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.abs(x - y) / 86_400_000;
};

/** 評価済みの抽選との関係。同一・同じ企画（店舗選択式）・別バージョン（同じ系列・商品で近い期間）・同じURLは除く。店舗が違う独立した応募は別件（除かない） */
export function excludedReason(g: NewGroup, evaluated: EvaluatedFacts[]): string | null {
  const urls = new Set(g.members.map((m) => normUrl(m.url)).filter(Boolean));
  for (const e of evaluated) {
    if (e.urls.some((u) => urls.has(normUrl(u)))) return "評価済みの抽選と同じ情報元URL";
    const r = matchIdentity({ chain: g.facts.chain, store: g.facts.store, storeSelect: g.facts.storeSelect, products: g.facts.products, applyDeadline: g.facts.applyDeadline }, { chain: e.chain || undefined, store: e.store || undefined, storeSelect: e.storeSelect, products: e.products, applyDeadline: e.applyDeadline || undefined });
    if (r.verdict === "same") return "評価済みの抽選と同一";
    const sameChain = !!g.facts.chain && !!e.chain && chainCanonicalKey(g.facts.chain) === chainCanonicalKey(e.chain);
    const sameProduct = g.facts.products.some((p) => e.products.some((q) => productKey(p) !== "" && productKey(p) === productKey(q)));
    const gap = dayGap(g.facts.applyDeadline, e.applyDeadline);
    if (sameChain && sameProduct && gap !== null && gap <= 14) {
      const storeKnownBoth = !!g.facts.store && !!e.store && !g.facts.storeSelect && !e.storeSelect;
      const differentStore = storeKnownBoth && normName(g.facts.store!) !== normName(e.store) && !normName(g.facts.store!).includes(normName(e.store)) && !normName(e.store).includes(normName(g.facts.store!));
      if (!differentStore) return "評価済みの抽選の別バージョン・同じ企画（同じ系列・商品・近い応募期間）";
    }
  }
  return null;
}

const SOCIAL = ["x.com", "twitter.com", "t.co"];
const LISTING = ["pokeso.jp", "torecabiyori.com", "cardchusen.com", "nyuka-now.com"];
const FORMS = ["docs.google.com", "forms.gle"];

/** 候補群のパターン（複数該当あり。「店舗ごとの独立抽選」は、プールの中に同じ系列・商品・近い期間で別の店舗の抽選がある場合） */
/** 系列の過去の実績（人間の確認済み）の要約。chain_trend / trend_conflict の判定に使う（正解の値は渡さない。系列と傾向の向きだけ） */
export interface ChainTrendInfo {
  /** 実績のある系列の正規形キー */
  known: Set<string>;
  /** 店舗選択式に傾く系列の正規形キー */
  selectLean: Set<string>;
}

export function tagPatterns(g: NewGroup, all: NewGroup[], opts: { today: string; trend?: ChainTrendInfo }): NewPattern[] {
  const p = new Set<NewPattern>();
  const m0 = g.members[0];
  const hosts = g.members.map((m) => host(m.url));
  const text = g.members.flatMap((m) => [...m.reasons, m.region ?? ""]).join(" ");
  if (g.members.some((m) => m.viaList || ["robots", "js_render", "not_found", "login_required"].includes(m.failKind ?? "")) || /取得制限|ロボット|ログインが必要/.test(text)) p.add("official_unreachable");
  else if (hosts.some((h) => h && ![...SOCIAL, ...LISTING, ...FORMS, "livepocket.jp"].includes(h))) p.add("official_direct");
  if (hosts.includes("livepocket.jp")) p.add("livepocket");
  if (hosts.some((h) => SOCIAL.includes(h))) p.add("x_main");
  if (g.members.some((m) => m.input.storeMode === "select_on_apply" || m.input.selectable.length >= 2)) p.add("store_select");
  const sib = all.some((o) => o !== g && !!g.facts.chain && !!o.facts.chain && chainCanonicalKey(o.facts.chain) === chainCanonicalKey(g.facts.chain) && !!g.facts.store && !!o.facts.store && normName(g.facts.store) !== normName(o.facts.store) && o.facts.products.some((x) => g.facts.products.some((y) => productKey(x) === productKey(y) && productKey(x) !== "")) && (dayGap(o.facts.applyDeadline, g.facts.applyDeadline) ?? 99) <= 7 && !o.facts.storeSelect && !g.facts.storeSelect);
  if (sib) p.add("store_independent");
  const online = /通販|オンライン|ネット/.test(m0.input.store);
  if (!m0.input.chain || (!m0.input.store && m0.input.storeMode !== "select_on_apply" && !online)) p.add("identity_unclear");
  const dls = g.members.map((m) => m.input.applyDeadline).filter((x): x is string => !!x);
  if (/食い違/.test(text) || (dls.length >= 2 && dls.some((d) => (dayGap(d, dls[0]) ?? 0) > 0 && !d.startsWith(dls[0].slice(0, 10)) && (dayGap(d, dls[0]) ?? 0) <= 14))) p.add("date_conflict");
  if (g.members.some((m) => m.status === "excluded" && (m.region || /地域|都道府県|対象外/.test(m.reasons.join(" "))))) p.add("region_exclude");
  if (g.members.some((m) => m.status === "excluded" && /受付終了|終了|期限切れ/.test(m.reasons.join(" "))) || (!!g.facts.applyDeadline && g.facts.applyDeadline.slice(0, 10) < opts.today && g.members.every((m) => m.status !== "auto_registered"))) p.add("expired");
  if (g.members.length >= 2) p.add("multi_source");
  // 9H-3I: LivePocketの形態・系列の傾向・独立抽選の差（候補の入力から見える範囲の分類。実際の正解は人間の評価で決まる）
  if (hosts.includes("livepocket.jp")) {
    const lpm = g.members.filter((m) => host(m.url) === "livepocket.jp");
    if (lpm.some((m) => m.input.storeMode === "select_on_apply" || m.input.selectable.length >= 2)) p.add("livepocket_select");
    else if (lpm.some((m) => !!m.input.store.trim() && m.input.storeMode !== "select_on_apply" && !/オンライン|通販/.test(m.input.store))) p.add("livepocket_independent");
    else p.add("livepocket_unclear");
  }
  const ck = g.facts.chain ? chainCanonicalKey(g.facts.chain) : "";
  if (ck && opts.trend?.known.has(ck)) {
    p.add("chain_trend");
    if (opts.trend.selectLean.has(ck) && !!g.facts.store && !g.facts.storeSelect) p.add("trend_conflict");
  }
  const sameStoreOther = all.some((o) => o !== g && !!ck && !!o.facts.chain && chainCanonicalKey(o.facts.chain) === ck && !!g.facts.store && !!o.facts.store && normName(g.facts.store) === normName(o.facts.store) && !o.facts.storeSelect && !g.facts.storeSelect && (o.facts.products.some((x) => g.facts.products.every((y) => productKey(x) !== productKey(y))) || (dayGap(o.facts.applyDeadline, g.facts.applyDeadline) ?? 0) > 3));
  if (sameStoreOther) p.add("independent_diff");
  const issues = ["official_unreachable", "store_select", "store_independent", "identity_unclear", "date_conflict", "region_exclude", "expired", "multi_source"] as NewPattern[];
  if (g.members.some((m) => m.status === "auto_registered") && m0.input.chain && (m0.input.store || m0.input.storeMode === "select_on_apply") && !!g.facts.applyDeadline && !issues.some((x) => p.has(x))) p.add("normal");
  return [...p];
}

/** 偏りを抑えた選定の優先順（まれなパターンの枠を先に埋める）と、パターンごとの枠 */
const ORDER: [NewPattern, number][] = [
  ["livepocket_select", 1],
  ["livepocket_independent", 1],
  ["livepocket_unclear", 1],
  ["trend_conflict", 1],
  ["store_select", 1],
  ["store_independent", 1],
  ["independent_diff", 1],
  ["chain_trend", 2],
  ["region_exclude", 1],
  ["expired", 1],
  ["date_conflict", 1],
  ["identity_unclear", 1],
  ["official_unreachable", 1],
  ["multi_source", 1],
  ["x_main", 1],
  ["official_direct", 1],
  ["normal", 1],
];

export interface SelectionReport {
  poolCandidates: number;
  groups: number;
  duplicatesMerged: number;
  excludedEvaluated: { id: string; reason: string }[];
  available: number;
  selected: number;
  target: { min: number; max: number };
  shortfall: string | null;
  byPattern: Record<string, number>;
  missingPatterns: NewPattern[];
  chains: Record<string, number>;
}

export function selectNewCases(pool: PoolCandidate[], evaluated: EvaluatedFacts[], opts: { today: string; target?: number; min?: number; max?: number; perChain?: number; trend?: ChainTrendInfo }): { selected: NewGroup[]; report: SelectionReport } {
  const target = opts.target ?? 12;
  const min = opts.min ?? 10;
  const max = opts.max ?? 15;
  const perChain = opts.perChain ?? 2;
  const groups = groupPool(pool);
  const excluded: { id: string; reason: string }[] = [];
  const kept: NewGroup[] = [];
  // 評価済みとの関係は、再分割の前のまとまり（粗いまとまり）でも調べる。再分割で評価済みの抽選のURLを持つ候補と離れた同じ企画の候補が、新規として残らないようにする（保守的）
  const coarseExcluded = new Set<string>();
  for (const cg of groupPool(pool, { refine: false })) if (excludedReason(cg, evaluated)) for (const m of cg.members) coarseExcluded.add(m.id);
  for (const g of groups) {
    const why = excludedReason(g, evaluated) ?? (g.members.some((m) => coarseExcluded.has(m.id)) ? "評価済みの抽選と同じまとまり（再分割前）に含まれる" : null) ?? (g.members.every((m) => m.reasons.some((r) => /ポケモンカード以外|別ゲーム/.test(r))) ? "ポケモンカード以外の商品（対象外ゲーム。地域・期限の除外検証には使わない）" : null);
    if (why) excluded.push({ id: g.id, reason: why });
    else kept.push(g);
  }
  for (const g of kept) g.patterns = tagPatterns(g, kept, { today: opts.today, trend: opts.trend });
  const chainOf = (g: NewGroup) => (g.facts.chain ? chainCanonicalKey(g.facts.chain) : "(不明)");
  const prodOf = (g: NewGroup) => (g.facts.products[0] ? productKey(g.facts.products[0]) : "");
  const chosen: NewGroup[] = [];
  const count = (key: (g: NewGroup) => string, k: string) => chosen.filter((c) => key(c) === k).length;
  const can = (g: NewGroup) => !chosen.includes(g) && count(chainOf, chainOf(g)) < perChain && count(prodOf, prodOf(g)) < Math.max(3, Math.ceil(max / 3));
  const order = (a: NewGroup, b: NewGroup) => b.members.length - a.members.length || a.id.localeCompare(b.id);
  for (const [pat, quota] of ORDER) {
    for (const g of [...kept].filter((x) => x.patterns.includes(pat)).sort(order)) {
      if (chosen.length >= max) break;
      if (chosen.filter((c) => c.patterns.includes(pat)).length >= quota) break;
      if (can(g)) chosen.push(g);
    }
  }
  // 補充: 選ばれていないパターンが多い・系列が少ない抽選を優先（目標件数まで）
  const rest = kept.filter((g) => !chosen.includes(g));
  while (chosen.length < Math.min(target, max)) {
    const cand = rest.filter(can).sort((a, b) => count(chainOf, chainOf(a)) - count(chainOf, chainOf(b)) || b.patterns.length - a.patterns.length || a.id.localeCompare(b.id))[0];
    if (!cand) break;
    chosen.push(cand);
    rest.splice(rest.indexOf(cand), 1);
  }
  const byPattern: Record<string, number> = {};
  for (const g of chosen) for (const p of g.patterns) byPattern[p] = (byPattern[p] ?? 0) + 1;
  const chains: Record<string, number> = {};
  for (const g of chosen) chains[chainOf(g)] = (chains[chainOf(g)] ?? 0) + 1;
  return {
    selected: chosen,
    report: {
      poolCandidates: pool.length,
      groups: groups.length,
      duplicatesMerged: pool.length - groups.length,
      excludedEvaluated: excluded,
      available: kept.length,
      selected: chosen.length,
      target: { min, max },
      shortfall: chosen.length < min ? `新規の抽選が${chosen.length}件しか確保できませんでした（目標${min}〜${max}件）。水増しせず、この件数で報告します` : null,
      byPattern,
      missingPatterns: ORDER.map(([p]) => p).filter((p) => !byPattern[p]),
      chains,
    },
  };
}

/** 評価の記録（review-answers の results）→ 評価済みの抽選の材料 */
export function evaluatedFromAnswers(files: { results?: { aiOriginal?: { extracted?: { chain?: string | null; store?: string | null; products?: string[] | null; applyDeadline?: string | null } }; source?: { url?: string }; human?: { corrections?: { field: string; correctValue?: string }[] } }[] }[]): EvaluatedFacts[] {
  const out: EvaluatedFacts[] = [];
  for (const f of files) {
    for (const r of f.results ?? []) {
      const x = r.aiOriginal?.extracted ?? {};
      const fix = (k: string) => (r.human?.corrections ?? []).find((c) => c.field === k)?.correctValue;
      out.push({
        chain: (fix("chain") || x.chain || "") as string,
        store: (x.store ?? "") as string,
        products: x.products ?? [],
        applyDeadline: (x.applyDeadline ?? "") as string,
        storeSelect: (r.human?.corrections ?? []).some((c) => /店舗選択/.test(c.correctValue ?? "")),
        urls: r.source?.url ? [r.source.url] : [],
      });
    }
  }
  return out;
}
