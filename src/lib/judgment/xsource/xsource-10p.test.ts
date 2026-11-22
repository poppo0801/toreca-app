// @vitest-environment node
/** Stage 10P: 日時の意味・正規化／公式バッジの条件／公式性が判断に影響しないこと。架空データのみ。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveOfficialBadge } from "./badge";
import { classifyDateContext, deadlineIsPast, isNotifiableDeadline, normalizeDateTime, splitRange, toRegistrationFormat, validatePeriod, type DateRole } from "./datetime";

const REF = new Date("2026-11-10T00:00:00Z"); // 基準日: 2026-11-10（火）
const n = (raw: string, role: DateRole = "apply_deadline", ref = REF) => normalizeDateTime(raw, { role, reference: ref });

describe("日時の正規化: 根拠のない年・時刻を補わず、精度・年の根拠・曜日不一致を保持する", () => {
  it("年あり・時刻あり（JST）。登録の形式へ", () => {
    const d = n("2026年11月22日(日) 23:59");
    expect(d).toMatchObject({ date: "2026-11-22", time: "23:59", precision: "datetime", yearBasis: "explicit", tz: "Asia/Tokyo", weekdayMismatch: false });
    expect(toRegistrationFormat(d)).toBe("2026-11-22 23:59");
  });
  it("年なし＋曜日あり: 曜日が一致する年だけ採用（確認）。曜日が合う年が無ければ年を決めない", () => {
    expect(n("11/22(日)23:59")).toMatchObject({ date: "2026-11-22", yearBasis: "inferred_weekday_confirmed" });
    const bad = n("11/22(月)23:59");
    expect(bad).toMatchObject({ date: null, yearBasis: "ambiguous", weekdayMismatch: true, precision: "month_day" });
    expect(toRegistrationFormat(bad)).toBeNull();
  });
  it("年なし＋曜日なし: 基準日に近い年を『推定』とし、通知には使えない。日付のみは時刻を補わない", () => {
    const d = n("11月25日");
    expect(d).toMatchObject({ date: "2026-11-25", precision: "date", time: null, yearBasis: "inferred_reference" });
    expect(toRegistrationFormat(d)).toBe("2026-11-25");
    expect(isNotifiableDeadline(d, true)).toBe(false);
  });
  it("年跨ぎ: 12月の基準日で1月の日付は翌年。曜日で確認できる", () => {
    const ref = new Date("2026-12-20T00:00:00Z");
    expect(normalizeDateTime("1/5(火) 23:59", { role: "apply_deadline", reference: ref })).toMatchObject({ date: "2027-01-05", yearBasis: "inferred_weekday_confirmed" });
  });
  it("明示された年の曜日不一致は記録（採用はするが通知には使えない）", () => {
    const d = n("2026年11月22日(月)23:59");
    expect(d.weekdayMismatch).toBe(true);
    expect(isNotifiableDeadline(d, true)).toBe(false);
  });
  it("24:00 は翌日 0:00 へ繰り上げ（記録）。0:00 の締切は境界の曖昧さを注記。23:59 はそのまま", () => {
    expect(n("2026年11月22日 24:00")).toMatchObject({ date: "2026-11-23", time: "00:00", rollover: true });
    expect(n("2026年11月23日 0:00").notes).toContain("midnight_boundary_ambiguous");
    expect(n("2026年11月22日 23:59").rollover).toBe(false);
  });
  it("無効な日付・時刻は採用しない", () => {
    expect(n("2026年2月30日").date).toBeNull();
    expect(n("2026年11月22日 25:70")).toMatchObject({ precision: "date", time: null });
    expect(n("日付なし").precision).toBe("unparsed");
  });
  it("範囲の分割: 月の引き継ぎ。開始が締切より後なら逆転", () => {
    expect(splitRange("11月5日(木)～7日(土)")).toEqual({ start: "11月5日(木)", end: "11月7日(土)" });
    expect(splitRange("2026年11月13日(金)～11月15日(日)")).toEqual({ start: "2026年11月13日(金)", end: "2026年11月15日(日)" });
    expect(validatePeriod(n("2026年11月23日", "apply_start"), n("2026年11月22日"))).toBe("reversed");
    expect(validatePeriod(n("2026年11月20日 10:00", "apply_start"), n("2026年11月22日 23:59"))).toBe("ok");
    expect(validatePeriod(n("日付不明", "apply_start"), n("2026年11月22日"))).toBe("unknown");
  });
  it("役割: 当選発表・受取・注文対象期間・販売期間を応募期間と区別する（『ご注文分』を応募期間にしない）", () => {
    expect(classifyDateContext("当選発表 11月25日")).toBe("result_announce");
    expect(classifyDateContext("11月1日（日）～11月10日（火）のご注文分")).toBe("order_period");
    expect(classifyDateContext("販売期間 11月1日〜")).toBe("purchase_window");
    expect(classifyDateContext("店頭お受け取り期間 11月26日〜")).toBe("pickup_window");
    expect(classifyDateContext("応募受付期間 11月20日10:00から", "start")).toBe("apply_start");
    expect(classifyDateContext("抽選応募締切 11月22日 23:59まで")).toBe("apply_deadline");
    expect(classifyDateContext("11月22日")).toBe("unknown");
  });
  it("通知に使える締切は『役割＝締切・年が明示/曜日で確認・時刻あり・原文確認済み』だけ。締切当日・終了判定", () => {
    expect(isNotifiableDeadline(n("2026年11月22日 23:59"), true)).toBe(true);
    expect(isNotifiableDeadline(n("2026年11月22日 23:59"), false)).toBe(false);
    expect(isNotifiableDeadline(n("2026年11月22日"), true)).toBe(false);
    expect(isNotifiableDeadline(n("2026年11月22日 23:59", "result_announce"), true)).toBe(false);
    const now = new Date("2026-11-22T14:00:00Z"); // JST 23:00
    expect(deadlineIsPast(n("2026年11月22日 23:59"), now)).toBe(false);
    expect(deadlineIsPast(n("2026年11月22日"), now)).toBe(false);
    expect(deadlineIsPast(n("2026年11月22日 22:00"), now)).toBe(true);
  });
});

describe("公式バッジの条件: 発信者の確認と当該抽選の告知の確認の両方。否定的なラベルは持たない", () => {
  const NOW = new Date("2099-11-21T00:00:00Z");
  type Code = "reciprocal_link" | "official_page_itself" | "trusted_site_links" | "store_public_info";
  const basis = (code: Code, checkedAt = "2099-11-10T00:00:00Z") => ({ code, checkedAt });
  const s = (over: Partial<Parameters<typeof deriveOfficialBadge>[0][number]> = {}) => ({ sourceId: "s", host: "shop.example.com", publisherBasis: [basis("reciprocal_link")], announcementConfirmed: true, announcementCheckedAt: "2099-11-20T00:00:00Z", ...over });
  it("発信者の確認＋告知の確認がそろったときだけ。どちらか欠けるとバッジなし（null）", () => {
    expect(deriveOfficialBadge([s()], NOW)).toMatchObject({ show: true, sources: [{ host: "shop.example.com", basis: ["reciprocal_link"] }] });
    expect(deriveOfficialBadge([s({ announcementConfirmed: false })], NOW)).toBeNull();
    expect(deriveOfficialBadge([s({ announcementCheckedAt: null })], NOW)).toBeNull();
    expect(deriveOfficialBadge([s({ publisherBasis: [] })], NOW)).toBeNull();
    expect(deriveOfficialBadge([], NOW)).toBeNull();
  });
  it("相互リンクは唯一の方法ではない（公式ページ自身・公式サイトからの発信元リンク・店舗の公開情報）。古い確認は無効", () => {
    for (const code of ["official_page_itself", "trusted_site_links", "store_public_info"] as const) expect(deriveOfficialBadge([s({ publisherBasis: [basis(code)] })], NOW)).not.toBeNull();
    expect(deriveOfficialBadge([s({ publisherBasis: [basis("reciprocal_link", "2090-01-01T00:00:00Z")] })], NOW)).toBeNull();
  });
  it("複数の情報源のうち1つでも確認できればよい。根拠と最終確認日時を持つ。URLは持たない", () => {
    const b = deriveOfficialBadge([s({ sourceId: "a", publisherBasis: [] }), s({ sourceId: "b", host: "x.example.com", publisherBasis: [basis("store_public_info")] })], NOW);
    expect(b?.sources.map((x) => x.host)).toEqual(["x.example.com"]);
    expect(b?.lastCheckedAt).toBe("2099-11-20T00:00:00Z");
    expect(JSON.stringify(b)).not.toMatch(/https?:\/\//);
  });
});

describe("公式性は判断の条件ではない（静的検査）", () => {
  const dec = readFileSync("src/lib/judgment/xsource/decision.ts", "utf8");
  it("decision.ts は official.ts・badge.ts を読み込まず、情報源の種類（kind）を判断に使わない", () => {
    expect(dec).not.toMatch(/from "\.\/official"|from "\.\/badge"/);
    expect(dec).not.toMatch(/\.kind\b/);
    expect(dec).not.toMatch(/official_source_unverified|authoritative/);
  });
  it("バッジの判定は判断・登録・通知の経路から参照されない", () => {
    for (const f of ["decision.ts", "resolve.ts", "cluster.ts", "relate.ts", "conditions.ts"]) expect(readFileSync(`src/lib/judgment/xsource/${f}`, "utf8")).not.toMatch(/deriveOfficialBadge|OfficialBadge/);
  });
});
