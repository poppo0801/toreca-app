import "server-only";
import { backoffHosts, resolveControls, type ControlsDecision, type DailyUsage } from "@/lib/agent/collection-planner/controls";
import { mergeOutcomes, type SourceOutcome } from "@/lib/agent/collection-planner/evaluate";
import type { InvestigationRecord } from "@/lib/agent/collection-planner/executor";
import type { Json } from "@/types/database";
import { autoCompleteLottery } from "@/lib/server/collector/complete";
import { saveLottery, type Db } from "@/lib/server/lottery-service";
import type { LotteryInput } from "@/lib/lottery-input";
import { jstToday } from "@/lib/ai/extraction";

/**
 * 調査の記録・日次の使用量・開発環境での自動適用（Stage 9D）。
 * 書き込み先は、調査の記録（agent_*）と、開発環境での「監視候補の自動追加」「新規抽選の自動登録」「既存抽選の補完」のみ。
 * 自動適用は `TOREMANE_ENV=local`（開発環境）だけ。本番では呼び出し側（アクション）が拒否する。応募・当選・購入の記録は変更しない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い（開発DBのみのマイグレーション103）
const anyDb = (db: Db) => db as any;
const jstDayStart = (now: Date): string => `${jstToday(now)}T00:00:00+09:00`;

export async function loadDailyUsage(db: Db, householdId: string, now: Date): Promise<DailyUsage> {
  const since = jstDayStart(now);
  const day = jstToday(now);
  const [runs, settings, stats] = await Promise.all([
    anyDb(db).from("agent_investigation_runs").select("usage").eq("household_id", householdId).gte("started_at", since).limit(200),
    db.from("collection_settings").select("worker_daily_ai_limit,worker_limit_override,worker_limit_override_date").eq("household_id", householdId).limit(1).maybeSingle(),
    db.from("collection_daily_stats").select("ai_calls").eq("household_id", householdId).eq("day", day).maybeSingle(),
  ]);
  const rows = (runs.data ?? []) as { usage: { costJpy?: number; analyses?: number } | null }[];
  const s = settings.data as { worker_daily_ai_limit: number; worker_limit_override: number | null; worker_limit_override_date: string | null } | null;
  // 既存の「1日の解析上限」と「一時的な引き上げ」（当日だけ有効）を、そのまま読む（変更しない）
  const limit = s ? (s.worker_limit_override != null && s.worker_limit_override_date === day ? s.worker_limit_override : s.worker_daily_ai_limit) : 30;
  return {
    runsToday: rows.length,
    costTodayJpy: rows.reduce((a, r) => a + Number(r.usage?.costJpy ?? 0), 0),
    workerDailyAiLimit: limit,
    aiCallsToday: Number(stats.data?.ai_calls ?? 0) + rows.reduce((a, r) => a + Number(r.usage?.analyses ?? 0), 0),
  };
}

/** 過去の調査の成果（情報源ごとの累計）と、しばらく避ける情報源 */
export async function loadHistory(db: Db, householdId: string, now: Date): Promise<{ previous: ReturnType<typeof mergeOutcomes>; blocked: string[] }> {
  const { data } = await anyDb(db).from("agent_investigation_runs").select("evaluation,started_at").eq("household_id", householdId).order("started_at", { ascending: false }).limit(20);
  const runs = (data ?? []) as { evaluation: { sources?: SourceOutcome[] } | null; started_at: string }[];
  const previous = mergeOutcomes(runs.map((r) => r.evaluation?.sources ?? []));
  const lastFail = new Map<string, string>();
  for (const r of runs) for (const s of r.evaluation?.sources ?? []) if (s.failures > 0 && !lastFail.has(s.host)) lastFail.set(s.host, r.started_at);
  const blocked = backoffHosts(previous.map((p) => ({ host: p.host, failures: p.failures, lastFailKind: p.lastFailKind, lastFailAt: lastFail.get(p.host) })), now);
  return { previous, blocked };
}

export async function decideControls(db: Db, householdId: string, now: Date, o: { mode: "dry_run" | "execute"; realApi: boolean }): Promise<ControlsDecision & { blocked: string[]; previous: ReturnType<typeof mergeOutcomes> }> {
  const [usage, hist] = await Promise.all([loadDailyUsage(db, householdId, now), loadHistory(db, householdId, now)]);
  return { ...resolveControls(usage, { ...o, blockedHosts: hist.blocked }), blocked: hist.blocked, previous: hist.previous };
}

const compact = (r: InvestigationRecord) => ({
  tasks: r.review?.accepted.tasks ?? [],
  findings: r.review?.accepted.findings ?? [],
  rejected: r.review?.rejected ?? [],
  previews: r.previews,
  monitorEvals: r.monitorEvals.map((e) => ({ ...e, evidence: e.evidence.slice(0, 6) })),
  pages: r.pages,
  stops: r.stops,
  injectionFlags: r.injectionFlags,
  // 行動を決めたのは誰か・理由（Stage 9E）／AIの判断と固定ロジックの照合／検証の指摘による追加調査の回数
  decisions: r.steps.map((s) => ({ seq: s.seq, by: s.decidedBy ?? null, why: s.rationale ?? null })),
  agreement: r.agreement,
  followUps: r.followUps,
});

/** 調査の記録を保存する（実行中の記録を作る → 完了時に更新）。ページ全文・個人情報・認証情報は保存しない */
export async function startRun(db: Db, householdId: string, o: { mode: "dry_run" | "execute"; brain: string }): Promise<string | null> {
  const { data, error } = await anyDb(db).from("agent_investigation_runs").insert({ household_id: householdId, mode: o.mode, brain: o.brain, status: "running" }).select("id").single();
  return error ? null : (data as { id: string }).id;
}

export async function finishRun(db: Db, householdId: string, runId: string, r: InvestigationRecord, extra: { applied?: unknown } = {}): Promise<void> {
  const analyses = r.steps.filter((s) => s.tool === "analyze_page_for_lottery" && s.ok).length;
  await anyDb(db)
    .from("agent_investigation_runs")
    .update({
      status: r.status === "failed" ? "failed" : r.status === "limit_reached" ? "limit_reached" : "completed",
      stop_reason: r.stopReason.slice(0, 300),
      finished_at: new Date().toISOString(),
      usage: { ...r.usage, analyses, totalMs: r.totalMs, costJpy: r.usage.costJpy } as unknown as Json,
      result: { ...compact(r), applied: extra.applied ?? null } as unknown as Json,
      evaluation: r.evaluation as unknown as Json,
      summary: r.summary.slice(0, 600),
    })
    .eq("id", runId);
  if (r.steps.length > 0)
    await anyDb(db).from("agent_investigation_steps").insert(
      r.steps.map((s) => ({ run_id: runId, household_id: householdId, seq: s.seq, tool: s.tool, purpose: s.purpose, target: s.target, ok: s.ok, ms: s.ms, cost_jpy: s.costJpy, result_summary: s.resultSummary, found: s.found as unknown as Json, next_info: s.nextInfo })),
    );
}

export async function failRun(db: Db, runId: string, message: string): Promise<void> {
  await anyDb(db).from("agent_investigation_runs").update({ status: "failed", stop_reason: message.slice(0, 300), finished_at: new Date().toISOString() }).eq("id", runId);
}

export interface AppliedSummary {
  monitorAdded: number;
  monitorCandidates: number;
  registered: { lotteryId: string; url: string }[];
  completed: { lotteryId: string; filled: string[] }[];
  skipped: { url: string; reason: string }[];
}

/** 監視候補を保存し、安全に検証できた情報源（公式性=確認済み・関連性=高・取得可能・Web）だけを、開発環境で自動監視に追加する。本番の監視対象は変更しない */
export async function saveMonitorCandidates(db: Db, householdId: string, runId: string, r: InvestigationRecord, o: { autoAdd: boolean }): Promise<{ added: number; saved: number }> {
  let added = 0;
  let saved = 0;
  for (const e of r.monitorEvals) {
    if (e.recommend === "reject") continue;
    const status = e.recommend === "auto_add" && o.autoAdd && e.kind === "web" ? "auto_added" : "candidate";
    let sourceId: string | null = null;
    if (status === "auto_added") {
      const ins = await db.from("collection_sources").insert({ household_id: householdId, kind: "web", name: e.name.slice(0, 80) || e.url, url: e.url, adapter: "generic", enabled: true, interval_hours: 24 }).select("id").single();
      if (ins.error) {
        // すでに同じ情報源がある（一意制約）ときは追加せず、候補として残す
        if (ins.error.code !== "23505") continue;
      } else sourceId = (ins.data as { id: string }).id;
    }
    const row = { household_id: householdId, run_id: runId, kind: e.kind, name: e.name.slice(0, 80) || e.url, url: e.url, chain_id: e.chainId, official: e.official, relevance: e.relevance, fetchable: e.fetchable, evidence: e.evidence.slice(0, 6) as unknown as Json, status: sourceId ? "auto_added" : "candidate", added_source_id: sourceId, updated_at: new Date().toISOString() };
    // 同じURLの候補があれば更新する（一意性は小文字化したURLの索引。人が不採用/承認した状態は上書きしない）
    let up = await anyDb(db).from("agent_monitor_candidates").insert(row);
    if (up.error?.code === "23505") {
      const { status: _s, added_source_id: _a, ...rest } = row;
      void _s;
      void _a;
      up = await anyDb(db).from("agent_monitor_candidates").update({ ...rest, ...(sourceId ? { status: "auto_added", added_source_id: sourceId } : {}) }).eq("household_id", householdId).ilike("url", e.url).neq("status", "rejected");
    }
    if (!up.error) {
      saved += 1;
      if (sourceId) added += 1;
    }
  }
  return { added, saved };
}

/**
 * 開発環境の自動適用（execute モード）。
 *   新規（new）かつ安全条件（系列・店舗/店舗選択式・商品がマスターと確実に一致・重複なし）を満たすもの → 自動登録（注意付き。日時が不明でも登録し、続報で補う）
 *   補完（complete）→ 既存の自動補完（手動編集・手動登録の抽選は更新しない）
 *   重複・追加調査・更新（update）→ 何も変更しない（新規カードを作らない／人の確認）
 */
export async function applyPreviews(db: Db, householdId: string, r: InvestigationRecord, drafts: Map<string, LotteryInput>, o: { actor: string | null; now: Date; officialUrls: Set<string>; /** 定期実行など、ログインなし（service_role）からの登録 */ asService?: boolean }): Promise<Pick<AppliedSummary, "registered" | "completed" | "skipped">> {
  const out: Pick<AppliedSummary, "registered" | "completed" | "skipped"> = { registered: [], completed: [], skipped: [] };
  const nowIso = o.now.toISOString();
  // 同じ調査の中で同じ抽選を複数のページから解析した場合（公式の告知→追跡した応募ページ）は、情報が多い方だけを適用する（二重登録しない）
  const key = (p: InvestigationRecord["previews"][number]) => `${p.chainName}|${p.storeName}|${[...p.products].sort().join(",")}|${p.disposition.targetLotteryId ?? ""}`;
  const handled = new Set<string>();
  // 情報が多い順。同じなら、あとで解析したページ（追跡した詳細ページ）を優先する
  const ordered = r.previews.map((p, i) => ({ p, i })).sort((a, b) => a.p.missing.length - b.p.missing.length || b.i - a.i).map((x) => x.p);
  for (const p of ordered) {
    const k = key(p);
    if (p.recognized && handled.has(k)) {
      out.skipped.push({ url: p.url, reason: "同じ調査で、より情報の多い解析を適用済みのため見送りました" });
      continue;
    }
    handled.add(k);
    const input = drafts.get(p.url);
    if (!input) {
      out.skipped.push({ url: p.url, reason: "解析の下書きがありません" });
      continue;
    }
    if (p.disposition.kind === "new" && p.registrable) {
      const saved = await saveLottery(db, householdId, null, { ...input, sourceUrls: [p.url] }, o.actor, { autoCollected: true, asService: o.asService });
      if (!saved.ok) {
        out.skipped.push({ url: p.url, reason: `登録できませんでした: ${saved.error}` });
        continue;
      }
      const cautions = [
        { code: "agent_registered", field: "other", message: "調査エージェントが登録しました（内容を確認してください）", at: nowIso },
        ...(p.applyDeadline ? [] : [{ code: "deadline_unknown", field: "applyDeadline", message: "応募締切が確認できていません（続報で自動的に補います）", at: nowIso }]),
      ];
      await db.from("lotteries").update({ source_kind: "auto", is_new: true, registration_path: "auto", cautions: cautions as unknown as Json, confidence: "partial", cautions_updated_at: nowIso }).eq("id", saved.value.id);
      out.registered.push({ lotteryId: saved.value.id, url: p.url });
    } else if (p.disposition.kind === "complete" && p.disposition.targetLotteryId) {
      let official = false;
      try {
        official = o.officialUrls.has(new URL(p.url).hostname.replace(/^www\./, ""));
      } catch {
        official = false;
      }
      const c = await autoCompleteLottery(db, p.disposition.targetLotteryId, input, { official, now: o.now });
      if (c.updated) out.completed.push({ lotteryId: p.disposition.targetLotteryId, filled: c.filled });
      else out.skipped.push({ url: p.url, reason: c.skipped === "manual_edit" ? "手動で編集された抽選のため補完しません" : c.skipped === "not_auto" ? "自動登録ではない抽選のため補完しません" : "補完できる項目がありません" });
    } else out.skipped.push({ url: p.url, reason: `${p.disposition.kind === "duplicate" ? "重複のため新規カードは作りません" : p.disposition.kind === "update" ? "内容の変更は人の確認が必要です" : p.disposition.kind === "investigate" ? "追加調査・続報待ちです" : "登録の安全条件を満たしません"}${p.blockers.length ? `（${p.blockers.slice(0, 2).join("・")}）` : ""}` });
  }
  return out;
}
