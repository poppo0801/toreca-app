import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly, formatFlexible, isPast, remainingBadge, UNKNOWN_DATE } from "@/lib/datetime";
import { judgeAccount } from "@/lib/eligibility";
import { DEFAULT_FILTERS, formatItem, selectLotteries } from "@/lib/lottery-view";
import * as m from "@/lib/mutations";

const NOW = new Date("2026-10-26T03:00:00Z");
const mk = () => createMockData(NOW);
const lot = (d: ReturnType<typeof mk>, id: string) => d.lotteries.find((l) => l.id === id)!;
const acc = (d: ReturnType<typeof mk>, id: string) => d.accounts.find((a) => a.id === id)!;
const status = (d: ReturnType<typeof mk>, l: string, a: string) =>
  judgeAccount(d, lot(d, l), acc(d, a), NOW).status;

describe("応募可能判定", () => {
  it("AのスルーはBへ伝播しない（L5: Aは店舗スルー、Bは未確認だが対象）", () => {
    const d = mk();
    // L5 は上限未確認のため両者 needs_review になるが、スルーはAのみ
    expect(status(d, "L5", "a-c4")).toBe("skipped");
    expect(status(d, "L5", "b-c4")).not.toBe("skipped");
  });

  it("★はプロフィールに依存しない（共通）", () => {
    const d = mk();
    expect(d.management.find((x) => x.lotteryId === "L1")?.isManaged).toBe(true);
  });

  it("Cの許可リスト外の系列は対象外で、未応募扱いにならない", () => {
    const d = mk();
    expect(status(d, "L3", "c-c2")).toBe("ineligible");
    expect(status(d, "L1", "c-c1")).toBe("eligible_unapplied");
  });

  it("同キャンペーンの店舗は独立レコードで、1店舗制限は横断判定される", () => {
    const d = mk();
    expect(d.applications.some((a) => a.lotteryId === "L1")).toBe(false);
    // L2(名谷)にAが応募済み → L1(三宮)のAは枠充足、Bは未応募のまま
    expect(status(d, "L2", "a-c1")).toBe("applied");
    expect(status(d, "L1", "a-c1")).toBe("covered_by_limit");
    expect(status(d, "L1", "b-c1")).toBe("eligible_unapplied");
  });

  it("1家族1回: Aが応募するとBは枠充足で通知対象外", () => {
    const d = mk();
    expect(status(d, "L3", "a-c2")).toBe("applied");
    expect(status(d, "L3", "b-c2")).toBe("covered_by_limit");
  });

  it("会員資格や上限が未確認なら needs_review", () => {
    const d = mk();
    expect(status(d, "L5", "b-c4")).toBe("needs_review");
  });
});

describe("日時の精度", () => {
  it("日付のみ・不明では残り時間バッジを算出しない", () => {
    expect(remainingBadge(dateOnly("2026-10-27"), NOW)).toBeNull();
    expect(remainingBadge(UNKNOWN_DATE, NOW)).toBeNull();
    expect(formatFlexible(dateOnly("2026-10-27"))).toBe("10/27（時刻未確認）");
  });
  it("時刻ありなら残り時間と段階を返す", () => {
    const r = remainingBadge({ precision: "date_time", at: new Date(NOW.getTime() + 20 * 60000).toISOString() }, NOW);
    expect(r).toEqual({ label: "あと20分", level: "urgent" });
  });
  it("不明は期限超過と仮定しない", () => {
    expect(isPast(UNKNOWN_DATE, NOW)).toBeNull();
  });
});

describe("タブと並び順", () => {
  it("応募済み: 発表日超過の未登録が最上位、日付不明は末尾", () => {
    const d = mk();
    const ids = selectLotteries(d, "applied", DEFAULT_FILTERS, NOW).map((l) => l.id);
    expect(ids[0]).toBe("L6");
    expect(ids[ids.length - 1]).toBe("L9");
  });
  it("落選のみの抽選は応募済み/当選から外れ、全情報に履歴として残る", () => {
    const d = mk();
    expect(selectLotteries(d, "applied", DEFAULT_FILTERS, NOW).map((l) => l.id)).not.toContain("L10");
    expect(selectLotteries(d, "all", DEFAULT_FILTERS, NOW).map((l) => l.id)).toContain("L10");
  });
  it("当選: 未購入が先、購入済みは後ろ", () => {
    const d = mk();
    expect(selectLotteries(d, "won", DEFAULT_FILTERS, NOW).map((l) => l.id)).toEqual(["L7", "L8"]);
  });
  it("商品の入数でBOX/P換算する（固定30Pにしない）", () => {
    const d = mk();
    const it = lot(d, "L3").items;
    expect(formatItem(it[0], d.products.find((p) => p.id === it[0].productId))).toContain("(60P)");
    expect(formatItem(it[1], d.products.find((p) => p.id === it[1].productId))).toContain("(20P)");
  });
});

describe("状態変更", () => {
  it("購入済みを繰り返しても購入記録は二重生成されない", () => {
    let d = mk();
    d = m.setFulfillment(d, "pA", "ap5", "purchased", NOW);
    d = m.setFulfillment(d, "pA", "ap5", "purchased", NOW);
    expect(d.purchases.filter((p) => p.applicationId === "ap5")).toHaveLength(1);
  });
  it("★OFFでも応募・結果・購入履歴は消えない。同値の再操作は冪等", () => {
    const d0 = mk();
    const d1 = m.setManaged(d0, "pA", "L8", false, NOW);
    expect(d1.applications).toEqual(d0.applications);
    expect(d1.purchases).toEqual(d0.purchases);
    expect(d1.audit).toHaveLength(1);
    expect(m.setManaged(d1, "pA", "L8", false, NOW)).toBe(d1);
  });
  it("応募取消でも行は残り、操作履歴に実行プロフィールと前後状態が残る", () => {
    let d = mk();
    d = m.setApplied(d, "pB", "L1", "b-c1", true, NOW);
    d = m.setApplied(d, "pB", "L1", "b-c1", false, NOW);
    expect(d.applications.find((a) => a.accountId === "b-c1" && a.lotteryId === "L1")?.state).toBe("cancelled");
    expect(d.audit[0]).toMatchObject({ actorProfileId: "pB", action: "cancel_apply" });
  });
  it("スルーは実行プロフィールのみに作用する", () => {
    let d = mk();
    d = m.setLotterySkip(d, "pA", "L1", true, NOW);
    expect(status(d, "L1", "a-c1")).toBe("skipped");
    expect(status(d, "L1", "b-c1")).toBe("eligible_unapplied");
  });
  it("期限切れ抽選も応募済みとして記録でき、一覧から消えない", () => {
    let d = mk();
    d = m.setApplied(d, "pA", "L10", "b-c3", true, NOW);
    expect(selectLotteries(d, "applied", DEFAULT_FILTERS, NOW).map((l) => l.id)).toContain("L10");
  });
});
