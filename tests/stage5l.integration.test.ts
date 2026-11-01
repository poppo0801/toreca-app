/**
 * Stage 5L の結合テスト（実Supabase・RLS適用下）: 標準分類の保存、抽選Excelの出力→確認→適用、再取り込みの冪等性、
 * 過去履歴の取り込み（通知を作らない・購入記録に触れない）、適用の原子性、世帯間の分離。
 *   npm run test:db
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { LSHEET } from "@/lib/lottery-excel/schema";
import { DEFAULT_EXPORT_FILTERS } from "@/lib/lottery-excel/workbook";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { applyLotteryImport, exportLotteries, loadLotterySnapshot, previewLotteryImport } from "@/lib/server/lottery-import-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5L: 標準分類・抽選Excel", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let profs: { id: string; label: string }[];
  let chainId: string;
  let storeA: string;
  let storeOnline: string;
  let p1: string;

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };
  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(JSON.stringify(error)).toBe("null");
    return data as { id: string };
  };
  const base = (over: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId, storeId: storeA, campaignId: null, newCampaign: null,
    items: [{ productId: p1, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [],
    eventState: "open", limitBasis: "account", limitMaxCount: 5, memo: "", applications: [], appliedAt: "", ...over,
  });
  const colOf = (ws: ExcelJS.Worksheet, label: string) => {
    let c = 0;
    ws.getRow(1).eachCell((cell, i) => {
      if (cell.value === label) c = i;
    });
    if (!c) throw new Error(label);
    return c;
  };
  async function edited(db: Db, edit: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
    const buf = await exportLotteries(db, DEFAULT_EXPORT_FILTERS);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    edit(wb);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const count = async (db: Db) => ((await db.from("lotteries").select("id")).data ?? []).length;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5l", 1);
    const b = await signInTestUser(admin, "s5l", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    profs = (await u1.from("profiles").select("id,label").order("sort_order")).data!;
    chainId = (await must(u1.from("chains").insert({ household_id: hid, name: "5L電機" }).select("id").single())).id;
    storeA = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "5L-A店", prefecture: "兵庫県" }).select("id").single())).id;
    storeOnline = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "5L公式オンライン", sales_kind: "online_only" } as never).select("id").single())).id;
    p1 = (await must(u1.from("products").insert({ household_id: hid, official_name: "5L商品1", packs_per_box: 20 }).select("id").single())).id;
    await must(u1.from("products").insert({ household_id: hid, official_name: "5L商品2", packs_per_box: 20 }).select("id").single());
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid, label: "住所" }).select("id").single())).id;
    for (const [i, p] of profs.slice(0, 2).entries()) {
      const idn = (await must(u1.from("identities").insert({ household_id: hid, display_label: `名義${i}`, family_group_id: fam, address_group_id: adr }).select("id").single())).id;
      await must(u1.from("service_accounts").insert({ household_id: hid, chain_id: chainId, identity_id: idn, managed_by_profile_id: p.id, account_label: `acc${i}`, membership_state: "eligible" }).select("id").single());
    }
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("標準分類（発表方法・応募条件）が保存・読み込みできる。店舗の営業形態も読める。元の文章は補足として残る", async () => {
    const id = ok(
      await saveLottery(
        u1, hid, null,
        base({
          announcementMethod: "当選者のみにメール",
          announcementMethods: ["winner_mail"], announcementTarget: "winners_only", announcementInferred: true,
          requirementTags: ["member_card", "purchase_amount"], requirementLogic: "or", requirementDetails: { minAmountYen: 3000 },
          conditionsText: "3,000円以上の購入",
        }),
        profs[0].id,
      ),
    ).id;
    const d = await loadAppData(u1);
    const l = d.lotteries.find((x) => x.id === id)!;
    expect(l.announcementMethods).toEqual(["winner_mail"]);
    expect(l.announcementTarget).toBe("winners_only");
    expect(l.announcementInferred).toBe(true);
    expect(l.requirementTags).toEqual(["member_card", "purchase_amount"]);
    expect(l.requirementLogic).toBe("or");
    expect(l.requirementDetails).toEqual({ minAmountYen: 3000 });
    expect(l.announcementMethod).toBe("当選者のみにメール");
    expect(d.stores.find((s) => s.id === storeOnline)!.salesKind).toBe("online_only");
    expect(d.stores.find((s) => s.id === storeA)!.salesKind).toBe("physical");
    // 不正な分類コードはDBが拒否する
    const bad = await u1.from("lotteries").update({ announcement_methods: ["carrier_pigeon"] } as never).eq("id", id);
    expect(bad.error).not.toBeNull();
  });

  it("出力 → そのまま再確認で全行が変更なし。新規（過去の日付・A当選/B落選）を取り込み、再取り込みで重複しない。通知・購入記録は作られない", async () => {
    const before = await count(u1);
    const snap0 = await loadLotterySnapshot(u1);
    const same = await previewLotteryImport(u1, await exportLotteries(u1, DEFAULT_EXPORT_FILTERS), {}, profs[0].id);
    expect(same.ok && same.preview.counts).toMatchObject({ new: 0, update: 0, error: 0, unchanged: snap0.data.lotteries.length });

    const file = await edited(u1, (wb) => {
      const l = wb.getWorksheet(LSHEET.lotteries)!;
      const i = wb.getWorksheet(LSHEET.items)!;
      const a = wb.getWorksheet(LSHEET.apps)!;
      const r = l.rowCount + 1;
      l.getCell(r, colOf(l, "取込キー")).value = "PAST1";
      l.getCell(r, colOf(l, "系列名")).value = "5L電機";
      l.getCell(r, colOf(l, "店舗名")).value = "5L-A店";
      l.getCell(r, colOf(l, "応募開始日")).value = "2024-04-01";
      l.getCell(r, colOf(l, "応募締切日")).value = "2024-04-10";
      l.getCell(r, colOf(l, "発表開始日")).value = "2024-04-15";
      l.getCell(r, colOf(l, "発表方法")).value = "当落メール";
      l.getCell(r, colOf(l, "応募条件")).value = "会員登録";
      l.getCell(r, colOf(l, "受取方法")).value = "店頭受取";
      const ri = i.rowCount + 1;
      i.getCell(ri, colOf(i, "取込キー")).value = "PAST1";
      i.getCell(ri, colOf(i, "正式商品名")).value = "5L商品2";
      i.getCell(ri, colOf(i, "数量")).value = "1";
      i.getCell(ri, colOf(i, "数量単位")).value = "BOX";
      const ra = a.rowCount + 1;
      a.getCell(ra, colOf(a, "取込キー")).value = "PAST1";
      a.getCell(ra, colOf(a, "プロフィールID")).value = profs[0].id;
      a.getCell(ra, colOf(a, "応募状況")).value = "応募済み";
      a.getCell(ra, colOf(a, "応募日")).value = "2024-04-02";
      a.getCell(ra, colOf(a, "当落結果")).value = "当選";
      a.getCell(ra, colOf(a, "当落確認日")).value = "2024-04-15";
      a.getCell(ra + 1, colOf(a, "取込キー")).value = "PAST1";
      a.getCell(ra + 1, colOf(a, "プロフィールID")).value = profs[1].id;
      a.getCell(ra + 1, colOf(a, "応募状況")).value = "応募済み";
      a.getCell(ra + 1, colOf(a, "当落結果")).value = "落選";
    });
    const pv = await previewLotteryImport(u1, file, {}, profs[0].id);
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    expect(pv.preview.counts).toMatchObject({ new: 1, error: 0 });
    expect(await count(u1)).toBe(before); // 確認では保存しない

    // 古い指紋・別の指紋は拒否
    const stale = await applyLotteryImport(u1, file, "x.xlsx", "0".repeat(64), {}, profs[0].id);
    expect(stale.ok).toBe(false);

    const notesBefore = ((await admin.from("notification_deliveries").select("id").eq("household_id", hid)).data ?? []).length;
    const purchasesBefore = ((await admin.from("purchases").select("id").eq("household_id", hid)).data ?? []).length;
    const applied = await applyLotteryImport(u1, file, "past.xlsx", pv.preview.fingerprint, {}, profs[0].id);
    expect(applied.ok, applied.ok ? "" : applied.error).toBe(true);
    expect(await count(u1)).toBe(before + 1);

    const d = await loadAppData(u1);
    const created = d.lotteries.find((l) => l.sourceKind === "import")!;
    expect(created.announcementMethods).toEqual(["result_mail"]);
    expect(created.requirementTags).toEqual(["member_registration"]);
    expect(created.applyDeadline).toEqual({ precision: "date_only", date: "2024-04-10" });
    const apps = d.applications.filter((a) => a.lotteryId === created.id);
    expect(apps).toHaveLength(2);
    const accOf = (pid: string) => d.accounts.find((x) => x.profileId === pid && x.chainId === chainId)!.id;
    expect(apps.find((a) => a.accountId === accOf(profs[0].id))).toMatchObject({ state: "applied", result: "won" });
    expect(apps.find((a) => a.accountId === accOf(profs[1].id))).toMatchObject({ state: "applied", result: "lost" }); // A当選・B落選が独立
    const { data: origin } = await u1.from("applications").select("origin").eq("lottery_id", created.id);
    expect((origin ?? []).every((x) => x.origin === "import")).toBe(true);
    // 履歴が残る
    const hist = await u1.from("lottery_import_history").select("created_count,application_count,file_name");
    expect(hist.data).toEqual(expect.arrayContaining([expect.objectContaining({ created_count: 1, application_count: 2, file_name: "past.xlsx" })]));
    // 通知・購入記録は作られない
    expect(((await admin.from("notification_deliveries").select("id").eq("household_id", hid)).data ?? []).length).toBe(notesBefore);
    expect(((await admin.from("purchases").select("id").eq("household_id", hid)).data ?? []).length).toBe(purchasesBefore);

    // 同じファイルをもう一度: 重複登録しない（取込キーで同じ抽選と判定→変更なし）、適用するものがない
    const again = await previewLotteryImport(u1, file, {}, profs[0].id);
    expect(again.ok && again.preview.counts.new).toBe(0);
    expect(again.ok && again.preview.counts.unchanged).toBeGreaterThan(0);
    // 二重送信: 同じ指紋は2回適用できない
    const dup = await applyLotteryImport(u1, file, "past.xlsx", pv.preview.fingerprint, {}, profs[0].id);
    expect(dup.ok).toBe(false);
    expect(await count(u1)).toBe(before + 1);
  });

  it("既存の応募・当落は、空欄のセルでは変わらず、値を入れた項目だけ更新される。ファイルに無い抽選は削除されない", async () => {
    const id = ok(await saveLottery(u1, hid, null, base({ memo: "変更前", applications: [] }), profs[0].id)).id;
    const before = await count(u1);
    const file = await edited(u1, (wb) => {
      const l = wb.getWorksheet(LSHEET.lotteries)!;
      const target = (() => {
        let n = 0;
        l.eachRow((row, i) => {
          if (row.getCell(colOf(l, "抽選ID")).value === id) n = i;
        });
        return n;
      })();
      l.getCell(target, colOf(l, "備考")).value = "変更後";
      l.getCell(target, colOf(l, "応募方法")).value = null;
    });
    const pv = await previewLotteryImport(u1, file, {}, profs[0].id);
    expect(pv.ok && pv.preview.counts.update).toBe(1);
    if (!pv.ok) return;
    const ap = await applyLotteryImport(u1, file, "upd.xlsx", pv.preview.fingerprint, {}, profs[0].id);
    expect(ap.ok, ap.ok ? "" : ap.error).toBe(true);
    const l = (await loadAppData(u1)).lotteries.find((x) => x.id === id)!;
    expect(l.memo).toBe("変更後");
    expect(l.applyMethod).toBe("web");
    expect(await count(u1)).toBe(before);
  });

  it("適用は原子的: 途中の抽選が失敗したら、先の抽選も履歴も作られない", async () => {
    const before = await count(u1);
    const histBefore = ((await u1.from("lottery_import_history").select("id")).data ?? []).length;
    const okSave = (name: string) => ({
      id: null,
      chain: { id: chainId, name: "5L電機" },
      store: { id: storeA, name: "5L-A店", prefecture: "" },
      campaign: { id: null, new: null },
      lottery: { multi_mode: "single", receive_method: "store", apply_method: "web", event_state: "open" },
      items: [{ id: null, product: { id: p1, name: "5L商品1" }, quantity: 1, unit: "box" }],
      is_managed: true,
      applied_at: "",
      _name: name,
    });
    const ops = {
      lotteries: [
        { id: null, expected: null, import_key: "zzzzzzzz:ATOM1", save: okSave("1"), tax: {}, managed: true, apps: [] },
        // 存在しない商品を指す当落（商品別の当落）→ 例外でロールバックされる
        { id: null, expected: null, import_key: "zzzzzzzz:ATOM2", save: okSave("2"), tax: {}, managed: true, apps: [{ profile_id: profs[0].id, state: "applied", items: [{ item_id: null, product: "存在しない商品", result: "won" }] }] },
      ],
    };
    const r = await u1.rpc("apply_lottery_import" as never, { p_ops: ops, p_actor: profs[0].id, p_file_name: "atom.xlsx", p_file_sha: "a".repeat(64), p_fingerprint: "b".repeat(64), p_unchanged: 0 } as never);
    expect(r.error).not.toBeNull();
    expect(await count(u1)).toBe(before);
    expect(((await u1.from("lottery_import_history").select("id")).data ?? []).length).toBe(histBefore);
  });

  it("世帯の分離: 他の世帯のユーザーは、出力に含まれず、他の世帯の抽選IDを更新できない", async () => {
    const mine = (await loadAppData(u1)).lotteries[0];
    const out = await loadLotterySnapshot(u2);
    expect(out.data.lotteries.some((l) => l.id === mine.id)).toBe(false);
    const prof2 = (await u2.from("profiles").select("id").order("sort_order")).data![0].id;
    const ops = { lotteries: [{ id: mine.id, expected: null, import_key: null, save: { id: mine.id, chain: { id: mine.chainId, name: "" }, store: { id: mine.storeId, name: "" }, campaign: { id: null, new: null }, lottery: {}, items: [], is_managed: true, applied_at: "" }, tax: {}, managed: null, apps: [] }] };
    const r = await u2.rpc("apply_lottery_import" as never, { p_ops: ops, p_actor: prof2, p_file_name: "x.xlsx", p_file_sha: "c".repeat(64), p_fingerprint: "d".repeat(64), p_unchanged: 0 } as never);
    expect(r.error).not.toBeNull();
    // 未ログイン（anon）は呼べない
    const anon = (await import("./helpers/db")).anonClient();
    const r2 = await anon.rpc("apply_lottery_import" as never, { p_ops: { lotteries: [] }, p_actor: prof2, p_file_name: "x", p_file_sha: "e".repeat(64), p_fingerprint: "f".repeat(64), p_unchanged: 0 } as never);
    expect(r2.error).not.toBeNull();
  });
});
