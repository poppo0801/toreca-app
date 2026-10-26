import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly, dateTime, jstDateString, UNKNOWN_DATE } from "@/lib/datetime";
import { computeAlerts, DEFAULT_NOTIFICATION_SETTINGS, jstAt, planNotifications, type NotificationSettings } from "@/lib/notifications";
import * as m from "@/lib/mutations";
import type { AppData, FlexibleDate, Lottery } from "@/types/domain";

/** 2026-10-26 12:00 JST */
const NOW = new Date("2026-10-26T03:00:00Z");
const mins = (n: number, from = NOW) => new Date(from.getTime() + n * 60000);
const at = (n: number): FlexibleDate => dateTime(mins(n).toISOString());

/** L4（テスト玩具）を題材に、AとBが未応募の状態を作る */
function base(patch: Partial<Lottery> = {}): AppData {
  const d = createMockData(NOW);
  return { ...d, lotteries: d.lotteries.map((l) => (l.id === "L4" ? { ...l, ...patch } : l)) };
}
const plan = (d: AppData, now = NOW, s: Record<string, NotificationSettings | undefined> = {}) => planNotifications(d, s, now);
const forL4 = (p: ReturnType<typeof plan>, profile?: string) => p.due.filter((n) => n.lotteryId === "L4" && (!profile || n.profileId === profile));

describe("応募締切の段階通知", () => {
  it("締切まで遠い間は何も送らない", () => {
    expect(forL4(plan(base({ applyDeadline: at(60 * 30) })))).toHaveLength(0);
  });

  it("2時間前の窓に入ったら2時間前だけ送る。本文の残り時間は送信時点の値", () => {
    const p = plan(base({ applyDeadline: at(100) }));
    const n = forL4(p, "pA");
    expect(n).toHaveLength(1);
    expect(n[0].type).toBe("deadline_before");
    expect(n[0].triggerKey).toContain("m120");
    expect(n[0].body).toContain("あと1時間40分");
    expect(n[0].body).toContain("a-c3".replace("a-c3", "A c3")); // 未応募アカウント名
  });

  it("15分前の窓では最も締切に近い1件だけ送り、手前の段階は抑止（連続送信しない）", () => {
    const p = plan(base({ applyDeadline: at(10) }));
    const n = forL4(p, "pA");
    expect(n.map((x) => x.triggerKey.split(":")[1])).toEqual(["m15"]);
    const sup = p.suppressed.filter((x) => x.profileId === "pA" && x.lotteryId === "L4").map((x) => x.triggerKey.split(":")[1]);
    expect(sup).toEqual(expect.arrayContaining(["m120"]));
    expect(sup.every((k) => k !== "m15")).toBe(true);
  });

  it("当日の朝（時刻あり）: 朝の設定時刻を過ぎ、2時間前より前なら朝の通知", () => {
    // 締切 15:00 JST（NOW=12:00）。朝09:00は過ぎ、2時間前=13:00はまだ
    const p = plan(base({ applyDeadline: at(180) }));
    const n = forL4(p, "pA");
    expect(n.map((x) => x.type)).toEqual(["deadline_morning"]);
    expect(n[0].title).toContain("本日が応募締切");
  });

  it("締切を過ぎたら送らない。応募済み・スルー・対象外・枠充足・要確認・★OFFのプロフィールには送らない", () => {
    expect(forL4(plan(base({ applyDeadline: at(-5) })))).toHaveLength(0);

    const open = base({ applyDeadline: at(10) });
    expect(forL4(plan(open)).map((n) => n.profileId).sort()).toEqual(["pA", "pB"]);

    // Aが応募済み → Aには送らない（Bには送る）
    const applied = m.setApplied(open, "pA", "L4", "a-c3", true, NOW);
    expect(forL4(plan(applied)).map((n) => n.profileId)).toEqual(["pB"]);
    // Bがスルー → Bには送らない。Aのスルーは別
    const skipped = m.setLotterySkip(applied, "pB", "L4", true, NOW);
    expect(forL4(plan(skipped))).toHaveLength(0);
    // 枠充足: 1人1回のため、同名義では他アカウントも不要…ここでは家族1回に変えてAの応募でBが枠充足
    const fam = m.setApplied(base({ applyDeadline: at(10), limit: { basis: "family", maxCount: 1 } }), "pA", "L4", "a-c3", true, NOW);
    expect(forL4(plan(fam))).toHaveLength(0);
    // 要確認（上限未確認）は確定発火しない
    expect(forL4(plan(base({ applyDeadline: at(10), limit: { basis: "unknown", maxCount: 1 } })))).toHaveLength(0);
    // ★OFFは応募漏れ通知の対象外（★とスルーは独立）
    expect(forL4(plan(m.setManaged(open, "pA", "L4", false, NOW)))).toHaveLength(0);
    // Cは対象系列外
    expect(forL4(plan(open), "pC")).toHaveLength(0);
  });

  it("日付のみの締切: 当日の朝に「時刻未確認」として通知。設定でOFFにでき、時刻を仮定した通知はしない", () => {
    const today = jstDateString(NOW);
    const p = plan(base({ applyDeadline: dateOnly(today) }));
    const n = forL4(p, "pA");
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain("時刻未確認");
    expect(n.every((x) => x.type === "deadline_morning")).toBe(true);
    // 朝の前は送らない
    expect(forL4(plan(base({ applyDeadline: dateOnly(today) }), jstAt(today, "08:30")))).toHaveLength(0);
    // 翌日は送らない（期限を仮定しない）
    expect(forL4(plan(base({ applyDeadline: dateOnly(today) }), jstAt(jstDateString(mins(24 * 60)), "10:00")))).toHaveLength(0);
    // 通知しない設定
    const off = { pA: { ...DEFAULT_NOTIFICATION_SETTINGS, dateOnlyPolicy: "none" as const } };
    expect(forL4(plan(base({ applyDeadline: dateOnly(today) }), NOW, off), "pA")).toHaveLength(0);
    // 期限不明は通知しない
    expect(forL4(plan(base({ applyDeadline: UNKNOWN_DATE })))).toHaveLength(0);
  });

  it("プロフィール別の設定（通知OFF・オフセット・朝の時刻）が反映される", () => {
    const d = base({ applyDeadline: at(40) });
    const s = { pA: { ...DEFAULT_NOTIFICATION_SETTINGS, deadlineOffsetsMin: [45] }, pB: { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false } };
    const n = forL4(plan(d, NOW, s));
    expect(n.map((x) => `${x.profileId}:${x.triggerKey.split(":")[1]}`)).toEqual(["pA:m45"]);
  });

  it("同じ入力から同じキーが生成される（冪等キー）。締切が変わるとキーも変わる", () => {
    const k1 = forL4(plan(base({ applyDeadline: at(10) }))).map((n) => n.triggerKey);
    const k2 = forL4(plan(base({ applyDeadline: at(10) }))).map((n) => n.triggerKey);
    expect(k1).toEqual(k2);
    const k3 = forL4(plan(base({ applyDeadline: at(12) }))).map((n) => n.triggerKey);
    expect(k3).not.toEqual(k1);
  });
});

describe("当落発表・結果未確認の再通知", () => {
  /** L6: A,B応募済み・結果待ち。applications.createdAt を調整して登録時期を変える */
  function result(resultDate: FlexibleDate, createdAtMin: number): AppData {
    const d = createMockData(NOW);
    return {
      ...d,
      lotteries: d.lotteries.map((l) => (l.id === "L6" ? { ...l, resultDate } : l)),
      applications: d.applications.map((a) => (a.lotteryId === "L6" ? { ...a, createdAt: mins(createdAtMin).toISOString() } : a)),
    };
  }
  const forL6 = (p: ReturnType<typeof plan>, profile = "pA") => p.due.filter((n) => n.lotteryId === "L6" && n.profileId === profile);

  it("発表時刻になったら通知し、その後の未確認リマインドは段階の最新だけ送る", () => {
    const d = result(at(-30), -60 * 24 * 7);
    expect(forL6(plan(d)).map((n) => n.type)).toEqual(["result_day"]);
    // 発表から4時間後: 3時間後のリマインド窓に入る（発表通知は窓内だが別枠）
    const later = plan(d, mins(210));
    expect(forL6(later).map((n) => n.type)).toContain("result_unconfirmed");
    expect(forL6(later).filter((n) => n.type === "result_unconfirmed")).toHaveLength(1);
  });

  it("過去の抽選を今登録しても過去分の通知は出ない（登録より前の時刻のトリガーは抑止）", () => {
    const d = result(at(-120), 0); // 2時間前に発表、応募記録は今作成
    const p = plan(d);
    expect(forL6(p)).toHaveLength(0);
    expect(p.suppressed.some((s) => s.lotteryId === "L6" && s.reason === "registered_after_due")).toBe(true);
    // 数日前の発表も、窓を過ぎているので送らない
    expect(forL6(plan(result(at(-60 * 24 * 3), -60 * 24 * 10)))).toHaveLength(0);
  });

  it("発表日のみ: 当日の朝に時刻未確認として通知し、翌朝に未確認リマインド", () => {
    const today = jstDateString(NOW);
    const d = result(dateOnly(today), -60 * 24 * 7);
    expect(forL6(plan(d)).map((n) => n.type)).toEqual(["result_day"]);
    expect(forL6(plan(d))[0].title).toContain("時刻未確認");
    const nextMorning = jstAt(jstDateString(mins(24 * 60)), "09:30");
    expect(forL6(plan(d, nextMorning)).map((n) => n.type)).toEqual(["result_unconfirmed"]);
  });

  it("結果が登録済み・中止の場合は通知しない", () => {
    const d = result(at(-30), -60 * 24 * 7);
    const done = d.applications.filter((a) => a.lotteryId === "L6").reduce((acc, a) => m.setResult(acc, "pA", a.id, "lost", NOW), d);
    expect(forL6(plan(done))).toHaveLength(0);
    const cancelled: AppData = { ...d, lotteries: d.lotteries.map((l) => (l.id === "L6" ? { ...l, eventState: "cancelled" as const } : l)) };
    expect(forL6(plan(cancelled))).toHaveLength(0);
  });
});

describe("購入手続き・受取期限の通知", () => {
  /** L7: Aが当選（a-c2）。procedureDeadline を調整 */
  const withProc = (procedureDeadline: FlexibleDate): AppData => {
    const d = createMockData(NOW);
    return { ...d, lotteries: d.lotteries.map((l) => (l.id === "L7" ? { ...l, procedureDeadline } : l)) };
  };
  const forL7 = (p: ReturnType<typeof plan>) => p.due.filter((n) => n.lotteryId === "L7");

  it("24時間前・3時間前の段階。短い期限では24時間を待たず最も近い段階を即通知", () => {
    expect(forL7(plan(withProc(at(60 * 20)))).map((n) => n.triggerKey.split(":")[1])).toEqual(["h24"]);
    const urgent = plan(withProc(at(60 * 2)));
    expect(forL7(urgent).map((n) => n.triggerKey.split(":")[1])).toEqual(["h3"]);
    expect(urgent.suppressed.some((s) => s.lotteryId === "L7" && s.triggerKey.includes("h24"))).toBe(true);
    expect(forL7(plan(withProc(at(60 * 40))))).toHaveLength(0);
  });

  it("購入済み・期限切れ・期限不明は通知しない", () => {
    const d = withProc(at(60 * 2));
    const app = d.applications.find((a) => a.lotteryId === "L7" && a.result === "won")!;
    expect(forL7(plan(m.setFulfillment(d, "pA", app.id, "purchased", NOW)))).toHaveLength(0);
    expect(forL7(plan(withProc(at(-10))))).toHaveLength(0);
    expect(forL7(plan(withProc(UNKNOWN_DATE)))).toHaveLength(0);
  });

  it("期限が日付のみなら前日・当日の朝に通知（時刻は仮定しない）", () => {
    const tomorrow = jstDateString(mins(24 * 60));
    const n = forL7(plan(withProc(dateOnly(tomorrow))));
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain("時刻未確認");
  });

  it("通知先は当選アカウントの担当プロフィール（A）のみ", () => {
    const n = plan(withProc(at(60 * 2))).due.filter((x) => x.lotteryId === "L7");
    expect(n.map((x) => x.profileId)).toEqual(["pA"]);
  });
});

describe("資格期限の通知と画面内アラート", () => {
  it("資格の有効期限が近づいたら担当プロフィールに1回通知（有効期限が更新されれば再通知）", () => {
    const d: AppData = {
      ...createMockData(NOW),
      requirements: [{ id: "q1", chainId: "c1", kind: "membership", label: "会員登録", validMonths: 12 }],
      eligibilities: [{ id: "e1", accountId: "a-c1", requirementId: "q1", state: "eligible", verifiedOn: null, validFrom: null, validUntil: jstDateString(mins(60 * 24 * 10)) }],
    };
    const n = plan(d).due.filter((x) => x.type === "eligibility_expiry");
    expect(n.map((x) => x.profileId)).toEqual(["pA"]);
    const d2 = { ...d, eligibilities: [{ ...d.eligibilities[0], validUntil: jstDateString(mins(60 * 24 * 40)) }] };
    expect(plan(d2).due.filter((x) => x.type === "eligibility_expiry")).toHaveLength(0);
  });

  it("画面内アラート: 締切間近の未応募・結果未登録・購入期限を現在のプロフィール分だけ表示", () => {
    const d = base({ applyDeadline: at(60) });
    const a = computeAlerts(d, "pA", NOW);
    expect(a.some((x) => x.kind === "apply_soon" && x.lotteryId === "L4")).toBe(true);
    expect(a.some((x) => x.kind === "result_overdue" && x.lotteryId === "L6")).toBe(true);
    expect(computeAlerts(d, "pC", NOW).some((x) => x.lotteryId === "L4")).toBe(false);
    // 応募済みならアラートから消える
    const applied = m.setApplied(d, "pA", "L4", "a-c3", true, NOW);
    expect(computeAlerts(applied, "pA", NOW).some((x) => x.kind === "apply_soon" && x.lotteryId === "L4")).toBe(false);
  });
});
