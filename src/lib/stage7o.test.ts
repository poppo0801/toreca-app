import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { restorePath, RESTORE_WITHIN_MS, type LaunchVerdict } from "@/lib/lifecycle";
import { reconcileData } from "@/lib/reconcile-data";

const NOW = new Date("2026-11-03T03:00:00Z");

describe("Stage 7O: 再取得データの構造共有（reconcileData）", () => {
  it("内容が同じなら前回と同じオブジェクト（再描画しない）。一部だけ違えば、違うキーだけ新しい値", () => {
    const prev = createMockData(NOW);
    const same = JSON.parse(JSON.stringify(prev)) as typeof prev; // 別の参照・同じ内容
    expect(reconcileData(prev, same)).toBe(prev);
    const next = JSON.parse(JSON.stringify(prev)) as typeof prev;
    next.lotteries = next.lotteries.map((l, i) => (i === 0 ? { ...l, memo: "変更" } : l));
    const out = reconcileData(prev, next);
    expect(out).not.toBe(prev);
    expect(out.lotteries).toBe(next.lotteries); // 変わったキーは新しい値
    expect(out.lotteries[0].memo).toBe("変更");
    expect(out.stores).toBe(prev.stores); // 変わらないキーは前回の参照のまま
    expect(out.products).toBe(prev.products);
  });
  it("古い値が新しい値として残らない（内容が違えば必ず新しい値）。前回が無ければそのまま", () => {
    const prev = createMockData(NOW);
    const next = JSON.parse(JSON.stringify(prev)) as typeof prev;
    next.applications = [];
    expect(reconcileData(prev, next).applications).toHaveLength(0);
    expect(reconcileData(null, next)).toBe(next);
  });
});

describe("Stage 7O: 破棄後の画面の復元（restorePath）", () => {
  const discarded = (path: string, awayMs = 5 * 60_000): LaunchVerdict => ({ kind: "discarded_in_background", path, awayMs });
  const start = { pathname: "/lotteries", search: "" };
  it("バックグラウンドで破棄され、起動画面から始まったときだけ、直前の一覧・設定の画面へ戻す", () => {
    expect(restorePath(discarded("/purchases"), start)).toBe("/purchases");
    expect(restorePath(discarded("/settings/masters"), start)).toBe("/settings/masters");
  });
  it("戻さない: 30分超・表示中に終了（クラッシュの疑い）・起動画面以外・クエリあり・IDつきや不明な画面・同じ画面", () => {
    expect(restorePath(discarded("/purchases", RESTORE_WITHIN_MS + 1), start)).toBeNull();
    expect(restorePath({ kind: "terminated_while_visible", path: "/settings/masters", sinceMs: 1000 }, start)).toBeNull();
    expect(restorePath(discarded("/purchases"), { pathname: "/finance", search: "" })).toBeNull();
    expect(restorePath(discarded("/purchases"), { pathname: "/lotteries", search: "?focus=1" })).toBeNull();
    expect(restorePath(discarded("/lotteries/:id"), start)).toBeNull();
    expect(restorePath(discarded("/lotteries"), start)).toBeNull();
    expect(restorePath(discarded("/share"), start)).toBeNull();
    expect(restorePath({ kind: "normal" }, start)).toBeNull();
    expect(restorePath({ kind: "first" }, start)).toBeNull();
  });
});
