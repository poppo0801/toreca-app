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
