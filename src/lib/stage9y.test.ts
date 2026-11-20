import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly, formatResultMdW, formatResultShort, hasResultPeriod, inferredResultStartDay, isResultFinished, isResultInPeriod, UNKNOWN_DATE } from "@/lib/datetime";
import { resultCountdown, resultStage } from "@/lib/lottery-flow";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { buildLotteryPayload } from "@/lib/lottery-payload";
import { resultNotice } from "@/lib/lottery-summary";
import { pickSourceLinks } from "@/lib/source-links";
import { planNotifications } from "@/lib/notifications";
import type { AppData, FlexibleDate, Lottery } from "@/types/domain";

/** 2026-10-26 12:00 JST */
const NOW = new Date("2026-10-26T03:00:00Z");

describe("Stage 9Y: 当選発表の終了日だけの登録（開始日の内部推定は期間中の判定にだけ使う）", () => {
  const l = (applyDeadline: FlexibleDate, resultEndDate?: string, resultDate: FlexibleDate = UNKNOWN_DATE) => ({ applyDeadline, resultDate, resultEndDate });

  it("開始が未登録で、終了日と応募締切があれば、応募締切の翌日を内部の開始日にする", () => {
    expect(inferredResultStartDay(l(dateOnly("2026-10-24"), "2026-10-30"))).toBe("2026-10-25");
    expect(inferredResultStartDay(l(dateOnly("2026-10-31"), "2026-11-05"))).toBe("2026-11-01"); // 月またぎ
    expect(inferredResultStartDay(l(dateOnly("2026-12-31"), "2027-01-05"))).toBe("2027-01-01"); // 年またぎ
  });

  it("応募締切も不明なときは推定しない（期間中にならない）。開始が登録済みなら推定は使わない", () => {
    expect(inferredResultStartDay(l(UNKNOWN_DATE, "2026-10-30"))).toBeNull();
    expect(isResultInPeriod(l(UNKNOWN_DATE, "2026-10-30"), NOW)).toBe(false);
    expect(inferredResultStartDay(l(dateOnly("2026-10-24"), "2026-10-30", dateOnly("2026-10-27")))).toBeNull();
    expect(inferredResultStartDay(l(dateOnly("2026-10-24")))).toBeNull(); // 終了日もない
  });

  it("発表期間中の判定: 締切の翌日〜終了日（含む）。締切日当日は期間前、終了日の翌日は終了", () => {
    const e = "2026-10-28";
    expect(isResultInPeriod(l(dateOnly("2026-10-25"), e), NOW)).toBe(true); // 昨日締切→今日は期間中
    expect(isResultInPeriod(l(dateOnly("2026-10-26"), e), NOW)).toBe(false); // 今日が締切日→まだ翌日ではない
    expect(isResultInPeriod(l(dateOnly("2026-10-20"), "2026-10-26"), NOW)).toBe(true); // 終了日当日
    expect(isResultInPeriod(l(dateOnly("2026-10-20"), "2026-10-25"), NOW)).toBe(false);
    expect(isResultFinished(l(dateOnly("2026-10-20"), "2026-10-25"), NOW)).toBe(true);
    expect(isResultFinished(l(dateOnly("2026-10-20"), "2026-10-26"), NOW)).toBe(false);
    expect(isResultFinished(l(UNKNOWN_DATE, "2026-10-30"), NOW)).toBe(false);
  });

  it("カードの状態: 期間中=in_period、推定できない・期間前=unknown（カウントダウンは出さない）、終了後=overdue", () => {
    expect(resultStage(l(dateOnly("2026-10-25"), "2026-10-30"), NOW)).toBe("in_period");
    expect(resultCountdown(l(dateOnly("2026-10-25"), "2026-10-30"), NOW)).toEqual({ label: "発表期間中", tone: "info" });
    expect(resultStage(l(UNKNOWN_DATE, "2026-10-30"), NOW)).toBe("unknown");
    expect(resultCountdown(l(UNKNOWN_DATE, "2026-10-30"), NOW)).toBeNull();
    expect(resultStage(l(dateOnly("2026-10-26"), "2026-10-30"), NOW)).toBe("unknown");
    expect(resultStage(l(dateOnly("2026-10-20"), "2026-10-25"), NOW)).toBe("overdue");
    expect(resultStage(l(dateOnly("2026-10-20")), NOW)).toBe("unknown"); // 発表日が何もない
  });

  it("画面には確定した終了日だけを出し、推定した開始日は出さない（期間扱いにもしない）", () => {
    const x = l(dateOnly("2026-10-25"), "2026-10-30");
    expect(formatResultShort(x, NOW)).toBe("〜10/30");
    expect(formatResultMdW(x, NOW)).toBe("〜10/30(金)");
    expect(formatResultMdW(x, NOW)).not.toContain("10/26");
    expect(hasResultPeriod(x)).toBe(false);
    expect(formatResultShort(l(dateOnly("2026-10-25")), NOW)).toBe("—");
  });

  it("従来の動作は変わらない（開始＋終了の期間・単一日・不明）", () => {
    const p = { applyDeadline: dateOnly("2026-10-01"), resultDate: dateOnly("2026-10-25"), resultEndDate: "2026-10-27" };
    expect(resultStage(p, NOW)).toBe("in_period");
    expect(formatResultShort(p, NOW)).toBe("10/25〜10/27");
    expect(resultStage({ applyDeadline: dateOnly("2026-10-01"), resultDate: dateOnly("2026-10-30") }, NOW)).toBe("before");
    expect(resultStage({ applyDeadline: dateOnly("2026-10-01"), resultDate: UNKNOWN_DATE }, NOW)).toBe("unknown");
  });
});

describe("Stage 9Y: 入力検証と保存（推定した開始日は保存しない）", () => {
  const base = {
    chain: { id: null, name: "テスト" },
    store: { id: null, name: "本店", prefecture: "大阪府" },
    items: [{ product: { id: null, name: "商品" }, quantity: 1, unit: "box" }],
    applyStart: { precision: "date_only", date: "2026-10-18", time: "" },
    applyDeadline: { precision: "date_only", date: "2026-10-24", time: "" },
    resultDate: { precision: "unknown", date: "", time: "" },
    resultEndDate: "2026-10-30",
    sourceUrls: ["https://example.com/a"],
    storeMode: "fixed",
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    receiveMethod: "store",
    applyMethod: "web",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 1,
    memo: "",
    procedureDeadline: { precision: "unknown", date: "", time: "" },
  };

  it("終了日だけでも登録でき、DBの行は終了日のみ（開始日の列は空のまま）", () => {
    const r = lotteryInputSchema.safeParse(base);
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join(".") + ":" + i.message)).toEqual([]);
    if (!r.success) return;
    const row = buildLotteryPayload(r.data, null, null) as unknown as { lottery: Record<string, unknown> } | Record<string, unknown>;
    const flat = JSON.stringify(row);
    expect(flat).toContain('"result_end_date":"2026-10-30"');
    expect(flat).toContain('"result_precision":"unknown"');
    expect(flat).toContain('"result_date":null');
    expect(flat).not.toContain("2026-10-25"); // 応募締切の翌日（推定値）は保存されない
  });

  it("開始日があるときは従来どおり、終了日が開始日より前なら保存できない", () => {
    const bad = lotteryInputSchema.safeParse({ ...base, resultDate: { precision: "date_only", date: "2026-10-28", time: "" }, resultEndDate: "2026-10-27" });
    expect(bad.success).toBe(false);
    const ok = lotteryInputSchema.safeParse({ ...base, resultDate: { precision: "date_only", date: "2026-10-28", time: "" }, resultEndDate: "2026-10-29" });
    expect(ok.success).toBe(true);
  });
});

describe("Stage 9Y: 推定開始日を根拠とした通知・既存の表示を出さない", () => {
  function withResult(applyDeadline: FlexibleDate, resultEndDate: string): AppData {
    const d = createMockData(NOW);
    return {
      ...d,
      lotteries: d.lotteries.map((x): Lottery => (x.id === "L6" ? { ...x, applyDeadline, resultDate: UNKNOWN_DATE, resultEndDate } : x)),
      applications: d.applications.map((a) => (a.lotteryId === "L6" ? { ...a, createdAt: new Date(NOW.getTime() - 7 * 86_400_000).toISOString() } : a)),
    };
  }
  const forL6 = (p: ReturnType<typeof planNotifications>) => p.due.filter((n) => n.lotteryId === "L6");

  it("発表期間中（推定）でも、発表開始の通知（result_day）は送らない", () => {
    const d = withResult(dateOnly("2026-10-24"), "2026-10-30");
    expect(forL6(planNotifications(d, {}, NOW)).filter((n) => n.type === "result_day")).toEqual([]);
    const l6 = d.lotteries.find((x) => x.id === "L6")!;
    expect(resultNotice(d, l6, NOW)).toBe("in_period"); // 表示の判定にだけ使う
  });
});

describe("Stage 9Y: 情報源URLは重複を除いて並べる", () => {
  it("同じURL（末尾スラッシュ・フラグメント違い）は1つにまとめる", () => {
    const links = pickSourceLinks({ announcementUrl: "https://example.com/a", sourceUrls: ["https://example.com/a", "https://example.com/b", "https://x.com/s/status/1"] });
    expect(links.map((x) => x.url)).toEqual(["https://example.com/a", "https://example.com/b", "https://x.com/s/status/1"]);
  });
});
