/**
 * Stage 3.5 の結合テスト（実Supabase・RLS適用下）: マスター仮登録、複数商品抽選、プロフィール設定、収支。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { deleteExpense, deleteSale, saveExpense, saveSale } from "@/lib/server/finance-service";
import {
  loadAppData,
  saveLottery,
  setApplied,
  setFulfillment,
  setItemResults,
  setResult,
  updateProfileSettings,
  type Db,
} from "@/lib/server/lottery-service";
import { annualStats, monthSummary } from "@/lib/finance";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 3.5: 仮登録マスター・複数商品抽選・収支", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let other: Db;
  let hid: string;
  let profA: string;
  let profB: string;
  let profC: string;

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };

  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: null, name: "新規テスト電機" },
    store: { id: null, name: "新規テスト店", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "新規テスト商品" }, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
    resultDate: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
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

  const count = async (table: "chains" | "stores" | "products") => ((await db.from(table).select("id")).data ?? []).length;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s35", 1);
    const b = await signInTestUser(admin, "s35", 2);
    userIds.push(a.userId, b.userId);
    db = a.db;
    other = b.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    await other.rpc("bootstrap_household");
    const profiles = (await db.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;
    profC = profiles.find((p) => p.label === "C")!.id;
  });

  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  // ---------------------------------------------------------------- マスター未登録での抽選登録
  it("マスターが空でも、名称の入力だけで抽選を登録でき、系列・店舗・商品が仮登録される", async () => {
    expect(await count("chains")).toBe(0);
    const id = ok(await saveLottery(db, hid, null, input(), profA)).id;
    const d = await loadAppData(db);
    const lot = d.lotteries.find((l) => l.id === id)!;
    expect(d.chains).toMatchObject([{ name: "新規テスト電機", provisional: true }]);
    expect(d.stores).toMatchObject([{ name: "新規テスト店", provisional: true }]);
    expect(d.products).toMatchObject([{ officialName: "新規テスト商品", provisional: true }]);
    expect(lot.chainId).toBe(d.chains[0].id);
    expect(lot.items[0].productId).toBe(d.products[0].id);
    expect(d.management.find((m) => m.lotteryId === id)?.isManaged).toBe(true);
  });

  it("同じ名称（全半角・空白・大小文字が違っても）は既存マスターを使い、重複作成しない", async () => {
    const before = [await count("chains"), await count("stores"), await count("products")];
    ok(await saveLottery(db, hid, null, input({ chain: { id: null, name: "新規 テスト電機" }, store: { id: null, name: "新規テスト店 " }, items: [{ product: { id: null, name: "新規ﾃｽﾄ商品" }, quantity: 2, unit: "box" }] }), profA));
    expect([await count("chains"), await count("stores"), await count("products")]).toEqual(before);
    // 既存マスターを id で選択した場合も同様
    const d = await loadAppData(db);
    ok(await saveLottery(db, hid, null, input({ chain: { id: d.chains[0].id, name: "" }, store: { id: d.stores[0].id, name: "" }, items: [{ product: { id: d.products[0].id, name: "" }, quantity: 1, unit: "pack" }] }), profA));
    expect([await count("chains"), await count("stores"), await count("products")]).toEqual(before);
  });

  it("略称と一致する商品名も既存商品として扱う", async () => {
    const d = await loadAppData(db);
    await db.from("product_aliases").insert({ household_id: hid, product_id: d.products[0].id, alias: "テスト略", normalized_alias: "テスト略" });
    const before = await count("products");
    ok(await saveLottery(db, hid, null, input({ items: [{ product: { id: null, name: "テスト略" }, quantity: 1, unit: "box" }] }), profA));
    expect(await count("products")).toBe(before);
  });

  it("保存が失敗したら、同じ操作で作られるはずだったマスターも残らない（1トランザクション）", async () => {
    const before = [await count("chains"), await count("stores"), await count("products")];
    // 単一方式に2商品 → DB関数内で拒否される（系列・店舗・商品の作成後に失敗するケース）
    const r = await saveLottery(
      db, hid, null,
      input({ chain: { id: null, name: "ロールバック系列" }, store: { id: null, name: "ロールバック店" }, multiMode: "all",
        items: [{ product: { id: null, name: "ロールバック商品" }, quantity: 1, unit: "box" }] }),
      profA,
    );
    expect(r.ok).toBe(false);
    // クライアント検証を通り抜けた不正なペイロードを直接DB関数へ送っても、全体が巻き戻る
    const direct = await db.rpc("save_lottery_tx", {
      p: {
        id: null, chain: { id: null, name: "直接ロールバック系列" }, store: { id: null, name: "直接店" }, campaign: { id: null, new: null },
        lottery: { multi_mode: "single", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "person", limit_max_count: 1,
          apply_start_precision: "unknown", apply_deadline_precision: "unknown", result_precision: "unknown", procedure_deadline_precision: "unknown" },
        items: [{ id: null, product: { id: null, name: "直接商品A" }, quantity: 1, unit: "box" }, { id: null, product: { id: null, name: "直接商品B" }, quantity: 1, unit: "box" }],
        is_managed: true, applications: [], applied_at: "",
      } as never,
      p_actor: profA,
    });
    expect(direct.error).not.toBeNull();
    expect([await count("chains"), await count("stores"), await count("products")]).toEqual(before);
  });

  it("仮登録マスターはマスター管理で編集でき、保存すると確定扱いになる／他世帯には見えない", async () => {
    const d = await loadAppData(db);
    const store = d.stores[0];
    expect(store.provisional).toBe(true);
    const { error } = await db.from("stores").update({ prefecture: "兵庫県", is_provisional: false }).eq("id", store.id);
    expect(error).toBeNull();
    expect((await loadAppData(db)).stores[0]).toMatchObject({ prefecture: "兵庫県", provisional: false });
    expect((await loadAppData(other)).chains).toHaveLength(0);
  });

  it("応募名義はユーザー単位: プロフィール×系列のアカウントが自動で作られ、画面でのアカウント管理は不要。再実行しても増えない", async () => {
    const d = await loadAppData(db);
    const chainId = d.chains[0].id;
    const mine = d.accounts.filter((a) => a.chainId === chainId);
    expect(mine.map((a) => a.profileId).sort()).toEqual([profA, profB, profC].sort());
    expect(mine.every((a) => a.membership === "eligible" && a.active)).toBe(true);
    await db.rpc("ensure_profile_accounts");
    await db.rpc("ensure_profile_accounts");
    expect((await loadAppData(db)).accounts.filter((a) => a.chainId === chainId)).toHaveLength(3);
  });

  // ---------------------------------------------------------------- 複数商品抽選
  const multiLottery = async (mode: "all" | "one_win" | "choose_one", name: string, apps: LotteryInput["applications"] = []) =>
    ok(
      await saveLottery(
        db, hid, null,
        input({
          multiMode: mode,
          store: { id: null, name },
          items: [
            { product: { id: null, name: `${name}-商品1` }, quantity: 1, unit: "box" },
            { product: { id: null, name: `${name}-商品2` }, quantity: 3, unit: "pack" },
            { product: { id: null, name: `${name}-商品3` }, quantity: 2, unit: "set" },
          ],
          applications: apps,
        }),
        profA,
      ),
    ).id;

  it("B方式: 1回の応募で商品ごとに当落。複数商品に当選でき、購入記録は当選商品だけを数量どおり1件に反映する", async () => {
    const lot = await multiLottery("all", "B方式店", [{ profileId: profA, status: "applied" }]);
    let d = await loadAppData(db);
    const app = d.applications.find((a) => a.lotteryId === lot)!;
    const items = d.lotteries.find((l) => l.id === lot)!.items;
    expect(d.lotteries.find((l) => l.id === lot)!.multiMode).toBe("all");
    expect(items).toHaveLength(3);
    expect(app.result).toBe("pending");

    // 集計値の直接変更は拒否（商品ごとに登録する）
    expect((await setResult(db, app.id, "won", profA)).ok).toBe(false);

    ok(await setItemResults(db, app.id, [{ itemId: items[0].id!, result: "won" }, { itemId: items[1].id!, result: "won" }], profA));
    ok(await setItemResults(db, app.id, [{ itemId: items[2].id!, result: "lost" }], profA));
    d = await loadAppData(db);
    const after = d.applications.find((a) => a.id === app.id)!;
    expect(after.result).toBe("won"); // 1つでも当選=全体はwon
    expect(after.itemResults).toEqual({ [items[0].id!]: "won", [items[1].id!]: "won", [items[2].id!]: "lost" });

    // 購入済みを繰り返しても購入は1件。当選した2商品のみ、数量どおり
    ok(await setFulfillment(db, app.id, "purchased", profA));
    ok(await setFulfillment(db, app.id, "purchased", profA));
    d = await loadAppData(db);
    const purchases = d.purchases.filter((p) => p.applicationId === app.id);
    expect(purchases).toHaveLength(1);
    expect(purchases[0].items.map((i) => `${i.productId}:${i.quantity}:${i.unit}`).sort()).toEqual(
      [items[0], items[1]].map((i) => `${i.productId}:${i.quantity}:${i.unit}`).sort(),
    );
    // 購入済みの結果は変更できない
    expect((await setItemResults(db, app.id, [{ itemId: items[2].id!, result: "won" }], profA)).ok).toBe(false);
  });

  it("C方式: 当選できるのは最大1商品まで（2つ目の当選は拒否され、状態は変わらない）", async () => {
    const lot = await multiLottery("one_win", "C方式店", [{ profileId: profB, status: "applied" }]);
    let d = await loadAppData(db);
    const app = d.applications.find((a) => a.lotteryId === lot)!;
    const items = d.lotteries.find((l) => l.id === lot)!.items;
    ok(await setItemResults(db, app.id, [{ itemId: items[0].id!, result: "won" }], profB));
    const second = await setItemResults(db, app.id, [{ itemId: items[1].id!, result: "won" }], profB);
    expect(second.ok).toBe(false);
    d = await loadAppData(db);
    expect(d.applications.find((a) => a.id === app.id)!.itemResults).toEqual({ [items[0].id!]: "won" });
    expect(d.applications.find((a) => a.id === app.id)!.result).toBe("won");
  });

  it("D方式: 応募時に選んだ商品をユーザーごとに記録。ユーザーごとに選択・当落が異なっても独立。未選択商品の結果は登録できない", async () => {
    const lot = await multiLottery("choose_one", "D方式店");
    let d = await loadAppData(db);
    const items = d.lotteries.find((l) => l.id === lot)!.items;
    const acc = (p: string) => d.accounts.find((a) => a.profileId === p && a.chainId === d.lotteries.find((l) => l.id === lot)!.chainId)!.id;

    // 選択なしでの応募は拒否
    expect((await setApplied(db, hid, lot, acc(profA), true, profA)).ok).toBe(false);
    ok(await setApplied(db, hid, lot, acc(profA), true, profA, items[0].id!));
    ok(await setApplied(db, hid, lot, acc(profB), true, profB, items[1].id!));
    ok(await setApplied(db, hid, lot, acc(profC), true, profC, items[2].id!));
    d = await loadAppData(db);
    const apps = d.applications.filter((a) => a.lotteryId === lot);
    expect(apps.map((a) => a.selectedItemId).sort()).toEqual([items[0].id!, items[1].id!, items[2].id!].sort());

    const appA = apps.find((a) => a.accountId === acc(profA))!;
    const appB = apps.find((a) => a.accountId === acc(profB))!;
    const appC = apps.find((a) => a.accountId === acc(profC))!;
    expect((await setItemResults(db, appA.id, [{ itemId: items[1].id!, result: "won" }], profA)).ok).toBe(false); // Aは商品1を選んだ
    ok(await setItemResults(db, appA.id, [{ itemId: items[0].id!, result: "won" }], profA));
    ok(await setItemResults(db, appB.id, [{ itemId: items[1].id!, result: "lost" }], profB));
    d = await loadAppData(db);
    expect(d.applications.find((a) => a.id === appA.id)!.result).toBe("won");
    expect(d.applications.find((a) => a.id === appB.id)!.result).toBe("lost");
    expect(d.applications.find((a) => a.id === appC.id)!.result).toBe("pending"); // Cは影響されない

    // Aが購入済みにしても、購入記録はAの選んだ商品だけ
    ok(await setFulfillment(db, appA.id, "purchased", profA));
    const p = (await loadAppData(db)).purchases.filter((x) => x.applicationId === appA.id);
    expect(p).toHaveLength(1);
    expect(p[0].items).toMatchObject([{ productId: items[0].productId, quantity: 1, unit: "box" }]);
  });

  it("商品名での検索対象に複数商品抽選の全明細が含まれる（データとして全明細を保持）", async () => {
    const d = await loadAppData(db);
    const multi = d.lotteries.filter((l) => l.multiMode !== "single");
    expect(multi.length).toBeGreaterThanOrEqual(3);
    expect(multi.every((l) => l.items.length === 3)).toBe(true);
  });

  // ---------------------------------------------------------------- プロフィール設定・通知先
  it("プロフィールの表示名・色・マーク・通知先を更新できる。通知先は有効なユーザーのみ", async () => {
    ok(await updateProfileSettings(db, profC, { label: "サブ", color: "teal", colorHex: "#ff8800", iconMark: "star", notifyRecipientIds: [profA] }, profA));
    const d = await loadAppData(db);
    expect(d.profiles.find((p) => p.id === profC)).toMatchObject({ label: "サブ", initial: "サ", colorHex: "#ff8800", iconMark: "star", notifyRecipientIds: [profA] });
    expect((await updateProfileSettings(db, profC, { label: "サブ", color: "teal", colorHex: "not-a-color", iconMark: "star", notifyRecipientIds: null }, profA)).ok).toBe(false);
    expect((await updateProfileSettings(db, profC, { label: "サブ", color: "teal", colorHex: null, iconMark: "star", notifyRecipientIds: [crypto.randomUUID()] }, profA)).ok).toBe(false);
    expect((await updateProfileSettings(other, profC, { label: "のっとり", color: "blue", colorHex: null, iconMark: "initial", notifyRecipientIds: null }, null)).ok).toBe(false);
    expect((await loadAppData(db)).profiles.find((p) => p.id === profC)!.label).toBe("サブ");
    // 通知なし（空配列）も保存できる
    ok(await updateProfileSettings(db, profB, { label: "B", color: "green", colorHex: null, iconMark: "initial", notifyRecipientIds: [] }, profA));
    expect((await loadAppData(db)).profiles.find((p) => p.id === profB)!.notifyRecipientIds).toEqual([]);
  });

  // ---------------------------------------------------------------- 収支
  it("支出: マスター外の商品・店舗を自由入力で登録・編集・削除できる。金額不明は0円ではない", async () => {
    const id = ok(
      await saveExpense(db, hid, null, {
        date: "2026-10-05", store: { id: null, name: "どこかの店" }, channel: "online", note: "",
        items: [{ product: { id: null, name: "自由入力の商品" }, quantity: 5, unit: "pack", amountPaid: 900 }],
      }, profA),
    ).id;
    let d = await loadAppData(db);
    let p = d.purchases.find((x) => x.id === id)!;
    expect(p).toMatchObject({ storeId: null, storeLabel: "どこかの店", source: "manual", channel: "online", purchasedOn: { precision: "date_only", date: "2026-10-05" } });
    expect(p.items[0]).toMatchObject({ productId: null, productLabel: "自由入力の商品", quantity: 5, unit: "pack", amountPaid: 900 });
    expect(monthSummary(d, "2026-10").expense).toBeGreaterThanOrEqual(900);

    // 編集: 数量・金額を変更し、明細IDを保つ
    ok(await saveExpense(db, hid, id, { date: "2026-10-06", store: { id: null, name: "どこかの店" }, channel: "store", note: "修正",
      items: [{ id: p.items[0].id!, product: { id: null, name: "自由入力の商品" }, quantity: 6, unit: "pack", amountPaid: null }] }, profA));
    d = await loadAppData(db);
    p = d.purchases.find((x) => x.id === id)!;
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ quantity: 6, amountPaid: null });
    expect(p.purchasedOn).toEqual({ precision: "date_only", date: "2026-10-06" });

    // 既存マスターと一致する名称は購入実績として商品に紐づく
    const master = d.products[0];
    const linked = ok(await saveExpense(db, hid, null, { date: "2026-10-07", store: { id: null, name: "" }, channel: "store", note: "",
      items: [{ product: { id: null, name: master.officialName }, quantity: 1, unit: "box", amountPaid: 5400 }] }, profA)).id;
    expect((await loadAppData(db)).purchases.find((x) => x.id === linked)!.items[0].productId).toBe(master.id);

    // 削除は論理削除（一覧から外れる）
    ok(await deleteExpense(db, id, profA));
    expect((await loadAppData(db)).purchases.some((x) => x.id === id)).toBe(false);
  });

  it("抽選由来の購入は削除できないが、日付・数量・金額は修正できる（購入実績と食い違わない）", async () => {
    const d = await loadAppData(db);
    const fromLottery = d.purchases.find((p) => p.source === "lottery")!;
    expect((await deleteExpense(db, fromLottery.id, profA)).ok).toBe(false);
    ok(await saveExpense(db, hid, fromLottery.id, { date: "2026-10-08", store: { id: fromLottery.storeId, name: "" }, channel: "store", note: "",
      items: fromLottery.items.map((i) => ({ id: i.id!, product: { id: i.productId, name: i.productLabel ?? "" }, quantity: i.quantity, unit: i.unit as "box", amountPaid: 1234 })) }, profA));
    const after = (await loadAppData(db)).purchases.find((p) => p.id === fromLottery.id)!;
    expect(after.items.every((i) => i.amountPaid === 1234)).toBe(true);
    expect((await loadAppData(db)).purchases.filter((p) => p.applicationId === fromLottery.applicationId)).toHaveLength(1);
  });

  it("売却: 原価の購入明細への紐づけは数量を超えて重複計上できない。原価未設定はnullのまま集計される", async () => {
    const purchaseId = ok(await saveExpense(db, hid, null, { date: "2026-02-01", store: { id: null, name: "仕入れ" }, channel: "store", note: "",
      items: [{ product: { id: null, name: "売却用商品" }, quantity: 4, unit: "box", amountPaid: 20000 }] }, profA)).id;
    const item = (await loadAppData(db)).purchases.find((p) => p.id === purchaseId)!.items[0];

    const sale = (over: Partial<Parameters<typeof saveSale>[3]> = {}) =>
      saveSale(db, hid, null, {
        soldOn: "2026-03-10", platform: "買取店", product: { id: null, name: "売却用商品" }, quantity: 1, unit: "box", amount: 9000,
        sellerProfileId: profB, costAmount: null, costPurchaseItemId: null, costQuantity: null, fee: 300, shipping: 200, memo: "", ...over,
      }, profA);

    const s1 = ok(await sale({ quantity: 3, costPurchaseItemId: item.id!, costQuantity: 3, costAmount: 15000 })).id;
    expect((await sale({ costPurchaseItemId: item.id!, costQuantity: 2, costAmount: 10000 })).ok).toBe(false); // 残り1個しかない
    const s2 = ok(await sale({ costPurchaseItemId: item.id!, costQuantity: 1, costAmount: 5000 })).id; // 残りぴったり
    expect((await sale({ costPurchaseItemId: item.id!, costQuantity: 1, costAmount: 5000 })).ok).toBe(false); // もう残りなし
    const s3 = ok(await sale({ amount: 4000 })).id; // 原価未設定

    // 紐づけ済みの売却を削除(論理)すると、その数量は再利用できる
    ok(await deleteSale(db, s2, profA));
    ok(await sale({ costPurchaseItemId: item.id!, costQuantity: 1, costAmount: 5000 }));

    const d = await loadAppData(db);
    expect(d.sales.find((s) => s.id === s3)).toMatchObject({ costAmount: null, sellerProfileId: profB });
    const { total, bySeller } = annualStats(d, 2026);
    expect(total.costUnknownCount).toBe(1);
    expect(bySeller.find((x) => x.sellerProfileId === profB)!.salesCount).toBe(3);
    expect(d.sales.some((s) => s.id === s1)).toBe(true);

    // 売却の原価に使われている購入は削除できない
    expect((await deleteExpense(db, purchaseId, profA)).ok).toBe(false);
  });

  it("別世帯の収支・売却は読めず、操作もできない", async () => {
    const o = await loadAppData(other);
    expect(o.sales).toHaveLength(0);
    expect(o.purchases).toHaveLength(0);
    const mine = await loadAppData(db);
    const sale = mine.sales[0];
    expect((await deleteSale(other, sale.id, null)).ok).toBe(false);
    expect((await loadAppData(db)).sales.some((s) => s.id === sale.id)).toBe(true);
    const forged = await other.from("sales").insert({ household_id: hid, sold_on: "2026-01-01", quantity: 1, amount: 1, seller_profile_id: profA });
    expect(forged.error).not.toBeNull();
  });
});
