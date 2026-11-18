import { describe, expect, it } from "vitest";
import { MAX_AUTO_UPDATES_PER_DAY, planAutoUpdate, type AutoUpdateContext, type UpdateEntry } from "@/lib/collector/auto-update";
import type { FieldChange } from "@/lib/collector/queue";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";

/** Stage 9B: 登録済み抽選の自動更新の判定（純関数）。応募機会を減らす変更・根拠の弱い変更・手動編集された抽選は、自動では反映しない */
const date = (d: string) => ({ ...EMPTY_FLEX, precision: "date_only" as const, date: d });
const lotFlex = (d?: string) => (d ? ({ precision: "date_only", date: d } as never) : ({ precision: "unknown" } as never));
const ctx = (over: Partial<AutoUpdateContext> = {}, cur: Partial<Record<"applyStart" | "applyDeadline" | "resultDate" | "procedureStart" | "procedureDeadline", string>> = { applyDeadline: "2026-11-20" }): AutoUpdateContext => ({
  lot: { applyStart: lotFlex(cur.applyStart), applyDeadline: lotFlex(cur.applyDeadline), resultDate: lotFlex(cur.resultDate), procedureStart: lotFlex(cur.procedureStart), procedureDeadline: lotFlex(cur.procedureDeadline), receiveMethod: "store" },
  autoRegistered: true, manuallyEdited: false, archived: false, official: false, sameSource: true, history: [], today: "2026-11-13", now: "2026-11-13T00:00:00Z", ...over,
});
const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({ applyStart: EMPTY_FLEX, applyDeadline: EMPTY_FLEX, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", ...over }) as unknown as LotteryInput;
const ch = (key: FieldChange["key"], label = "項目"): FieldChange => ({ key, label, before: "a", after: "b" });
const entry = (over: Partial<UpdateEntry> = {}): UpdateEntry => ({ id: "h1", at: "2026-11-12T00:00:00Z", keys: ["applyDeadline"], labels: ["応募締切"], before: {}, after: {}, afterKeys: {}, summary: [], sourceUrl: "u", sourceKind: "list_site", official: false, ...over });

describe("自動更新の判定: 応募機会を減らさない変更だけ自動で反映する", () => {
  it("応募締切の延長（同じ情報源の更新）は自動で反映する。不明だった日時を埋める変更も反映する", () => {
    const p = planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-25") }), ctx());
    expect(p.apply.map((c) => c.key)).toEqual(["applyDeadline"]);
    expect(p.reasons.applyDeadline).toContain("延長");
    const fill = planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-25") }), ctx({}, {}));
    expect(fill.apply).toHaveLength(1);
    expect(fill.reasons.applyDeadline).toContain("埋め");
  });
  it("応募締切の短縮は、応募機会に直接影響するため自動では反映せず、人の確認に回す（公式の情報源でも同じ）", () => {
    for (const official of [false, true]) {
      const p = planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-15") }), ctx({ official }));
      expect(p.apply).toEqual([]);
      expect(p.propose.map((c) => c.key)).toEqual(["applyDeadline"]);
      expect(p.reasons.applyDeadline).toContain("短縮");
    }
  });
  it("過去の日時への変更・開始日の変更・受取方法の変更は、人の確認に回す", () => {
    expect(planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-30") }), ctx({ today: "2026-12-05" })).apply).toEqual([]);
    expect(planAutoUpdate([ch("applyStart")], input({ applyStart: date("2026-11-10") }), ctx({}, { applyStart: "2026-11-05", applyDeadline: "2026-11-20" })).apply).toEqual([]);
    const m = planAutoUpdate([ch("receiveMethod")], input({ receiveMethod: "shipping" }), ctx());
    expect(m.apply).toEqual([]);
    expect(m.propose).toHaveLength(1);
  });
  it("当選発表日の変更は、応募機会に影響しないため自動で反映する", () => {
    const p = planAutoUpdate([ch("resultDate")], input({ resultDate: date("2026-11-28") }), ctx({}, { resultDate: "2026-11-25", applyDeadline: "2026-11-20" }));
    expect(p.apply.map((c) => c.key)).toEqual(["resultDate"]);
  });
});

describe("自動更新の判定: 根拠・保護", () => {
  it("公式でも、登録時と同じ情報源でもない更新は、自動では反映しない（人の確認）。公式なら別のURLでも反映する", () => {
    const base = [ch("applyDeadline")];
    const i = input({ applyDeadline: date("2026-11-25") });
    expect(planAutoUpdate(base, i, ctx({ sameSource: false, official: false })).apply).toEqual([]);
    expect(planAutoUpdate(base, i, ctx({ sameSource: false, official: true })).apply).toHaveLength(1);
  });
  it("手動で編集された抽選・自動収集でない抽選・退避された抽選は、自動では更新しない", () => {
    const i = input({ applyDeadline: date("2026-11-25") });
    for (const over of [{ manuallyEdited: true }, { autoRegistered: false }, { archived: true }]) {
      const p = planAutoUpdate([ch("applyDeadline")], i, ctx(over));
      expect(p.apply, JSON.stringify(over)).toEqual([]);
      expect(p.propose).toHaveLength(1);
    }
  });
  it("新しい情報に値が無い（取得できない・記載がない）ことを理由に、確認済みの値を消さない（無視する）", () => {
    const p = planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: EMPTY_FLEX }), ctx());
    expect(p.apply).toEqual([]);
    expect(p.propose).toEqual([]);
    expect(p.ignored).toHaveLength(1);
  });
  it("利用者が元に戻した内容と同じ変更は、再び反映も提案もしない（利用者の判断を尊重）", () => {
    const reverted = entry({ revertedAt: "2026-11-12T01:00:00Z", afterKeys: { applyDeadline: "2026-11-25T23:59" } });
    const p = planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-25") }), ctx({ history: [reverted] }));
    expect(p.apply).toEqual([]);
    expect(p.propose).toEqual([]);
    expect(p.ignored).toHaveLength(1);
    // 別の値への変更は対象になる
    expect(planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-27") }), ctx({ history: [reverted] })).apply).toHaveLength(1);
  });
  it("1日の自動更新の上限（誤った往復を防ぐ）を超える分は、人の確認に回す", () => {
    const hist = Array.from({ length: MAX_AUTO_UPDATES_PER_DAY }, (_, n) => entry({ id: `h${n}`, at: "2026-11-12T12:00:00Z" }));
    const p = planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-25") }), ctx({ history: hist }));
    expect(p.apply).toEqual([]);
    expect(p.propose).toHaveLength(1);
    // 元に戻したもの・24時間より前のものは数えない
    const old = [entry({ at: "2026-11-01T00:00:00Z" }), entry({ id: "r", revertedAt: "x" })];
    expect(planAutoUpdate([ch("applyDeadline")], input({ applyDeadline: date("2026-11-25") }), ctx({ history: old })).apply).toHaveLength(1);
  });
});
