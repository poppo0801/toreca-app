import "server-only";
import type { AgentLLM } from "@/lib/agent/core";
import type { MissionBudget } from "@/lib/agent/discovery/controls";
import type { DiscoveryRunRecord } from "@/lib/agent/discovery/engine";
import { buildMissions, emptyStrategy, runDiscoverySession, type StrategyMemory } from "@/lib/agent/discovery/session";
import type { DiscoveryMission } from "@/lib/agent/discovery/types";
import type { InvestigationRecord } from "@/lib/agent/collection-planner/executor";
import { candidatesFromRecord } from "@/lib/collector/engine-contract";
import { autonomousSlotDecision, compactRecord, LOCK_MS, pruneTargets, resolveEffectiveEngine, slotKeyOf } from "@/lib/collector/engine-setting";
import { checkReanalysis } from "@/lib/collector/intake-check";
import type { LotteryExtractor } from "@/lib/ai/provider";
import type { Json } from "@/types/database";
import type { RealDiscoveryWorld } from "@/lib/server/agent/discovery-world";
import { applyPreviews } from "@/lib/server/agent/investigation-service";
import { createInvestigationWorld } from "@/lib/server/agent/investigation-world";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 自律型AI主体の収集の実行（Stage 9H-3Q）。設定された収集方式が自律型のときだけ、定期実行・手動実行から呼ばれる。
 *   排他   : 世帯ごとの期限つきロック（collection_settings.autonomous_lock_until）＋実行中の記録は1つだけ（一意索引）。実行中の従来方式の収集があれば開始しない
 *   登録   : AIの発見は、既存の登録経路へ渡す。URLを既存の解析で再解析し、AIの報告と照合（checkReanalysis）→ 既存の重複照合・安全条件・自動登録（applyPreviews）。
 *            人間が確認・修正した抽選は更新しない（既存の補完と同じ保護）。AIの根拠（URL・原文・取得経路・要確認項目）は lottery_discovery_origins に保存する
 *   失敗   : 例外・AIの障害・上限は、調査の記録に残し、応募・当選・既存の抽選には影響しない。方式の設定は変更しない（自動で従来方式へ切り替えない）
 *   記録   : 調査履歴（discovery_runs）と探索実績（discovery_strategy）。保持方針に従って古い記録を削除する
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に無い（開発DBのみのマイグレーション104）
const anyDb = (db: Db) => db as any;

export interface IntakeOutcome {
  url: string;
  store?: string;
  outcome: "registered" | "completed" | "duplicate" | "held" | "mismatch" | "skipped";
  reason: string;
  lotteryId?: string;
}
export interface AutonomousCounts {
  missions: number;
  found: number;
  registered: number;
  duplicates: number;
  excluded: number;
  held: number;
  alreadyKnown: number;
  mismatches: number;
}

export type AutonomousResult = { ok: true; runId: string; counts: AutonomousCounts; costJpy: number; outcomes: IntakeOutcome[]; records: DiscoveryRunRecord[] } | { ok: false; skipped: true; reason: string } | { ok: false; skipped?: false; error: string; runId?: string };

export interface AutonomousDeps {
  db: Db;
  householdId: string;
  now: Date;
  trigger: "cron" | "manual";
  actor: string | null;
  llmFor: (m: DiscoveryMission) => AgentLLM;
  world: RealDiscoveryWorld;
  /** 実AI・実検索のときtrue（費用を記録できない実行は開始しない） */
  real?: boolean;
  costRecorder?: { record(missionId: string, costJpy: number): void };
  beforeMission?: (m: DiscoveryMission) => void;
  perMissionJpy?: number;
  /** 実行中の費用の累計（円）。例外・途中終了でも、消費した費用を調査履歴に記録するために使う */
  costSoFar?: () => number;
  /** 解析エンジン（既定は無料の規則ベース。実AIの解析は呼び出し側が承認された範囲で渡す） */
  extractor?: LotteryExtractor | null;
  sleep?: (ms: number) => Promise<void>;
  /** 1回の呼び出しで実行するミッション数と、使える時間（定期実行は約60秒以内） */
  maxMissions?: number;
  timeBudgetMs?: number;
  /** 1回の呼び出し全体（調査＋登録）の時間の目安。登録処理はこの範囲で打ち切る。既定は 調査の上限＋40秒 */
  totalBudgetMs?: number;
  /** 調査機会（枠）のキー。呼び出し口が決める（発売日の近さで枠の時刻が変わるため）。省略時は定期収集の時刻から決める */
  slot?: string;
  /** ログインなし（service_role）からの登録 */
  asService?: boolean;
  env?: { toremaneEnv?: string; enabled?: boolean };
}

export async function releaseLock(db: Db, householdId: string): Promise<void> {
  await anyDb(db).from("collection_settings").update({ autonomous_lock_until: null }).eq("household_id", householdId);
}

async function acquireLock(db: Db, householdId: string, now: Date): Promise<boolean> {
  const until = new Date(now.getTime() + LOCK_MS).toISOString();
  const { data } = await anyDb(db).from("collection_settings").update({ autonomous_lock_until: until }).eq("household_id", householdId).or(`autonomous_lock_until.is.null,autonomous_lock_until.lt.${now.toISOString()}`).select("household_id");
  return (data ?? []).length === 1;
}

export async function loadStrategy(db: Db, householdId: string): Promise<StrategyMemory> {
  const { data } = await anyDb(db).from("discovery_strategy").select("memory").eq("household_id", householdId).maybeSingle();
  const m = data?.memory as StrategyMemory | undefined;
  return m && m.version === 1 ? m : emptyStrategy();
}

/** ミッションの材料（読み取りのみ）: 近く発売の商品・最近の抽選・抽選のない系列。店舗名・検索語は決めない */
export async function loadMissionSources(db: Db, householdId: string, now: Date) {
  const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const from = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [products, lots, chains, stores, allProducts] = await Promise.all([
    db.from("products").select("id,official_name,release_date").eq("household_id", householdId).not("release_date", "is", null).gte("release_date", from).order("release_date").limit(20),
    db.from("lotteries").select("id,chain_id,store_id,source_urls,created_at").eq("household_id", householdId).is("archived_at", null).gte("created_at", since30).order("created_at", { ascending: false }).limit(300),
    db.from("chains").select("id,name").eq("household_id", householdId).is("archived_at", null),
    db.from("stores").select("id,chain_id,name").eq("household_id", householdId).is("archived_at", null),
    db.from("products").select("id,official_name").eq("household_id", householdId).limit(2000),
  ]);
  const lotIds = (lots.data ?? []).map((l) => l.id).slice(0, 300);
  const items = lotIds.length ? await db.from("lottery_items").select("lottery_id,product_id").in("lottery_id", lotIds) : { data: [] as { lottery_id: string; product_id: string }[] };
  const chainName = new Map((chains.data ?? []).map((c) => [c.id, c.name]));
  const storeName = new Map((stores.data ?? []).map((s) => [s.id, s.name]));
  const productName = new Map((allProducts.data ?? []).map((p) => [p.id, p.official_name]));
  const firstItem = new Map<string, string>();
  for (const i of items.data ?? []) if (!firstItem.has(i.lottery_id)) firstItem.set(i.lottery_id, productName.get(i.product_id) ?? "");
  const recentLotteries = (lots.data ?? []).flatMap((l) => {
    const chain = chainName.get(l.chain_id) ?? "";
    const store = l.store_id ? (storeName.get(l.store_id) ?? "") : "";
    const product = firstItem.get(l.id) ?? "";
    return chain && store && product ? [{ chain, store, product, sourceUrl: ((l.source_urls as string[] | null) ?? [])[0] }] : [];
  });
  const activeChains = new Set((lots.data ?? []).map((l) => l.chain_id));
  const count = new Map<string, number>();
  for (const s of stores.data ?? []) count.set(s.chain_id, (count.get(s.chain_id) ?? 0) + 1);
  const idleChains = (chains.data ?? []).filter((c) => !activeChains.has(c.id) && (count.get(c.id) ?? 0) >= 2).map((c) => ({ name: c.name, storeCount: count.get(c.id) ?? 0 }));
  return { today, releases: (products.data ?? []).map((p) => ({ name: p.official_name, releaseDate: p.release_date as string })), recentLotteries, idleChains };
}

/** AIの発見を、既存の登録経路へ渡す（再解析→AIの報告との照合→既存の重複照合・安全条件・自動登録）。AIの報告を無条件には信用しない */
export async function intakeRecord(o: { db: Db; householdId: string; record: DiscoveryRunRecord; world: RealDiscoveryWorld; now: Date; autoRegister: boolean; actor: string | null; asService?: boolean; extractor?: LotteryExtractor | null; runId: string; /** 登録処理の締め切り（epoch ms）。過ぎたら残りは登録せず確認待ちにする（調査の記録には保存済みで、成果は失われない） */ deadlineAt?: number }): Promise<IntakeOutcome[]> {
  const out: IntakeOutcome[] = [];
  for (const c of candidatesFromRecord(o.record)) {
    const base = { url: c.sourceUrl, store: c.store };
    if (o.deadlineAt !== undefined && Date.now() > o.deadlineAt) {
      out.push({ ...base, outcome: "held", reason: "実行時間の上限に近づいたため、登録を見送りました（調査の記録には保存済み。次回以降に確認できます）" });
      continue;
    }
    if (c.status !== "adopt") {
      out.push({ ...base, outcome: "held", reason: `確認が必要なため登録しません（${c.attention[0] ?? "根拠の一部が不足"}）` });
      continue;
    }
    const page = o.world.pageOf(c.sourceUrl);
    if (!page) {
      out.push({ ...base, outcome: "skipped", reason: "取得済みのページが見つからないため再解析できません" });
      continue;
    }
    const iw = createInvestigationWorld({ db: o.db, householdId: o.householdId, now: o.now, live: false, allowProvisionalStore: true, ...(c.store && !c.selectMode ? { storeHint: c.store } : {}), extractor: o.extractor, fetcher: async () => ({ ok: true, title: page.title, text: page.text, links: page.links }) });
    let preview;
    try {
      preview = await iw.world.analyze!({ url: c.sourceUrl, title: page.title, text: page.text, links: page.links });
    } catch (e) {
      out.push({ ...base, outcome: "skipped", reason: `再解析に失敗しました（${(e as Error).message?.slice(0, 80) ?? ""}）` });
      continue;
    }
    const chk = checkReanalysis({ chain: c.chain, store: c.store, selectMode: c.selectMode, products: c.products }, { chainName: preview.chainName, storeName: preview.storeName, products: preview.products, selectMode: preview.storeName === "応募時に店舗を選択" });
    if (!chk.ok) {
      out.push({ ...base, outcome: "mismatch", reason: chk.reason });
      continue;
    }
    if (preview.disposition.kind === "duplicate") {
      out.push({ ...base, outcome: "duplicate", reason: "既存の登録と同じ抽選のため、新規登録しません（AIの新規発見には数えません）" });
      continue;
    }
    if (!o.autoRegister) {
      out.push({ ...base, outcome: "held", reason: "自動登録が無効のため、登録せず確認待ちにします" });
      continue;
    }
    const ap = await applyPreviews(o.db, o.householdId, { previews: [preview] } as unknown as InvestigationRecord, iw.drafts, { actor: o.actor, now: o.now, officialUrls: new Set(), asService: o.asService });
    if (ap.registered[0]) {
      const lotteryId = ap.registered[0].lotteryId;
      const prov = o.record.sources.find((s) => s.url.replace(/\/+$/, "") === c.sourceUrl.replace(/\/+$/, ""))?.provenance ?? "unknown";
      await anyDb(o.db).from("lottery_discovery_origins").upsert({ household_id: o.householdId, lottery_id: lotteryId, run_id: o.runId, source_url: c.sourceUrl.slice(0, 600), provenance: prov, evidence_quote: c.evidenceQuote.slice(0, 400), reason: (c.trace.reason ?? "").slice(0, 300), attention: c.attention as unknown as Json }, { onConflict: "lottery_id,source_url" });
      out.push({ ...base, outcome: "registered", reason: "既存の登録経路で登録しました（注意付き・要確認項目は根拠とともに保存）", lotteryId });
    } else if (ap.completed[0]) out.push({ ...base, outcome: "completed", reason: "既存の抽選の未入力項目を補完しました（人間が編集した抽選は対象外）", lotteryId: ap.completed[0].lotteryId });
    else out.push({ ...base, outcome: "skipped", reason: ap.skipped[0]?.reason ?? "登録の安全条件を満たしません" });
  }
  return out;
}

export function countsOf(records: DiscoveryRunRecord[], outcomes: IntakeOutcome[]): AutonomousCounts {
  const leads = records.flatMap((r) => r.leads);
  const known = leads.filter((l) => l.decision.credit === "already_known").length;
  return {
    missions: records.length,
    found: leads.filter((l) => l.decision.credit === "ai_new" && l.decision.status !== "exclude").length,
    registered: outcomes.filter((x) => x.outcome === "registered").length,
    duplicates: outcomes.filter((x) => x.outcome === "duplicate").length + leads.filter((l) => l.decision.exclusion === "duplicate_in_run").length,
    excluded: leads.filter((l) => l.decision.status === "exclude" && l.decision.credit !== "already_known" && l.decision.exclusion !== "duplicate_in_run").length,
    held: outcomes.filter((x) => x.outcome === "held" || x.outcome === "skipped").length,
    alreadyKnown: known,
    mismatches: outcomes.filter((x) => x.outcome === "mismatch").length,
  };
}

export async function runAutonomousCollection(d: AutonomousDeps): Promise<AutonomousResult> {
  const { db, householdId: hid, now } = d;
  const settings = (await anyDb(db).from("collection_settings").select("collection_engine,prefectures,auto_register,schedule_hour_jst,schedule_hour2_jst").eq("household_id", hid).maybeSingle()).data as { collection_engine?: string; prefectures?: string[]; auto_register?: boolean; schedule_hour_jst?: number; schedule_hour2_jst?: number | null } | null;
  const eff = resolveEffectiveEngine({ stored: settings?.collection_engine, loadFailed: !settings, toremaneEnv: d.env?.toremaneEnv ?? process.env.TOREMANE_ENV, enabled: d.env?.enabled ?? process.env.AUTONOMOUS_COLLECTION === "on" });
  if (eff.engine !== "autonomous") return { ok: false, skipped: true, reason: eff.note ?? "収集方式が自律型AI主体ではありません" };
  // 従来方式の収集が実行中なら開始しない（同時に本登録処理を行わない）
  const legacyRunning = await db.from("collection_runs").select("id").eq("household_id", hid).eq("status", "running").gte("started_at", new Date(now.getTime() - 30 * 60_000).toISOString()).limit(1);
  if ((legacyRunning.data ?? []).length > 0) return { ok: false, skipped: true, reason: "従来方式の収集が実行中です" };
  if (d.real && !d.costRecorder) return { ok: false, skipped: true, reason: "費用を記録できないため、有料の実行は開始しません" };
  if (!(await acquireLock(db, hid, now))) return { ok: false, skipped: true, reason: "自律型の収集が実行中です（二重起動しません）" };

  let runId: string | undefined;
  const cost0 = d.costSoFar?.() ?? 0;
  try {
    // 異常終了で残った実行中の記録を閉じる
    // 費用は不明のため、1件の上限額を消費したものとして安全側に記録する（日次・月次の上限を超えないため）
    await anyDb(db).from("discovery_runs").update({ status: "failed", error: "実行が完了しないまま期限を過ぎたため終了として記録（費用は上限額を消費したものとして計上）", finished_at: now.toISOString(), cost_jpy: d.perMissionJpy ?? 12 }).eq("household_id", hid).eq("status", "running").lt("started_at", new Date(now.getTime() - LOCK_MS).toISOString());
    const slot = d.slot ?? slotKeyOf(now, [settings?.schedule_hour_jst, settings?.schedule_hour2_jst]);
    const ins = await anyDb(db).from("discovery_runs").insert({ household_id: hid, trigger: d.trigger, status: "running", slot, started_at: now.toISOString() }).select("id").single();
    if (ins.error) return { ok: false, skipped: true, reason: "自律型の収集が実行中です（記録を作れませんでした）" };
    runId = (ins.data as { id: string }).id;
    const t0 = Date.now();

    const memory = await loadStrategy(db, hid);
    const doneInSlot = new Set(((await anyDb(db).from("discovery_runs").select("mission_ids").eq("household_id", hid).eq("slot", slot).neq("status", "skipped").limit(50)).data ?? []).flatMap((r: { mission_ids: string[] }) => r.mission_ids ?? []));
    const missions = buildMissions({ ...(await loadMissionSources(db, hid, now)), targetPrefectures: settings?.prefectures ?? [], memory, maxMissions: 12 }).filter((m) => !doneInSlot.has(m.id)).slice(0, d.maxMissions ?? 1);

    const timeBudget = d.timeBudgetMs ?? 45_000;
    const res = await runDiscoverySession({
      missions,
      world: d.world.world,
      llmFor: d.llmFor,
      memory,
      real: d.real,
      costRecorder: d.costRecorder,
      beforeMission: d.beforeMission,
      adjustBudget: (_m, b): MissionBudget => ({ ...b, limits: { ...b.limits, maxMs: Math.min(b.limits.maxMs, timeBudget), maxCostJpy: d.perMissionJpy ? Math.min(b.limits.maxCostJpy, d.perMissionJpy) : b.limits.maxCostJpy } }),
      now: () => Date.now(),
      sleep: d.sleep,
    });
    // 調査の成果を先に保存する（登録処理の途中で実行時間の上限に達しても、調査の記録・費用は失われない）
    await anyDb(db).from("discovery_runs").update({ records: res.records.map(compactRecord) as unknown as Json, mission_ids: missions.map((m) => m.id), cost_jpy: res.totalCostJpy, duration_ms: Date.now() - t0 }).eq("id", runId);
    const outcomes: IntakeOutcome[] = [];
    const deadlineAt = t0 + (d.totalBudgetMs ?? timeBudget + 40_000);
    for (const r of res.records) outcomes.push(...(await intakeRecord({ db, householdId: hid, record: r, world: d.world, now, autoRegister: settings?.auto_register !== false, actor: d.actor, asService: d.asService, extractor: d.extractor, runId, deadlineAt })));
    const counts = countsOf(res.records, outcomes);
    const stops = res.records.map((r) => r.stop.reason);
    const status = res.records.length > 0 && stops.every((s) => s === "llm_failure") ? "failed" : stops.some((s) => ["cost_limit", "time_limit", "step_limit", "fetch_limit", "search_limit"].includes(s)) ? "limit_reached" : "completed";
    await anyDb(db).from("discovery_runs").update({
      status,
      finished_at: new Date().toISOString(),
      stop_reason: (res.records[0] ? res.records.map((r) => r.stop.reason).join(",") : missions.length === 0 ? "no_missions" : "").slice(0, 300),
      error: status === "failed" ? "AIの応答エラーで調査を完了できませんでした" : null,
      counts: { ...counts, outcomes: outcomes.slice(0, 40) } as unknown as Json,
      cost_jpy: res.totalCostJpy,
      duration_ms: Date.now() - t0,
      records: res.records.map(compactRecord) as unknown as Json,
      mission_ids: missions.map((m) => m.id),
    }).eq("id", runId);
    await anyDb(db).from("discovery_strategy").upsert({ household_id: hid, memory: res.memory as unknown as Json, updated_at: new Date().toISOString() }, { onConflict: "household_id" });
    await prune(db, hid, now);
    return { ok: true, runId, counts, costJpy: res.totalCostJpy, outcomes, records: res.records };
  } catch (e) {
    // 失敗は記録に残す。応募・既存の抽選・方式の設定には影響させない（自動で従来方式へ切り替えない）
    const msg = ((e as Error).message ?? "不明なエラー").slice(0, 250);
    // 失敗・途中終了でも、消費した費用は記録する（本番の日次・月次の上限は、この記録から計算する）
    const spent = Math.max(0, (d.costSoFar?.() ?? 0) - cost0);
    if (runId) await anyDb(db).from("discovery_runs").update({ status: "failed", error: msg, finished_at: new Date().toISOString(), cost_jpy: Math.round(spent * 100) / 100 }).eq("id", runId);
    return { ok: false, error: msg, runId };
  } finally {
    await releaseLock(db, hid).catch(() => undefined);
  }
}

/** 履歴の保持方針（古い記録・件数超過の記録を削除。実行中は残す） */
export async function prune(db: Db, householdId: string, now: Date): Promise<number> {
  const { data } = await anyDb(db).from("discovery_runs").select("id,started_at,status").eq("household_id", householdId).order("started_at", { ascending: false }).limit(1000);
  const ids = pruneTargets((data ?? []) as { id: string; started_at: string; status: string }[], now);
  if (ids.length) await anyDb(db).from("discovery_runs").delete().in("id", ids);
  return ids.length;
}

/** 自律型を開始できなかった（実AIの関門が未設定など）ことを、利用者に見える形で記録する。同じ枠で1回だけ。方式の設定は変更しない */
export async function recordSkippedRun(db: Db, householdId: string, now: Date, slot: string, reason: string): Promise<void> {
  const ex = await anyDb(db).from("discovery_runs").select("id").eq("household_id", householdId).eq("slot", slot).eq("status", "skipped").limit(1);
  if ((ex.data ?? []).length > 0) return;
  await anyDb(db).from("discovery_runs").insert({ household_id: householdId, trigger: "cron", status: "skipped", slot, started_at: now.toISOString(), finished_at: now.toISOString(), error: reason.slice(0, 280) });
}

export { autonomousSlotDecision };
