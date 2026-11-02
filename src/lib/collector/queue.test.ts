import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, backoffMs, collectDue, detectCancel, diffAgainstLottery, healthWarnings, hashNormalized, isNewRound, isPermanentError, nextCollectAt, normalizeForHash, priorityScore, scheduledInstant } from "@/lib/collector/queue";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import type { Lottery } from "@/types/domain";

const NOW = new Date("2026-11-02T03:00:00Z"); // 日本時間 12:00
const h = (n: number) => new Date(NOW.getTime() + n * 3600_000);
const P = (over: Partial<Parameters<typeof priorityScore>[0]> = {}) => priorityScore({ now: NOW, dueAt: null, createdAt: NOW, nextRunAt: null, changed: false, ...over });

describe("優先順位（本日締切 > 新着・1〜3日 > 通常。締切不明は後回しにしない。古いジョブも上がる）", () => {
  it("締切が近いほど優先: 数時間以内 > 24時間以内 > 72時間以内 > それ以降", () => {
    const old = new Date(NOW.getTime() - 48 * 3600_000);
    const s = (hours: number) => P({ dueAt: h(hours), createdAt: old });
    expect(s(3)).toBeGreaterThan(s(20));
    expect(s(20)).toBeGreaterThan(s(60));
    expect(s(60)).toBeGreaterThan(s(24 * 10));
  });
  it("締切不明は、4日以上先の締切より先に処理される（当日締切の可能性があるため最後尾にしない）", () => {
    const old = new Date(NOW.getTime() - 48 * 3600_000);
    expect(P({ dueAt: null, createdAt: old })).toBeGreaterThan(P({ dueAt: h(24 * 10), createdAt: old }));
  });
  it("新着は加点、内容の変更（締切延長など）はさらに加点", () => {
    const old = new Date(NOW.getTime() - 72 * 3600_000);
    expect(P({ createdAt: NOW })).toBeGreaterThan(P({ createdAt: old }) - 1);
    expect(P({ createdAt: old, changed: true })).toBe(P({ createdAt: old }) + 25);
  });
  it("待ち時間が長いほど優先度が上がる（古いジョブが放置されない）。上限は60", () => {
    const wait = (days: number) => P({ dueAt: h(24 * 10), createdAt: new Date(NOW.getTime() - days * 86400_000) });
    expect(wait(3)).toBeGreaterThan(wait(1));
    // 低優先でも、十分長く待てば新着の通常案件を上回る
    expect(wait(14)).toBeGreaterThan(P({ dueAt: h(24 * 10), createdAt: NOW }));
    expect(wait(100) - wait(30)).toBe(0);
  });
});

describe("再試行", () => {
  it("指数バックオフ: 15分 → 1時間 → 4時間。上限で打ち切る", () => {
    expect(backoffMs(1)).toBe(15 * 60_000);
    expect(backoffMs(2)).toBe(60 * 60_000);
    expect(backoffMs(MAX_ATTEMPTS)).toBeNull();
  });
  it("ロボット取得の拒否など、再試行しても変わらない失敗は永続エラー", () => {
    expect(isPermanentError("このサイトはロボットによるページ取得を許可していません")).toBe(true);
    expect(isPermanentError("通信に失敗しました")).toBe(false);
  });
});

describe("定期収集の実行時刻（日本時間6:00）", () => {
  it("指定時刻を過ぎていて、今日まだ収集していなければ実行。時刻前・収集済みは実行しない。ティックが数分ずれても実行される", () => {
    const at = scheduledInstant(new Date("2026-11-02T00:00:00+09:00"), 6);
    expect(at.toISOString()).toBe("2026-11-01T21:00:00.000Z");
    expect(collectDue(new Date("2026-11-02T05:59:00+09:00"), 6, null)).toBe(false);
    expect(collectDue(new Date("2026-11-02T06:00:00+09:00"), 6, null)).toBe(true);
    expect(collectDue(new Date("2026-11-02T06:04:00+09:00"), 6, new Date("2026-11-01T06:01:00+09:00"))).toBe(true); // 昨日の収集
    expect(collectDue(new Date("2026-11-02T06:04:00+09:00"), 6, new Date("2026-11-02T06:00:30+09:00"))).toBe(false); // 今日は収集済み
    expect(collectDue(new Date("2026-11-02T18:00:00+09:00"), 6, null)).toBe(true); // 取りこぼした日は後から実行
  });
  it("次回の収集予定", () => {
    expect(nextCollectAt(new Date("2026-11-02T05:00:00+09:00"), 6).toISOString()).toBe("2026-11-01T21:00:00.000Z");
    expect(nextCollectAt(new Date("2026-11-02T07:00:00+09:00"), 6).toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });
});

describe("変更検出（広告・カウントダウンの変化は無視し、日時・金額などの変更は検出する）", () => {
  it("相対時間・「新しいタブで開きます」・アクセス数の変化はハッシュに影響しない", () => {
    const a = "24時間以内に締切 11/1(日) 22:00 まで ¥5,500 応募する （古本市場 南茨木店・新しいタブで開きます）";
    const b = "あと5時間 11/1(日) 22:00 まで ¥5,500 応募する （古本市場 南茨木店）";
    expect(normalizeForHash(a)).toBe(normalizeForHash(b));
    expect(hashNormalized("PV 1,000 いま受付中の抽選 11/3(火) 20:30まで")).toBe(hashNormalized("PV 2,345 いま受付中の抽選 11/3(火) 20:30まで"));
  });
  it("締切・日付・金額・店舗の変更はハッシュが変わる", () => {
    expect(hashNormalized("11/3(火) 20:30まで 千葉県")).not.toBe(hashNormalized("11/5(木) 20:30まで 千葉県"));
    expect(hashNormalized("¥5,500 11/3まで")).not.toBe(hashNormalized("¥7,216 11/3まで"));
  });
  it("中止の表示を検出する", () => {
    expect(detectCancel("本抽選販売は中止となりました。")).toBeTruthy();
    expect(detectCancel("抽選販売は中止します")).toBeTruthy();
    expect(detectCancel("抽選販売のお知らせ。応募は11/3まで")).toBeNull();
  });
});

describe("既存の抽選との差分と新しい抽選回の判定", () => {
  const cur = {
    applyStart: { precision: "date_time", at: "2027-01-10T01:00:00.000Z" },
    applyDeadline: { precision: "date_time", at: "2027-01-20T14:59:00.000Z" }, // 日本時間 1/20 23:59
    resultDate: { precision: "date_only", date: "2027-01-25" },
    procedureStart: { precision: "unknown" },
    procedureDeadline: { precision: "unknown" },
    receiveMethod: "store",
  } as unknown as Lottery;
  const next = (over: Record<string, unknown> = {}) =>
    ({
      applyStart: { precision: "date_time", date: "2027-01-10", time: "10:00" },
      applyDeadline: { precision: "date_time", date: "2027-01-20", time: "23:59" },
      resultDate: { precision: "date_only", date: "2027-01-25", time: "" },
      procedureStart: EMPTY_FLEX,
      procedureDeadline: EMPTY_FLEX,
      receiveMethod: "store",
      ...over,
    }) as unknown as LotteryInput;
  it("変更なしなら差分なし。不明（読み取れなかった項目）は変更とみなさない", () => {
    expect(diffAgainstLottery(next(), cur)).toEqual([]);
    expect(diffAgainstLottery(next({ resultDate: EMPTY_FLEX, receiveMethod: "unknown" }), cur)).toEqual([]);
  });
  it("締切延長・発表日変更・受取方法の変更を検出する", () => {
    const d = diffAgainstLottery(next({ applyDeadline: { precision: "date_time", date: "2027-01-22", time: "23:59" }, resultDate: { precision: "date_only", date: "2027-01-28", time: "" }, receiveMethod: "shipping" }), cur);
    expect(d.map((x) => x.key)).toEqual(["applyDeadline", "resultDate", "receiveMethod"]);
    expect(d[0]).toMatchObject({ before: "2027-01-20 23:59", after: "2027-01-22 23:59" });
  });
  it("同じURLでも、前回の締切の後に新しい応募期間が始まれば別の抽選回。単なる延長は同じ抽選", () => {
    expect(isNewRound(next({ applyStart: { precision: "date_time", date: "2027-02-01", time: "10:00" }, applyDeadline: { precision: "date_time", date: "2027-02-10", time: "23:59" } }), cur)).toBe(true);
    expect(isNewRound(next({ applyDeadline: { precision: "date_time", date: "2027-01-22", time: "23:59" } }), cur)).toBe(false);
    expect(isNewRound(next(), cur)).toBe(false);
  });
});

describe("異常の警告", () => {
  const base = { now: NOW, workerEnabled: true, queued: 0, oldestQueuedAt: null, lastWorkerAt: h(-0.1), failedLast24h: 0, pausedReason: null, sources: [], scheduleEnabled: true, lastCollectAt: h(-5) };
  it("正常なら警告なし", () => expect(healthWarnings(base)).toEqual([]));
  it("ワーカー停止・滞留・失敗の急増・取得失敗・自動停止・定期収集の停止を警告する", () => {
    const w = healthWarnings({
      ...base,
      queued: 10,
      oldestQueuedAt: h(-72),
      lastWorkerAt: h(-3),
      failedLast24h: 12,
      pausedReason: "連続失敗",
      sources: [{ name: "pokeso", enabled: true, lastSuccessAt: h(-100), consecutiveFailures: 4 }],
      lastCollectAt: h(-50),
    }).map((x) => x.code);
    expect(w).toEqual(expect.arrayContaining(["paused", "queue_stuck", "failures_surge", "source_stale", "collect_stale"]));
    expect(healthWarnings({ ...base, queued: 3, lastWorkerAt: h(-2), oldestQueuedAt: h(-1) }).map((x) => x.code)).toContain("worker_stalled");
  });
  it("無効な収集元・ワーカー無効は警告しない", () => {
    expect(healthWarnings({ ...base, workerEnabled: false, queued: 5, lastWorkerAt: null, sources: [{ name: "x", enabled: false, lastSuccessAt: null, consecutiveFailures: 9 }] })).toEqual([]);
  });
});

import { CALL_RESERVE_JPY, budgetCallsLeft, effectiveDailyLimit, jstDayString } from "@/lib/collector/queue";

describe("日次上限（日本時間）と一時的な変更", () => {
  const base = { worker_daily_ai_limit: 100, worker_limit_override: 150, worker_limit_override_date: "2026-11-02" };
  it("一時的な変更は設定した日(日本時間)だけ有効で、翌日0時に通常の設定へ戻る", () => {
    expect(effectiveDailyLimit(base, new Date("2026-11-02T23:59:00+09:00"))).toEqual({ limit: 150, overridden: true });
    expect(effectiveDailyLimit(base, new Date("2026-11-03T00:00:00+09:00"))).toEqual({ limit: 100, overridden: false });
    // UTCでは前日でも、日本時間で翌日なら戻る（タイムゾーンを日本時間にそろえている）
    expect(effectiveDailyLimit(base, new Date("2026-11-02T15:30:00Z"))).toEqual({ limit: 100, overridden: false });
    expect(effectiveDailyLimit({ ...base, worker_limit_override: null, worker_limit_override_date: null }, new Date("2026-11-02T12:00:00+09:00"))).toEqual({ limit: 100, overridden: false });
  });
  it("日付は日本時間", () => {
    expect(jstDayString(new Date("2026-11-02T15:00:00Z"))).toBe("2026-11-03");
    expect(jstDayString(new Date("2026-11-02T14:59:00Z"))).toBe("2026-11-02");
  });
});

describe("月額予算の安全側の停止", () => {
  it("残額が『1回の見込み×件数』に満たない分は始めない。予算超過・ちょうど到達は0", () => {
    expect(budgetCallsLeft(3000, 0)).toBe(Math.floor(3000 / CALL_RESERVE_JPY));
    expect(budgetCallsLeft(3000, 2990)).toBe(1);
    expect(budgetCallsLeft(3000, 2995)).toBe(0); // 残り5円では1回(約8円)の見込みに満たない
    expect(budgetCallsLeft(3000, 3000)).toBe(0);
    expect(budgetCallsLeft(3000, 3500)).toBe(0);
    expect(budgetCallsLeft(0, 0)).toBe(0);
  });
});

describe("上限・予算・停止の警告", () => {
  const NOW2 = new Date("2026-11-02T03:00:00Z");
  const hb = { now: NOW2, workerEnabled: true, queued: 12, oldestQueuedAt: new Date(NOW2.getTime() - 3600_000), lastWorkerAt: new Date(NOW2.getTime() - 60_000), lastProgressAt: new Date(NOW2.getTime() - 60_000), failedLast24h: 0, pausedReason: null, sources: [], scheduleEnabled: false, lastCollectAt: null };
  it("日次上限に達したら『本日のAI解析上限N件に達しました。解析待ちM件』。ワーカーは動いているので停止の警告は出さない", () => {
    const w = healthWarnings({ ...hb, dailyUsed: 100, dailyLimit: 100, lastProgressAt: new Date(NOW2.getTime() - 5 * 3600_000) });
    expect(w.map((x) => x.message)).toContain("本日のAI解析上限100件に達しました。解析待ち12件");
    expect(w.map((x) => x.code)).not.toContain("worker_stalled");
  });
  it("本日締切が未処理のまま上限・予算で止まっているときは、優先して警告する", () => {
    const w = healthWarnings({ ...hb, dailyUsed: 100, dailyLimit: 100, dueTodayQueued: 3 });
    expect(w[0].code).toBe("due_today");
    expect(w[0].message).toContain("3件");
  });
  it("月額予算が不足なら予算の警告（日次上限を変えても再開しないと明示）", () => {
    const w = healthWarnings({ ...hb, budgetBlocked: true, dailyUsed: 0, dailyLimit: 100 });
    expect(w.find((x) => x.code === "budget")?.message).toContain("再開しません");
    expect(w.map((x) => x.code)).not.toContain("daily_limit");
  });
  it("Cronが動いていても、実際に処理が進んでいなければ警告する（正常とみなさない）", () => {
    const w = healthWarnings({ ...hb, lastWorkerAt: new Date(NOW2.getTime() - 60_000), lastProgressAt: new Date(NOW2.getTime() - 3 * 3600_000), dailyUsed: 3, dailyLimit: 100 });
    expect(w.map((x) => x.code)).toContain("worker_stalled");
    expect(healthWarnings({ ...hb, dailyUsed: 3, dailyLimit: 100 })).toEqual([]);
  });
});
