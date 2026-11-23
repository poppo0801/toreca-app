/**
 * 個別購入・一括購入と購入記録（シングルカード）・収支の連携、収録パックマスターの結合テスト（実Supabase・RLS適用下）。
 *   npm run test:db
 * ①収録パックマスター: ログインした利用者は読めるが書けない／SV1S・SV2a・SV8 など
 * ②個別購入（151図鑑・相場調査メモ）: 購入記録（シングルカード）に明細が1件追加される／同じ購入者・同じ購入日は既存の記録へ合算（枚数・金額）／日付・購入者が違えば別の記録／二重購入は拒否
 * ③訂正・削除: 収集カードの削除→明細も取り除かれ（収支が減る）、空の購入記録は削除済みになる／金額の訂正→明細の金額／購入日の訂正→明細が新しい日の記録へ移る
 * ④一括購入も同じ合算（個別購入と同じ日・同じ購入者なら1件の購入記録）。再送しても二重にならない。購入記録の合計＝明細の合計（収支は購入記録から集計するので二重計上しない）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い
type Db = any;

describe.skipIf(!dbTestsEnabled)("個別購入・一括購入と購入記録・収支、収録パックマスター", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let pA: string;
  let pB: string;
  let n = 0;
  const run = Math.random().toString(36).slice(2, 6);

  const zprice = async (o: Record<string, unknown> = {}) => {
    n++;
    const { data, error } = await u1.from("zukan_price_records").insert({ household_id: hid, profile_id: pA, dex_no: 25, card_name: "ピカチュウ" + n, set_name: "151", card_number: `0${n}/165`, rarity: "SAR", store_name: "梅田店", chain_name: "カードラボ", condition: "S", price_yen: 2000, ...o }).select("*").single();
    expect(error).toBeNull();
    return data as { id: string };
  };
  const mprice = async (o: Record<string, unknown> = {}, price: Record<string, unknown> = {}) => {
    n++;
    const { data: c, error: e1 } = await u1.from("market_cards").insert({ household_id: hid, profile_id: pA, name: "テスト" + n, set_name: "SV" + n + run, card_number: `00${n}/100`, rarity: "SAR", ...o }).select("*").single();
    expect(e1).toBeNull();
    const { data, error } = await u1.from("market_prices").insert({ household_id: hid, profile_id: pA, card_id: c.id, store_name: "垂水店", chain_name: "トレカキャピタル", condition: "A", price_yen: 1000, ...price }).select("*").single();
    expect(error).toBeNull();
    return data as { id: string };
  };
  const buyZ = (id: string, date: string, profile = pA) => u1.rpc("zukan_buy_from_price_tx", { p_price: id, p_acquired_on: date, p_profile: profile });
  const buyM = (id: string, date: string, profile = pA) => u1.rpc("market_buy_from_price_tx", { p_price: id, p_purchased_on: date, p_profile: profile });
  type Single = { id: string; store_label: string; items: { id: string; amount_paid: number; quantity: number; product_label: string }[] };
  /** 購入者・日付の単品購入記録（削除済みを除く）と、その明細 */
  const singles = async (date: string, buyer = pA): Promise<Single[]> => {
    const { data } = await u1.from("purchases").select("id,store_label,archived_at").eq("buyer_profile_id", buyer).eq("purchased_date", date).eq("category", "single_card").is("archived_at", null);
    const out: Single[] = [];
    for (const p of (data ?? []) as { id: string; store_label: string }[]) {
      const { data: items } = await u1.from("purchase_items").select("id,amount_paid,quantity,product_label").eq("purchase_id", p.id);
      out.push({ ...p, items: items ?? [] });
    }
    return out;
  };
  const total = (s: Single[]) => s.reduce((a, p) => a + p.items.reduce((b, i) => b + i.amount_paid, 0), 0);

  beforeAll(async () => {
    const a = await signInTestUser(admin, "mpl", 1);
    const b = await signInTestUser(admin, "mpl", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    pA = ((await u1.from("profiles").select("id").order("sort_order")).data as { id: string }[])[0].id;
    const { data: second } = await admin.from("profiles").insert({ household_id: hid, label: "購入者B" + run, initial: "B", sort_order: 97 } as never).select("id").single();
    pB = (second as { id: string }).id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("①収録パックマスター: 利用者は読めるが書けない。SV1S=スカーレットex・SV2a=ポケモンカード151・SV8=超電ブレイカー。同じマーク×商品は一意", async () => {
    const { data, error } = await u1.from("expansion_marks").select("mark,set_name,active").in("mark", ["SV1S", "SV2a", "SV8", "SV1a"]);
    expect(error).toBeNull();
    const by = Object.fromEntries((data ?? []).map((r: { mark: string; set_name: string }) => [r.mark, r.set_name]));
    expect(by).toMatchObject({ SV1S: "スカーレットex", SV2a: "ポケモンカード151", SV8: "超電ブレイカー", SV1a: "トリプレットビート" });
    expect((await u1.from("expansion_marks").insert({ mark: "ZZ1", product_id: "x" + run, product_name: "n", set_name: "n" })).error).not.toBeNull();
    expect((await u1.from("expansion_marks").update({ set_name: "改ざん" }).eq("mark", "SV8")).data ?? []).toHaveLength(0);
    expect((await admin.from("expansion_marks").insert({ mark: "SV8", product_id: "923", product_name: "重複", set_name: "重複" })).error).not.toBeNull();
  });

  it("②個別購入: 購入記録（シングルカード）へ明細が追加される。同じ購入者・同じ購入日は既存の記録に合算（金額・枚数）。日付・購入者が違えば別の記録。二重購入は拒否", async () => {
    const D = "2026-12-01";
    const z1 = await zprice({ price_yen: 2000 });
    const m1 = await mprice({}, { price_yen: 1500 });
    const z2 = await zprice({ price_yen: 700, store_name: "三宮店", chain_name: "カードラボ" });
    expect((await buyZ(z1.id, D)).error).toBeNull();
    let s = await singles(D);
    expect(s).toHaveLength(1);
    expect(s[0].items).toHaveLength(1);
    expect(total(s)).toBe(2000);
    expect((await buyM(m1.id, D)).error).toBeNull(); // 相場調査メモ側も同じ記録へ合算
    s = await singles(D);
    expect(s).toHaveLength(1);
    expect(s[0].items).toHaveLength(2);
    expect(total(s)).toBe(3500);
    expect(s[0].items.every((i) => i.quantity === 1)).toBe(true);
    expect(s[0].store_label).toBe("複数店舗"); // 店舗が違うとき
    expect((await buyZ(z2.id, D)).error).toBeNull();
    s = await singles(D);
    expect(s).toHaveLength(1);
    expect(s[0].items).toHaveLength(3);
    expect(total(s)).toBe(4200); // 合算（収支は購入記録の明細から集計される）
    // 明細は個別の購入内容を追跡できる（カード名・店舗・状態つき）
    expect(s[0].items.map((i) => i.product_label).some((l) => l.includes("梅田店") && l.includes("状態S"))).toBe(true);
    // 収集カード・購入記録（相場調査メモ）が明細にひも付く
    const card = (await u1.from("zukan_cards").select("purchase_item_id,purchase_amount_yen,acquired_on").eq("price_record_id", z1.id).single()).data;
    expect(card).toMatchObject({ purchase_amount_yen: 2000, acquired_on: D });
    expect(s[0].items.map((i) => i.id)).toContain(card.purchase_item_id);
    // 二重購入は拒否（明細も増えない）
    expect((await buyZ(z1.id, D)).error?.code).toBe("23505");
    expect((await buyM(m1.id, D)).error?.code).toBe("23505");
    expect((await singles(D))[0].items).toHaveLength(3);
    // 別の購入日 → 別の記録。別の購入者 → 別の記録
    const z3 = await zprice({ price_yen: 300 });
    const z4 = await zprice({ price_yen: 400 });
    expect((await buyZ(z3.id, "2026-12-02")).error).toBeNull();
    expect((await buyZ(z4.id, D, pB)).error).toBeNull();
    expect(await singles("2026-12-02")).toHaveLength(1);
    expect(total(await singles(D))).toBe(4200);
    expect(total(await singles(D, pB))).toBe(400);
    // 他世帯の記録は購入できない
    expect((await u2.rpc("zukan_buy_from_price_tx", { p_price: z3.id, p_acquired_on: D, p_profile: pA })).error).not.toBeNull();
  });

  it("③訂正・削除: 収集カードの削除で明細も消え収支が減る（空の購入記録は削除済み）／金額の訂正は明細に反映／購入日の訂正は明細が新しい日の記録へ移る", async () => {
    const D1 = "2026-12-10";
    const D2 = "2026-12-11";
    const a = await zprice({ price_yen: 1000 });
    const b = await zprice({ price_yen: 2500 });
    await buyZ(a.id, D1);
    await buyZ(b.id, D1);
    expect(total(await singles(D1))).toBe(3500);
    // 金額の訂正
    const cardA = (await u1.from("zukan_cards").select("id").eq("price_record_id", a.id).single()).data;
    expect((await u1.from("zukan_cards").update({ purchase_amount_yen: 1200 }).eq("id", cardA.id)).error).toBeNull();
    expect(total(await singles(D1))).toBe(3700);
    // 購入日の訂正: D1 → D2（D2 に既存の記録があれば合算）
    const c = await zprice({ price_yen: 50 });
    await buyZ(c.id, D2);
    expect((await u1.from("zukan_cards").update({ acquired_on: D2 }).eq("id", cardA.id)).error).toBeNull();
    expect(total(await singles(D1))).toBe(2500);
    const s2 = await singles(D2);
    expect(s2).toHaveLength(1);
    expect(total(s2)).toBe(1250);
    expect(s2[0].items).toHaveLength(2);
    expect((await u1.from("zukan_cards").select("purchase_item_id").eq("id", cardA.id).single()).data.purchase_item_id).toBe(s2[0].items.find((i) => i.amount_paid === 1200)!.id);
    // 削除: 収集カードを消すと明細も取り除かれる
    const cardB = (await u1.from("zukan_cards").select("id").eq("price_record_id", b.id).single()).data;
    expect((await u1.from("zukan_cards").delete().eq("id", cardB.id)).error).toBeNull();
    expect(await singles(D1)).toHaveLength(0); // 明細が無くなった購入記録は削除済み（物理削除はしない）
    const archived = ((await u1.from("purchases").select("id,archived_at").eq("buyer_profile_id", pA).eq("purchased_date", D1).eq("category", "single_card")).data ?? []) as { archived_at: string | null }[];
    expect(archived).toHaveLength(1);
    expect(archived[0].archived_at).not.toBeNull();
    expect(total(await singles(D2))).toBe(1250);
    // 相場調査メモ側の購入の削除・金額訂正
    const m = await mprice({}, { price_yen: 800 });
    await buyM(m.id, D2);
    expect(total(await singles(D2))).toBe(2050);
    const mp = (await u1.from("market_purchases").select("id").eq("price_id", m.id).single()).data;
    expect((await u1.from("market_purchases").update({ price_yen: 900 }).eq("id", mp.id)).error).toBeNull();
    expect(total(await singles(D2))).toBe(2150);
    expect((await u1.from("market_purchases").delete().eq("id", mp.id)).error).toBeNull();
    expect(total(await singles(D2))).toBe(1250);
  });

  it("④一括購入も同じ合算（同じ日・同じ購入者なら個別購入と1件の購入記録）。再送しても二重にならない。購入済みを含むと何も作らない", async () => {
    const D = "2026-12-20";
    const solo = await zprice({ price_yen: 600 });
    expect((await buyZ(solo.id, D)).error).toBeNull();
    const z = await zprice({ price_yen: 1100 });
    const m = await mprice({}, { price_yen: 2200 });
    const op = crypto.randomUUID();
    const rows = [{ refs: [{ source: "zukan", id: z.id }] }, { refs: [{ source: "market", id: m.id }] }];
    const first = await u1.rpc("market_bulk_buy_tx", { p_op: op, p_rows: rows, p_date: D, p_profile: pA });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ item_count: 2, total_yen: 3300, replay: false });
    const s = await singles(D);
    expect(s).toHaveLength(1); // 個別購入の記録に合算
    expect(s[0].items).toHaveLength(3);
    expect(total(s)).toBe(3900);
    expect(first.data.purchase_id).toBe(s[0].id);
    // 再送（同じ操作ID）は何も増やさない
    const replay = await u1.rpc("market_bulk_buy_tx", { p_op: op, p_rows: rows, p_date: D, p_profile: pA });
    expect(replay.data).toMatchObject({ replay: true, item_count: 2, total_yen: 3300 });
    expect(total(await singles(D))).toBe(3900);
    // 別の操作でも購入済みを含むと何も作らない
    const extra = await zprice({ price_yen: 5 });
    const bad = await u1.rpc("market_bulk_buy_tx", { p_op: crypto.randomUUID(), p_rows: [...rows, { refs: [{ source: "zukan", id: extra.id }] }], p_date: D, p_profile: pA });
    expect(bad.error).not.toBeNull();
    expect(total(await singles(D))).toBe(3900);
    expect((await singles(D))[0].items).toHaveLength(3);
    // 一括購入した収集カードの削除も明細を取り除く
    const cardZ = (await u1.from("zukan_cards").select("id").eq("price_record_id", z.id).single()).data;
    await u1.from("zukan_cards").delete().eq("id", cardZ.id);
    expect(total(await singles(D))).toBe(2800);
  });
});
