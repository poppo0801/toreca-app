import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { buildDraft } from "@/lib/lottery-match";
import {
  dateOnly,
  dateTime,
  deadlineBadge,
  formatResultShort,
  hasResultPeriod,
  isResultFinished,
  isResultInPeriod,
  resultSortKey,
  UNKNOWN_DATE,
} from "@/lib/datetime";
import { EMPTY_FLEX, lotteryInputSchema } from "@/lib/lottery-input";
import { applyControlFor, extraKindsLabel, markLabel, profileMarks, resultNotice, summarizeItems } from "@/lib/lottery-summary";
import { selectLotteries, DEFAULT_FILTERS } from "@/lib/lottery-view";
import * as m from "@/lib/mutations";
import { addDaysJst, computeAlerts, jstAt, planNotifications, tabDots } from "@/lib/notifications";
import { InMemoryRepository } from "@/services/memory-repository";
import type { AppData, FlexibleDate, Lottery } from "@/types/domain";

/** 2026-10-26 12:00 JST */
const NOW = new Date("2026-10-26T03:00:00Z");
const min = (n: number, from = NOW) => new Date(from.getTime() + n * 60000);
const at = (n: number): FlexibleDate => dateTime(min(n).toISOString());

describe("応募締切の残り時間バッジ（段階: 3日以上/3日未満/24時間未満/終了）", () => {
  const b = (v: FlexibleDate) => deadlineBadge(v, NOW);

  it("3日以上は通常、3日未満はオレンジ、24時間未満は赤、終了はグレー。境界を正確に分ける", () => {
    expect(b(at(7 * 1440))).toMatchObject({ label: "あと7日", tone: "normal" });
    expect(b(at(3 * 1440))).toMatchObject({ label: "あと3日", tone: "normal" });
    expect(b(at(3 * 1440 - 1))).toMatchObject({ label: "あと2日", tone: "warn" });
    expect(b(at(1440))).toMatchObject({ label: "あと1日", tone: "warn" });
    expect(b(at(1439))).toMatchObject({ label: "あと23時間", tone: "danger" });
    expect(b(at(18 * 60))).toMatchObject({ label: "あと18時間", tone: "danger" });
    expect(b(at(60))).toMatchObject({ label: "あと1時間", tone: "danger" });
    expect(b(at(59))).toMatchObject({ label: "あと59分", tone: "danger" });
    expect(b(at(35))).toMatchObject({ label: "あと35分", tone: "danger" });
    expect(b(at(-1))).toMatchObject({ label: "締切済み", tone: "ended" });
  });

  it("日付のみの締切は、23:59など時刻を補わず、日付の差だけで示す（dateOnly）", () => {
    expect(b(dateOnly("2026-10-26"))).toMatchObject({ label: "本日まで", tone: "danger", dateOnly: true });
    expect(b(dateOnly("2026-10-27"))).toMatchObject({ label: "あと1日", tone: "warn", dateOnly: true });
    expect(b(dateOnly("2026-10-28"))).toMatchObject({ label: "あと2日", tone: "warn" });
    expect(b(dateOnly("2026-10-29"))).toMatchObject({ label: "あと3日", tone: "normal" });
    expect(b(dateOnly("2026-11-02"))).toMatchObject({ label: "あと7日", tone: "normal" });
    expect(b(dateOnly("2026-10-25"))).toMatchObject({ label: "締切済み", tone: "ended" });
  });

  it("締切が不明ならバッジを出さない", () => {
    expect(b(UNKNOWN_DATE)).toBeNull();
  });
});

describe("複数商品の集約（＋他N種）", () => {
  const data = createMockData(NOW);
  const base = data.lotteries.find((l) => l.id === "L3")!;
  const many = (n: number): Lottery => ({
    ...base,
    items: Array.from({ length: n }, (_, i) => ({ id: `it${i}`, productId: i % 2 ? "p2" : "p1", quantity: i + 1, unit: "box" as const })),
  });

  it("単一商品は「＋他」を出さない", () => {
    const s = summarizeItems(many(1), data);
    expect(s.extraKinds).toBe(0);
    expect(extraKindsLabel(s.extraKinds)).toBeNull();
  });

  it("9商品は先頭1種類＋「＋他8種」。数は商品種類数（数量やBOX数ではない）", () => {
    const l = many(9);
    const s = summarizeItems(l, data);
    expect(s.extraKinds).toBe(8);
    expect(extraKindsLabel(s.extraKinds)).toBe("＋他8種");
    expect(s.name).toBe(data.products.find((p) => p.id === "p1")!.officialName);
    // 数量の合計（1+2+…+9=45）ではなく種類数
    expect(extraKindsLabel(summarizeItems(many(2), data).extraKinds)).toBe("＋他1種");
  });

  it("一覧の集約でも、内部の商品情報は失われない（全商品が items に残る）", () => {
    const l = many(9);
    summarizeItems(l, data);
    expect(l.items).toHaveLength(9);
  });

  it("商品が未登録の抽選でも落ちない", () => {
    expect(summarizeItems({ ...base, items: [] }, data)).toMatchObject({ name: "商品未登録", extraKinds: 0 });
  });
});

describe("当落発表の期間指定", () => {
  const lot = (resultDate: FlexibleDate, resultEndDate?: string) => ({ resultDate, resultEndDate });

  it("単一日は従来どおり。期間は開始〜終了。今年以外は年も付ける", () => {
    expect(formatResultShort(lot(dateOnly("2026-11-07")), NOW)).toBe("11/7");
    expect(formatResultShort(lot(dateOnly("2026-11-07"), "2026-11-10"), NOW)).toBe("11/7〜11/10");
    expect(formatResultShort(lot(dateOnly("2026-12-28"), "2027-01-05"), NOW)).toBe("12/28〜2027/1/5");
    expect(formatResultShort(lot(UNKNOWN_DATE), NOW)).toBe("—");
  });

  it("時刻つきの開始は時刻を失わない。開始が日時でも期間にできる", () => {
    const start = dateTime("2026-11-07T03:00:00Z"); // JST 12:00
    expect(formatResultShort(lot(start), NOW)).toBe("11/7 12:00");
    expect(formatResultShort(lot(start, "2026-11-10"), NOW)).toBe("11/7 12:00〜11/10");
    expect(hasResultPeriod(lot(start, "2026-11-10"))).toBe(true);
  });

  it("終了が開始と同じ日・開始より前・開始が不明のときは期間として扱わない", () => {
    expect(hasResultPeriod(lot(dateOnly("2026-11-07"), "2026-11-07"))).toBe(false);
    expect(hasResultPeriod(lot(dateOnly("2026-11-07"), "2026-11-06"))).toBe(false);
    expect(hasResultPeriod(lot(UNKNOWN_DATE, "2026-11-10"))).toBe(false);
  });

  it("発表が終わったのは最終日の翌日から。期間中は『期間中』で、未確認とは扱わない", () => {
    const p = lot(dateOnly("2026-10-26"), "2026-10-28"); // 今日が開始日
    expect(isResultInPeriod(p, NOW)).toBe(true);
    expect(isResultFinished(p, NOW)).toBe(false);
    expect(isResultFinished(p, min(2 * 1440))).toBe(false); // 10/28 中
    expect(isResultFinished(p, min(3 * 1440))).toBe(true); // 10/29
    // 単一日の発表日は従来と同じ（当日中は過ぎていない）
    expect(isResultFinished(lot(dateOnly("2026-10-26")), NOW)).toBe(false);
    expect(isResultFinished(lot(dateOnly("2026-10-25")), NOW)).toBe(true);
    expect(isResultFinished(lot(UNKNOWN_DATE), NOW)).toBeNull();
  });

  it("並び替えは発表開始日が基準", () => {
    expect(resultSortKey(lot(dateOnly("2026-11-07"), "2026-11-20"))).toBe(resultSortKey(lot(dateOnly("2026-11-07"))));
    expect(resultSortKey(lot(dateOnly("2026-11-07")))).toBeLessThan(resultSortKey(lot(dateOnly("2026-11-08"))));
    expect(resultSortKey(lot(UNKNOWN_DATE))).toBe(Number.POSITIVE_INFINITY);
  });

  it("入力検証: 終了日は開始日以降。開始日が無い終了日は保存できない。空は単一日", () => {
    const base = createMockData(NOW);
    const l = base.lotteries.find((x) => x.id === "L1")!;
    const valid = {
      chain: { id: l.chainId, name: "x" },
      store: { id: l.storeId, name: "x", prefecture: "" },
      items: [{ product: { id: "00000000-0000-4000-8000-000000000001", name: "p" }, quantity: 1, unit: "box" as const }],
      campaignId: null,
      newCampaign: null,
      applyStart: EMPTY_FLEX,
      applyDeadline: EMPTY_FLEX,
      resultDate: { precision: "date_only" as const, date: "2026-11-07", time: "" },
      procedureDeadline: EMPTY_FLEX,
      receiveMethod: "store" as const,
      applyMethod: "web" as const,
      conditionsText: "",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: [],
      eventState: "open" as const,
      limitBasis: "unknown" as const,
      limitMaxCount: 1,
      memo: "",
    };
    const ok = (extra: object) => lotteryInputSchema.safeParse({ ...valid, chain: { id: "00000000-0000-4000-8000-000000000002", name: "x" }, store: { id: "00000000-0000-4000-8000-000000000003", name: "x", prefecture: "" }, ...extra }).success;
    expect(ok({})).toBe(true);
    expect(ok({ resultEndDate: "" })).toBe(true);
    expect(ok({ resultEndDate: "2026-11-10" })).toBe(true);
    expect(ok({ resultEndDate: "2026-11-07" })).toBe(true);
    expect(ok({ resultEndDate: "2026-11-06" })).toBe(false);
    expect(ok({ resultEndDate: "11/10" })).toBe(false);
    expect(ok({ resultDate: EMPTY_FLEX, resultEndDate: "2026-11-10" })).toBe(false);
    // 時刻つきの開始 + 終了日
    expect(ok({ resultDate: { precision: "date_time", date: "2026-11-07", time: "12:00" }, resultEndDate: "2026-11-10" })).toBe(true);
  });
});

describe("AI解析: 当落発表の期間", () => {
  const base = {
    is_lottery_announcement: true,
    chain_name: "サンプル電機",
    store_name: "三宮店",
    products: [{ name: "商品A", quantity: 1, unit: "box" }],
    apply_deadline: { year: null, month: 11, day: 5, hour: 23, minute: 59 },
  };
  const d = (month: number, day: number, year: number | null = null) => ({ year, month, day, hour: null, minute: null });

  it("「11月7日から11月10日に順次発表」→ 開始と最終日が登録候補へ反映される", () => {
    const e = normalizeExtraction({ ...base, result_date: d(11, 7), result_end_date: d(11, 10) }, NOW);
    expect(e.resultDate).toMatchObject({ precision: "date_only", date: "2026-11-07" });
    expect(e.resultEndDate).toBe("2026-11-10");
    const draft = buildDraft(e, createMockData(NOW));
    expect(draft.input.resultEndDate).toBe("2026-11-10");
  });

  it("年またぎの期間（12月28日〜1月5日）は終了日を翌年にする", () => {
    const e = normalizeExtraction({ ...base, apply_deadline: { year: null, month: 12, day: 20, hour: 23, minute: 59 }, result_date: d(12, 28), result_end_date: d(1, 5) }, NOW);
    expect(e.resultEndDate).toBe("2027-01-05");
  });

  it("期間でない・最終日が明確でない・開始より前・開始が不明のときは、推測で補わず期間にしない", () => {
    expect(normalizeExtraction({ ...base, result_date: d(11, 7) }, NOW).resultEndDate).toBe("");
    expect(normalizeExtraction({ ...base, result_date: d(11, 7), result_end_date: null }, NOW).resultEndDate).toBe("");
    expect(normalizeExtraction({ ...base, result_date: d(11, 7), result_end_date: d(11, 7) }, NOW).resultEndDate).toBe("");
    expect(normalizeExtraction({ ...base, result_end_date: d(11, 10) }, NOW).resultEndDate).toBe("");
  });

  it("既存の抽出結果（result_end_date なし）はそのまま読める", () => {
    const e = normalizeExtraction({ ...base, result_date: d(11, 7) }, NOW);
    expect(e.resultEndDate).toBe("");
    expect(e.resultDate.date).toBe("2026-11-07");
  });
});

describe("発表期間と通知・結果未確認・並び替え", () => {
  const today = "2026-10-26";
  /** L6（A・B 応募済み・結果待ち）の発表日を差し替える */
  function withResult(resultDate: FlexibleDate, resultEndDate?: string): AppData {
    const d = createMockData(NOW);
    return {
      ...d,
      lotteries: d.lotteries.map((l) => (l.id === "L6" ? { ...l, resultDate, resultEndDate } : l)),
      applications: d.applications.map((a) => (a.lotteryId === "L6" ? { ...a, createdAt: min(-60 * 24 * 7).toISOString() } : a)),
    };
  }
  const forL6 = (p: ReturnType<typeof planNotifications>) => p.due.filter((n) => n.lotteryId === "L6" && n.profileId === "pA");
  const L6 = (d: AppData) => d.lotteries.find((l) => l.id === "L6")!;

  it("期間中は『結果未確認』を強く出さない。最終日を過ぎてから出す", () => {
    const during = withResult(dateOnly("2026-10-25"), "2026-10-27"); // 昨日開始・明日終了
    expect(resultNotice(during, L6(during), NOW)).toBe("in_period");
    expect(computeAlerts(during, "pA", NOW).some((a) => a.kind === "result_overdue" && a.lotteryId === "L6")).toBe(false);
    expect(tabDots(during, "pA", NOW).appliedDot).toBe(false);

    const after = withResult(dateOnly("2026-10-23"), "2026-10-25"); // 昨日終了
    expect(resultNotice(after, L6(after), NOW)).toBe("unconfirmed");
    expect(computeAlerts(after, "pA", NOW).some((a) => a.kind === "result_overdue" && a.lotteryId === "L6")).toBe(true);
    expect(tabDots(after, "pA", NOW).appliedDot).toBe(true);
  });

  it("単一日で発表日を過ぎていれば、従来どおり『結果未確認』", () => {
    const d = withResult(dateOnly("2026-10-25"));
    expect(resultNotice(d, L6(d), NOW)).toBe("unconfirmed");
  });

  it("発表前の応募済みでは『結果未確認』を出さない", () => {
    const d = withResult(dateOnly("2026-10-30"));
    expect(resultNotice(d, L6(d), NOW)).toBeNull();
  });

  it("期間の通知: 開始日の朝に『期間が始まった』を通知し、未確認の催促は最終日の翌朝まで出さない", () => {
    const d = withResult(dateOnly(today), "2026-10-28");
    const start = forL6(planNotifications(d, {}, NOW));
    expect(start.map((n) => n.type)).toEqual(["result_day"]);
    expect(start[0].title).toContain("発表期間");
    // 期間の途中（最終日の朝）には未確認の催促を出さない
    const mid = planNotifications(d, {}, jstAt("2026-10-28", "09:30"));
    expect(forL6(mid).some((n) => n.type === "result_unconfirmed")).toBe(false);
    // 最終日の翌朝に催促
    const next = planNotifications(d, {}, jstAt(addDaysJst("2026-10-28", 1), "09:30"));
    expect(forL6(next).map((n) => n.type)).toEqual(["result_unconfirmed"]);
  });

  it("発表日のソートは開始日基準（期間の終了日では並べない）", () => {
    const d = createMockData(NOW);
    const patch = (id: string, rd: FlexibleDate, end?: string): Lottery => ({ ...d.lotteries.find((l) => l.id === id)!, resultDate: rd, resultEndDate: end });
    const lots = [patch("L1", dateOnly("2026-11-09")), patch("L2", dateOnly("2026-11-05"), "2026-11-30"), patch("L3", dateOnly("2026-11-07"))];
    const data: AppData = { ...d, lotteries: lots, applications: [] };
    const out = selectLotteries({ ...data, management: data.lotteries.map((l) => ({ lotteryId: l.id, isManaged: true, managedSource: "manual" as const })) }, "managed", { ...DEFAULT_FILTERS, sort: "result" }, NOW);
    expect(out.map((l) => l.id)).toEqual(["L2", "L3", "L1"]);
  });
});

describe("プロフィール別の応募状況と現在のプロフィール専用の応募操作", () => {
  const L = (d: AppData, id: string) => d.lotteries.find((l) => l.id === id)!;

  it("表示専用の行は全プロフィール分の状態を持ち、状態は文字（ラベル）でも区別できる", () => {
    const d = m.setApplied(createMockData(NOW), "pA", "L4", "a-c3", true, NOW);
    const marks = profileMarks(d, L(d, "L4"), NOW);
    expect(marks.map((x) => x.profileId).sort()).toEqual(["pA", "pB", "pC"].filter((p) => marks.some((x) => x.profileId === p)).sort());
    const a = marks.find((x) => x.profileId === "pA")!;
    expect(a.status).toBe("applied");
    expect(markLabel(a)).toBe("応募済み");
    const b = marks.find((x) => x.profileId === "pB");
    if (b) expect(markLabel(b)).not.toBe("応募済み");
  });

  it("操作は現在のプロフィールのアカウントだけが対象。Aの画面ではAのアカウントしか操作できない", () => {
    const d = createMockData(NOW);
    const forA = applyControlFor(d, L(d, "L4"), "pA", NOW);
    const forB = applyControlFor(d, L(d, "L4"), "pB", NOW);
    expect(forA).toMatchObject({ kind: "apply", accountId: "a-c3" });
    expect(forB).toMatchObject({ kind: "apply", accountId: "b-c3" });
    expect(applyControlFor(d, L(d, "L4"), "unknown-profile", NOW)).toEqual({ kind: "none" });
  });

  it("応募済みは解除できる。当落が確定した後は解除できない", () => {
    let d = m.setApplied(createMockData(NOW), "pA", "L4", "a-c3", true, NOW);
    expect(applyControlFor(d, L(d, "L4"), "pA", NOW)).toMatchObject({ kind: "applied", canUndo: true });
    d = m.setApplied(d, "pA", "L4", "a-c3", false, NOW);
    expect(applyControlFor(d, L(d, "L4"), "pA", NOW)).toMatchObject({ kind: "apply" });
    // 当選が登録されたら解除不可
    const won = createMockData(NOW);
    const l6 = L(won, "L6");
    const wonAcc = won.applications.find((a) => a.lotteryId === "L6" && a.accountId === "a-c1");
    if (wonAcc) {
      const d2: AppData = { ...won, applications: won.applications.map((a) => (a.id === wonAcc.id ? { ...a, result: "won" as const } : a)) };
      expect(applyControlFor(d2, l6, "pA", NOW)).toMatchObject({ kind: "applied", canUndo: false });
    }
  });

  it("スルー中・受付終了は応募ボタンにせず、状態名だけ見せる", () => {
    const base = createMockData(NOW);
    const closed = { ...base, lotteries: base.lotteries.map((l) => (l.id === "L4" ? { ...l, applyDeadline: at(-5) } : l)) };
    expect(applyControlFor(closed, L(closed, "L4"), "pA", NOW)).toMatchObject({ kind: "blocked", label: "応募不可" });
    const skipped = m.setLotterySkip(base, "pA", "L4", true, NOW);
    expect(applyControlFor(skipped, L(skipped, "L4"), "pA", NOW)).toMatchObject({ kind: "blocked", label: "スルー" });
    // Aのスルーは B に伝わらない
    expect(applyControlFor(skipped, L(skipped, "L4"), "pB", NOW).kind).toBe("apply");
  });

  it("希望商品を選んで応募する抽選は、商品の選択が必要。複数商品の他の抽選は一括で応募済みにできる", () => {
    const base = createMockData(NOW);
    const choose = { ...base, lotteries: base.lotteries.map((l) => (l.id === "L4" ? { ...l, multiMode: "choose_one" as const } : l)) };
    expect(applyControlFor(choose, L(choose, "L4"), "pA", NOW)).toMatchObject({ kind: "apply", needsChoice: true });
    expect(applyControlFor(base, L(base, "L4"), "pA", NOW)).toMatchObject({ kind: "apply", needsChoice: false });
  });

  it("モック保存先でも、他のプロフィールのアカウントは変更できない", async () => {
    const repo = new InMemoryRepository();
    await repo.load(NOW);
    const denied = await repo.setApplied("pA", "L4", "b-c3", true);
    expect(denied.ok).toBe(false);
    const allowed = await repo.setApplied("pA", "L4", "a-c3", true);
    expect(allowed.ok).toBe(true);
  });

  it("当選・落選は応募済みの記録から表示され、発表前の応募済みは『応募済み』で足りる（未確認と書かない）", () => {
    let d = m.setApplied(createMockData(NOW), "pA", "L4", "a-c3", true, NOW);
    const app = d.applications.find((a) => a.lotteryId === "L4" && a.accountId === "a-c3")!;
    let marks = profileMarks(d, L(d, "L4"), NOW);
    expect(markLabel(marks.find((x) => x.accountId === "a-c3")!)).toBe("応募済み");
    d = { ...d, applications: d.applications.map((a) => (a.id === app.id ? { ...a, result: "won" as const } : a)) };
    marks = profileMarks(d, L(d, "L4"), NOW);
    expect(markLabel(marks.find((x) => x.accountId === "a-c3")!)).toBe("当選");
    d = { ...d, applications: d.applications.map((a) => (a.id === app.id ? { ...a, result: "lost" as const } : a)) };
    marks = profileMarks(d, L(d, "L4"), NOW);
    expect(markLabel(marks.find((x) => x.accountId === "a-c3")!)).toBe("落選");
  });

  it("複数商品の商品別の当落・応募した商品は集約表示でも保持される", () => {
    const base = createMockData(NOW);
    const choose: AppData = {
      ...base,
      lotteries: base.lotteries.map((l) => (l.id === "L4" ? { ...l, multiMode: "choose_one" as const } : l)),
      applications: [
        ...base.applications,
        { id: "x1", lotteryId: "L4", accountId: "a-c3", appliedAt: NOW.toISOString(), state: "applied", result: "pending", itemResults: { i4a: "pending" }, selectedItemId: "i4a", resultConfirmedAt: null, fulfillment: "none", createdAt: NOW.toISOString() },
      ],
    };
    const marks = profileMarks(choose, L(choose, "L4"), NOW);
    const a = marks.find((x) => x.accountId === "a-c3")!;
    expect(a.partial).toBe(true);
    expect(markLabel(a)).toBe("応募済み（選んだ商品のみ）");
    // 集約しても商品別データは変わらない
    expect(choose.applications.find((x) => x.id === "x1")!.itemResults).toEqual({ i4a: "pending" });
  });
});
