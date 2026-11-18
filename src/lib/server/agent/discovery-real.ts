import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentLLM } from "@/lib/agent/core";
import { AnthropicWebSearch } from "@/lib/agent/anthropic";
import { RealRunGuard, type LedgerState } from "@/lib/agent/collection-planner/real-guard";
import { createDiscoveryBrain } from "@/lib/agent/discovery/real-brain";
import { checkRealApi } from "@/lib/agent/real-gate";
import { DEFAULT_AI_MODEL } from "@/lib/ai-cost";
import type { PageFetcher, SearchProvider } from "@/lib/agent/store-location/tools";

/**
 * 自律探索の実AI・実検索の接続（Stage 9H-3Q・開発専用）。**実API（有料）。関門を通ったときだけ生成される。**
 *   関門: 開発環境・AGENT_REAL_API=allow・開発専用キー・費用上限・実行前の確認（real-gate.ts）に加え、
 *         COLLECT_AUTONOMOUS_CONFIRM=yes と、累計の上限 COLLECT_AUTONOMOUS_CAP_JPY（円）が必要。
 *   費用: 費用の台帳（RealRunGuard）に、AIのトークン料金と検索料金を記録し、呼び出しの前に上限を確認する。台帳を保存できなければ実行しない。
 * 本番のAPIキーは使わない。関門を通らなければ ok=false（理由つき）を返し、実AIには接続しない。キー・認証情報は理由に含めない。
 * このステージでは、この部品を使った有料の実地検証は行っていない（9H-3Rの導入前に、少額の予算で確認する）。
 */
export const PER_MISSION_DEFAULT_JPY = 8;

export type RealDiscoveryDeps = { ok: true; guard: RealRunGuard; llmFor: () => AgentLLM; search: SearchProvider; perMissionJpy: number; ledgerFile: string } | { ok: false; reason: string };

/**
 * 本番（Vercel）での接続。開発環境の関門（real-gate.ts）とは別に、明示的な許可（AUTONOMOUS_COLLECTION=on）と、DBに記録された費用から決めた「今日・今月の残り予算」を使う。
 *   キー: AUTONOMOUS_ANTHROPIC_API_KEY（あれば）、なければ既存の ANTHROPIC_API_KEY（既存のAI解析と同じ契約・追加契約なし）
 *   予算: 呼び出し側（autonomous-hook）が、DBの実行履歴（discovery_runs.cost_jpy）から日次・月次の上限の残りを計算して渡す。残りが1件の上限に満たなければ開始しない
 *   台帳: Vercelではファイルに書けないため、費用の記録は調査履歴（DB）に残す（実行の前後で更新。失敗・途中終了でも消費分を記録する）
 */
function prodDeps(o: { env: Record<string, string | undefined>; clientFactory?: (apiKey: string) => unknown; budgetRemainingJpy?: number }): RealDiscoveryDeps {
  const e = o.env;
  if (e.AUTONOMOUS_COLLECTION !== "on") return { ok: false, reason: "本番での自律型AI主体が有効になっていません（AUTONOMOUS_COLLECTION=on が必要）" };
  const key = (e.AUTONOMOUS_ANTHROPIC_API_KEY ?? e.ANTHROPIC_API_KEY)?.trim();
  if (!key) return { ok: false, reason: "AIのAPIキーが設定されていません" };
  const perMission = Number(e.COLLECT_AUTONOMOUS_PER_MISSION_JPY) > 0 ? Number(e.COLLECT_AUTONOMOUS_PER_MISSION_JPY) : PER_MISSION_DEFAULT_JPY;
  const remaining = o.budgetRemainingJpy;
  if (remaining === undefined) return { ok: false, reason: "今日・今月の残り予算を確認できないため、有料の実行は開始しません" };
  if (remaining < perMission) return { ok: false, reason: `今日または今月の費用の上限に達しているため開始しません（残り ${remaining.toFixed(1)}円）` };
  const model = e.AUTONOMOUS_MODEL?.trim() || DEFAULT_AI_MODEL;
  const guard = new RealRunGuard({ capJpy: remaining, perCaseJpy: perMission, model, spentBefore: 0 });
  const raw = (o.clientFactory ? o.clientFactory(key) : new Anthropic({ apiKey: key, maxRetries: 0, timeout: 60_000 })) as Anthropic;
  return { ok: true, guard, llmFor: () => createDiscoveryBrain(guard.wrapClient(raw, "agent"), model), search: new AnthropicWebSearch(raw, model), perMissionJpy: perMission, ledgerFile: "(db)" };
}

export function realDiscoveryDeps(o: { env: Record<string, string | undefined>; clientFactory?: (apiKey: string) => unknown; ledgerDir?: string; fetcher?: PageFetcher; /** 本番: 今日・今月の残り予算（円） */ budgetRemainingJpy?: number }): RealDiscoveryDeps {
  const e = o.env;
  if (e.TOREMANE_ENV !== "local") return prodDeps(o);
  const cap = Number(e.COLLECT_AUTONOMOUS_CAP_JPY);
  if (!(cap > 0)) return { ok: false, reason: "実AIの累計上限（COLLECT_AUTONOMOUS_CAP_JPY）が未設定です" };
  const g = checkRealApi({ env: e, confirm: e.COLLECT_AUTONOMOUS_CONFIRM === "yes", runsToday: 0 });
  if (!g.ok) return { ok: false, reason: g.reason };
  const perMission = Number(e.COLLECT_AUTONOMOUS_PER_MISSION_JPY) > 0 ? Number(e.COLLECT_AUTONOMOUS_PER_MISSION_JPY) : PER_MISSION_DEFAULT_JPY;
  const dir = o.ledgerDir ?? join(process.cwd(), "backups", "autonomous-ledger");
  const file = join(dir, "ledger.json");
  let prior: LedgerState | null = null;
  try {
    prior = JSON.parse(readFileSync(file, "utf8")) as LedgerState;
  } catch {
    prior = null;
  }
  // 台帳を書き込めないなら、費用を記録できないため有料の実行を始めない
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".write-check"), "ok");
  } catch {
    return { ok: false, reason: "費用の台帳を保存できないため、有料の実行は開始しません" };
  }
  const guard = new RealRunGuard({
    capJpy: cap,
    perCaseJpy: perMission,
    model: g.model,
    spentBefore: prior?.spentJpy ?? 0,
    persist: (s) => writeFileSync(file, JSON.stringify({ ...s, entries: [...(prior?.entries ?? []), ...s.entries] }, null, 1)),
  });
  const raw = (o.clientFactory ? o.clientFactory(g.apiKey) : new Anthropic({ apiKey: g.apiKey, maxRetries: 0, timeout: 60_000 })) as Anthropic;
  return { ok: true, guard, llmFor: () => createDiscoveryBrain(guard.wrapClient(raw, "agent"), g.model), search: new AnthropicWebSearch(raw, g.model), perMissionJpy: perMission, ledgerFile: file };
}
