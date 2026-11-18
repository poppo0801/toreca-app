/**
 * 系列横断の調査（Stage 9H-3N・純関数。DB・ネットワークに触れない）。
 *
 * 同じ系列の複数店舗は、同じ商品の抽選をほぼ同時期に行うことが多い。1店舗の抽選を見つけたとき、他の店舗でも開催されている可能性を、
 * **蓄積した履歴から系列ごとに発見した傾向**で判断し、調査すべき店舗を選ぶ。系列名の固定ルール・辞書は使わない（未知の系列も、蓄積から傾向を発見する）。
 *  1. 開催機会（Opportunity）: 系列＋商品＋時期のまとまり。発売時の抽選と再販の抽選など、別の開催機会は統合しない
 *  2. 系列の傾向（ChainProfile）: 開催機会ごとの店舗の参加率・同時性・時期のずれ。標本が少ないときは信頼度を下げ、全系列の傾向で補う
 *  3. 関連店舗の調査計画（planSweep）: 起点の抽選から、まだ見つかっていない店舗のうち、開催の可能性が高い店舗を、上限つきで選ぶ
 *  4. 調査の台帳（SweepLedger）: 未確認の店舗は「開催なし」と決めつけず、間隔を広げて継続して調べる。同じ調査を重複して実行しない。回数・期限の上限で終了する
 * AIの推測は確定情報にしない。見つかった抽選は、既存の登録・グループ化の検証を経て候補にする（店舗ごとの応募期間・条件・URL・発表日の独立性は維持する）。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { productKey } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";

export interface HistoryLottery {
  chain: string;
  store: string;
  product: string;
  /** YYYY-MM-DD。不明は null */
  applyStart?: string | null;
  applyDeadline?: string | null;
  /** 告知の文言（再販・発売時などの開催機会の種類を読むため） */
  text?: string;
}

export type RoundKind = "launch" | "resale" | "unspecified";
const RESALE = /再販|再入荷|再抽選|追加(抽選|販売)|第[2-9二三四]弾|2次(抽選|販売)/;
const LAUNCH = /発売(記念|日|時)?(抽選|予約)?|新発売|初回(販売|抽選)|先行(抽選|予約)/;
export function roundKindOf(text: string | undefined | null): RoundKind {
  const t = (text ?? "").normalize("NFKC");
  if (RESALE.test(t)) return "resale";
  if (LAUNCH.test(t)) return "launch";
  return "unspecified";
}

const DAY = 86_400_000;
const dayNum = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / DAY) : null;
};
/** 同じ開催機会とみなす開始日のずれの上限（日）。これを超えて離れていれば別の開催機会 */
export const SAME_OPPORTUNITY_DAYS = 7;

export interface Opportunity {
  key: string;
  chain: string;
  product: string;
  /** 開催機会に含まれる抽選（店舗ごと） */
  members: HistoryLottery[];
  stores: string[];
  startDay: number | null;
  round: RoundKind;
  /** 店舗間の開始日の最大のずれ（日）。開始日が分かる店舗が2つ未満なら null */
  spreadDays: number | null;
}

const chainKeyOf = (c: string) => chainCanonicalKey(c) || normName(c);
const productKeyOf = (p: string) => productKey(p) || normName(p);
const storeKeyOf = (s: string) => normName(s);

/** 2つの抽選が同じ開催機会か（系列・商品が同じで、時期が近く、再販/発売時などの種類が矛盾しない） */
export function sameOpportunity(a: HistoryLottery, b: HistoryLottery): { same: boolean; reason: string } {
  if (chainKeyOf(a.chain) !== chainKeyOf(b.chain)) return { same: false, reason: "系列が違う" };
  if (productKeyOf(a.product) !== productKeyOf(b.product)) return { same: false, reason: "商品が違う" };
  const ra = roundKindOf(a.text);
  const rb = roundKindOf(b.text);
  if (ra !== "unspecified" && rb !== "unspecified" && ra !== rb) return { same: false, reason: "開催の種類が違う（発売時の抽選と再販の抽選は別の開催機会）" };
  const sa = dayNum(a.applyStart);
  const sb = dayNum(b.applyStart);
  if (sa === null || sb === null) {
    // 開始日が分からないときは、期間で判断する。どちらも期間が分からなければ統合しない（推測で同じ開催機会にしない）
    const ea = dayNum(a.applyDeadline);
    const eb = dayNum(b.applyDeadline);
    if (ea !== null && eb !== null) return Math.abs(ea - eb) <= SAME_OPPORTUNITY_DAYS ? { same: true, reason: "締切が近い" } : { same: false, reason: "締切が離れている" };
    return { same: false, reason: "時期を比べられないため統合しない" };
  }
  return Math.abs(sa - sb) <= SAME_OPPORTUNITY_DAYS ? { same: true, reason: "開始日が近い" } : { same: false, reason: `開始日が${SAME_OPPORTUNITY_DAYS}日を超えて離れている（別の開催機会）` };
}

/** 履歴を開催機会にまとめる（系列・商品ごとに、時期の近い抽選を同じ開催機会にする） */
export function clusterOpportunities(history: HistoryLottery[]): Opportunity[] {
  const groups: HistoryLottery[][] = [];
  const sorted = [...history].filter((h) => h.chain.trim() && h.product.trim()).sort((a, b) => (dayNum(a.applyStart) ?? 1e9) - (dayNum(b.applyStart) ?? 1e9));
  for (const h of sorted) {
    // 既存のまとまりの全員と同じ開催機会であること（連鎖して遠い抽選まで同じにしない）
    const g = groups.find((m) => m.every((x) => sameOpportunity(x, h).same));
    if (g) g.push(h);
    else groups.push([h]);
  }
  return groups.map((members) => {
    const starts = members.map((m) => dayNum(m.applyStart)).filter((x): x is number => x !== null);
    const rounds = members.map((m) => roundKindOf(m.text)).filter((r) => r !== "unspecified");
    const startDay = starts.length ? Math.min(...starts) : null;
    return {
      key: `${chainKeyOf(members[0].chain)}|${productKeyOf(members[0].product)}|${startDay ?? "?"}`,
      chain: members[0].chain,
      product: members[0].product,
      members,
      stores: [...new Set(members.map((m) => m.store.trim()).filter(Boolean))],
      startDay,
      round: rounds[0] ?? "unspecified",
      spreadDays: starts.length >= 2 ? Math.max(...starts) - Math.min(...starts) : null,
    };
  });
}

export interface ChainProfile {
  chain: string;
  /** 履歴にある開催機会の数と、複数店舗で行われた開催機会の数 */
  opportunities: number;
  multiStoreOpportunities: number;
  /** 履歴で見た店舗 */
  storesKnown: string[];
  /** 複数店舗の開催機会で、系列の既知の店舗のうち参加した割合の平均（0〜1） */
  coverage: number;
  /** 複数店舗の開催機会のうち、開始日のずれが3日以内だった割合（0〜1） */
  simultaneity: number;
  medianSpreadDays: number | null;
  /** 店舗ごとの参加率（その店舗が、複数店舗の開催機会のうち参加した割合）と標本数 */
  storeRates: Record<string, { hits: number; n: number }>;
  /** 傾向の信頼度。標本（複数店舗の開催機会）が少ないときは low／none */
  confidence: "none" | "low" | "medium" | "high";
  /** 発見した傾向の説明（根拠の記録） */
  note: string;
}

const median = (xs: number[]): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);

/** 1つの系列の傾向を、蓄積した履歴から発見する。knownStores（店舗マスター）があれば、系列の店舗の母数に使う */
export function profileChain(chain: string, history: HistoryLottery[], knownStores: string[] = []): ChainProfile {
  const ck = chainKeyOf(chain);
  const mine = history.filter((h) => chainKeyOf(h.chain) === ck);
  const opps = clusterOpportunities(mine);
  const storesKnown = [...new Set([...mine.map((h) => h.store.trim()).filter(Boolean), ...knownStores.map((s) => s.trim()).filter(Boolean)])];
  const multi = opps.filter((o) => o.stores.length >= 2);
  const storeRates: ChainProfile["storeRates"] = {};
  for (const s of storesKnown) storeRates[s] = { hits: 0, n: multi.length };
  let covSum = 0;
  for (const o of multi) {
    const present = new Set(o.stores.map(storeKeyOf));
    for (const s of storesKnown) if (present.has(storeKeyOf(s))) storeRates[s].hits++;
    covSum += o.stores.length / Math.max(storesKnown.length, o.stores.length);
  }
  const spreads = multi.map((o) => o.spreadDays).filter((x): x is number => x !== null);
  const sim = multi.length ? multi.filter((o) => (o.spreadDays ?? 99) <= 3).length / multi.length : 0;
  const confidence: ChainProfile["confidence"] = multi.length >= 5 ? "high" : multi.length >= 3 ? "medium" : multi.length >= 1 ? "low" : "none";
  return {
    chain,
    opportunities: opps.length,
    multiStoreOpportunities: multi.length,
    storesKnown,
    coverage: multi.length ? covSum / multi.length : 0,
    simultaneity: sim,
    medianSpreadDays: median(spreads),
    storeRates,
    confidence,
    note: multi.length ? `複数店舗の開催機会${multi.length}件で、店舗の参加率の平均${Math.round((covSum / multi.length) * 100)}%・開始日が3日以内に揃った割合${Math.round(sim * 100)}%` : "複数店舗で開催された履歴がまだ無く、傾向は未発見",
  };
}

/** 全系列の傾向を、蓄積から発見する（系列名を指定しない）。標本の少ない系列を補う全体の傾向（global）も返す */
export function discoverTendencies(history: HistoryLottery[], knownStoresByChain: Record<string, string[]> = {}): { profiles: ChainProfile[]; global: { coverage: number; simultaneity: number; samples: number } } {
  const chains = new Map<string, string>();
  for (const h of history) if (h.chain.trim()) chains.set(chainKeyOf(h.chain), h.chain);
  const profiles = [...chains.values()].map((c) => profileChain(c, history, knownStoresByChain[c] ?? []));
  const rated = profiles.filter((p) => p.multiStoreOpportunities >= 2);
  const samples = rated.reduce((n, p) => n + p.multiStoreOpportunities, 0);
  const global = samples ? { coverage: rated.reduce((n, p) => n + p.coverage * p.multiStoreOpportunities, 0) / samples, simultaneity: rated.reduce((n, p) => n + p.simultaneity * p.multiStoreOpportunities, 0) / samples, samples } : { coverage: 0, simultaneity: 0, samples: 0 };
  return { profiles, global };
}

// ----------------------------------------------------------------------------- 調査の計画・台帳

export type SweepStatus = "pending" | "found" | "unconfirmed" | "closed_unconfirmed";
export interface SweepEntry {
  key: string;
  chain: string;
  store: string;
  opportunityKey: string;
  status: SweepStatus;
  attempts: number;
  lastCheckedAt: string | null;
  /** 次に調べてよい時刻。未確認のとき、間隔を広げて継続する */
  nextCheckAt: string | null;
}
export type SweepLedger = Record<string, SweepEntry>;

export interface SweepLimits {
  /** 起点1件あたりに調べる店舗数の上限 */
  maxPerSeed: number;
  /** 1回の実行で調べる店舗数の上限（費用・アクセス量の上限） */
  maxPerRun: number;
  /** 同じ店舗を調べる回数の上限（これを超えたら継続しない。「開催なし」とは記録しない） */
  maxAttempts: number;
  /** 調べる最低の可能性（0〜1） */
  minProbability: number;
  /** 平滑化の強さ。標本が少ない店舗の参加率を、系列の平均へ寄せる度合い（大きいほど慎重） */
  smoothing: number;
}
export const DEFAULT_SWEEP_LIMITS: SweepLimits = { maxPerSeed: 5, maxPerRun: 15, maxAttempts: 3, minProbability: 0.4, smoothing: 4 };

export interface SweepTarget {
  chain: string;
  store: string;
  opportunityKey: string;
  /** 開催している可能性（0〜1）。蓄積した傾向からの推定であり、開催の確認ではない */
  probability: number;
  confidence: ChainProfile["confidence"];
  /** 判断の根拠（記録） */
  reasons: string[];
  ledgerKey: string;
}

export const sweepKey = (chain: string, store: string, oppKey: string) => `${chainKeyOf(chain)}|${storeKeyOf(store)}|${oppKey}`;

/** 調べる対象になる実在の店舗名か（9H-3O: 実調査の計画に「店舗未確認」「おもちゃ文具レジ特設コーナー」が選ばれていた） */
export function isRealStoreName(s: string): boolean {
  const t = s.normalize("NFKC").trim();
  if (!t) return false;
  return !/未確認|未定|不明|特設|コーナー|レジ|売場|売り場|^(通販|オンライン|ネット|web)|各店|全店|対象店舗/i.test(t);
}

/** 未確認のときの次回調査までの間隔（日）。回数が増えるほど広げる */
const backoffDays = (attempts: number) => [1, 2, 4][Math.min(attempts, 3) - 1] ?? 4;

/**
 * 起点の抽選から、調べる店舗を選ぶ。
 * - 既に見つかった店舗・調査済みで間隔が空いていない店舗・上限回数に達した店舗は選ばない（重複調査をしない）
 * - 起点の応募期間が終わっている開催機会は調べない
 * - 可能性は、店舗の参加率を系列の平均で補った値（標本が少ないほど全体の傾向へ寄せる）。標本が無い系列は全体の傾向を弱めて使い、最低の可能性に届かなければ調べない
 */
export function planSweep(o: {
  seed: HistoryLottery;
  profile: ChainProfile | null;
  global: { coverage: number; samples: number };
  /** この開催機会で、既に抽選が見つかっている店舗 */
  foundStores: string[];
  ledger: SweepLedger;
  now: Date;
  limits?: Partial<SweepLimits>;
  /** この実行で、既に選んだ店舗数（実行全体の上限の管理） */
  usedInRun?: number;
  /** 収集の対象地域の外にあると分かっている店舗か（9H-3O: 見つかっても地域外で除外される店舗を調べて費用を使わない。所在地が不明なら false＝調べる） */
  outOfRegion?: (store: string) => boolean;
}): SweepTarget[] {
  const lim = { ...DEFAULT_SWEEP_LIMITS, ...o.limits };
  const seedStart = dayNum(o.seed.applyStart);
  const seedEnd = dayNum(o.seed.applyDeadline);
  const today = Math.floor(o.now.getTime() / DAY);
  // 応募期間が終わっている（締切を3日過ぎた）開催機会は、新たに調べても応募できないので調べない
  if (seedEnd !== null && today > seedEnd + 3) return [];
  const oppKey = `${chainKeyOf(o.seed.chain)}|${productKeyOf(o.seed.product)}|${seedStart ?? "?"}`;
  const profile = o.profile;
  const found = new Set(o.foundStores.map(storeKeyOf));
  found.add(storeKeyOf(o.seed.store));
  const remainRun = Math.max(0, lim.maxPerRun - (o.usedInRun ?? 0));
  if (remainRun === 0) return [];
  const stores = profile?.storesKnown ?? [];
  const k = lim.smoothing; // 平滑化の強さ（標本が少ない店舗の参加率を、系列の平均へ寄せる）
  const base = profile && profile.multiStoreOpportunities > 0 ? profile.coverage : o.global.samples > 0 ? o.global.coverage * 0.6 : 0;
  const out: SweepTarget[] = [];
  for (const s of stores) {
    if (found.has(storeKeyOf(s))) continue;
    if (!isRealStoreName(s)) continue; // 「店舗未確認」「特設コーナー」「オンライン」などは、調べる店舗ではない
    if (o.outOfRegion?.(s)) continue;
    const key = sweepKey(o.seed.chain, s, oppKey);
    const e = o.ledger[key];
    if (e) {
      if (e.status === "found" || e.status === "closed_unconfirmed") continue;
      if (e.attempts >= lim.maxAttempts) continue;
      if (e.nextCheckAt && Date.parse(e.nextCheckAt) > o.now.getTime()) continue;
    }
    const r = profile?.storeRates[s];
    // 複数の開催機会に一度も参加していない店舗は、参加しない根拠として扱う（平滑化で可能性を引き上げない）。平滑化の強さは標本数までに抑える（標本が少ないほど証拠を優先）
    if (r && r.n >= 2 && r.hits === 0) continue;
    const kk = r ? Math.min(k, r.n) : k;
    const p = r && r.n > 0 ? (r.hits + kk * base) / (r.n + kk) : base;
    if (p < lim.minProbability) continue;
    const conf = profile?.confidence ?? "none";
    out.push({
      chain: o.seed.chain,
      store: s,
      opportunityKey: oppKey,
      probability: Math.round(p * 100) / 100,
      confidence: conf,
      reasons: [
        r && r.n > 0 ? `この店舗は、複数店舗の開催機会${r.n}件のうち${r.hits}件に参加している` : "この店舗の履歴は少ない",
        profile && profile.multiStoreOpportunities > 0 ? `系列の傾向: ${profile.note}` : "系列の傾向は未発見（全体の傾向を弱めて使用）",
        "開催の可能性であり、開催の確認ではない（調査して確認する）",
      ],
      ledgerKey: key,
    });
  }
  return out.sort((a, b) => b.probability - a.probability || a.store.localeCompare(b.store)).slice(0, Math.min(lim.maxPerSeed, remainRun));
}

/** 調査を始めたことの記録（同じ調査の重複実行を防ぐため、実行前に記録する） */
export function markPlanned(ledger: SweepLedger, t: SweepTarget, now: Date): SweepLedger {
  const cur = ledger[t.ledgerKey];
  return { ...ledger, [t.ledgerKey]: { key: t.ledgerKey, chain: t.chain, store: t.store, opportunityKey: t.opportunityKey, status: "pending", attempts: (cur?.attempts ?? 0) + 1, lastCheckedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + backoffDays((cur?.attempts ?? 0) + 1) * DAY).toISOString() } };
}

/** 調査の結果を記録する。見つからなかったときは「開催なし」とは記録せず、未確認のまま間隔を広げて継続する（上限回数・期限で終了） */
export function recordResult(ledger: SweepLedger, ledgerKey: string, result: "found" | "not_found" | "inconclusive", now: Date, opts: { maxAttempts?: number; windowClosed?: boolean } = {}): SweepLedger {
  const e = ledger[ledgerKey];
  if (!e) return ledger;
  if (result === "found") return { ...ledger, [ledgerKey]: { ...e, status: "found", nextCheckAt: null, lastCheckedAt: now.toISOString() } };
  const exhausted = e.attempts >= (opts.maxAttempts ?? DEFAULT_SWEEP_LIMITS.maxAttempts) || !!opts.windowClosed;
  return { ...ledger, [ledgerKey]: { ...e, status: exhausted ? "closed_unconfirmed" : "unconfirmed", lastCheckedAt: now.toISOString(), nextCheckAt: exhausted ? null : new Date(now.getTime() + backoffDays(e.attempts) * DAY).toISOString() } };
}

// ----------------------------------------------------------------------------- 調査計画への手がかり

export interface SiblingSignalOut {
  /** 台帳のキー（調査計画の対象ID） */
  id: string;
  chain: string;
  store: string;
  probability: number;
  confidence: ChainProfile["confidence"];
  reasons: string[];
  opportunityKey: string;
}

/**
 * 直近に見つかった抽選（起点）ごとに、関連店舗の調査候補を出す。履歴は、登録済みの抽選と保存済みの候補から作る。
 * 起点: 受付開始が直近（10日以内）で、応募期間が終わっていない抽選。実行全体の件数の上限（maxPerRun）を守る。
 */
export function buildSiblingSignals(o: {
  history: HistoryLottery[];
  knownStoresByChain?: Record<string, string[]>;
  ledger: SweepLedger;
  now: Date;
  limits?: Partial<SweepLimits>;
  /** 収集の対象地域の外にあると分かっている店舗か（所在地が不明なら false） */
  outOfRegion?: (chain: string, store: string) => boolean;
}): SiblingSignalOut[] {
  const lim = { ...DEFAULT_SWEEP_LIMITS, ...o.limits };
  const tend = discoverTendencies(o.history, o.knownStoresByChain ?? {});
  const today = Math.floor(o.now.getTime() / DAY);
  const seeds = o.history.filter((h) => {
    const s = dayNum(h.applyStart);
    return s !== null && today - s >= 0 && today - s <= 10;
  });
  const opps = clusterOpportunities(o.history);
  const out: SiblingSignalOut[] = [];
  const seenKeys = new Set<string>();
  // 9H-3O: 商品名の表記違いで開催機会が分かれても、同じ店舗を1回の実行で重複して調べない（同じ系列・店舗は1件。実調査の計画の21件中10件が重複だった）
  const seenStores = new Set<string>();
  for (const seed of seeds) {
    if (out.length >= lim.maxPerRun) break;
    const opp = opps.find((x) => x.members.includes(seed));
    const prof = tend.profiles.find((p) => chainKeyOf(p.chain) === chainKeyOf(seed.chain)) ?? null;
    const targets = planSweep({ seed: { ...seed, applyDeadline: seed.applyDeadline ?? opp?.members.map((m) => m.applyDeadline).filter(Boolean).sort().at(-1) ?? null }, profile: prof, global: tend.global, foundStores: opp?.stores ?? [], ledger: o.ledger, now: o.now, limits: lim, usedInRun: out.length, ...(o.outOfRegion ? { outOfRegion: (s: string) => o.outOfRegion!(seed.chain, s) } : {}) });
    for (const t of targets) {
      if (seenKeys.has(t.ledgerKey)) continue;
      const sk = `${chainKeyOf(t.chain)}|${storeKeyOf(t.store)}`;
      if (seenStores.has(sk)) continue;
      seenStores.add(sk);
      seenKeys.add(t.ledgerKey);
      out.push({ id: t.ledgerKey, chain: t.chain, store: t.store, probability: t.probability, confidence: t.confidence, reasons: t.reasons, opportunityKey: t.opportunityKey });
    }
  }
  return out.slice(0, lim.maxPerRun);
}

/** 台帳のキーから、系列・店舗・開催機会を取り出す（キー = 系列|店舗|開催機会キー） */
function entryFromKey(key: string): { chain: string; store: string; opportunityKey: string } {
  const [chain = "", store = "", ...rest] = key.split("|");
  return { chain, store, opportunityKey: rest.join("|") };
}

export interface SweepTaskLike {
  kind: string;
  targetId: string;
}
export interface SweepFindingLike {
  kind: string;
  targetId: string;
  pageKind?: string;
  action?: string;
}

/**
 * 調査計画の結果から、台帳を更新する。調査を始めたことを記録し（重複実行の防止）、結果を記録する。
 *  - 受け入れられた系列横断の調査（chain_sibling）だけが対象。他の種類の調査には触れない
 *  - 抽選の告知（lottery_announcement）が見つかり、AIの判断が「抽選ではない」でなければ found
 *  - 見つからなかった・判断できなかったときは未確認のまま（「開催なし」とは記録しない）。上限回数で終了
 * 台帳は調査結果の蓄積であり、確認済みの事実（抽選の登録）ではない。
 */
export function updateSweepLedger(prev: SweepLedger, tasks: SweepTaskLike[], findings: SweepFindingLike[], now: Date, limits: Partial<SweepLimits> = {}): SweepLedger {
  let ledger = { ...prev };
  const lim = { ...DEFAULT_SWEEP_LIMITS, ...limits };
  for (const t of tasks) {
    if (t.kind !== "chain_sibling") continue;
    const e = entryFromKey(t.targetId);
    ledger = markPlanned(ledger, { chain: e.chain, store: e.store, opportunityKey: e.opportunityKey, probability: 0, confidence: "none", reasons: [], ledgerKey: t.targetId }, now);
    const hit = findings.some((f) => f.kind === "lottery_info" && f.targetId === t.targetId && f.pageKind === "lottery_announcement" && f.action !== "not_lottery");
    ledger = recordResult(ledger, t.targetId, hit ? "found" : "not_found", now, { maxAttempts: lim.maxAttempts });
  }
  return ledger;
}
