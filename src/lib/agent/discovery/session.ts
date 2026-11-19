/**
 * 自律探索のミッション作成・セッション実行・探索実績の保存（Stage 9H-3P）。
 *   - ミッションは「何を調べるか」の入口だけ（商品・見つかった抽選・系列）。店舗名・検索語・順序は決めない（それはAIが選ぶ）
 *   - セッションは、複数ミッションを費用・件数の上限の中で実行する。費用を記録できないなら、有料の実行は始めない
 *   - 探索実績（StrategyMemory）は再利用しやすい plain JSON。AIが自分の実績を分析して調査戦略を改善するための材料（既存ロジック・手動登録が先に見つけたものは数えない）
 */
import type { AgentLLM } from "@/lib/agent/core";
import { allocateMission, SESSION_CAPS, type MissionBudget } from "./controls";
import { runDiscovery, type DiscoveryRunRecord, type NextMission } from "./engine";
import type { DiscoveryMission, DiscoveryWorld } from "./types";

// ---------------------------------------------------------------- 探索実績
export interface ChainStrategy {
  runs: number;
  /** 既存に無い新規の発見（AIの実績。既存が先に持っていたものは含めない） */
  aiNew: number;
  alreadyKnown: number;
  costJpy: number;
  /** 続けて新規発見が無かった回数 */
  barrenStreak: number;
  lastRunAt: string;
}
export interface HostStrategy {
  fetches: number;
  failures: number;
  aiNewLeads: number;
}
/** ミッションごとの調査履歴（9U）。同じミッションを成果なく繰り返さない（AIが決めた再調査までの時間を尊重する） */
export interface MissionMemory {
  runs: number;
  lastRunAt: string;
  /** この時刻より前には、同じミッションを再び選ばない（AIの revisit_hours、無ければ既定の間隔） */
  nextEligibleAt: string;
  lastAdopt: number;
  lastHold: number;
  by: "ai" | "default";
}
/** 次に調べる対象の待ち行列（AIの提案・保留中の手がかりの確認）。期限つき・件数に上限 */
export interface FrontierItem {
  id: string;
  next: NextMission;
  source: "ai" | "hold";
  addedAt: string;
}
export interface StrategyMemory {
  version: 1;
  chains: Record<string, ChainStrategy>;
  hosts: Record<string, HostStrategy>;
  missions?: Record<string, MissionMemory>;
  frontier?: FrontierItem[];
}
export const FRONTIER_MAX = 20;
export const FRONTIER_TTL_MS = 7 * 86_400_000;
const HOUR = 3_600_000;
/** AIが再調査までの時間を示さなかったときの既定の間隔（成果が無いほど長くする。上限48時間）。AIが示したときはそれを使う */
export function defaultRevisitHours(r: DiscoveryRunRecord): number {
  const produced = (r.counts?.adopt ?? 0) + (r.counts?.hold ?? 0);
  return produced > 0 ? 12 : 24;
}
export function missionIdOfNext(n: NextMission): string {
  return n.kind === "chain" ? `chain:${n.chain}` : n.kind === "product" ? `product:${n.product}` : `lead:${n.chain}|${n.store ?? ""}|${n.product ?? ""}`;
}
export const emptyStrategy = (): StrategyMemory => ({ version: 1, chains: {}, hosts: {} });

export function updateStrategy(mem: StrategyMemory, r: DiscoveryRunRecord, at: string): StrategyMemory {
  const next: StrategyMemory = { version: 1, chains: { ...mem.chains }, hosts: { ...mem.hosts }, missions: mem.missions, frontier: mem.frontier };
  const chains = new Set<string>([r.trigger.chain, ...r.leads.map((l) => l.lead.chain)].filter((x): x is string => !!x));
  for (const c of chains) {
    const p = next.chains[c] ?? { runs: 0, aiNew: 0, alreadyKnown: 0, costJpy: 0, barrenStreak: 0, lastRunAt: at };
    const mine = r.leads.filter((l) => l.lead.chain === c);
    const aiNew = mine.filter((l) => l.decision.credit === "ai_new").length;
    next.chains[c] = { runs: p.runs + 1, aiNew: p.aiNew + aiNew, alreadyKnown: p.alreadyKnown + mine.filter((l) => l.decision.credit === "already_known").length, costJpy: Math.round((p.costJpy + r.usage.costJpy / chains.size) * 100) / 100, barrenStreak: aiNew > 0 ? 0 : p.barrenStreak + 1, lastRunAt: at };
  }
  for (const s of r.sources) {
    const p = next.hosts[s.host] ?? { fetches: 0, failures: 0, aiNewLeads: 0 };
    next.hosts[s.host] = { ...p, fetches: p.fetches + 1, failures: p.failures + (s.ok ? 0 : 1) };
  }
  // ミッション単位の履歴: 次に選べる時刻（AIが決めた再調査までの時間）を記録する
  const hours = r.revisitHours ?? defaultRevisitHours(r);
  const nowMs = Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now();
  const atIso = new Date(nowMs).toISOString();
  const prevM = mem.missions?.[r.missionId];
  const missions = { ...(mem.missions ?? {}) };
  missions[r.missionId] = { runs: (prevM?.runs ?? 0) + 1, lastRunAt: atIso, nextEligibleAt: new Date(nowMs + hours * HOUR).toISOString(), lastAdopt: r.counts?.adopt ?? 0, lastHold: r.counts?.hold ?? 0, by: r.revisitHours != null ? "ai" : "default" };
  // 古い履歴は整理する（30日より前の実行・件数の上限）
  for (const [k, v] of Object.entries(missions)) if (nowMs - Date.parse(v.lastRunAt) > 30 * 86_400_000) delete missions[k];
  next.missions = missions;
  // 待ち行列: 実行済みのミッションを除き、AIの提案と保留中の手がかり（根拠が足りず保留したもの）を加える。期限切れ・上限超過は捨てる
  let frontier = (mem.frontier ?? []).filter((f) => f.id !== r.missionId && nowMs - Date.parse(f.addedAt) <= FRONTIER_TTL_MS);
  const add = (n: NextMission, source: FrontierItem["source"]) => {
    const id = missionIdOfNext(n);
    if (id === r.missionId || frontier.some((f) => f.id === id)) return;
    const done = next.missions?.[id];
    if (done && Date.parse(done.nextEligibleAt) > nowMs) return;
    frontier.push({ id, next: n, source, addedAt: atIso });
  };
  for (const n of r.nextMissions ?? []) add(n, "ai");
  for (const l of r.leads) if (l.decision.status === "hold" && l.lead.chain) add({ kind: "lead", chain: l.lead.chain, store: l.lead.store, product: l.lead.products[0], url: l.lead.url, reason: `保留: ${l.decision.reason}`.slice(0, 200) }, "hold");
  frontier = frontier.slice(-FRONTIER_MAX);
  next.frontier = frontier;
  for (const l of r.leads) {
    if (l.decision.credit !== "ai_new") continue;
    try {
      const h = new URL(l.lead.url).hostname.toLowerCase().replace(/^www\./, "");
      const p = next.hosts[h] ?? { fetches: 0, failures: 0, aiNewLeads: 0 };
      next.hosts[h] = { ...p, aiNewLeads: p.aiNewLeads + 1 };
    } catch {
      /* URLが不正なら数えない */
    }
  }
  return next;
}

/** 次の調査のための参考情報（事実の確定ではない。AIは採用してもしなくてもよい） */
export function strategyHints(mem: StrategyMemory, chain?: string): string[] {
  const out: string[] = [];
  const c = chain ? mem.chains[chain] : undefined;
  if (c) out.push(`過去の探索: ${c.runs}回・新規発見${c.aiNew}件・既存と重複${c.alreadyKnown}件${c.barrenStreak >= 2 ? `・直近${c.barrenStreak}回は新規なし（未確認であり、開催なしの意味ではありません）` : ""}`);
  const weak = Object.entries(mem.hosts).filter(([, h]) => h.fetches >= 2 && h.failures / h.fetches >= 0.6).map(([h]) => h);
  if (weak.length) out.push(`取得に失敗しやすい情報源: ${weak.slice(0, 5).join("・")}（回避せず、別の情報源を探す）`);
  const good = Object.entries(mem.hosts).filter(([, h]) => h.aiNewLeads >= 1).sort((a, b) => b[1].aiNewLeads - a[1].aiNewLeads).slice(0, 3).map(([h]) => h);
  if (good.length) out.push(`過去に新規の抽選が見つかった情報源: ${good.join("・")}`);
  return out;
}

// ---------------------------------------------------------------- ミッション
export interface MissionSources {
  today: string;
  targetPrefectures: string[];
  /** 近く発売される商品（発売日つき） */
  releases?: { name: string; releaseDate: string }[];
  /** 最近登録・収集された抽選（起点になる） */
  recentLotteries?: { chain: string; store: string; product: string; sourceUrl?: string }[];
  /** 抽選がまだ見つかっていない系列（店舗数つき） */
  idleChains?: { name: string; storeCount: number }[];
  memory?: StrategyMemory;
  maxMissions?: number;
  /** 現在時刻（ミリ秒）。再調査までの時間・待ち行列の期限の判定に使う（省略時は today の0時） */
  nowMs?: number;
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** ミッションを作り、価値（緊急度・系列の大きさ・過去の収穫）の順に並べる。AIに調べる店舗・検索語を指示しない */
export function buildMissions(s: MissionSources): DiscoveryMission[] {
  const mem = s.memory ?? emptyStrategy();
  const base = { targetPrefectures: s.targetPrefectures, today: s.today };
  const scored: { m: DiscoveryMission; score: number }[] = [];
  for (const r of s.releases ?? []) {
    const d = daysBetween(s.today, r.releaseDate);
    if (d < -7 || d > 21) continue;
    scored.push({ m: { id: `product:${r.name}`, trigger: { kind: "product", product: r.name }, context: [`発売日: ${r.releaseDate}`], ...base }, score: 100 - Math.abs(d) });
  }
  const seenChain = new Set<string>();
  for (const l of s.recentLotteries ?? []) {
    const key = `${l.chain}|${l.product}`;
    if (seenChain.has(key)) continue;
    seenChain.add(key);
    const c = mem.chains[l.chain];
    scored.push({ m: { id: `lottery:${key}`, trigger: { kind: "lottery", chain: l.chain, store: l.store, product: l.product, sourceUrl: l.sourceUrl }, context: strategyHints(mem, l.chain), ...base }, score: 60 - (c?.barrenStreak ?? 0) * 8 + (c?.aiNew ?? 0) * 2 });
  }
  for (const c of s.idleChains ?? []) scored.push({ m: { id: `chain:${c.name}`, trigger: { kind: "chain", chain: c.name }, context: [...strategyHints(mem, c.name), `登録済みの店舗: ${c.storeCount}件`], ...base }, score: 20 + Math.min(c.storeCount, 30) / 3 - (mem.chains[c.name]?.barrenStreak ?? 0) * 6 });
  // 待ち行列（AIの提案・保留中の手がかりの確認）。固定の巡回ではなく、AIが見つけた次の対象を優先して調べる
  for (const f of mem.frontier ?? []) {
    const n = f.next;
    const id = f.id;
    const reason = n.reason ? `${f.source === "hold" ? "前回の保留の確認" : "前回の調査でAIが提案"}: ${n.reason}` : "";
    const trigger: DiscoveryMission["trigger"] = n.kind === "product" ? { kind: "product", product: n.product } : n.kind === "chain" ? { kind: "chain", chain: n.chain } : { kind: "lead", chain: n.chain, store: n.store, product: n.product, sourceUrl: n.url };
    scored.push({ m: { id, trigger, context: [reason, ...strategyHints(mem, n.chain)].filter(Boolean), ...base }, score: f.source === "ai" ? 90 : 80 });
  }
  // 再調査までの時間（AIが決めた、または既定）がまだ経っていないミッションは選ばない。同じ対象を成果なく繰り返し調べて、他の対象に広がらなくなるのを防ぐ
  const nowMs = s.nowMs ?? Date.parse(`${s.today}T00:00:00+09:00`);
  const eligible = scored.filter((x) => {
    const m = mem.missions?.[x.m.id];
    return !m || Date.parse(m.nextEligibleAt) <= nowMs;
  });
  const seen = new Set<string>();
  return eligible
    .sort((a, b) => b.score - a.score)
    .filter((x) => (seen.has(x.m.id) ? false : (seen.add(x.m.id), true)))
    .slice(0, s.maxMissions ?? SESSION_CAPS.maxMissions)
    .map((x) => x.m);
}

// ---------------------------------------------------------------- セッション
export interface SessionInput {
  missions: DiscoveryMission[];
  world: DiscoveryWorld;
  llmFor: (m: DiscoveryMission) => AgentLLM;
  memory?: StrategyMemory;
  real?: boolean;
  /** 実AI・実検索のとき必須: 費用の台帳（記録できないなら有料の実行は始めない） */
  costRecorder?: { record(missionId: string, costJpy: number): void };
  sessionCapJpy?: number;
  /** 割り当ての調整（上限を下げる用途だけ。絶対上限 DISCOVERY_CAPS は超えられない＝呼び出し側が下げた値だけを返す） */
  adjustBudget?: (m: DiscoveryMission, b: MissionBudget) => MissionBudget;
  /** ミッション開始前の呼び出し（費用の台帳の案件開始など） */
  beforeMission?: (m: DiscoveryMission) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface SessionResult {
  records: DiscoveryRunRecord[];
  memory: StrategyMemory;
  skipped: { missionId: string; reason: string }[];
  totalCostJpy: number;
}

export async function runDiscoverySession(s: SessionInput): Promise<SessionResult> {
  let memory = s.memory ?? emptyStrategy();
  const cap = Math.min(s.sessionCapJpy ?? SESSION_CAPS.maxCostJpy, SESSION_CAPS.maxCostJpy);
  const records: DiscoveryRunRecord[] = [];
  const skipped: SessionResult["skipped"] = [];
  let total = 0;
  const list = s.missions.slice(0, SESSION_CAPS.maxMissions);
  for (const m of s.missions.slice(SESSION_CAPS.maxMissions)) skipped.push({ missionId: m.id, reason: "1回の実行のミッション数の上限" });
  for (const m of list) {
    if (s.real && !s.costRecorder) {
      skipped.push({ missionId: m.id, reason: "費用を記録できないため、有料の実行は開始しません" });
      continue;
    }
    if (s.real && total >= cap) {
      skipped.push({ missionId: m.id, reason: "全体の費用の上限に達したため開始しません" });
      continue;
    }
    s.beforeMission?.(m);
    const b0 = allocateMission(m, { real: s.real });
    const rec = await runDiscovery({ mission: m, world: s.world, llm: s.llmFor(m), budget: s.adjustBudget ? lowerOnly(b0, s.adjustBudget(m, b0)) : b0, real: s.real, now: s.now, sleep: s.sleep });
    total += rec.usage.costJpy;
    s.costRecorder?.record(m.id, rec.usage.costJpy);
    records.push(rec);
    memory = updateStrategy(memory, rec, new Date((s.now ?? Date.now)()).toISOString());
  }
  return { records, memory, skipped, totalCostJpy: Math.round(total * 100) / 100 };
}

/** 調整後の割り当ては、元の割り当てより大きくならない（上限を引き上げる手段にしない） */
function lowerOnly(a: MissionBudget, b: MissionBudget): MissionBudget {
  const l = a.limits;
  const m = b.limits;
  return { ...a, limits: { ...l, maxSteps: Math.min(l.maxSteps, m.maxSteps), maxSearches: Math.min(l.maxSearches, m.maxSearches), maxFetches: Math.min(l.maxFetches, m.maxFetches), maxCostJpy: Math.min(l.maxCostJpy, m.maxCostJpy), maxMs: Math.min(l.maxMs, m.maxMs) }, rationale: b.rationale };
}
