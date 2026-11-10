import { describe, expect, it } from "vitest";
import { isUnmanagedConflict, type Caution } from "@/lib/collector/attention";
import { planCompletion } from "@/lib/collector/complete";
import { ackCautions, liveCautions, pruneCautionsOnEdit } from "@/lib/live-cautions";
import type { Lottery } from "@/types/domain";

const base = { resultDate: { precision: "unknown" }, procedureStart: { precision: "unknown" }, procedureDeadline: { precision: "unknown" }, receiveMethod: "unknown", applyMethod: "web", conditionsText: "x", requirementTags: [], storeMode: "fixed", storeId: "s", multiMode: "single", items: [{}] } as unknown as Lottery;
const c = (code: string, message = "m", extra: Partial<Caution> = {}): Caution => ({ code, field: "other", message, at: "2026-11-01T00:00:00Z", ...extra });

describe("Stage 7N: 金額の表示差は矛盾にしない", () => {
  it("チケットサイトの0円と本文の税込891円は抽選管理の対象外", () => {
    expect(isUnmanagedConflict("本文の税込891円とチケットサイトの0円が食い違っている")).toBe(true);
  });
  it("応募期間・当選発表・条件などに触れる矛盾は維持する", () => {
    expect(isUnmanagedConflict("応募期間が画像と本文で食い違っている")).toBe(false);
    expect(isUnmanagedConflict("当選発表日が11/10と11/12で矛盾（税込891円）")).toBe(false);
    expect(isUnmanagedConflict("画像の内容に矛盾がある")).toBe(false);
    expect(isUnmanagedConflict(null)).toBe(false);
  });
  it("保存済みの金額差のtext_conflictは表示しない。日付の矛盾は残す", () => {
    const l = { ...base, cautions: [c("text_conflict", "情報に矛盾の疑いがあります: 税込891円と0円"), c("text_conflict", "情報に矛盾の疑いがあります: 応募期間が食い違う")] } as Lottery;
    expect(liveCautions(l, undefined).map((x) => x.message)).toEqual(["情報に矛盾の疑いがあります: 応募期間が食い違う"]);
  });
});

describe("Stage 7N: 要確認の解除", () => {
  it("確認済みにした注意は、再読み込み相当（保存済みの値）でも表示しない。他の注意は残る", () => {
    const cs = [c("result_date_unknown"), c("receive_method_unknown")];
    const acked = ackCautions(cs, ["result_date_unknown"], "2026-11-02T00:00:00Z");
    const l = { ...base, cautions: acked } as Lottery;
    expect(liveCautions(l, undefined).map((x) => x.code)).toEqual(["receive_method_unknown"]);
    expect(acked[0].ackAt).toBe("2026-11-02T00:00:00Z");
  });
  it("同じ内容の注意が再収集で出ても復活しない。内容が変われば新しい注意として出る", () => {
    const cur = { resultDate: { precision: "date_only", date: "2026-11-10" }, applyDeadline: { precision: "date_only", date: "2026-11-05" }, procedureStart: { precision: "unknown" }, procedureDeadline: { precision: "unknown" }, receiveStart: { precision: "unknown" }, receiveDeadline: { precision: "unknown" }, receiveMethod: "store", applyMethod: "web" } as never;
    const inc = { ...(cur as object), resultDate: { precision: "date_only", date: "2026-11-12" } } as never;
    const first = planCompletion(cur, inc, [], { official: false, now: "2026-11-01T00:00:00Z" });
    expect(first.cautions.map((x) => x.code)).toEqual(["conflict_resultDate"]);
    const acked = ackCautions(first.cautions, ["conflict_resultDate"], "2026-11-02T00:00:00Z");
    const again = planCompletion(cur, inc, acked, { official: false, now: "2026-11-03T00:00:00Z" });
    expect(again.cautions[0].ackAt).toBeTruthy();
    expect(again.cautionsChanged).toBe(false);
    const changed = planCompletion(cur, { ...(inc as object), resultDate: { precision: "date_only", date: "2026-11-15" } } as never, acked, { official: false, now: "2026-11-03T00:00:00Z" });
    expect(changed.cautions[0].ackAt).toBeUndefined();
  });
  it("編集での再評価: 該当項目を変更したときだけ相違の注意を解消する（編集しただけでは外さない）", () => {
    const snap = { applyDeadline: "2026-11-05", resultDate: "2026-11-10", applyMethod: "web", receiveMethod: "store" };
    const cs = [c("deadline_conflict"), c("conflict_resultDate"), c("text_conflict")];
    expect(pruneCautionsOnEdit(cs, snap, { ...snap }).map((x) => x.code)).toEqual(["deadline_conflict", "conflict_resultDate", "text_conflict"]);
    expect(pruneCautionsOnEdit(cs, snap, { ...snap, applyDeadline: "2026-11-06" }).map((x) => x.code)).toEqual(["conflict_resultDate", "text_conflict"]);
    expect(pruneCautionsOnEdit(cs, snap, { ...snap, resultDate: "2026-11-12" }).map((x) => x.code)).toEqual(["deadline_conflict", "text_conflict"]);
  });
  it("補った項目は自動で解消し、全て解消すれば0件", () => {
    const l = { ...base, receiveMethod: "store", resultDate: { precision: "date_only", date: "2026-11-20" }, cautions: [c("result_date_unknown"), c("receive_method_unknown")] } as Lottery;
    expect(liveCautions(l, undefined)).toHaveLength(0);
  });
});
