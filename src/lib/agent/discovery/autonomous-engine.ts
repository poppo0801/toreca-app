/**
 * 自律型AI主体の収集エンジン（CollectionEngine の実装。Stage 9H-3P）。共通の候補（EngineCandidate）を返すだけで、登録・保存はしない。
 * 世界（DiscoveryWorld）・頭脳（AgentLLM）・ミッションの材料は呼び出し側が渡す（開発環境の接続は9H-3Qで設定画面と結ぶ）。
 */
import type { AgentLLM } from "@/lib/agent/core";
import { candidatesFromRecord, ENGINE_LABEL, type CollectionEngine } from "@/lib/collector/engine-contract";
import { buildMissions, runDiscoverySession, type MissionSources, type StrategyMemory } from "./session";
import type { DiscoveryMission, DiscoveryWorld } from "./types";

export interface AutonomousEngineDeps {
  world: DiscoveryWorld;
  llmFor: (m: DiscoveryMission) => AgentLLM;
  /** ミッションの材料（近く発売の商品・最近の抽選・抽選のない系列）。today・targetPrefectures は実行時の入力で補う */
  sources: () => Promise<Omit<MissionSources, "today" | "targetPrefectures">>;
  loadMemory?: () => Promise<StrategyMemory | undefined>;
  saveMemory?: (m: StrategyMemory) => Promise<void>;
  real?: boolean;
  costRecorder?: { record(missionId: string, costJpy: number): void };
}

export function createAutonomousEngine(d: AutonomousEngineDeps): CollectionEngine {
  return {
    id: "autonomous",
    label: ENGINE_LABEL.autonomous,
    async run(input) {
      const memory = await d.loadMemory?.();
      const missions = buildMissions({ ...(await d.sources()), today: input.today, targetPrefectures: input.targetPrefectures, memory });
      const res = await runDiscoverySession({ missions, world: d.world, llmFor: d.llmFor, memory, real: d.real, costRecorder: d.costRecorder });
      await d.saveMemory?.(res.memory);
      return { candidates: res.records.flatMap(candidatesFromRecord), records: res.records };
    },
  };
}
