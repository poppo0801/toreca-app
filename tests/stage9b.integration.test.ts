/**
 * Stage 9B: 登録済み抽選の自動更新・履歴・復旧、日時不明の抽選の「終了候補」（実Supabase・RLS適用下・架空データのみ。有料APIなし）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lotteryInputSchema, type LotteryInput } from "@/lib/lottery-input";
import { loadAppData, saveLottery, type Db } from "@/lib/server/lottery-service";
import { revertAutoUpdate, tryAutoUpdate } from "@/lib/server/collector/auto-update";
import { markEndCandidates } from "@/lib/server/collector/complete";
import { recheckPages } from "@/lib/server/collector/run";
import { mkApplication } from "./helpers/application";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 9B", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const ids: string[] = [];
  let u1: Db;
  let h1: string;
  let actor: string;
  let chain: string;
  let product: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い
  const x = (db: unknown) => db as any;
  const NOW = new Date();

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9b", 1);
    ids.push(a.userId);
    u1 = a.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    for (let i = 0; i < 10 && !actor; i++) {
      actor = (await u1.from("profiles").select("id").order("sort_order")).data?.[0]?.id as string;
      if (!actor) await new Promise((r) => setTimeout(r, 300));
    }
    chain = (await u1.from("chains").insert({ household_id: h1, name: "9B系列" } as never).select("id").single()).data!.id as string;
    product = (await u1.from("products").insert({ household_id: h1, official_name: "9B商品", packs_per_box: 20 } as never).select("id").single()).data!.id as string;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  const input = (storeId: string, over: Record<string, unknown> = {}): LotteryInput =>
    lotteryInputSchema.parse({
      chain: { id: chain, name: "" }, store: { id: storeId, name: "", prefecture: "" }, campaignId: null, newCampaign: null,
      items: [{ product: { id: product, name: "" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "date_only", date: "2099-01-01", time: "" }, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: { precision: "date_only", date: "2099-01-15", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", conditionsText: "会員登録が必要です", verificationText: "", announcementMethod: "", announcementUrl: "",
      sourceUrls: ["https://q9b.example.invalid/a"], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", ...over,
    });
  let seq = 0;
  /** 自動収集で登録された抽選（source_kind=auto）を作る。deadline に null を渡すと締切不明＋『未確認』の注意つき */
  const mkAuto = async (deadline: string | null) => {
    const st = (await u1.from("stores").insert({ household_id: h1, chain_id: chain, name: `9B店${++seq}`, prefecture: "東京都" } as never).select("id").single()).data!.id as string;
    const r = await saveLottery(u1, h1, null, input(st, deadline ? {} : { applyDeadline: { precision: "unknown", date: "", time: "" } }), actor, { autoCollected: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const id = r.ok ? r.value.id : "";
    const cautions = deadline ? [] : [{ code: "deadline_unknown", field: "applyDeadline", message: "応募締切が確認できていません", at: new Date().toISOString() }];
    await x(u1).from("lotteries").update({ source_kind: "auto", cautions, cautions_updated_at: new Date().toISOString() }).eq("id", id);
    return { id, st };
  };
  const changeOf = (key: "applyDeadline", label = "応募締切") => ({ key, label, before: "a", after: "b" });
  const lotOf = async (id: string) => (await loadAppData(sys, h1)).lotteries.find((l) => l.id === id)!;
  const col = async (id: string) => (await x(u1).from("lotteries").select("apply_deadline_date,apply_deadline_precision,update_history,cautions,archived_at,source_kind").eq("id", id).single()).data;

  it("公式の情報源で締切が延長されたら、人の承認を待たず自動更新する。更新前後・情報源が履歴に残り、元に戻せる。応募の記録・店舗・条件は変わらない", async () => {
    const { id, st } = await mkAuto("2099-01-10");
    await mkApplication(x(u1), h1, chain, id);
    const appsBefore = (await x(u1).from("applications").select("id,state,result_status").eq("lottery_id", id).order("id")).data;
    const lot = await lotOf(id);
    const r = await tryAutoUpdate(sys, lot, input(st, { applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" } }), [changeOf("applyDeadline")], { sourceUrl: "https://shop.example.invalid/official", sourceKind: "official_site", official: true, now: NOW });
    expect(r?.applied.map((c) => c.key)).toEqual(["applyDeadline"]);
    const after = await col(id);
    expect(after.apply_deadline_date).toBe("2099-01-20");
    expect(after.update_history).toHaveLength(1);
    expect(after.update_history[0]).toMatchObject({ official: true, sourceUrl: "https://shop.example.invalid/official", keys: ["applyDeadline"] });
    expect(after.update_history[0].before.apply_deadline_date).toBe("2099-01-10");
    expect((await x(u1).from("applications").select("id,state,result_status").eq("lottery_id", id).order("id")).data).toEqual(appsBefore);
    // 画面の読み込みにも履歴が出る
    expect((await lotOf(id)).updateHistory).toHaveLength(1);
    // 元に戻す（その後に変更があれば戻せない）
    const rv = await revertAutoUpdate(u1, id, after.update_history[0].id, actor);
    expect(rv.ok, JSON.stringify(rv)).toBe(true);
    expect((await col(id)).apply_deadline_date).toBe("2099-01-10");
    expect((await revertAutoUpdate(u1, id, after.update_history[0].id, actor)).ok).toBe(false);
    expect((await x(u1).from("applications").select("id,state,result_status").eq("lottery_id", id).order("id")).data).toEqual(appsBefore);
  });

  it("元に戻したあと、同じ内容の変更は再び自動では反映されない（利用者の判断を尊重）。その後に利用者が編集した抽選は戻せない", async () => {
    const { id, st } = await mkAuto("2099-01-10");
    const i2 = input(st, { applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" } });
    const o = { sourceUrl: "https://q9b.example.invalid/a", sourceKind: "list_site", official: false, now: NOW };
    expect((await tryAutoUpdate(sys, await lotOf(id), i2, [changeOf("applyDeadline")], o))?.applied).toHaveLength(1);
    const h = (await col(id)).update_history[0].id as string;
    expect((await revertAutoUpdate(u1, id, h, actor)).ok).toBe(true);
    // 戻した内容と同じ変更 → 反映も提案もしない
    const again = await tryAutoUpdate(sys, await lotOf(id), i2, [changeOf("applyDeadline")], o);
    expect(again?.applied).toEqual([]);
    expect(again?.plan.propose).toEqual([]);
    expect((await col(id)).apply_deadline_date).toBe("2099-01-10");
  });

  it("締切の短縮は応募機会に影響するため自動では反映しない（提案に回す）。手動で編集された抽選・自動収集でない抽選も反映しない", async () => {
    const { id, st } = await mkAuto("2099-01-10");
    const o = { sourceUrl: "https://shop.example.invalid/official", sourceKind: "official_site", official: true, now: NOW };
    const shorter = await tryAutoUpdate(sys, await lotOf(id), input(st, { applyDeadline: { precision: "date_only", date: "2099-01-05", time: "" } }), [changeOf("applyDeadline")], o);
    expect(shorter?.applied).toEqual([]);
    expect(shorter?.plan.propose).toHaveLength(1);
    expect((await col(id)).apply_deadline_date).toBe("2099-01-10");
    // 手動で編集された（最終更新が自動処理の更新より十分後）
    await x(u1).from("lotteries").update({ cautions_updated_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", id);
    const ext = input(st, { applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" } });
    const manual = await tryAutoUpdate(sys, await lotOf(id), ext, [changeOf("applyDeadline")], o);
    expect(manual?.applied).toEqual([]);
    expect(manual?.plan.reasons.applyDeadline).toContain("手動");
    // 自動収集でない抽選（手動登録）
    const st2 = (await u1.from("stores").insert({ household_id: h1, chain_id: chain, name: "9B手動店", prefecture: "東京都" } as never).select("id").single()).data!.id as string;
    const m = await saveLottery(u1, h1, null, input(st2), actor);
    const mid = m.ok ? m.value.id : "";
    const notAuto = await tryAutoUpdate(sys, await lotOf(mid), input(st2, { applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" } }), [changeOf("applyDeadline")], o);
    expect(notAuto?.applied).toEqual([]);
    expect((await col(mid)).apply_deadline_date).toBe("2099-01-10");
  });

  it("日時が長く不明な抽選には『終了候補』の注意を付ける。非表示・アーカイブ・削除はしない。手動編集された抽選・新しい抽選には付けない。日時が分かれば注意は自動で外れる", async () => {
    const old = await mkAuto(null);
    const young = await mkAuto(null);
    const edited = await mkAuto(null);
    const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await x(admin).from("lotteries").update({ created_at: longAgo }).in("id", [old.id, edited.id]);
    await x(u1).from("lotteries").update({ cautions_updated_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", edited.id);
    expect(await markEndCandidates(sys, h1, new Date())).toBeGreaterThanOrEqual(1);
    const codes = async (id: string) => ((await col(id)).cautions as { code: string }[]).map((c) => c.code);
    expect(await codes(old.id)).toContain("end_candidate");
    expect(await codes(old.id)).toContain("deadline_unknown");
    expect(await codes(young.id)).not.toContain("end_candidate");
    expect(await codes(edited.id)).not.toContain("end_candidate");
    // 表示を止めない（アーカイブされない・自動収集のまま）
    expect(await col(old.id)).toMatchObject({ archived_at: null, source_kind: "auto", apply_deadline_precision: "unknown" });
    // 何度実行しても重複して付かない
    await markEndCandidates(sys, h1, new Date());
    expect((await codes(old.id)).filter((c) => c === "end_candidate")).toHaveLength(1);
    // 続報で締切が分かって自動更新されたら、注意も外れる
    const r = await tryAutoUpdate(sys, await lotOf(old.id), input(old.st, { applyDeadline: { precision: "date_only", date: "2099-02-01", time: "" } }), [changeOf("applyDeadline")], { sourceUrl: "https://q9b.example.invalid/a", sourceKind: "list_site", official: false, now: NOW });
    expect(r?.applied).toHaveLength(1);
    expect(await codes(old.id)).not.toContain("end_candidate");
    expect(await codes(old.id)).not.toContain("deadline_unknown");
  });

  it("情報源の再確認は、応募締切が未確認の抽選（重要情報が不足している抽選）を先に確認する。件数の上限は守る", async () => {
    const plain = await mkAuto("2099-01-10");
    const unknown = await mkAuto(null);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const mk = (key: string, lotteryId: string, checked: string) => x(admin).from("collection_candidates").insert({ household_id: h1, dedupe_key: `https://q9b.example.invalid/${key}`, source_url: `https://q9b.example.invalid/${key}`, title: key, status: "auto_registered", job_state: "completed", lottery_id: lotteryId, last_checked_at: checked, reasons: ["登録済み"] });
    await mk("plain", plain.id, old); // より古く確認されていない（従来の順序なら先）
    await mk("unknown", unknown.id, recent);
    const fetched: string[] = [];
    const deps = {
      db: sys, householdId: h1, trigger: "cron", now: NOW, actor: null, canRegister: false, serviceRegister: true, xClient: null,
      fetchPage: async (u: string) => (fetched.push(u), { ok: false as const, code: "robots", message: "robots" }), fetchOembed: async () => ({ ok: false as const, message: "x" }),
    } as unknown as Parameters<typeof recheckPages>[0];
    await recheckPages(deps, { max: 1, recheckHours: 6, timeLeft: () => 50_000 });
    expect(fetched).toEqual(["https://q9b.example.invalid/unknown"]); // 上限1件。未確認の抽選の情報源が先
    await x(admin).from("collection_candidates").delete().like("dedupe_key", "%q9b.example.invalid%");
  });
});
