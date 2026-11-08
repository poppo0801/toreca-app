import { describe, expect, it } from "vitest";
import { archiveCounts, archiveReasonOf, isArchived } from "@/lib/collector/archive";
import { evaluateCandidate, prefectureFromStoreName, resolveTargetPrefecture, normalizeConditions } from "@/lib/collector/conditions";
import type { LotteryInput } from "@/lib/lottery-input";

const NOW = new Date("2026-11-05T03:00:00Z");
const KANSAI = ["兵庫県", "大阪府", "京都府"];

describe("Stage 6G: 複数地域の表記と関西3府県の判定", () => {
  it("対象の府県を含む複数地域は対象、含まなければ元の表記のまま（推測しない）", () => {
    expect(resolveTargetPrefecture("大阪府・東京都", KANSAI)).toBe("大阪府");
    expect(resolveTargetPrefecture("兵庫・大阪・京都", KANSAI)).toBe("兵庫県");
    expect(resolveTargetPrefecture("愛知・岐阜・三重", KANSAI)).toBe("愛知・岐阜・三重");
    expect(resolveTargetPrefecture("東京都", KANSAI)).toBe("東京都");
    expect(resolveTargetPrefecture("", KANSAI)).toBe("");
    expect(resolveTargetPrefecture("京都府", KANSAI)).toBe("京都府");
  });
  const cond = normalizeConditions({ prefectures: KANSAI, includeOnline: true });
  const base = { applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" }, applyStart: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", requirementTags: [], sourceUrls: [], items: [] } as unknown as LotteryInput;
  const ev = (pref: string, over: Partial<LotteryInput> = {}, storeKind: "physical" | "online_only" = "physical") => evaluateCandidate({ ...base, ...over }, cond, { prefecture: pref, storeKind, distanceKm: null, now: NOW });
  it("関西3府県の店頭は対象、関東の店頭は対象外", () => {
    expect(ev("大阪府").verdict).toBe("match");
    expect(ev("東京都").verdict).toBe("exclude");
    expect(ev("神奈川県").reasons[0]).toContain("対象外の地域");
  });
  it("全国から応募できる通販は対象。複数地域に関西が含まれれば対象", () => {
    expect(ev("", { receiveMethod: "shipping" }, "online_only").verdict).toBe("match");
    expect(ev("東京都・大阪府").verdict).toBe("match");
  });
  it("地域が不明な候補は、関東と推測して除外せず確認（追跡）に回す", () => {
    expect(ev("").verdict).toBe("review");
  });
  it("応募期限を過ぎた候補は除外（受付終了）。締切が不明なものは受付終了と断定しない", () => {
    expect(ev("大阪府", { applyDeadline: { precision: "date_only", date: "2026-11-01", time: "" } as never }).verdict).toBe("exclude");
    const unknown = ev("大阪府", { applyDeadline: { precision: "unknown", date: "", time: "" } as never });
    expect(unknown.verdict).toBe("review");
    expect(unknown.reasons.join()).toContain("不明");
  });
});

describe("Stage 6G: 除外済み候補のアーカイブ", () => {
  const row = (status: string, reasons: string[], resolved: string | null) => ({ status, reasons, resolved_at: resolved });
  const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  it("理由の種類を判定する", () => {
    expect(archiveReasonOf(row("duplicate", [], null))).toBe("duplicate");
    expect(archiveReasonOf(row("excluded", ["応募締切を過ぎています"], null))).toBe("expired");
    expect(archiveReasonOf(row("excluded", ["対象外の地域です（東京都）"], null))).toBe("region");
    expect(archiveReasonOf(row("excluded", ["利用者が除外しました"], null))).toBe("manual");
    expect(archiveReasonOf(row("excluded", ["応募方法が収集条件に合いません"], null))).toBe("auto");
    expect(archiveReasonOf(row("pending", [], null))).toBeNull();
  });
  it("重複・期限終了・地域対象外は即時、自動・手動は3日後に通常の一覧から隠す", () => {
    expect(isArchived(row("duplicate", [], ago(0)), NOW)).toBe(true);
    expect(isArchived(row("excluded", ["応募締切を過ぎています"], ago(0)), NOW)).toBe(true);
    expect(isArchived(row("excluded", ["対象外の地域です（東京都）"], ago(0)), NOW)).toBe(true);
    expect(isArchived(row("excluded", ["利用者が除外しました"], ago(2)), NOW)).toBe(false);
    expect(isArchived(row("excluded", ["利用者が除外しました"], ago(3)), NOW)).toBe(true);
    expect(isArchived(row("excluded", ["応募方法が収集条件に合いません"], ago(1)), NOW)).toBe(false);
    expect(isArchived(row("excluded", ["応募方法が収集条件に合いません"], ago(4)), NOW)).toBe(true);
    expect(isArchived(row("auto_registered", [], ago(9)), NOW)).toBe(false);
  });
  it("理由別の件数", () => {
    const c = archiveCounts([row("duplicate", [], null), row("excluded", ["対象外の地域です（東京都）"], null), row("excluded", ["利用者が除外しました"], ago(1))], NOW);
    expect(c.total).toBe(2);
    expect(c.byReason).toMatchObject({ duplicate: 1, region: 1, manual: 0 });
  });
});

describe("Stage 6G: 店舗名の明示的な地域名", () => {
  it("店舗名に地域名が1つだけ含まれるときだけ都道府県を読む。含まれない・曖昧なら空（推測しない）", () => {
    expect(prefectureFromStoreName("千葉中央店")).toBe("千葉県");
    expect(prefectureFromStoreName("大阪梅田店")).toBe("大阪府");
    expect(prefectureFromStoreName("イオンモール成田店")).toBe("");
    expect(prefectureFromStoreName("ヨコハマ本店")).toBe("");
    expect(prefectureFromStoreName("京都・大阪店")).toBe("");
    expect(prefectureFromStoreName("")).toBe("");
  });
  const cond = normalizeConditions({ prefectures: KANSAI, includeOnline: true });
  const mk = (store: string) => ({ applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" }, applyStart: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", requirementTags: [], sourceUrls: [], items: [], store: { id: null, name: store, prefecture: "" } }) as unknown as LotteryInput;
  it("店舗名から関東と分かる店頭抽選は対象外、関西は対象、地域が読めないものは確認に回す", () => {
    const ev = (s: string) => evaluateCandidate(mk(s), cond, { prefecture: "", storeKind: "physical", distanceKm: null, now: NOW }).verdict;
    expect(ev("千葉中央店")).toBe("exclude");
    expect(ev("大阪梅田店")).toBe("match");
    expect(ev("成田店")).toBe("exclude"); // 市区町村名から都道府県（千葉県）を判定する（Stage 7A）
    expect(ev("ミナト本店")).toBe("review");
  });
});
