/**
 * 相場管理の機能改善の結合テスト（実Supabase・RLS適用下）: 状態ランク S/A/B/C/D・販売情報の更新/完売の履歴・購入予定の一括購入。
 *   npm run test:db
 * ①状態ランクの制約（旧ランクは拒否）②更新・完売: 重複させない・追記専用・完売→更新で販売中へ・他世帯から操作不可・価格記録は書き換わらない
 * ③完売は購入予定へ新規追加できない（既存のマークは残る）④一括購入: 購入記録（シングルカード・1件）・151図鑑・相場調査メモの購入情報を1回で作り、マークを解除。
 *   同じ操作IDの再送・同時実行で1回だけ／別の操作でも購入済みは拒否／完売・世帯外・購入済みが含まれると何も作らない／金額はサーバーが記録から読む（収支は購入記録から集計されるため二重計上しない）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い
type Db = any;
const uuidv4 = () => crypto.randomUUID();

describe.skipIf(!dbTestsEnabled)("相場管理: ランク・更新/完売・一括購入", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let pA: string;
  let n = 0;
  const run = Math.random().toString(36).slice(2, 6);

  const card = async (o: Record<string, unknown> = {}) => {
    n++;
    const { data, error } = await u1.from("market_cards").insert({ household_id: hid, profile_id: pA, name: "テスト" + n, set_name: "SV" + n + run, card_number: `00${n}/100`, rarity: "SAR", ...o }).select("*").single();
    expect(error).toBeNull();
    return data as { id: string };
  };
  const price = async (cardId: string, o: Record<string, unknown> = {}) => {
    const { data, error } = await u1.from("market_prices").insert({ household_id: hid, profile_id: pA, card_id: cardId, store_name: "垂水店", chain_name: "トレカキャピタル", condition: "A", price_yen: 1000, ...o }).select("*").single();
    expect(error).toBeNull();
    return data as { id: string };
  };
  const zprice = async (o: Record<string, unknown> = {}) => {
    n++;
    const { data, error } = await u1.from("zukan_price_records").insert({ household_id: hid, profile_id: pA, dex_no: 25, card_name: "ピカチュウ" + n, set_name: "151", card_number: `0${n}/165`, rarity: "SAR", store_name: "梅田店", chain_name: "カードラボ", condition: "S", price_yen: 2000, ...o }).select("*").single();
    expect(error).toBeNull();
    return data as { id: string };
  };
  const ev = async (kind: "market" | "zukan", id: string, event: string) => u1.rpc("market_record_event", { p_kind: kind, p_id: id, p_event: event, p_profile: pA });
  const events = async (col: "market_price_id" | "zukan_price_id", id: string) => ((await u1.from("market_price_events").select("*").eq(col, id).order("created_at")).data ?? []) as { event: string }[];
  const bulk = (op: string, rows: unknown[], client: Db = u1, profile = pA) => client.rpc("market_bulk_buy_tx", { p_op: op, p_rows: rows, p_date: "2026-11-24", p_profile: profile });
  const mark = (kind: string, id: string, on: boolean) => u1.rpc("market_set_plan_mark", { p_kind: kind, p_id: id, p_on: on, p_profile: pA });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "mevb", 1);
    const b = await signInTestUser(admin, "mevb", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    pA = ((await u1.from("profiles").select("id").order("sort_order")).data as { id: string }[])[0].id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("①状態ランク: S/A/B/C/D だけ受け付ける（旧 A+・B+ は拒否）。151図鑑の収集カードは空欄も可", async () => {
    const c = await card();
    for (const ok of ["S", "A", "B", "C", "D"]) expect((await u1.from("market_prices").insert({ household_id: hid, profile_id: pA, card_id: c.id, store_name: "x" + ok, condition: ok, price_yen: 1 })).error).toBeNull();
    for (const bad of ["A+", "B+", "E", ""]) expect((await u1.from("market_prices").insert({ household_id: hid, profile_id: pA, card_id: c.id, store_name: "y", condition: bad, price_yen: 1 })).error).not.toBeNull();
    expect((await u1.from("zukan_cards").insert({ household_id: hid, profile_id: pA, dex_no: 1, card_name: "フシギダネ", acquire_method: "pack_opening", condition: "" })).error).toBeNull();
    expect((await u1.from("zukan_cards").insert({ household_id: hid, profile_id: pA, dex_no: 1, card_name: "フシギダネ", acquire_method: "pack_opening", condition: "A+" })).error).not.toBeNull();
    expect((await u1.from("zukan_price_records").insert({ household_id: hid, profile_id: pA, dex_no: 1, card_name: "x", store_name: "x", chain_name: "x", condition: "B+", price_yen: 1 })).error).not.toBeNull();
  });

  it("②更新・完売: 同じ事象は重複させない・追記専用・完売→更新で販売中へ。価格記録は書き換わらない。他世帯は操作できない", async () => {
    const c = await card();
    const p = await price(c.id, { surveyed_on: "2020-01-01" }); // 過去の調査
    expect((await ev("market", p.id, "confirmed")).error).toBeNull();
    expect((await ev("market", p.id, "confirmed")).error).toBeNull(); // 同じ日の再度の更新は記録しない
    expect(await events("market_price_id", p.id)).toHaveLength(1);
    expect((await ev("market", p.id, "sold_out")).error).toBeNull();
    expect((await ev("market", p.id, "sold_out")).error).toBeNull(); // 完売の重複も記録しない
    expect((await events("market_price_id", p.id)).map((e) => e.event)).toEqual(["confirmed", "sold_out"]);
    expect((await ev("market", p.id, "confirmed")).error).toBeNull(); // 完売から販売中に戻す
    expect((await events("market_price_id", p.id)).map((e) => e.event)).toEqual(["confirmed", "sold_out", "confirmed"]);
    // 調査した当日の最初の更新は、調査自体が確認なので記録しない
    const today = (await u1.rpc("market_record_event", { p_kind: "market", p_id: (await price(c.id, { store_name: "今日店", surveyed_on: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date()) })).id, p_event: "confirmed", p_profile: pA })).error;
    expect(today).toBeNull();
    // 価格記録そのものは変わらない
    const after = (await u1.from("market_prices").select("price_yen,condition,surveyed_on").eq("id", p.id).single()).data;
    expect(after).toMatchObject({ price_yen: 1000, condition: "A", surveyed_on: "2020-01-01" });
    // 追記専用（更新・削除できない）
    expect((await admin.from("market_price_events").update({ event: "confirmed" }).eq("market_price_id", p.id)).error).not.toBeNull();
    // 他世帯・不正な値・存在しない記録
    expect((await u2.rpc("market_record_event", { p_kind: "market", p_id: p.id, p_event: "sold_out", p_profile: null })).error).not.toBeNull();
    expect((await u2.from("market_price_events").select("id").eq("market_price_id", p.id)).data ?? []).toHaveLength(0);
    expect((await ev("market", p.id, "bogus")).error).not.toBeNull();
    expect((await ev("market", "00000000-0000-4000-8000-000000000000", "confirmed")).error?.code).toBe("P0002");
    // 151図鑑側の記録にも同じ（別々の記録）
    const z = await zprice({ surveyed_on: "2020-01-01" });
    expect((await ev("zukan", z.id, "sold_out")).error).toBeNull();
    expect((await events("zukan_price_id", z.id)).map((e) => e.event)).toEqual(["sold_out"]);
    // 記録した人（プロフィール）を削除しても、履歴は残る（記録者だけ外れる。追記専用でも、この更新は許す）
    const { data: tmp } = await admin.from("profiles").insert({ household_id: hid, label: "削除予定E" + n, initial: "削", sort_order: 98 } as never).select("id").single();
    const zz = await zprice({ surveyed_on: "2020-01-01" });
    await u1.rpc("market_record_event", { p_kind: "zukan", p_id: zz.id, p_event: "sold_out", p_profile: (tmp as { id: string }).id });
    expect((await admin.from("profiles").delete().eq("id", (tmp as { id: string }).id)).error).toBeNull();
    const kept = ((await u1.from("market_price_events").select("created_by_profile_id,event").eq("zukan_price_id", zz.id)).data ?? []) as { created_by_profile_id: string | null; event: string }[];
    expect(kept).toEqual([{ created_by_profile_id: null, event: "sold_out" }]);
    // 記録を削除すると履歴も消える
    await u1.from("zukan_price_records").delete().eq("id", z.id);
    expect(await events("zukan_price_id", z.id)).toHaveLength(0);
  });

  it("③完売は購入予定へ新規追加できない。既に購入予定のものが完売になっても、マークは外れない（完売の表示は呼び出し側）。更新で再び追加できる", async () => {
    const c = await card();
    const p = await price(c.id, { surveyed_on: "2020-01-01" });
    const q = await price(c.id, { store_name: "別店", surveyed_on: "2020-01-01" });
    await mark("market", q.id, true);
    await ev("market", q.id, "sold_out");
    expect((await u1.from("market_plan_marks").select("id").eq("market_price_id", q.id)).data).toHaveLength(1); // 勝手に消えない
    await ev("market", p.id, "sold_out");
    const r = await mark("market", p.id, true);
    expect(r.error).not.toBeNull(); // 完売は新規追加不可
    expect(String(r.error.message)).toContain("sold_out");
    expect((await mark("market", q.id, true)).error).toBeNull(); // 既に購入予定のものは操作できる（冪等）
    await ev("market", p.id, "confirmed"); // 販売中に戻す
    expect((await mark("market", p.id, true)).error).toBeNull();
  });

  it("④一括購入: 購入記録（シングルカード1件・明細＝カードごと）・151図鑑の収集カード・相場調査メモの購入記録を1回で作り、マークを解除する。金額はサーバーが記録から読む", async () => {
    const c = await card();
    const m1 = await price(c.id, { price_yen: 1500, condition: "B", store_name: "A店" });
    const z1 = await zprice({ price_yen: 3000, store_name: "B店" });
    // 同じ内容が両方の記録元にある行（refs 2つ）: 1枚として数える
    const c2 = await card({ name: "共通", set_name: "SVC" + run, card_number: "100/100" });
    const mBoth = await price(c2.id, { price_yen: 700, condition: "C", store_name: "C店", chain_name: "系列C" });
    const zBoth = await zprice({ card_name: "共通", set_name: "SVC" + run, card_number: "100/100", price_yen: 700, condition: "C", store_name: "C店", chain_name: "系列C" });
    for (const [k, id] of [["market", m1.id], ["zukan", z1.id], ["market", mBoth.id], ["zukan", zBoth.id]] as const) await mark(k, id, true);
    const before = ((await u1.from("purchases").select("id", { count: "exact", head: true }).eq("category", "single_card")).count ?? 0) as number;
    const op = uuidv4();
    const rows = [{ refs: [{ source: "market", id: m1.id }] }, { refs: [{ source: "zukan", id: z1.id }] }, { refs: [{ source: "market", id: mBoth.id }, { source: "zukan", id: zBoth.id }] }];
    const r = await bulk(op, rows);
    expect(r.error?.message ?? null).toBeNull();
    expect(r.data).toMatchObject({ item_count: 3, total_yen: 1500 + 3000 + 700, replay: false });
    // 購入記録: 1件（シングルカード）・明細3件（合計一致）。収支は購入記録から集計されるので、ここ以外に支出は作らない
    const pur = (await u1.from("purchases").select("*").eq("id", r.data.purchase_id).single()).data;
    expect(pur).toMatchObject({ category: "single_card", source_kind: "manual", buyer_profile_id: pA, purchased_date: "2026-11-24" });
    const items = ((await u1.from("purchase_items").select("*").eq("purchase_id", r.data.purchase_id)).data ?? []) as { amount_paid: number; unit: string; quantity: number; product_label: string }[];
    expect(items).toHaveLength(3);
    expect(items.reduce((t, i) => t + i.amount_paid, 0)).toBe(5200);
    expect(items.every((i) => i.unit === "piece" && i.quantity === 1)).toBe(true);
    expect(((await u1.from("purchases").select("id", { count: "exact", head: true }).eq("category", "single_card")).count ?? 0) - before).toBe(1);
    // 151図鑑・相場調査メモの購入情報（両方に同じ内容がある行は両方に反映。支出は1枚分だけ）
    expect(((await u1.from("market_purchases").select("*").in("price_id", [m1.id, mBoth.id])).data ?? []).length).toBe(2);
    const zc = ((await u1.from("zukan_cards").select("*").in("price_record_id", [z1.id, zBoth.id])).data ?? []) as { acquire_method: string; purchase_amount_yen: number }[];
    expect(zc).toHaveLength(2);
    expect(zc.every((x) => x.acquire_method === "single_purchase")).toBe(true);
    // マークは全て解除
    expect(((await u1.from("market_plan_marks").select("id").in("market_price_id", [m1.id, mBoth.id])).data ?? []).length).toBe(0);
    expect(((await u1.from("market_plan_marks").select("id").in("zukan_price_id", [z1.id, zBoth.id])).data ?? []).length).toBe(0);
    // 同じ操作IDの再送: 何も作らず、同じ結果を返す（二重購入しない）
    const again = await bulk(op, rows);
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ purchase_id: r.data.purchase_id, replay: true });
    expect(((await u1.from("purchases").select("id", { count: "exact", head: true }).eq("category", "single_card")).count ?? 0) - before).toBe(1);
    expect(((await u1.from("zukan_cards").select("id").in("price_record_id", [z1.id, zBoth.id])).data ?? []).length).toBe(2);
    // 別の操作IDでも、購入済みの記録は拒否（途中まで作らない）
    const dup = await bulk(uuidv4(), rows);
    expect(dup.error?.code).toBe("P0005");
    expect(((await u1.from("purchases").select("id", { count: "exact", head: true }).eq("category", "single_card")).count ?? 0) - before).toBe(1);
  });

  it("⑤同時実行・失敗時の不整合なし: 同じ操作の同時送信は1回だけ。完売が含まれる・世帯外の記録・不正なプロフィールは、何も作らず失敗（購入予定も残る）", async () => {
    const c = await card();
    const a = await price(c.id, { store_name: "並列店A", price_yen: 100 });
    await mark("market", a.id, true);
    const op = uuidv4();
    const rows = [{ refs: [{ source: "market", id: a.id }] }];
    const rs = await Promise.all([bulk(op, rows), bulk(op, rows), bulk(op, rows)]);
    expect(rs.every((x) => !x.error)).toBe(true);
    expect(new Set(rs.map((x) => x.data.purchase_id)).size).toBe(1);
    expect(rs.filter((x) => !x.data.replay)).toHaveLength(1);
    expect(((await u1.from("market_purchases").select("id").eq("price_id", a.id)).data ?? []).length).toBe(1);
    // 完売が1つでも含まれると全体が失敗
    const ok = await price(c.id, { store_name: "正常店", price_yen: 200 });
    const sold = await price(c.id, { store_name: "完売店", price_yen: 300 });
    await mark("market", ok.id, true);
    await mark("market", sold.id, true);
    await ev("market", sold.id, "sold_out");
    const cnt = async () => ((await u1.from("market_purchases").select("id", { count: "exact", head: true })).count ?? 0) as number;
    const base = await cnt();
    const f = await bulk(uuidv4(), [{ refs: [{ source: "market", id: ok.id }] }, { refs: [{ source: "market", id: sold.id }] }]);
    expect(f.error?.code).toBe("P0004");
    expect(await cnt()).toBe(base); // 正常な行も作られていない
    expect(((await u1.from("market_plan_marks").select("id").eq("market_price_id", ok.id)).data ?? []).length).toBe(1); // マークも残る
    // 世帯外の記録・不正なプロフィール・不正な形式
    const foreign = await bulk(uuidv4(), [{ refs: [{ source: "market", id: ok.id }] }], u2);
    expect(foreign.error).not.toBeNull();
    expect((await bulk(uuidv4(), [{ refs: [{ source: "market", id: ok.id }] }], u1, "00000000-0000-4000-8000-000000000000")).error).not.toBeNull();
    expect((await bulk(uuidv4(), [])).error).not.toBeNull();
    expect((await bulk(uuidv4(), [{ refs: [] }])).error).not.toBeNull();
    expect(await cnt()).toBe(base);
    // 行内の価格・状態が食い違う記録は拒否
    const z = await zprice({ price_yen: 999, condition: "D" });
    const mix = await bulk(uuidv4(), [{ refs: [{ source: "market", id: ok.id }, { source: "zukan", id: z.id }] }]);
    expect(mix.error).not.toBeNull();
    expect(await cnt()).toBe(base);
  });
});
