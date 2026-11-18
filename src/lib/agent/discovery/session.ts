/**
 * 自律探索のミッション作成・セッション実行・探索実績の保存（Stage 9H-3P）。
 *   - ミッションは「何を調べるか」の入口だけ（商品・見つかった抽選・系列）。店舗名・検索語・順序は決めない（それはAIが選ぶ）
 *   - セッションは、複数ミッションを費用・件数の上限の中で実行する。費用を記録できないなら、有料の実行は始めない
 *   - 探索実績（StrategyMemory）は再利用しやすい plain JSON。AIが自分の実績を分析して調査戦略を改善するための材料（既存ロジック・手動登録が先に見つけたものは数えない）
 */
import type { AgentLLM } from "@/lib/agent/core";
import { allocateMission, SESSION_CAPS, type MissionBudget } from "./controls";
import { runDiscovery, type DiscoveryRunRecord } from "./engine";
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
export interface StrategyMemory {
  version: 1;
  chains: Record<string, ChainStrategy>;
  hosts: Record<string, HostStrategy>;
}
export const emptyStrategy = (): StrategyMemory => ({ version: 1, chains: {}, hosts: {} });

export function updateStrategy(mem: StrategyMemory, r: DiscoveryRunRecord, at: string): StrategyMemory {
  const next: StrategyMemory = { version: 1, chains: { ...mem.chains }, hosts: { ...mem.hosts } };
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
  return scored.sort((a, b) => b.score - a.score).slice(0, s.maxMissions ?? SESSION_CAPS.maxMissions).map((x) => x.m);
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
