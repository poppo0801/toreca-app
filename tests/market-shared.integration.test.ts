/**
 * UI改修の結合テスト（実Supabase・RLS適用下）: 相場管理データ（151図鑑・相場調査メモ）の世帯共通化と、購入予定マーク。
 *   npm run test:db
 * 確認すること: ①プロフィールA・Bが同じ記録を閲覧・追加・編集・削除できる／他の世帯からは見えない ②カードの一意制約は世帯単位（別プロフィールの同じカードは重複登録できない）
 * ③プロフィールを削除しても共有の記録は消えない（作成者だけが外れる）④購入予定マーク: ON/OFFの指定（冪等・同時操作）・世帯共通・記録の削除で消える・他世帯から操作できない・当日以外は無効（日付で判定できる）
 * ⑤応募・購入・当選などの他の表には影響しない。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い
type Db = any;

describe.skipIf(!dbTestsEnabled)("UI改修: 相場管理データの世帯共通化・購入予定マーク", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let pA: string;
  let pB: string;

  const card = (o: Record<string, unknown> = {}) => ({ household_id: hid, profile_id: pA, name: "ミロカロス", set_name: "SV8", card_number: "100/106", rarity: "SAR", ...o });
  const price = (cardId: string, o: Record<string, unknown> = {}) => ({ household_id: hid, profile_id: pA, card_id: cardId, store_name: "垂水店", chain_name: "トレカキャピタル", condition: "A", price_yen: 11000, ...o });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "mshare", 1);
    const b = await signInTestUser(admin, "mshare", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    const profs = (await u1.from("profiles").select("id").order("sort_order")).data as { id: string }[];
    pA = profs[0].id;
    pB = profs[1].id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("①プロフィールAが作った記録を、プロフィールBが閲覧・編集・削除できる（アプリは profile で絞らない）。更新者が履歴に残る。別の世帯からは見えない", async () => {
    const c = (await u1.from("market_cards").insert(card()).select("*").single()).data as { id: string };
    const p = (await u1.from("market_prices").insert(price(c.id)).select("*").single()).data as { id: string };
    const z = (await u1.from("zukan_price_records").insert({ household_id: hid, profile_id: pA, dex_no: 25, card_name: "ミロカロス", store_name: "梅田店", chain_name: "カードラボ", condition: "B", price_yen: 9000 }).select("*").single()).data as { id: string };
    // プロフィールを問わず、世帯のログインから全て読める
    expect(((await u2.from("market_cards").select("id").eq("household_id", hid)).data ?? []).length).toBe(0); // 別世帯のログイン（u2）からは見えない
    expect(((await u1.from("market_prices").select("id").eq("id", p.id)).data ?? []).length).toBe(1);
    // 編集（更新者 = プロフィールB）
    const up = await u1.from("market_prices").update({ price_yen: 10500, updated_by_profile_id: pB }).eq("id", p.id).select("*").single();
    expect(up.error).toBeNull();
    expect(up.data.price_yen).toBe(10500);
    expect(up.data.profile_id).toBe(pA); // 作成者は保持
    expect(up.data.updated_by_profile_id).toBe(pB); // 更新者の内部履歴
    // 削除
    expect((await u1.from("zukan_price_records").delete().eq("id", z.id).select("id")).data).toHaveLength(1);
    // 他世帯からの改ざんはできない（0件）
    expect((await u2.from("market_prices").update({ price_yen: 1 }).eq("id", p.id).select("id")).data ?? []).toHaveLength(0);
    expect((await u2.from("market_prices").delete().eq("id", p.id).select("id")).data ?? []).toHaveLength(0);
  });

  it("②カードの一意制約は世帯単位（別プロフィールが同じセット・番号・レアリティを重複登録できない）。補足の違いやレアリティ違いは別のカード", async () => {
    const dup = await u1.from("market_cards").insert(card({ profile_id: pB })).select("id");
    expect(dup.error?.code).toBe("23505");
    expect((await u1.from("market_cards").insert(card({ profile_id: pB, rarity: "SR" })).select("id")).error).toBeNull(); // レアリティが違えば別のカード
    expect((await u1.from("market_cards").insert(card({ profile_id: pB, card_number: "101/106", name: "別カード" })).select("id")).error).toBeNull();
  });

  it("③プロフィールを削除しても、共有の記録（カード・価格・図鑑の記録）は消えない。作成者だけが外れる", async () => {
    const { data: prof } = await admin.from("profiles").insert({ household_id: hid, label: "削除予定", initial: "削", sort_order: 99 } as never).select("id").single();
    const pid = (prof as { id: string }).id;
    const c = (await u1.from("market_cards").insert(card({ profile_id: pid, set_name: "SV9", card_number: "001/001" })).select("id").single()).data as { id: string };
    const p = (await u1.from("market_prices").insert(price(c.id, { profile_id: pid })).select("id").single()).data as { id: string };
    const del = await admin.from("profiles").delete().eq("id", pid);
    expect(del.error).toBeNull();
    const after = (await u1.from("market_cards").select("id,profile_id").eq("id", c.id)).data as { profile_id: string | null }[];
    expect(after).toHaveLength(1); // 共有のカードは残る
    expect(after[0].profile_id).toBeNull(); // 作成者だけ外れる
    expect(((await u1.from("market_prices").select("id").eq("id", p.id)).data ?? []).length).toBe(1);
  });

  it("④購入予定マーク: ON/OFFを指定して設定（二重のONでも1件・OFFで消える）。世帯で共通。同時のON/OFFでも一貫。記録を削除するとマークも消える。他世帯・不正な種別・存在しない記録は拒否", async () => {
    const c = (await u1.from("market_cards").insert(card({ set_name: "SV10", card_number: "010/010" })).select("id").single()).data as { id: string };
    const p = (await u1.from("market_prices").insert(price(c.id)).select("id").single()).data as { id: string };
    const marks = async () => ((await u1.from("market_plan_marks").select("*").eq("market_price_id", p.id)).data ?? []) as { marked_on: string; marked_by_profile_id: string | null }[];
    expect((await u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: true, p_profile: pA })).error).toBeNull();
    expect((await u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: true, p_profile: pB })).error).toBeNull(); // 二重のON（別のプロフィール）
    const m = await marks();
    expect(m).toHaveLength(1); // 1件のまま
    const jst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect(m[0].marked_on).toBe(jst); // 日付はサーバーが日本時間で決める
    expect(m[0].marked_by_profile_id).toBe(pB);
    // 同時操作: ON と OFF を同時に送っても、どちらかの状態で一貫（0件か1件。重複しない）
    await Promise.all([1, 2, 3, 4].map((i) => u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: i % 2 === 0, p_profile: pA })));
    expect((await marks()).length).toBeLessThanOrEqual(1);
    await u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: false, p_profile: pA });
    expect(await marks()).toHaveLength(0); // OFF
    // 前日以前のマークは無効（行は残り、判定は marked_on で行う）: 古い日付にしてからONし直すと、当日に更新される
    await u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: true, p_profile: pA });
    await admin.from("market_plan_marks").update({ marked_on: "2020-01-01" }).eq("market_price_id", p.id);
    const stale = await u1.from("market_plan_marks").select("id").eq("market_price_id", p.id).eq("marked_on", jst);
    expect(stale.data ?? []).toHaveLength(0); // 当日の条件では見えない（翌日以降は表示されない）
    expect((await u1.from("market_plan_marks").select("id").eq("market_price_id", p.id)).data).toHaveLength(1); // 行は残る
    await u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: true, p_profile: pA });
    expect((await marks())[0].marked_on).toBe(jst); // 再度ONで当日に
    // 他世帯（u2）は操作できない・読めない
    expect((await u2.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: false, p_profile: null })).error).not.toBeNull();
    expect((await u2.from("market_plan_marks").select("id").eq("market_price_id", p.id)).data ?? []).toHaveLength(0);
    // 不正な種別・存在しない記録
    expect((await u1.rpc("market_set_plan_mark", { p_kind: "x", p_id: p.id, p_on: true, p_profile: null })).error).not.toBeNull();
    expect((await u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: "00000000-0000-4000-8000-000000000000", p_on: true, p_profile: null })).error?.code).toBe("P0002");
    // 151図鑑側の記録にも付けられ、記録を削除するとマークも消える（cascade）
    const z = (await u1.from("zukan_price_records").insert({ household_id: hid, profile_id: pA, dex_no: 1, card_name: "フシギダネ", store_name: "X店", chain_name: "系列", condition: "A", price_yen: 100 }).select("id").single()).data as { id: string };
    expect((await u1.rpc("market_set_plan_mark", { p_kind: "zukan", p_id: z.id, p_on: true, p_profile: pA })).error).toBeNull();
    expect((await u1.from("market_plan_marks").select("id").eq("zukan_price_id", z.id)).data).toHaveLength(1);
    await u1.from("zukan_price_records").delete().eq("id", z.id);
    expect((await u1.from("market_plan_marks").select("id").eq("zukan_price_id", z.id)).data ?? []).toHaveLength(0);
    // マークは相場記録を変更しない
    expect(((await u1.from("market_prices").select("price_yen").eq("id", p.id)).data as { price_yen: number }[])[0].price_yen).toBe(11000);
  });

  it("⑤同じ記録に購入予定マークが付いていても、価格記録の削除は妨げない（マークは記録と一緒に消える）。利用者は種別をまたいで両方を指定できない（片方だけ）", async () => {
    const c = (await u1.from("market_cards").insert(card({ set_name: "SV11", card_number: "011/011" })).select("id").single()).data as { id: string };
    const p = (await u1.from("market_prices").insert(price(c.id)).select("id").single()).data as { id: string };
    await u1.rpc("market_set_plan_mark", { p_kind: "market", p_id: p.id, p_on: true, p_profile: pA });
    expect((await u1.from("market_prices").delete().eq("id", p.id).select("id")).data).toHaveLength(1);
    expect((await u1.from("market_plan_marks").select("id").eq("market_price_id", p.id)).data ?? []).toHaveLength(0);
    // 両方を指定する行・どちらも無い行は制約で拒否（管理者でも）
    const both = await admin.from("market_plan_marks").insert({ household_id: hid, zukan_price_id: "00000000-0000-4000-8000-000000000001", market_price_id: "00000000-0000-4000-8000-000000000002", marked_on: "2026-11-23" } as never);
    expect(both.error).not.toBeNull();
    const none = await admin.from("market_plan_marks").insert({ household_id: hid, marked_on: "2026-11-23" } as never);
    expect(none.error).not.toBeNull();
  });
});
