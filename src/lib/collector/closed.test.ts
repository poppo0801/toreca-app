import { describe, expect, it } from "vitest";
import { isApplicationClosed } from "@/lib/collector/closed";

const d = (iso: string) => new Date(iso);
const input = (applyDeadline: unknown, extra: object = {}) => ({ draft: { input: { applyDeadline, ...extra } } });

describe("受付終了した確認待ち候補の判定", () => {
  it("日時の締切は、過ぎたら終了", () => {
    const c = input({ precision: "date_time", date: "2026-11-07", time: "18:00" });
    expect(isApplicationClosed(c, d("2026-11-07T08:59:00Z"))).toBe(false); // 17:59 JST
    expect(isApplicationClosed(c, d("2026-11-07T09:01:00Z"))).toBe(true);
  });
  it("日付のみは、その日の23:59:59(JST)まで有効", () => {
    const c = input({ precision: "date_only", date: "2026-11-07", time: "" });
    expect(isApplicationClosed(c, d("2026-11-07T14:59:58Z"))).toBe(false); // 23:59:58
    expect(isApplicationClosed(c, d("2026-11-07T15:00:00Z"))).toBe(true); // 翌0:00
  });
  it("複数の応募期間は、有効な期間が残っていれば維持", () => {
    const c = input(undefined, { applyPeriods: [{ deadline: { precision: "date_only", date: "2026-11-05" } }, { deadline: { precision: "date_only", date: "2026-11-09" } }] });
    expect(isApplicationClosed(c, d("2026-11-07T00:00:00Z"))).toBe(false);
    expect(isApplicationClosed(c, d("2026-11-10T00:00:00Z"))).toBe(true);
  });
  it("締切が不明なものは推測で外さない", () => {
    expect(isApplicationClosed(input({ precision: "unknown" }), d("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isApplicationClosed({ draft: null }, d("2030-01-01T00:00:00Z"))).toBe(false);
  });
  it("草稿が無ければ候補の締切(due_at)を使う。日付のみ保存の23:59:00は23:59:59まで有効", () => {
    const dueAt = "2026-11-07T23:59:00+09:00";
    expect(isApplicationClosed({ dueAt }, d("2026-11-07T14:59:30Z"))).toBe(false);
    expect(isApplicationClosed({ dueAt }, d("2026-11-07T15:00:01Z"))).toBe(true);
  });
});
