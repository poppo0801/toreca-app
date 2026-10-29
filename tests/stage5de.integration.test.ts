/**
 * Stage 5D/5E の結合テスト（実Supabase・RLS適用下）: 購入・受取の期間、プロフィール別の設定、設定のコピー（認可・原子性）。
 *   npm run test:db   ※ マイグレーション 20261029000024 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveLottery, type Db } from "@/lib/server/lottery-service";
import type { LotteryInput } from "@/lib/lottery-input";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5D/5E: 購入・受取の期間とプロフィール別の設定", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let a1: string;
  let b1: string;
  let a2: string;
  let chainId: string;
  let productId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
  const any = (db: Db) => db as any;

  const flex = (date: string, time = "") => ({ precision: time ? ("date_time" as const) : ("date_only" as const), date, time });
  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: chainId, name: "" },
    store: { id: null, name: "5DE店", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ id: null, product: { id: productId, name: "" }, quantity: 1, unit: "box" }],
    applyStart: { precision: "unknown", date: "", time: "" },
    applyDeadline: flex("2026-11-10", "23:59"),
    resultDate: flex("2026-11-13"),
    procedureStart: { precision: "unknown", date: "", time: "" },
    procedureDeadline: { precision: "unknown", date: "", time: "" },
    receiveMethod: "store",
    applyMethod: "app",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "person",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5de", 1);
    const b = await signInTestUser(admin, "s5de", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    const profs = (await u1.from("profiles").select("id,label")).data!;
    a1 = profs.find((p) => p.label === "A")!.id;
    b1 = profs.find((p) => p.label === "B")!.id;
    a2 = (await u2.from("profiles").select("id,label")).data!.find((p) => p.label === "A")!.id;
    chainId = (await u1.from("chains").insert({ household_id: hid1, name: "5DE電機" }).select("id").single()).data!.id;
    productId = (await u1.from("products").insert({ household_id: hid1, official_name: "5DE商品", packs_per_box: 20 }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("購入・受取の開始〜終了を保存でき、日付のみ・日時・不明が区別される。開始が無い従来の登録も保存できる", async () => {
    const r1 = await saveLottery(u1, hid1, null, input({ procedureStart: flex("2026-11-14"), procedureDeadline: flex("2026-11-20", "18:00") }), a1);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const row = (await u1.from("lotteries").select("procedure_start_precision,procedure_start_date,procedure_start_at,procedure_deadline_precision,procedure_deadline_at").eq("id", r1.value.id).single()).data!;
    expect(row).toMatchObject({ procedure_start_precision: "date_only", procedure_start_date: "2026-11-14", procedure_start_at: null, procedure_deadline_precision: "date_time" });
    expect(row.procedure_deadline_at).toBeTruthy();
    // 従来どおり開始なし（終了のみ）。既存のデータは unknown のまま
    const r2 = await saveLottery(u1, hid1, null, input({ store: { id: null, name: "5DE店2", prefecture: "" }, procedureDeadline: flex("2026-11-20") }), a1);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect((await u1.from("lotteries").select("procedure_start_precision,procedure_start_date").eq("id", r2.value.id).single()).data).toEqual({ procedure_start_precision: "unknown", procedure_start_date: null });
    // 編集で開始を追加できる
    const r3 = await saveLottery(u1, hid1, r2.value.id, input({ store: { id: null, name: "5DE店2", prefecture: "" }, procedureStart: flex("2026-11-15"), procedureDeadline: flex("2026-11-20") }), a1);
    expect(r3.ok).toBe(true);
    expect((await u1.from("lotteries").select("procedure_start_date").eq("id", r2.value.id).single()).data!.procedure_start_date).toBe("2026-11-15");
  });

  it("開始が終了より後ろの期間は、アプリでもDBでも拒否される", async () => {
    const r = await saveLottery(u1, hid1, null, input({ procedureStart: flex("2026-11-25"), procedureDeadline: flex("2026-11-20") }), a1);
    expect(r.ok).toBe(false);
    // 検証を通らない経路（直接のRPC・更新）でも DB の制約で止まる
    const any1 = (await u1.from("lotteries").select("id").limit(1)).data![0].id;
    const bad = await u1.from("lotteries").update({ procedure_start_precision: "date_only", procedure_start_date: "2027-01-01", procedure_deadline_precision: "date_only", procedure_deadline_date: "2026-12-01" }).eq("id", any1);
    expect(bad.error).not.toBeNull();
  });

  it("プロフィール別の設定: 自世帯のプロフィールだけ読み書きでき、他世帯からは見えない・書けない。未ログインは不可", async () => {
    const put = (db: Db, hid: string, pid: string, settings: Record<string, unknown>) => any(db).from("profile_settings").upsert({ profile_id: pid, household_id: hid, settings }, { onConflict: "profile_id" });
    expect((await put(u1, hid1, a1, { nav: ["lotteries", "finance"], cardView: "simple", theme: "dark" })).error).toBeNull();
    const got = await any(u1).from("profile_settings").select("settings").eq("profile_id", a1).single();
    expect(got.data.settings).toMatchObject({ cardView: "simple" });
    // 他世帯からは見えない
    expect((await any(u2).from("profile_settings").select("profile_id")).data ?? []).toHaveLength(0);
    // 他世帯のプロフィールへは書けない（RLS・複合外部キー）。世帯IDを偽っても不可
    expect((await put(u2, hid2, a1, { cardView: "detail" })).error).not.toBeNull();
    expect((await put(u2, hid1, a1, { cardView: "detail" })).error).not.toBeNull();
    expect((await put(u1, hid1, a2, { cardView: "detail" })).error).not.toBeNull();
    // 大きすぎる設定・配列は拒否
    expect((await put(u1, hid1, b1, { big: "x".repeat(9000) })).error).not.toBeNull();
    expect((await put(u1, hid1, b1, [] as unknown as Record<string, unknown>)).error).not.toBeNull();
    // 未ログイン
    expect((await any(anonClient() as unknown as Db).from("profile_settings").select("profile_id")).data ?? []).toHaveLength(0);
    // 削除はできない（権限なし）
    expect((await any(u1).from("profile_settings").delete().eq("profile_id", a1).select()).data ?? []).toHaveLength(0);
  });

  it("設定のコピー: 選んだ項目だけがコピー先へ上書きされ、他の項目は変わらない。コピー元に無い項目は消える", async () => {
    await any(u1).from("profile_settings").upsert({ profile_id: b1, household_id: hid1, settings: { cardView: "detail", theme: "light", cardDisplay: { deadline: false } } }, { onConflict: "profile_id" });
    const r = await any(u1).rpc("copy_profile_settings", { p_from: a1, p_to: b1, p_keys: ["nav", "cardView"], p_actor: a1 });
    expect(r.error).toBeNull();
    const b = (await any(u1).from("profile_settings").select("settings").eq("profile_id", b1).single()).data.settings;
    expect(b).toEqual({ nav: ["lotteries", "finance"], cardView: "simple", theme: "light", cardDisplay: { deadline: false } }); // theme・cardDisplay は変わらない
    // コピー元に無い項目を選ぶと、コピー先でも未設定に戻る
    expect((await any(u1).rpc("copy_profile_settings", { p_from: a1, p_to: b1, p_keys: ["cardDisplay"], p_actor: a1 })).error).toBeNull();
    expect((await any(u1).from("profile_settings").select("settings").eq("profile_id", b1).single()).data.settings.cardDisplay).toBeUndefined();
    // 監査ログに設定の更新が残る
    expect(((await u1.from("audit_logs").select("id").eq("entity_type", "profile_settings")).data ?? []).length).toBeGreaterThan(0);
  });

  it("設定のコピーの認可と不正入力: 他世帯のプロフィール・自分自身・不正なキーは拒否され、何も変わらない", async () => {
    const before = (await any(u1).from("profile_settings").select("settings").eq("profile_id", b1).single()).data.settings;
    const call = (db: Db, args: Record<string, unknown>) => any(db).rpc("copy_profile_settings", { p_actor: null, ...args });
    expect((await call(u2, { p_from: a1, p_to: a2, p_keys: ["nav"] })).error).not.toBeNull(); // 他世帯のコピー元
    expect((await call(u2, { p_from: a2, p_to: b1, p_keys: ["nav"] })).error).not.toBeNull(); // 他世帯のコピー先
    expect((await call(u1, { p_from: a1, p_to: a1, p_keys: ["nav"] })).error).not.toBeNull(); // 同じプロフィール
    expect((await call(u1, { p_from: a1, p_to: b1, p_keys: [] })).error).not.toBeNull();
    expect((await call(u1, { p_from: a1, p_to: b1, p_keys: ["nav", "x'; drop table"] })).error).not.toBeNull(); // 途中で不正 → 全体が取り消される
    expect((await call(u1, { p_from: a1, p_to: b1, p_keys: ["nav"], p_actor: a2 })).error).not.toBeNull(); // 他世帯のプロフィールを操作者にできない
    expect((await call(anonClient() as unknown as Db, { p_from: a1, p_to: b1, p_keys: ["nav"] })).error).not.toBeNull();
    const after = (await any(u1).from("profile_settings").select("settings").eq("profile_id", b1).single()).data.settings;
    expect(after).toEqual(before);
    // 他世帯の設定は一切変わっていない
    expect((await any(u2).from("profile_settings").select("profile_id")).data ?? []).toHaveLength(0);
  });
});
