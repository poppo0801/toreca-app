/**
 * Stage 6K の結合テスト（実Supabase・RLS適用下）: 支出の品目区分、状態別倍率（世帯別・RLS）、状態別の取得相場。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { saveExpense } from "@/lib/server/finance-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6K: 支出の品目・状態倍率・状態別相場", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列・表は生成型に無い
  const x = (db: unknown) => db as any;
  const item = (name: string, amount: number, over: Record<string, unknown> = {}) => ({ product: { id: null, name }, quantity: 2, unit: "piece" as const, amountPaid: amount, ...over });
  const exp = (category: string | undefined, items: ReturnType<typeof item>[]) => ({ ...(category ? { category } : {}), date: "2026-10-05", store: { id: null, name: "" }, channel: "store" as const, note: "", items });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6k", 1);
    const b = await signInTestUser(admin, "s6k", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    actor = (await u1.from("profiles").select("id,label")).data!.find((p) => p.label === "A")!.id;
  });
  afterAll(async () => {
    // 取得相場・カードを先に消す（カードを参照しているため）
    for (const h of [hid1, hid2]) {
      if (!h) continue;
      await x(admin).from("card_market_prices").delete().eq("household_id", h);
      await x(admin).from("condition_multipliers").delete().eq("household_id", h);
    }
    await cleanupTestUsers(admin, ids);
  });

  it("既存の支出（品目の指定なし）は『ポケモンカード』になり、金額・日付・明細は変わらない", async () => {
    const r = await saveExpense(u1, hid1, null, exp(undefined, [item("既存のBOX", 6000)]), actor);
    expect(r.ok).toBe(true);
    const id = (r as { value: { id: string } }).value.id;
    const { data } = await x(u1).from("purchases").select("category,purchased_date").eq("id", id).single();
    expect(data).toMatchObject({ category: "pokemon_card", purchased_date: "2026-10-05" });
    const items = (await u1.from("purchase_items").select("amount_paid,quantity").eq("purchase_id", id)).data!;
    expect(items).toEqual([{ amount_paid: 6000, quantity: 2 }]);
  });

  it("DBの形式制限: 英小文字の識別子だけ。不正な品目は保存できない（将来の品目はアプリ側の定義追加で足せる）", async () => {
    const bad = await x(admin).from("purchases").insert({ household_id: hid1, category: "Bad Category!" });
    expect(bad.error).not.toBeNull();
    const ok = await x(admin).from("purchases").insert({ household_id: hid1, category: "future_item", purchased_date: "2026-10-06" }).select("id").single();
    expect(ok.error).toBeNull();
  });

  it("周辺グッズ・経費は商品マスターに紐づけず（自由入力）、品目つきで保存され、読み出しでも品目が分かる", async () => {
    // 同名のマスター商品があっても、品目がカード以外なら紐づけない
    const prod = await x(admin).from("products").insert({ household_id: hid1, official_name: "スリーブ" }).select("id").maybeSingle();
    const g = await saveExpense(u1, hid1, null, exp("goods", [item("スリーブ", 1200)]), actor);
    const e = await saveExpense(u1, hid1, null, exp("expense", [item("駐車場代", 800, { quantity: 5, unit: "box" })]), actor);
    expect(g.ok && e.ok).toBe(true);
    const gid = (g as { value: { id: string } }).value.id;
    const eid = (e as { value: { id: string } }).value.id;
    const rows = (await u1.from("purchase_items").select("purchase_id,product_id,product_label,unit,quantity").in("purchase_id", [gid, eid])).data!;
    expect(rows.every((r) => r.product_id === null)).toBe(true);
    expect(rows.find((r) => r.purchase_id === gid)).toMatchObject({ product_label: "スリーブ", unit: "piece" });
    // 経費は数量・単位を持たない（1個の金額）。入力がどうであれ 1個 になる
    expect(rows.find((r) => r.purchase_id === eid)).toMatchObject({ product_label: "駐車場代", unit: "piece", quantity: 1 });
    if (prod.data) await admin.from("products").delete().eq("id", prod.data.id);

    const data = await loadAppData(u1);
    expect(data.purchases.find((p) => p.id === gid)?.category).toBe("goods");
    expect(data.purchases.find((p) => p.id === eid)?.category).toBe("expense");
  });

  it("未知の品目はアプリ側の検証で拒否される", async () => {
    const r = await saveExpense(u1, hid1, null, exp("nope", [item("x", 1)]), actor);
    expect(r.ok).toBe(false);
  });

  it("状態別の倍率は世帯ごと。自世帯だけ読み書きでき、不正な値は保存できない", async () => {
    const up = await x(u1).from("condition_multipliers").upsert({ household_id: hid1, a_pct: 100, b_pct: 90, c_pct: 70 }, { onConflict: "household_id" });
    expect(up.error).toBeNull();
    const mine = await x(u1).from("condition_multipliers").select("a_pct,b_pct,c_pct").maybeSingle();
    expect(mine.data).toEqual({ a_pct: 100, b_pct: 90, c_pct: 70 });
    const theirs = await x(u2).from("condition_multipliers").select("a_pct").maybeSingle();
    expect(theirs.data).toBeNull();
    const cross = await x(u2).from("condition_multipliers").upsert({ household_id: hid1, a_pct: 1, b_pct: 1, c_pct: 1 }, { onConflict: "household_id" });
    expect(cross.error).not.toBeNull();
    const bad = await x(u1).from("condition_multipliers").upsert({ household_id: hid1, a_pct: 100, b_pct: 0, c_pct: 70 }, { onConflict: "household_id" });
    expect(bad.error).not.toBeNull();
    expect(hid2).toBeTruthy();
  });

  it("取得相場は『カード×販売/買取×状態区分』で1行。状態Aの既存行を保ったまま B/C の実測相場を別に持てる", async () => {
    const card = await x(admin).from("card_masters").insert({ household_id: hid1, name: "テストカード" }).select("id").single();
    expect(card.error).toBeNull();
    const row = (grade: string, median: number) => ({ household_id: hid1, card_id: card.data.id, kind: "sale", condition_grade: grade, median_yen: median, low_yen: median, high_yen: median, sample_count: 1 });
    const ins = await x(admin).from("card_market_prices").upsert([row("A", 10000), row("B", 8000)], { onConflict: "card_id,kind,condition_grade" });
    expect(ins.error).toBeNull();
    // 同じ区分は上書き（1行のまま）、別の区分は別の行
    await x(admin).from("card_market_prices").upsert([row("B", 7500)], { onConflict: "card_id,kind,condition_grade" });
    const rows = (await x(u1).from("card_market_prices").select("condition_grade,median_yen").eq("card_id", card.data.id).order("condition_grade")).data;
    expect(rows).toEqual([
      { condition_grade: "A", median_yen: 10000 },
      { condition_grade: "B", median_yen: 7500 },
    ]);
    const badGrade = await x(admin).from("card_market_prices").insert(row("Z", 1));
    expect(badGrade.error).not.toBeNull();
  });
});
