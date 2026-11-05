// @vitest-environment node
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { planLotteries, type LotterySnapshot } from "@/lib/lottery-excel/plan";
import { LSHEET } from "@/lib/lottery-excel/schema";
import { DEFAULT_EXPORT_FILTERS, buildLotteryExport, readLotteryWorkbook } from "@/lib/lottery-excel/workbook";
import type { AppData, FlexibleDate, Lottery } from "@/types/domain";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PA = U(1);
const flexD = (d: string): FlexibleDate => ({ precision: "date_only", date: d }) as FlexibleDate;

function snapshot(over: Partial<Lottery>): LotterySnapshot {
  const lot = {
    id: U(200), chainId: U(10), storeId: U(20), items: [{ id: U(100), productId: U(30), quantity: 1, unit: "box" }], multiMode: "single",
    applyStart: { precision: "unknown" }, applyDeadline: flexD("2026-12-01"), resultDate: flexD("2026-12-05"),
    procedureStart: flexD("2026-12-10"), procedureDeadline: flexD("2026-12-12"),
    receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementMethods: ["result_mail"], announcementTarget: "both",
    requirementTags: [], requirementLogic: "and", requirementDetails: {}, sourceUrls: [], eventState: "open", limit: { basis: "account", maxCount: 1 },
    sourceKind: "manual", isNew: false, memo: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T01:02:03.123456+00:00", ...over,
  } as Lottery;
  const data = {
    profiles: [{ id: PA, label: "A", active: true }],
    chains: [{ id: U(10), name: "サンプル電機", aliases: [] }],
    stores: [{ id: U(20), chainId: U(10), name: "三宮店", prefecture: "兵庫県", aliases: [] }],
    products: [{ id: U(30), officialName: "拡張パックA", aliases: [], images: {} }],
    accounts: [{ id: U(40), profileId: PA, chainId: U(10), active: true }],
    lotteries: [lot], management: [{ lotteryId: U(200), isManaged: true, managedSource: "manual" }], applications: [], skipRules: [],
  } as unknown as AppData;
  return { data, storeNos: { [U(20)]: "ST000001" }, productNos: { [U(30)]: "PR000001" }, importKeys: {} };
}
const colOf = (ws: ExcelJS.Worksheet, label: string) => {
  let c = 0;
  ws.getRow(1).eachCell((cell, i) => {
    if (cell.value === label) c = i;
  });
  if (!c) throw new Error(label);
  return c;
};
const exportBuf = (s: LotterySnapshot) => buildLotteryExport(s, DEFAULT_EXPORT_FILTERS, new Date("2026-11-01T00:00:00Z"));
const planOf = async (s: LotterySnapshot, buf: Buffer) => {
  const read = await readLotteryWorkbook(buf);
  if (!read.ok) throw new Error(read.error);
  return planLotteries(read.value, s, {}, "a".repeat(64), PA);
};
const edited = async (buf: Buffer, f: (ws: ExcelJS.Worksheet) => void) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  f(wb.getWorksheet(LSHEET.lotteries)!);
  return Buffer.from(await wb.xlsx.writeBuffer());
};

describe("Stage 6F-9: 抽選Excelで、購入/受取の分離・抽選の種類・有効期限が失われない", () => {
  const split = { procedureSplit: true, receiveStart: flexD("2026-12-15"), receiveDeadline: flexD("2026-12-20"), kind: "ongoing", validUntil: "2027-03-31" } as Partial<Lottery>;

  it("出力して再取り込みすると、分離した購入・受取期間と継続抽選の設定は『変更なし』", async () => {
    const s = snapshot(split);
    const r = await planOf(s, await exportBuf(s));
    expect(r.preview.counts).toMatchObject({ unchanged: 1, update: 0, error: 0 });
  });

  it("別の項目（備考）だけを変更しても、購入/受取の分離・抽選の種類・有効期限・受取期間は既存の値のまま更新される", async () => {
    const s = snapshot(split);
    const buf = await edited(await exportBuf(s), (ws) => {
      ws.getCell(2, colOf(ws, "備考")).value = "メモを更新";
    });
    const r = await planOf(s, buf);
    expect(r.preview.counts.update).toBe(1);
    const lot = r.ops!.lotteries[0].save.lottery;
    expect(lot.procedure_split).toBe(true);
    expect(lot.lottery_kind).toBe("ongoing");
    expect(lot.valid_until_date).toBe("2027-03-31");
    expect(lot.receive_start_date).toBe("2026-12-15");
    expect(lot.receive_end_date ?? lot.receive_deadline_date).toBeTruthy();
  });

  it("旧い形式のファイル（新しい列が無い）で更新しても、既存の分離・種類は変わらない", async () => {
    const s = snapshot(split);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await exportBuf(s)) as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet(LSHEET.lotteries)!;
    for (const label of ["購入と受取を分ける", "受取開始日", "受取開始時刻", "受取終了日", "受取終了時刻", "抽選の種類", "有効期限"]) ws.getCell(1, colOf(ws, label)).value = null; // 見出しを消す＝旧形式
    ws.getCell(2, colOf(ws, "備考")).value = "旧形式から更新";
    const r = await planOf(s, Buffer.from(await wb.xlsx.writeBuffer()));
    const lot = r.ops!.lotteries[0].save.lottery;
    expect(lot.procedure_split).toBe(true);
    expect(lot.lottery_kind).toBe("ongoing");
  });

  it("ファイルで変えたときは反映される（受取開始日・抽選の種類）", async () => {
    const s = snapshot({});
    const buf = await edited(await exportBuf(s), (ws) => {
      ws.getCell(2, colOf(ws, "購入と受取を分ける")).value = "○";
      ws.getCell(2, colOf(ws, "受取開始日")).value = "2026-12-14";
      ws.getCell(2, colOf(ws, "受取終了日")).value = "2026-12-18";
      ws.getCell(2, colOf(ws, "抽選の種類")).value = "継続抽選";
      ws.getCell(2, colOf(ws, "有効期限")).value = "2027-01-31";
    });
    const r = await planOf(s, buf);
    const lot = r.ops!.lotteries[0].save.lottery;
    expect(lot.procedure_split).toBe(true);
    expect(lot.receive_start_date).toBe("2026-12-14");
    expect(lot.lottery_kind).toBe("ongoing");
    expect(lot.valid_until_date).toBe("2027-01-31");
  });
});
