import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getExtractor } from "@/lib/ai/provider";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { runCollection, runWorker } from "@/lib/server/collector/run";
import { enrichFromListings } from "@/lib/server/collector/enrich";
import { runLowInfoPass, runMergePass } from "@/lib/server/collector/merge-pass";
import { runHoldPass } from "@/lib/server/collector/hold";
import { planScheduledCollection } from "@/lib/server/collector/schedule";
import { runBookmarkCron } from "@/lib/server/collector/bookmarks";
import { bumpRetry, refreshBookmarkStates, unresolvedBookmarkCandidateIds } from "@/lib/server/collector/bookmark-track";
import { processGeocodeBatch } from "@/lib/server/geocode-service";
import { createXClient } from "@/lib/server/collector/x-client";
import type { Db } from "@/lib/server/lottery-service";
import { resolveEffectiveEngine } from "@/lib/collector/engine-setting";
import { runAutonomousInCron } from "@/lib/server/collector/autonomous-hook";

export const dynamic = "force-dynamic";
// 自律型AI主体の1回（調査100秒＋登録）が収まるよう、既定の60秒から延ばす（Vercel の Fluid Compute では Hobby/Pro とも上限300秒）。
// Fluid Compute が無効で上限が60秒のプランでは、環境変数 AUTONOMOUS_TIME_BUDGET_MS=35000 にして60秒内に収める（docs/PRODUCTION_ROLLOUT_9H.md）
export const maxDuration = 180;

/**
 * 自動収集の定期実行の入口。Supabase Cron(pg_cron + pg_net)が数分おきに `Authorization: Bearer $CRON_SECRET` 付きで呼ぶ。
 *  1) 定期収集が有効で、指定時刻(日本時間。1日1〜2回。例 6:00・18:00)を過ぎていて、その時刻のスロットでまだ収集していなければ、収集元を確認して新規・変更をキューに追加する
 *  2) 定期ワーカーが有効なら、解析待ちを優先順位順に小分けで解析する（解析待ちが無ければ何もせずすぐ終了する）
 * 1回の呼び出しは約60秒以内に終わる。残りは次の呼び出しが引き継ぐ（HTTPレスポンス後の処理には依存しない）。
 * 収集方式（9H-3Q）が「自律型AI主体」（開発環境のみ）の場合、1) は自律探索（1回の呼び出しでミッション1件。同じ時刻の枠で最大回数まで）に置き換わる。2) は共通。
 * 定期実行ではログインが無いため、候補の作成まで。抽選の自動登録は手動実行か候補画面で行う。
 */
async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;

  // 店舗の位置情報の取得待ち（住所の登録・変更・取込・自動収集のあと）を小分けで処理する。取得待ちが無ければ何もしない
  const geo = await processGeocodeBatch(db, { limit: 6 }).catch(() => null);

  const now = new Date();
  // Xブックマークの同期: 利用者が連携して自動収集をONにしたときだけ（既定OFF）。X APIの月額予算の範囲内で、12時間おきに少量を読む。失敗しても他の処理は止めない
  const bookmarks = await runBookmarkCron(db, now).catch(() => null);
  const { data: targets } = await db.from("collection_settings").select("household_id,schedule_enabled,schedule_hour_jst,schedule_hour2_jst,worker_enabled").or("schedule_enabled.eq.true,worker_enabled.eq.true");
  const summary: { household: number; collected: number; worked: number; idle: number }[] = [];
  let collected = 0;
  let worked = 0;
  let idle = 0;
  for (const t of targets ?? []) {
    const base = { db, householdId: t.household_id, trigger: "cron" as const, now, actor: null, canRegister: false, serviceRegister: true, extractor: getExtractor(), xClient: createXClient() };
    // Xブックマーク由来の未解決は、収集・解析より先に補完を試みる（AI・X APIは呼ばない。保存済みの候補・既存の抽選・公式ページ由来の候補と照合）。
    // 状態の更新で、登録済み・統合済み・受付終了を反映し、受付終了後は再調査を止める
    try {
      const due = await unresolvedBookmarkCandidateIds(db, t.household_id, now);
      if (due.length > 0) {
        await runMergePass({ ...base, trigger: "manual" as const }, { execute: true, ids: due }).catch(() => undefined);
        await bumpRetry(db, t.household_id, due, now);
      }
      await refreshBookmarkStates(db, t.household_id, now);
    } catch {
      /* 補完に失敗しても収集は続ける */
    }
    // 収集方式（Stage 9H-3Q）: 設定を実行ごとに読み直す。読めない・不正なら従来方式（設定は書き換えない）。自律型は開発環境、または本番で AUTONOMOUS_COLLECTION=on のとき
    const engRow = await db.from("collection_settings").select("collection_engine").eq("household_id", t.household_id).maybeSingle();
    const eng = resolveEffectiveEngine({ stored: (engRow.data as { collection_engine?: string } | null)?.collection_engine, loadFailed: !!engRow.error, toremaneEnv: process.env.TOREMANE_ENV, enabled: process.env.AUTONOMOUS_COLLECTION === "on" });
    if (eng.engine === "autonomous" && t.schedule_enabled) {
      // 自律型AI主体: 調査機会・排他・実AIの関門・費用の上限は呼び出し口が判定する。失敗しても、ワーカーなど他の処理は続ける
      const r = await runAutonomousInCron({ db, householdId: t.household_id, now, extractor: getExtractor() });
      if (r.status === "ran") {
        collected++;
        continue; // 続きは次の呼び出し（同じ枠で最大回数まで）
      }
    }
    // 従来方式の定期収集（登録済みの収集元の取得）は、自律型の調査が動かない呼び出しで引き続き実行する（既存の収集を止めない。自律型は上乗せの探索）
    if (t.schedule_enabled) {
      // 手動収集の履歴とは独立に、今日の定期収集のスロットで未取得の収集元だけを取得する（失敗した収集元は間隔をおいて再試行）
      const plan = await planScheduledCollection(db, t.household_id, now, [t.schedule_hour_jst, t.schedule_hour2_jst]);
      if (plan && plan.due.length > 0) {
        const out = await runCollection({ ...base, scheduled: { slotDate: plan.slotDate, sourceIds: plan.due } });
        if (out.ok) {
          collected++;
          continue; // 収集と最初のバッチでこの呼び出しの時間を使う。続きは次の呼び出しのワーカーが引き継ぐ
        }
      }
    }
    if (t.worker_enabled) {
      // 保留（自動再調査）: 次回調査の時刻を過ぎた候補を、朝6時の収集を待たずに再調査する（無料の再照合と取得元の再確認が中心）
      const t0 = Date.now();
      await enrichFromListings(base, { max: 40 }).catch(() => undefined);
      await runHoldPass(base, { max: 6, timeLeft: () => 30_000 - (Date.now() - t0) }).catch(() => undefined);
      const out = await runWorker({ ...base, budgetMs: Math.max(25_000, 54_000 - (Date.now() - t0)) });
      if (out.ok && "runId" in out) worked++;
      else {
        idle++;
        // 解析待ちが無いときだけ、1時間に1回（毎時最初の呼び出し）、保存済みの結果で項目別の統合と低情報量の整理を行う（AI・X APIは呼ばない。何も無ければ書き込まない）
        if (now.getUTCMinutes() < 5) {
          const mp = { ...base, trigger: "manual" as const };
          await runMergePass(mp, { execute: true }).catch(() => undefined);
          await runLowInfoPass(mp, { execute: true }).catch(() => undefined);
        }
      }
    }
  }
  summary.push({ household: targets?.length ?? 0, collected, worked, idle });
  return NextResponse.json({ ok: true, ...summary[0], geocoded: geo?.ok ?? 0, bookmarks: bookmarks?.synced ?? 0 });
}

export const GET = handle;
export const POST = handle;
