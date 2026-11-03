// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { buildDraft } from "@/lib/lottery-match";

/** Stage 5N: AI解析の「購入/受取期間の区別」と「抽選方式」。実際のAPIは呼ばない */
const NOW = new Date("2026-11-05T03:00:00Z");
const d = (month: number, day: number, hour: number | null = null, minute: number | null = null) => ({ year: 2026, month, day, hour, minute });
const base = {
  is_lottery_announcement: true,
  chain_name: "テスト玩具",
  store_name: "本店",
  products: [{ name: "ポケカ ブースターパック「ほしぞら」", code: "", quantity: 1, unit: "box" }],
  multi_mode: "unknown",
  confidence: { chain: "high", store: "high" },
};
const data = createMockData(NOW);

describe("購入手続き期間と店舗受取期間の区別", () => {
  it("両方が別々に書かれていれば分離して取り込む", () => {
    const draft = buildDraft(
      normalizeExtraction({ ...base, procedure_start: d(11, 10), procedure_deadline: d(11, 12), receive_start: d(11, 15), receive_deadline: d(11, 25) }, NOW),
      data,
    );
    expect(draft.input.procedureSplit).toBe(true);
    expect(draft.input.procedureDeadline).toMatchObject({ precision: "date_only", date: "2026-11-12" });
    expect(draft.input.receiveStart).toMatchObject({ precision: "date_only", date: "2026-11-15" });
    expect(draft.input.receiveDeadline).toMatchObject({ precision: "date_only", date: "2026-11-25" });
  });

  it("区別が読み取れない（受取期間が無い）ときは分離せず、購入・受取は共通の期間のまま", () => {
    const draft = buildDraft(normalizeExtraction({ ...base, procedure_start: d(11, 10), procedure_deadline: d(11, 12) }, NOW), data);
    expect(draft.input.procedureSplit).toBe(false);
    expect(draft.input.receiveStart).toBeUndefined();
  });

  it("時刻が書かれていない期限に23:59などを補わない", () => {
    const draft = buildDraft(normalizeExtraction({ ...base, procedure_deadline: d(11, 12), receive_deadline: d(11, 25) }, NOW), data);
    expect(draft.input.receiveDeadline).toMatchObject({ precision: "date_only", time: "" });
  });
});

describe("抽選方式の判定", () => {
  it("招待制・継続抽選は取り込み、有効期限は書かれているときだけ入る", () => {
    const invite = buildDraft(normalizeExtraction({ ...base, lottery_kind: "invite", valid_until: d(12, 31) }, NOW), data);
    expect(invite.input.lotteryKind).toBe("invite");
    expect(invite.input.validUntil).toBe("2026-12-31");
    const ongoing = buildDraft(normalizeExtraction({ ...base, lottery_kind: "ongoing" }, NOW), data);
    expect(ongoing.input.lotteryKind).toBe("ongoing");
    expect(ongoing.input.validUntil).toBe(""); // 無期限とは仮定せず、未確認のまま
  });

  it("不明・通常は通常抽選として扱い、有効期限は持たない", () => {
    for (const kind of ["unknown", "normal", undefined]) {
      const draft = buildDraft(normalizeExtraction({ ...base, lottery_kind: kind, valid_until: d(12, 31) }, NOW), data);
      expect(draft.input.lotteryKind).toBe("normal");
      expect(draft.input.validUntil).toBe("");
    }
  });
});
