import "server-only";
import { judge, isXCandidate, type CandidateLite, type Judgement, type ReevalClass, type StoredDraft } from "@/lib/collector/reevaluate";
import { isReady } from "@/lib/collector/ready";
import { rebuildQueued } from "@/lib/collector/queued";
import { aiAllowance, conditionsFromRow, processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { monthBudget } from "@/lib/server/ai-budget";
import { loadAppData, saveLottery, type Db } from "@/lib/server/lottery-service";
import type { Json } from "@/types/database";

/**
 * 確認待ち候補の再評価の実行（Stage 4C 追加）。判定は src/lib/collector/reevaluate.ts（純関数）。
 *  - 無料の見直し（保存済みの解析結果を現在のマスター・収集条件で照合し直す）→ AI/X が必要な候補だけ、件数と予算の上限内で再解析 → もう一度見直し
 *  - 変更するのは候補の行（status/job_state/reasons/draft）と、条件を満たした候補の新規登録だけ。既存の抽選・応募・当落・購入は変更しない。
 *  - 候補は物理削除しない。変更前の状態は draft.reeval.before に記録し、restoreReevaluation で復元できる。
 */
export const REEVAL_VERSION = "2026-11-04";

export interface ReevalMarker {
  at: string;
  version: string;
  cls: ReevalClass;
  action: string;
  /** 解決の手段: rematch=マスター再照合 / ai=追加取得＋AI再解析 / rule=ルール（受付終了・対象外・重複） */
  via?: "rematch" | "ai" | "x_image" | "refetch" | "rule";
  /** 変更前の状態（復元用）。draft は変更前の解析結果 */
  before: { status: string; job_state: string; reasons: string[]; lottery_id: string | null; draft: unknown };
  registeredLotteryId?: string;
}

export interface ReevalOptions {
  /** false=判定のみ（DBを一切変更しない） */
  execute: boolean;
  /** AI/X を使う再解析の最大件数（0=使わない）。実際の件数は、既存のAI利用上限・月額予算でさらに制限される */
  aiMax: number;
  /** 対象を絞る（少数での安全性の検証用） */
  ids?: string[];
  /** 処理するクラス（既定はすべて） */
  classes?: ReevalClass[];
  budgetMs?: number;
}

export interface ReevalRow {
  id: string;
  cls: ReevalClass;
  action: string;
  outcome: "registered" | "duplicate" | "excluded_past" | "excluded_offtarget" | "review" | "failed" | "requeued";
  via?: ReevalMarker["via"];
  reason: string;
  deadline: string;
  x?: { source: boolean; imageStatus: string };
}

export interface ReevalReport {
  ok: true;
  execute: boolean;
  before: { review: number };
  after: { review: number };
  counts: Record<string, number>;
  byClass: Record<string, number>;
  rows: ReevalRow[];
  ai: { requested: number; allowed: number; calls: number; stop: string | null; costJpyDelta: number | null };
  xCostNote: string;
}

const xImageStatus = (draft: StoredDraft | null): string => {
  const n = (draft?.notices ?? []).join(" ");
  if (!n) return "不明";
  if (/画像未取得/.test(n)) return "画像あり・未取得（本文のみで解析）";
  if (/添付画像\d+枚のうち/.test(n)) return "画像一部取得";
  if (/添付画像と|添付画像は/.test(n) && /解析できていません/.test(n)) return "画像なし（本文のみ）";
  if (/X API/.test(n)) return "X API";
  return "本文取得済み";
};

const toLite = (r: Record<string, unknown>): CandidateLite => r as unknown as CandidateLite;

async function loadReview(db: Db, householdId: string, ids?: string[]): Promise<CandidateLite[]> {
  let q = db.from("collection_candidates").select("id,status,job_state,kind,source_url,dedupe_key,x_post_id,title,reasons,due_at,lottery_id,draft").eq("household_id", householdId).eq("job_state", "review").eq("status", "pending").limit(1000);
  if (ids && ids.length > 0) q = q.in("id", ids);
  const { data } = await q;
  return (data ?? []).map(toLite);
}

const dueOf = (c: CandidateLite) => c.due_at ?? "9999";

export async function runReevaluation(deps: CollectDeps, opts: ReevalOptions): Promise<ReevalReport | { ok: false; message: string }> {
  const { db, householdId, now } = deps;
  const started = Date.now();
  const timeLeft = () => (opts.budgetMs ?? 54_000) - (Date.now() - started);
  const { data: settings } = await db.from("collection_settings").select("*").eq("household_id", householdId).maybeSingle();
  if (!settings) return { ok: false, message: "自動収集の設定がありません" };
  const cond = conditionsFromRow(settings as unknown as Record<string, unknown>);
  let data = await loadAppData(db, householdId);
  const list = await loadReview(db, householdId, opts.ids);
  const before = list.length;
  const rows = new Map<string, ReevalRow>();
  const markers = new Map<string, ReevalMarker>();
  const wantClass = (c: ReevalClass) => !opts.classes || opts.classes.includes(c);

  const budgetBefore = await monthBudget(db, householdId).catch(() => null);

  const judgeAll = (cands: CandidateLite[]) =>
    cands
      .map((c) => ({ c, j: judge(c, data, cond, now, isReady) }))
      .filter((x): x is { c: CandidateLite; j: Judgement } => x.j !== null && wantClass(x.j.cls))
      .sort((a, b) => a.j.priority - b.j.priority || dueOf(a.c).localeCompare(dueOf(b.c)));

  const mark = (c: CandidateLite, j: Judgement, via?: ReevalMarker["via"], extra: Partial<ReevalMarker> = {}): ReevalMarker => {
    const prev = markers.get(c.id);
    const { reeval: _old, ...origDraft } = ((c.draft as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    void _old;
    const m: ReevalMarker = prev ?? { at: now.toISOString(), version: REEVAL_VERSION, cls: j.cls, action: j.action, via, before: { status: c.status, job_state: c.job_state, reasons: c.reasons, lottery_id: c.lottery_id, draft: origDraft } };
    const out = { ...m, cls: j.cls, action: j.action, via: via ?? m.via, ...extra };
    markers.set(c.id, out);
    return out;
  };
  const note = (c: CandidateLite, j: Judgement, outcome: ReevalRow["outcome"], via?: ReevalMarker["via"]) =>
    rows.set(c.id, { id: c.id, cls: j.cls, action: j.action, outcome, via, reason: (j.reasons[0] ?? "").slice(0, 80), deadline: j.deadline, x: isXCandidate(c) ? { source: true, imageStatus: xImageStatus(c.draft as StoredDraft | null) } : undefined });

  /** 草稿の入力・照合結果を、再照合の結果で更新した形（記録用）。変更は候補の行だけ */
  const newDraft = (c: CandidateLite, j: Judgement, extra: Record<string, unknown>, m: ReevalMarker): Json => {
    const stored = c.draft as StoredDraft;
    return { ...stored, input: j.rematched.input, summary: j.rematched.summary, ...extra, reeval: m } as unknown as Json;
  };

  // ---- 1) 無料の見直し（AIなし）
  const pass = async (allowRequeue: boolean): Promise<{ requeue: { c: CandidateLite; j: Judgement }[] }> => {
    const requeue: { c: CandidateLite; j: Judgement }[] = [];
    for (const { c, j } of judgeAll(await loadReview(db, householdId, opts.ids))) {
      if (j.action === "requeue") {
        if (allowRequeue) requeue.push({ c, j });
        else note(c, j, "review");
        continue;
      }
      if (!opts.execute) {
        note(c, j, j.action === "register" ? "registered" : j.action === "duplicate" ? "duplicate" : j.action === "exclude" ? (j.cls === "E" ? "excluded_past" : "excluded_offtarget") : "review", j.action === "register" ? "rematch" : "rule");
        continue;
      }
      const nowIso = now.toISOString();
      if (j.action === "duplicate" && j.duplicateOf) {
        const m = mark(c, j, "rule");
        await db.from("collection_candidates").update({ status: "duplicate", job_state: "completed", lottery_id: j.duplicateOf.lotteryId, reasons: [...j.reasons, "確認待ち候補の再評価: 既存の抽選と同じ内容のため統合しました（既存の抽選は変更していません）"], draft: newDraft(c, j, {}, m), resolved_at: nowIso, completed_at: nowIso }).eq("id", c.id);
        note(c, j, "duplicate", "rule");
      } else if (j.action === "exclude") {
        const m = mark(c, j, "rule");
        await db.from("collection_candidates").update({ status: "excluded", job_state: "skipped", reasons: [...j.reasons, "確認待ち候補の再評価で除外（候補は残しています。除外一覧から戻せます）"], draft: newDraft(c, j, {}, m), resolved_at: nowIso, completed_at: nowIso }).eq("id", c.id);
        note(c, j, j.cls === "E" ? "excluded_past" : "excluded_offtarget", "rule");
      } else if (j.action === "register") {
        const stored = c.draft as StoredDraft;
        const input = { ...j.rematched.input, isManaged: false, applications: [], sourceUrls: [...new Set([...(j.rematched.input.sourceUrls ?? []), ...(c.source_url ? [c.source_url] : [])])].slice(0, 10) };
        const saved = await saveLottery(db, householdId, null, input, deps.actor, { asService: !deps.canRegister });
        if (!saved.ok) {
          const m = mark(c, j, "rematch");
          await db.from("collection_candidates").update({ reasons: [`再評価で登録を試みましたが失敗しました: ${saved.error}`], draft: newDraft(c, j, {}, m) }).eq("id", c.id);
          note(c, j, "failed", "rematch");
          continue;
        }
        await db.from("lotteries").update({ source_kind: "auto", is_new: true, registration_path: "auto" }).eq("id", saved.value.id);
        const via: ReevalMarker["via"] = markers.get(c.id)?.via ?? (j.cls === "B" ? "rematch" : "rule");
        const m = mark(c, j, via, { registeredLotteryId: saved.value.id });
        await db.from("collection_candidates").update({ status: "auto_registered", job_state: "completed", lottery_id: saved.value.id, reasons: [...j.reasons, "確認待ち候補の再評価で自動登録しました（★管理対象・応募記録は作っていません）"], draft: { ...stored, input, summary: j.rematched.summary, reeval: m } as unknown as Json, resolved_at: nowIso, completed_at: nowIso }).eq("id", c.id);
        note(c, j, "registered", via);
        data = await loadAppData(db, householdId); // 同じ回の中で同じ抽選を二重に登録しない
      } else {
        // keep: 登録はしない。理由を最新にし、再照合で改善した内容を草稿に反映する
        const m = mark(c, j, j.improved ? "rematch" : undefined);
        await db.from("collection_candidates").update({ reasons: j.reasons.slice(0, 8), draft: newDraft(c, j, {}, m) }).eq("id", c.id);
        note(c, j, "review");
      }
    }
    return { requeue };
  };

  const first = await pass(true);

  // ---- 2) 追加取得＋AI再解析（C: X投稿、D: 取得元の再確認）。件数・予算の上限内。候補は優先順位順
  const requestN = Math.min(first.requeue.length, Math.max(0, opts.aiMax));
  const allow = await aiAllowance(deps, requestN);
  const aiN = deps.extractor ? Math.min(requestN, allow.allowed) : 0;
  const chosen = first.requeue.slice(0, aiN);
  let aiCalls = 0;
  let aiStop: string | null = allow.note || null;
  if (!opts.execute) {
    for (const { c, j } of first.requeue) note(c, j, chosen.some((x) => x.c.id === c.id) ? "requeued" : "review", isXCandidate(c) ? "x_image" : "refetch");
  } else {
    // 上限外・AI未設定の候補は確認待ちのまま理由を更新する
    for (const { c, j } of first.requeue.slice(aiN)) {
      const why = !deps.extractor ? "AIが未設定のため再解析していません" : requestN < first.requeue.length ? "AI再解析の件数の上限により、今回は再解析していません" : (allow.note || "AIの利用上限により、今回は再解析していません");
      const m = mark(c, j);
      await db.from("collection_candidates").update({ reasons: [...j.reasons.slice(0, 6), why], draft: newDraft(c, j, {}, m) }).eq("id", c.id);
      note(c, j, "review");
    }
    if (chosen.length > 0) {
      for (const { c, j } of chosen) {
        const prior = (c.draft as object | null) ?? {};
        const m = mark(c, j, isXCandidate(c) ? "x_image" : "refetch");
        // 既存の「再解析」と同じキュー（取得済みの内容は残したまま、同じ候補を解析待ちに戻す）。変更を検出した再解析として、一覧の事前除外は通さない
        // 一覧のカード・店舗/商品・ヒント・文脈は引き継ぐ
        const queued = rebuildQueued(prior, { kind: c.dedupe_key.startsWith("x:") || isXCandidate(c) ? "x_oembed" : "web_page", url: c.source_url ?? "", sourceName: "確認待ちの再評価", reason: isXCandidate(c) ? "image_refetch" : "reevaluate", changed: true, fallbackTitle: c.title });
        await db.from("collection_candidates").update({ job_state: "pending", status: "pending", attempts: 0, next_run_at: null, reasons: ["再評価: 追加取得・再解析待ち"], draft: { ...prior, queued, reeval: m } as never, lease_until: null, locked_by: null }).eq("id", c.id);
      }
      const q = await processQueue(deps, { settings, cond, data, aiLeft: aiN, timeLeft, perBatch: 4 });
      aiCalls = q.aiCalls;
      aiStop = q.stopReason ?? aiStop;
      data = await loadAppData(db, householdId);
      // 解析後の状態を記録（processCandidate が草稿を置き換えるため、再評価の記録を付け直す）
      for (const { c, j } of chosen) {
        const { data: now2 } = await db.from("collection_candidates").select("status,job_state,draft,reasons").eq("id", c.id).maybeSingle();
        const m = markers.get(c.id) as ReevalMarker;
        if (now2) {
          const d = (now2.draft as Record<string, unknown> | null) ?? {};
          await db.from("collection_candidates").update({ draft: { ...d, reeval: m } as never }).eq("id", c.id);
        }
        const outcome: ReevalRow["outcome"] = now2?.status === "auto_registered" ? "registered" : now2?.status === "duplicate" ? "duplicate" : now2?.status === "excluded" ? "excluded_offtarget" : now2?.job_state === "retry" || now2?.job_state === "failed" ? "failed" : "review";
        rows.set(c.id, { id: c.id, cls: j.cls, action: "requeue", outcome, via: m.via, reason: (now2?.reasons?.[0] ?? "").slice(0, 80), deadline: j.deadline, x: isXCandidate(c) ? { source: true, imageStatus: xImageStatus(now2?.draft as StoredDraft | null) } : undefined });
      }
    }
  }

  // ---- 3) もう一度、無料の見直し（再解析で情報が揃った候補のうち、自動登録がオフ等で確認待ちに残ったものを登録する）
  if (opts.execute && chosen.length > 0) await pass(false);

  const finalReview = (await loadReview(db, householdId)).length;
  const budgetAfter = opts.execute ? await monthBudget(db, householdId).catch(() => null) : null;
  const all = [...rows.values()];
  const counts: Record<string, number> = {};
  for (const r of all) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const byClass: Record<string, number> = {};
  for (const r of all) byClass[r.cls] = (byClass[r.cls] ?? 0) + 1;
  return {
    ok: true,
    execute: opts.execute,
    before: { review: before },
    after: { review: finalReview },
    counts,
    byClass,
    rows: all,
    ai: { requested: requestN, allowed: aiN, calls: aiCalls, stop: aiStop, costJpyDelta: budgetBefore && budgetAfter ? Math.round((budgetAfter.costJpy - budgetBefore.costJpy) * 100) / 100 : null },
    xCostNote: "X APIは、収集設定のX月額予算・APIキーの範囲内でのみ呼びます（予算0円・キー未設定のときは呼ばず、本文のみで解析します）",
  };
}

/** 再評価で変更した候補を、変更前の状態へ戻す。再評価で新規登録した抽選は変更しない（削除せず、返り値で通知する） */
export async function restoreReevaluation(db: Db, householdId: string, ids?: string[]): Promise<{ restored: number; registeredLotteryIds: string[] }> {
  const { data } = await db.from("collection_candidates").select("id,draft,status").eq("household_id", householdId).limit(2000);
  let restored = 0;
  const registered: string[] = [];
  for (const r of data ?? []) {
    const m = (r.draft as { reeval?: ReevalMarker } | null)?.reeval;
    if (!m || (ids && !ids.includes(r.id))) continue;
    if (m.registeredLotteryId) registered.push(m.registeredLotteryId);
    await db.from("collection_candidates").update({ status: m.before.status, job_state: m.before.job_state, reasons: m.before.reasons, lottery_id: m.before.lottery_id, draft: (m.before.draft ?? null) as never, resolved_at: null, completed_at: null }).eq("id", r.id);
    restored++;
  }
  return { restored, registeredLotteryIds: registered };
}
