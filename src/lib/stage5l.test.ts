// @vitest-environment node
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  classifyAnnouncement,
  classifyRequirements,
  normalizeAnnounceMethods,
  normalizeRequirementTags,
  placeInfo,
  resolveAnnouncement,
  sanitizeRequirementDetails,
} from "@/lib/lottery-taxonomy";
import { fingerprintLotteryOps, planLotteries, type LotterySnapshot } from "@/lib/lottery-excel/plan";
import { APP_COLUMNS, ITEM_COLUMNS, LOTTERY_COLUMNS, LSHEET } from "@/lib/lottery-excel/schema";
import { DEFAULT_EXPORT_FILTERS, buildLotteryExport, buildLotteryTemplate, filterLotteries, readLotteryWorkbook } from "@/lib/lottery-excel/workbook";
import type { AppData, Lottery } from "@/types/domain";

describe("当落発表方法の分類", () => {
  it("メールのみ・当選者のみ・結果ページを分類し、対象は経路と別に持つ", () => {
    expect(classifyAnnouncement("当選者のみにメールでご連絡します")).toMatchObject({ methods: ["winner_mail"], target: "winners_only", matched: true });
    expect(classifyAnnouncement("結果は応募サイトのマイページにて確認")).toMatchObject({ methods: ["result_page"], matched: true });
    const both = classifyAnnouncement("当落結果をメールでお知らせし、マイページでも確認できます");
    // 単一選択: 主な方法は当落メール、結果ページは補足へ回す
    expect(both.methods).toEqual(["result_mail"]);
    expect(both.extra).toEqual(["result_page"]);
    expect(both.target).toBe("both");
  });
  it("LINE・SMS・店頭などメール以外の経路にも「当選者のみ」を付けられる（経路と対象は別）", () => {
    const c = classifyAnnouncement("当選者のみLINEでご連絡します");
    expect(c.methods).toContain("line");
    expect(c.target).toBe("winners_only");
  });
  it("分類できない文章は「その他」にし、空欄は何も入れない（推測しない）", () => {
    expect(classifyAnnouncement("後日お知らせします")).toMatchObject({ methods: ["other"], matched: false });
    expect(classifyAnnouncement("")).toMatchObject({ methods: [], matched: false });
  });
  it("正規化: 重複を除き、不明は他があれば外し、当落メールと当選者のみメールは同時に持たない", () => {
    expect(normalizeAnnounceMethods(["unknown", "app", "app", "result_mail", "winner_mail"])).toEqual(["winner_mail"]);
    expect(normalizeAnnounceMethods(["unknown"])).toEqual(["unknown"]);
    expect(normalizeAnnounceMethods(["bogus", 3])).toEqual([]);
  });
});

describe("LivePocketの標準ルール（ルールベースの補完）", () => {
  it("LivePocketが明確で、告知に発表方法が無いときだけ、当落メール＋結果確認ページを推定で補う", () => {
    const r = resolveAnnouncement({ text: "", urls: ["https://t.livepocket.jp/e/abcd"] });
    expect(r.methods).toEqual(["result_mail"]);
    expect(r.extra).toEqual(["result_page"]); // 結果確認ページは補足（他の確認方法）へ
    expect(r.inferred).toBe(true);
    expect(r.service).toBe("livepocket");
    expect(r.target).toBe("unknown"); // 通知対象まで確定しない（当選メールが来ないことだけで落選とは判定しない）
  });
  it("告知に明記された方法を優先し、推定にしない", () => {
    const r = resolveAnnouncement({ text: "当選者のみにメールでご連絡します", urls: ["https://t.livepocket.jp/e/abcd"] });
    expect(r.methods).toEqual(["winner_mail"]);
    expect(r.inferred).toBe(false);
  });
  it("LivePocketと分からない場合は補完しない", () => {
    const r = resolveAnnouncement({ text: "", urls: ["https://example.com/x"] });
    expect(r.methods).toEqual([]);
    expect(r.inferred).toBe(false);
    // ホスト名の一部（偽装）では判定しない
    expect(resolveAnnouncement({ text: "", urls: ["https://livepocket.jp.evil.example/x"] }).inferred).toBe(false);
  });
});

describe("応募条件の分類", () => {
  it("複数タグを抽出し、金額は文章から明確に読めたときだけ構造化する", () => {
    const c = classifyRequirements("会員証をお持ちで、過去の購入履歴があり、5,000円以上のお買い上げの方。身分証を提示。1人1回まで。");
    expect(c.tags).toEqual(expect.arrayContaining(["member_card", "purchase_history", "purchase_amount", "id_check", "once_per_person"]));
    expect(c.details.minAmountYen).toBe(5000);
  });
  it("金額・年齢が文章に無ければ構造化しない。分類できない文章は「その他」", () => {
    expect(classifyRequirements("購入履歴のある方").details).toEqual({});
    expect(classifyRequirements("店舗スタッフにお尋ねください")).toMatchObject({ tags: ["other"], matched: false });
    expect(classifyRequirements("")).toMatchObject({ tags: [], matched: false });
  });
  it("正規化: 条件不明は他があれば外す。不正な数値・未知のキーは捨てる", () => {
    expect(normalizeRequirementTags(["unknown", "x_follow", "x_follow", "once_per_family"])).toEqual(["x_follow", "once_per_family"]);
    expect(sanitizeRequirementDetails({ minAmountYen: -5, minAge: 20, hack: 1, purchasePeriodFrom: "2026-01-01", maxStores: 0 })).toEqual({ minAge: 20, purchasePeriodFrom: "2026-01-01" });
  });
});

describe("通販区分と地域表示", () => {
  it("Webで応募しても店頭受取なら都道府県。発送のみ・オンライン専用店舗は通販（距離なし）", () => {
    expect(placeInfo({ receiveMethod: "store", prefecture: "兵庫県" })).toMatchObject({ label: "兵庫県", showLocation: true, canShip: false });
    expect(placeInfo({ receiveMethod: "shipping", prefecture: "兵庫県" })).toMatchObject({ label: "通販", showLocation: false });
    expect(placeInfo({ receiveMethod: "store", prefecture: "", storeKind: "online_only" })).toMatchObject({ label: "通販", showLocation: false });
    expect(placeInfo({ receiveMethod: "either", prefecture: "大阪府" })).toMatchObject({ label: "大阪府", canShip: true });
    expect(placeInfo({ receiveMethod: "unknown", prefecture: "兵庫県" }).label).toBeNull(); // 推測で都道府県を出さない
    expect(placeInfo({ receiveMethod: "store", prefecture: "東京都", storeKind: "both" }).label).toBe("東京都");
  });
});

// ------------------------------------------------------------------ Excel
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [PA, PB] = [U(1), U(2)];
const flexD = (date: string) => ({ precision: "date_only" as const, date });
function lot(over: Partial<Lottery> & { id: string }): Lottery {
  return {
    chainId: U(10),
    storeId: U(20),
    items: [{ id: U(100), productId: U(30), quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: { precision: "unknown" },
    applyDeadline: flexD("2026-12-01"),
    resultDate: flexD("2026-12-05"),
    procedureStart: { precision: "unknown" },
    procedureDeadline: { precision: "unknown" },
    receiveMethod: "store",
    applyMethod: "web",
    conditionsText: "会員登録済みであること",
    verificationText: "",
    announcementMethod: "メール",
    announcementMethods: ["result_mail"],
    announcementTarget: "both",
    requirementTags: ["member_registration"],
    requirementLogic: "and",
    requirementDetails: {},
    sourceUrls: [],
    eventState: "open",
    limit: { basis: "account", maxCount: 1 },
    sourceKind: "manual",
    isNew: false,
    memo: "",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T01:02:03.123456+00:00",
    ...over,
  } as Lottery;
}
function snapshot(): LotterySnapshot {
  const data = {
    profiles: [
      { id: PA, label: "A", active: true },
      { id: PB, label: "B", active: true },
    ],
    chains: [{ id: U(10), name: "サンプル電機", aliases: [] }],
    stores: [
      { id: U(20), chainId: U(10), name: "三宮店", prefecture: "兵庫県", aliases: [] },
      { id: U(21), chainId: U(10), name: "梅田店", prefecture: "大阪府", aliases: [] },
    ],
    products: [
      { id: U(30), officialName: "拡張パックA", aliases: [], images: {} },
      { id: U(31), officialName: "拡張パックB", aliases: [], images: {} },
    ],
    accounts: [
      { id: U(40), profileId: PA, chainId: U(10), active: true },
      { id: U(41), profileId: PB, chainId: U(10), active: true },
    ],
    lotteries: [
      lot({ id: U(200) }),
      lot({
        id: U(201),
        storeId: U(21),
        multiMode: "all",
        items: [
          { id: U(101), productId: U(30), quantity: 1, unit: "box" },
          { id: U(102), productId: U(31), quantity: 2, unit: "pack" },
        ],
        applyDeadline: flexD("2026-01-10"), // 過去
        resultDate: flexD("2026-01-15"),
      }),
    ],
    management: [{ lotteryId: U(200), isManaged: true, managedSource: "manual" }],
    applications: [
      { id: U(300), lotteryId: U(200), accountId: U(40), appliedAt: "2026-11-20T03:00:00.000Z", state: "applied", result: "won", itemResults: {}, selectedItemId: null, resultConfirmedAt: "2026-12-05T03:00:00.000Z", fulfillment: "none", createdAt: "x" },
      { id: U(301), lotteryId: U(201), accountId: U(40), appliedAt: null, state: "applied", result: "won", itemResults: { [U(101)]: "won", [U(102)]: "lost" }, selectedItemId: null, resultConfirmedAt: null, fulfillment: "none", createdAt: "x" },
    ],
    skipRules: [],
  } as unknown as AppData;
  return {
    data,
    storeNos: { [U(20)]: "ST000001", [U(21)]: "ST000002" },
    productNos: { [U(30)]: "PR000001", [U(31)]: "PR000002" },
    importKeys: {},
  };
}

type Edit = (wb: ExcelJS.Workbook) => void;
async function roundTrip(snap: LotterySnapshot, edit?: Edit): Promise<Buffer> {
  const buf = await buildLotteryExport(snap, DEFAULT_EXPORT_FILTERS, new Date("2026-11-01T00:00:00Z"));
  if (!edit) return buf;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  edit(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const colOf = (ws: ExcelJS.Worksheet, label: string) => {
  let c = 0;
  ws.getRow(1).eachCell((cell, i) => {
    if (cell.value === label) c = i;
  });
  if (!c) throw new Error(label);
  return c;
};
const plan = async (snap: LotterySnapshot, buf: Buffer, decisions: Record<string, string> = {}) => {
  const read = await readLotteryWorkbook(buf);
  if (!read.ok) throw new Error(read.error);
  return planLotteries(read.value, snap, decisions, "a".repeat(64), PA);
};

describe("抽選Excel: 出力と再取り込み", () => {
  it("テンプレートは3シート＋説明。出力したデータは、そのまま再取り込みして全行が「変更なし」（空欄で値を消さない）", async () => {
    const t = new ExcelJS.Workbook();
    await t.xlsx.load((await buildLotteryTemplate()) as unknown as ExcelJS.Buffer);
    expect(t.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining([LSHEET.guide, LSHEET.lotteries, LSHEET.items, LSHEET.apps]));
    expect(String(t.keywords)).toMatch(/^toremane-lottery-import:v1$/);

    const snap = snapshot();
    const r = await plan(snap, await roundTrip(snap));
    expect(r.preview.counts).toEqual({ new: 0, update: 0, unchanged: 2, duplicate: 0, review: 0, error: 0 });
    expect(r.preview.applicable).toBe(false);
    expect(r.ops).toEqual({ lotteries: [] });
  });

  it("日付が過去の抽選もエラーにならない。複数商品の商品別当落・応募日・A/Bの状態が独立して出力される", async () => {
    const snap = snapshot();
    const read = await readLotteryWorkbook(await roundTrip(snap));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.items?.rows).toHaveLength(3);
    const apps = read.value.apps!.rows.map((r) => r.cells);
    expect(apps).toHaveLength(3); // L200: A / L201: 商品別2行
    expect(apps.filter((a) => a.lottery_id === U(201)).map((a) => a.result).sort()).toEqual(["当選", "落選"]);
    expect(apps.find((a) => a.lottery_id === U(200))).toMatchObject({ profile: "A", apply_status: "応募済み", applied_on: "2026-11-20", result: "当選", confirmed_on: "2026-12-05" });
    expect(apps.some((a) => a.profile === "B")).toBe(false); // Bは記録なし
  });

  it("既存の抽選の更新: 値のある項目だけ変わり、空欄の項目は変わらない。#CLEARで消せる項目だけ消せる", async () => {
    const snap = snapshot();
    const buf = await roundTrip(snap, (wb) => {
      const ws = wb.getWorksheet(LSHEET.lotteries)!;
      let row = 0;
      ws.eachRow((r, i) => {
        if (r.getCell(colOf(ws, "抽選ID")).value === U(200)) row = i;
      });
      ws.getCell(row, colOf(ws, "応募締切日")).value = "2026-12-03";
      ws.getCell(row, colOf(ws, "発表方法の補足")).value = "#CLEAR";
      ws.getCell(row, colOf(ws, "備考")).value = null; // 空欄
      ws.getCell(row, colOf(ws, "応募方法")).value = null;
    });
    const r = await plan(snap, buf);
    const u = r.preview.rows.find((x) => x.status === "update")!;
    expect(u.changes.map((c) => c.column)).toEqual(expect.arrayContaining(["応募締切日", "発表方法の補足"]));
    expect(u.changes.some((c) => c.column === "応募方法" || c.column === "備考")).toBe(false);
    const op = r.ops!.lotteries[0];
    expect(op.id).toBe(U(200));
    expect(op.save.lottery.announcement_method).toBe("");
    expect(op.save.lottery.apply_method).toBe("web"); // 空欄は既存値のまま
    // 必須項目は #CLEAR で消せない
    const bad = await plan(snap, await roundTrip(snap, (wb) => { const ws = wb.getWorksheet(LSHEET.lotteries)!; ws.getCell(2, colOf(ws, "受取方法")).value = "#CLEAR"; }));
    expect(bad.preview.counts.error).toBe(1);
    expect(bad.ops).toBeNull();
  });

  it("標準分類は選択肢だけ受け付ける（選択肢にない発表方法・応募条件はエラー）", async () => {
    const snap = snapshot();
    const bad = await plan(snap, await roundTrip(snap, (wb) => { const ws = wb.getWorksheet(LSHEET.lotteries)!; ws.getCell(2, colOf(ws, "発表方法")).value = "伝書鳩"; }));
    expect(bad.preview.rows.find((r) => r.status === "error")!.errors[0].message).toContain("選択肢にない値");
    // 発表方法は1つだけ。複数指定はエラー（ほかの確認方法は補足へ）
    const multi = await plan(snap, await roundTrip(snap, (wb) => { const ws = wb.getWorksheet(LSHEET.lotteries)!; ws.getCell(2, colOf(ws, "発表方法")).value = "当落メール|結果確認ページ"; }));
    expect(multi.preview.rows.find((r) => r.status === "error")!.errors[0].message).toContain("1つだけ");
    const good = await plan(snap, await roundTrip(snap, (wb) => {
      const ws = wb.getWorksheet(LSHEET.lotteries)!;
      ws.getCell(2, colOf(ws, "発表方法")).value = "当落メール";
      ws.getCell(2, colOf(ws, "応募条件")).value = "会員証・ポイントカード|購入履歴";
      ws.getCell(2, colOf(ws, "条件の結合")).value = "いずれか";
      ws.getCell(2, colOf(ws, "購入金額(円以上)")).value = "3000";
    }));
    const tax = good.ops!.lotteries[0].tax as Record<string, unknown>;
    expect(tax.announcement_methods).toEqual(["result_mail"]);
    expect(tax.requirement_tags).toEqual(["member_card", "purchase_history"]);
    expect(tax.requirement_logic).toBe("or");
    expect(tax.requirement_details).toEqual({ minAmountYen: 3000 });
  });

  it("新規: 取込キーで3シートの親子を結び付ける。過去の日付・応募済み・当選でも登録でき、取込キーは重複登録を防ぐ", async () => {
    const snap = snapshot();
    const make = async () =>
      roundTrip(snap, (wb) => {
        const l = wb.getWorksheet(LSHEET.lotteries)!;
        const i = wb.getWorksheet(LSHEET.items)!;
        const a = wb.getWorksheet(LSHEET.apps)!;
        const r = l.rowCount + 1;
        l.getCell(r, colOf(l, "取込キー")).value = "NEW001";
        l.getCell(r, colOf(l, "系列名")).value = "サンプル電機";
        l.getCell(r, colOf(l, "店舗名")).value = "三宮店";
        l.getCell(r, colOf(l, "応募開始日")).value = "2025-03-01";
        l.getCell(r, colOf(l, "応募締切日")).value = "2025-03-10";
        l.getCell(r, colOf(l, "発表開始日")).value = "2025-03-15";
        l.getCell(r, colOf(l, "受取方法")).value = "店頭受取";
        const ri = i.rowCount + 1;
        i.getCell(ri, colOf(i, "取込キー")).value = "NEW001";
        i.getCell(ri, colOf(i, "正式商品名")).value = "拡張パックB";
        i.getCell(ri, colOf(i, "数量")).value = "2";
        i.getCell(ri, colOf(i, "数量単位")).value = "BOX";
        const ra = a.rowCount + 1;
        a.getCell(ra, colOf(a, "取込キー")).value = "NEW001";
        a.getCell(ra, colOf(a, "プロフィール名")).value = "A";
        a.getCell(ra, colOf(a, "応募状況")).value = "応募済み";
        a.getCell(ra, colOf(a, "応募日")).value = "2025-03-02";
        a.getCell(ra, colOf(a, "当落結果")).value = "当選";
        const rb = ra + 1;
        a.getCell(rb, colOf(a, "取込キー")).value = "NEW001";
        a.getCell(rb, colOf(a, "プロフィール名")).value = "B";
        a.getCell(rb, colOf(a, "応募状況")).value = "応募済み";
        a.getCell(rb, colOf(a, "当落結果")).value = "落選";
      });
    const r = await plan(snap, await make());
    expect(r.preview.counts).toMatchObject({ new: 1, unchanged: 2, error: 0 });
    const op = r.ops!.lotteries.find((o) => o.id === null)!;
    expect(op.import_key).toBe(`aaaaaaaa:NEW001`);
    expect(op.save.items).toHaveLength(1);
    expect(op.apps.map((x) => [x.profile_id, x.result]).sort()).toEqual([[PA, "won"], [PB, "lost"]]); // A/Bが独立
    expect(r.preview.applicable).toBe(true);
    // 指紋は同じ入力なら同じ（適用時の照合に使う）
    const r2 = await plan(snap, await make());
    expect(fingerprintLotteryOps(r2.ops!)).toBe(fingerprintLotteryOps(r.ops!));
    // 取り込み済みの取込キー（DBの import_key）に一致すれば、再取り込みで重複登録しない（更新または変更なし）
    const snap2 = snapshot();
    snap2.data.lotteries.push(lot({ id: U(202), applyDeadline: flexD("2025-03-10"), resultDate: flexD("2025-03-15"), items: [{ id: U(103), productId: U(31), quantity: 2, unit: "box" }] }));
    snap2.importKeys[U(202)] = "aaaaaaaa:NEW001";
    const again = await plan(snap2, await make());
    expect(again.ops!.lotteries.every((o) => o.id !== null)).toBe(true);
  });

  it("未登録の商品は勝手に統合せず、選ぶまで適用しない（既存候補／新規登録／保留）", async () => {
    const snap = snapshot();
    const buf = await roundTrip(snap, (wb) => {
      const l = wb.getWorksheet(LSHEET.lotteries)!;
      const i = wb.getWorksheet(LSHEET.items)!;
      const r = l.rowCount + 1;
      l.getCell(r, colOf(l, "取込キー")).value = "N1";
      l.getCell(r, colOf(l, "系列名")).value = "サンプル電機";
      l.getCell(r, colOf(l, "店舗名")).value = "三宮店";
      l.getCell(r, colOf(l, "応募締切日")).value = "2026-12-20";
      const ri = i.rowCount + 1;
      i.getCell(ri, colOf(i, "取込キー")).value = "N1";
      i.getCell(ri, colOf(i, "正式商品名")).value = "拡張パックＡ（再販）";
      i.getCell(ri, colOf(i, "数量")).value = "1";
      i.getCell(ri, colOf(i, "数量単位")).value = "BOX";
    });
    const pending = await plan(snap, buf);
    expect(pending.preview.counts.review).toBe(1);
    const d = pending.preview.decisions.find((x) => x.kind === "product")!;
    expect(d.chosen).toBeNull();
    expect(d.options.some((o) => o.value === `existing:${U(30)}`)).toBe(true); // 近い名前は候補として出す
    expect(pending.ops!.lotteries.find((o) => o.id === null)).toBeUndefined();
    const created = await plan(snap, buf, { [d.key]: "create" });
    const op = created.ops!.lotteries.find((o) => o.id === null)!;
    expect(op.save.items[0].product).toEqual({ id: null, name: "拡張パックＡ（再販）" });
    const existing = await plan(snap, buf, { [d.key]: `existing:${U(30)}` });
    expect(existing.ops!.lotteries.find((o) => o.id === null)!.save.items[0].product.id).toBe(U(30));
    const held = await plan(snap, buf, { [d.key]: "hold" });
    expect(held.ops!.lotteries.find((o) => o.id === null)).toBeUndefined();
  });

  it("同じ店舗・締切日・商品の新規行は重複候補。別の店舗なら重複としない。選ぶまで適用しない", async () => {
    const snap = snapshot();
    const add = (store: string) => (wb: ExcelJS.Workbook) => {
      const l = wb.getWorksheet(LSHEET.lotteries)!;
      const i = wb.getWorksheet(LSHEET.items)!;
      const r = l.rowCount + 1;
      l.getCell(r, colOf(l, "取込キー")).value = "D1";
      l.getCell(r, colOf(l, "系列名")).value = "サンプル電機";
      l.getCell(r, colOf(l, "店舗名")).value = store;
      l.getCell(r, colOf(l, "応募締切日")).value = "2026-12-01";
      const ri = i.rowCount + 1;
      i.getCell(ri, colOf(i, "取込キー")).value = "D1";
      i.getCell(ri, colOf(i, "正式商品名")).value = "拡張パックA";
      i.getCell(ri, colOf(i, "数量")).value = "1";
      i.getCell(ri, colOf(i, "数量単位")).value = "BOX";
    };
    const dup = await plan(snap, await roundTrip(snap, add("三宮店")));
    expect(dup.preview.counts.duplicate).toBe(1);
    const dec = dup.preview.decisions.find((d) => d.kind === "duplicate")!;
    const accepted = await plan(snap, await roundTrip(snap, add("三宮店")), { [dec.key]: "new" });
    expect(accepted.preview.counts.new).toBe(1);
    const other = await plan(snap, await roundTrip(snap, add("梅田店")));
    expect(other.preview.counts.duplicate).toBe(0);
    expect(other.preview.counts.new).toBe(1);
  });

  it("エラー: 不明な抽選ID・複数商品で方式未指定・数式・購入済みの設定・単一商品の商品指定", async () => {
    const snap = snapshot();
    const e1 = await plan(snap, await roundTrip(snap, (wb) => { const ws = wb.getWorksheet(LSHEET.lotteries)!; ws.getCell(2, colOf(ws, "抽選ID")).value = U(999); }));
    expect(e1.preview.counts.error).toBeGreaterThan(0);
    const e2 = await plan(snap, await roundTrip(snap, (wb) => {
      const a = wb.getWorksheet(LSHEET.apps)!;
      a.getCell(2, colOf(a, "購入手続き状況")).value = "購入済み";
    }));
    expect(e2.preview.rows.some((r) => r.errors.some((x) => x.message.includes("購入済み")))).toBe(true);
    const wbf = await roundTrip(snap, (wb) => { const ws = wb.getWorksheet(LSHEET.lotteries)!; ws.getCell(2, colOf(ws, "備考")).value = { formula: "1+1", result: 2 } as ExcelJS.CellFormulaValue; });
    const read = await readLotteryWorkbook(wbf);
    expect(read.ok && read.value.issues.length).toBe(1);
  });

  it("応募の変更: 空欄のセルは既存の応募・当落を変えない。当落を入れた行だけ更新する。Bの新規応募はAに影響しない", async () => {
    const snap = snapshot();
    const r = await plan(snap, await roundTrip(snap, (wb) => {
      const a = wb.getWorksheet(LSHEET.apps)!;
      const row = a.rowCount + 1;
      a.getCell(row, colOf(a, "抽選ID")).value = U(200);
      a.getCell(row, colOf(a, "プロフィール名")).value = "B";
      a.getCell(row, colOf(a, "応募状況")).value = "応募済み";
      a.getCell(row, colOf(a, "当落結果")).value = "落選";
    }));
    expect(r.preview.counts.update).toBe(1);
    const op = r.ops!.lotteries[0];
    expect(op.apps).toHaveLength(1);
    expect(op.apps[0]).toMatchObject({ profile_id: PB, state: "applied", result: "lost" });
  });
});

describe("出力の絞り込み", () => {
  it("受付状況・応募状況・当落・プロフィールで絞り込める（複数条件はAND）", () => {
    const snap = snapshot();
    const now = new Date("2026-11-01T00:00:00Z");
    const f = (o: Partial<typeof DEFAULT_EXPORT_FILTERS>) => filterLotteries(snap.data, { ...DEFAULT_EXPORT_FILTERS, ...o }, now).map((l) => l.id);
    expect(f({})).toHaveLength(2);
    expect(f({ reception: "closed" })).toEqual([U(201)]);
    expect(f({ reception: "open" })).toEqual([U(200)]);
    expect(f({ apply: "applied", profileIds: [PA] })).toHaveLength(2);
    expect(f({ apply: "applied", profileIds: [PB] })).toHaveLength(0);
    expect(f({ apply: "unapplied", profileIds: [PB] })).toHaveLength(2);
    expect(f({ result: "won", profileIds: [PA] })).toHaveLength(2);
    expect(f({ result: "lost", profileIds: [PA] })).toHaveLength(0);
    expect(f({ reception: "closed", result: "won" })).toEqual([U(201)]);
    expect(f({ productIds: [U(31)] })).toEqual([U(201)]);
    expect(f({ deadlineFrom: "2026-12-01", deadlineTo: "2026-12-31" })).toEqual([U(200)]);
  });
  it("列定義に重複がない（取り込み・出力で同じ定義を使う）", () => {
    for (const cols of [LOTTERY_COLUMNS, ITEM_COLUMNS, APP_COLUMNS]) {
      expect(new Set(cols.map((c) => c.key)).size).toBe(cols.length);
      expect(new Set(cols.map((c) => c.label)).size).toBe(cols.length);
    }
  });
});
