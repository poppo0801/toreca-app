import { describe, expect, it } from "vitest";
import { relateDateTimes, parseResultPhrase } from "@/lib/collector/date-phrases";
import { supplementResultDate } from "@/lib/collector/date-supplement";
import { buildInvestigationGaps, evidenceRecords, lotteryIdentity, tierOf } from "@/lib/collector/investigation-gaps";
import { mergeSides, provenanceFor, type FieldSource, type Side } from "@/lib/collector/fields";
import { detectStoreSelect } from "@/lib/collector/store-select";
import { judgeForm } from "@/lib/lottery-form";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { normalizeExtraction } from "@/lib/ai/extraction";

/** Stage 9G: 人間の評価（30件）で見つかった問題の回帰テスト。架空の店名・商品名のみ。特定の1件専用の例外ではなく、一般的な表現・構造で検証する */
const flex = (date: string | null, time = "") => (date ? { precision: time ? ("date_time" as const) : ("date_only" as const), date, time } : EMPTY_FLEX);
function input(o: Partial<LotteryInput> = {}): LotteryInput {
  return { chain: { id: null, name: "テスト玩具" }, store: { id: null, name: "", prefecture: "" }, items: [{ product: { id: null, name: "ハドウシーカー" }, quantity: 1, unit: "box" }], multiMode: "single", applyStart: EMPTY_FLEX, applyDeadline: EMPTY_FLEX, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "unknown", applyMethod: "unknown", conditionsText: "", verificationText: "", announcementMethod: "", announcementMethods: [], requirementTags: [], sourceUrls: [], memo: "", ...o } as unknown as LotteryInput;
}
const src = (o: Partial<FieldSource> = {}): FieldSource => ({ kind: "official_site", url: "https://example.invalid/a", origin: "o1", at: "2026-11-05T01:00:00Z", account: "example.invalid", ...o });
const side = (i: LotteryInput, s: FieldSource): Side => ({ input: i, summary: { chain: "none", store: "none", items: [] }, fields: provenanceFor(i, s), source: s });

describe("9G 日時: 境界表現・詳しさの違い", () => {
  it("11:59と12:00、23:59と翌0:00は同じ締切の表記差（早い方を採用）", () => {
    const a = relateDateTimes({ date: "2026-11-13", time: "11:59" }, { date: "2026-11-13", time: "12:00" });
    expect(a).toMatchObject({ same: true, reason: "boundary", adopt: { date: "2026-11-13", time: "11:59" } });
    const b = relateDateTimes({ date: "2026-11-16", time: "00:00" }, { date: "2026-11-15", time: "23:59" });
    expect(b).toMatchObject({ same: true, adopt: { date: "2026-11-15", time: "23:59" } });
  });
  it("同じ日の日付のみと時刻つきは詳しさの違い（時刻つきを採用）。1日以上・数時間の差は別の値", () => {
    expect(relateDateTimes({ date: "2026-11-06" }, { date: "2026-11-06", time: "22:00" })).toMatchObject({ same: true, reason: "refinement", adopt: { time: "22:00" } });
    expect(relateDateTimes({ date: "2026-11-12", time: "23:59" }, { date: "2026-11-13", time: "23:59" }).same).toBe(false);
    expect(relateDateTimes({ date: "2026-11-15", time: "12:00" }, { date: "2026-11-15", time: "18:00" }).same).toBe(false);
  });
  it("統合: 境界表現・詳しさの違いは矛盾にしない／本当に違う締切は矛盾のまま", () => {
    const a = side(input({ applyDeadline: flex("2026-11-16", "23:59") }), src({ kind: "list_site", account: "a", origin: "a" }));
    const b = side(input({ applyDeadline: flex("2026-11-16", "23:58") }), src({ kind: "aggregator_x", account: "b", origin: "b", url: "https://x.com/b/status/1" }));
    const m = mergeSides(a, b);
    expect(m.conflicts).toEqual([]);
    expect(m.input.applyDeadline.time).toBe("23:58");
    const dateOnly = side(input({ applyDeadline: flex("2026-11-06") }), src({ kind: "list_site", account: "a", origin: "a" }));
    const timed = side(input({ applyDeadline: flex("2026-11-06", "22:00") }), src({ account: "z", origin: "z" }));
    const m2 = mergeSides(dateOnly, timed);
    expect(m2.conflicts).toEqual([]);
    expect(m2.input.applyDeadline.time).toBe("22:00");
    const far = side(input({ applyDeadline: flex("2026-11-20", "23:59") }), src({ kind: "list_site", account: "c", origin: "c" }));
    expect(mergeSides(a, far).conflicts.map((c) => c.field)).toEqual(["applyDeadline"]);
  });
  it("主催者の説明本文は、サービス側の表示と食い違うときに優先される。人間が確定した値は上書きしない", () => {
    const meta = side(input({ applyDeadline: flex("2026-11-13", "23:59") }), src({ basis: "platform_meta", origin: "m", account: "p1" }));
    const body = side(input({ applyDeadline: flex("2026-11-15", "12:00") }), src({ basis: "organizer_body", origin: "b", account: "p2" }));
    const m = mergeSides(meta, body);
    expect(m.conflicts).toEqual([]);
    expect(m.input.applyDeadline.date).toBe("2026-11-15");
    expect(mergeSides(body, meta).input.applyDeadline.date).toBe("2026-11-15"); // 逆の順でも主催者の本文を残す
    const manual = { ...meta, fields: { ...meta.fields, applyDeadline: { ...meta.fields.applyDeadline!, manual: true } } };
    expect(mergeSides(manual, body).input.applyDeadline.date).toBe("2026-11-13");
  });
});

describe("9G 日時: 当選発表の表現", () => {
  it("期間・終わりだけ・目途を区別し、応募期間の日付とは混同しない", () => {
    expect(parseResultPhrase("当選発表は11月16日(月)～11月21日(土)にメールで", "2026-11-14")).toMatchObject({ kind: "range", start: "2026-11-16", end: "2026-11-21", approximate: false });
    expect(parseResultPhrase("当選のご連絡は11月20日までにメールでお送りします", "2026-11-14")).toMatchObject({ kind: "end_only", end: "2026-11-20", start: "" });
    expect(parseResultPhrase("当選発表は11月26日を目途にご連絡します", "2026-11-14")).toMatchObject({ kind: "approx", end: "2026-11-26", approximate: true });
    expect(parseResultPhrase("応募期間は11月13日～11月15日です", "2026-11-14")).toBeNull();
  });
  it("AIが読み取った当選発表日は上書きしない。読み取れなかったときだけ補い、確定日でないことを記録する", () => {
    const base = normalizeExtraction({ is_lottery_announcement: true, products: [{ name: "ハドウシーカー" }] }, new Date("2026-11-14T00:00:00Z"));
    const r = supplementResultDate(base, "当選発表は11月26日を目途にご連絡します", "2026-11-14");
    expect(r.extraction.resultDate.date).toBe("2026-11-26");
    expect(r.extraction.warnings.join()).toContain("目途・予定");
    const withAi = { ...base, resultDate: { ...base.resultDate, precision: "date_only" as const, date: "2026-11-30" } };
    expect(supplementResultDate(withAi, "当選発表は11月26日を目途に", "2026-11-14").applied).toBeNull();
    expect(supplementResultDate(base, "11月16日から抽選受付", "2026-11-14").applied).toBeNull();
  });
});

describe("9G 店舗選択式: 構造の記載で判断し、制限だけでは断定しない", () => {
  it("フォームのプルダウンで店舗を選ぶ → 店舗選択式", () => {
    expect(detectStoreSelect({ texts: ["Googleフォームの店舗プルダウンから回答して送信"] })).toBe(true);
    expect(detectStoreSelect({ texts: ["フォームの店舗ドロップダウンに回答してください"] })).toBe(true);
    expect(judgeForm({ texts: ["フォームの店舗プルダウンで1店舗に回答して応募"], storeMode: "fixed" }).form).toBe("store_select");
  });
  it("「1店舗のみ応募可」という制限だけでは店舗選択式と断定しない（8F-6の方針の維持）", () => {
    expect(judgeForm({ texts: ["応募はいずれか1店舗のみ可能です"], storeMode: "fixed" }).form).not.toBe("store_select");
  });
});

describe("9G 系列表記: 通販チャネル語は系列名から分ける（9Cの正規化が評価事例にも効く）", () => {
  it("ホビビ通販部／イトーヨーカドーネット通販は、店舗名の有無にかかわらず系列キーが一致する", () => {
    expect(chainCanonicalKey("カードショップホビビ通販部")).toBe(chainCanonicalKey("カードショップホビビ"));
    expect(chainCanonicalKey("イトーヨーカドーネット通販")).toBe(chainCanonicalKey("イトーヨーカドー"));
  });
});

describe("9H準備: 根拠・不足・取得失敗・同一抽選の識別", () => {
  it("一次情報と二次情報を区別する", () => {
    expect(tierOf("official_site")).toBe("primary");
    expect(tierOf("official_x")).toBe("primary");
    expect(tierOf("aggregator_x")).toBe("secondary");
    expect(tierOf("list_site")).toBe("secondary");
  });
  it("項目ごとの根拠に、情報源・取得日時・一次/二次・状態が残る", () => {
    const i = input({ applyDeadline: flex("2026-11-16", "23:59") });
    const rec = evidenceRecords(provenanceFor(i, src({ kind: "list_site", account: "l", origin: "l" })), { applyDeadline: "11/16 23:59まで" });
    const d = rec.find((r) => r.field === "applyDeadline")!;
    expect(d).toMatchObject({ tier: "secondary", state: "unverified", fetchedAt: "2026-11-05T01:00:00Z", quote: "11/16 23:59まで" });
  });
  it("不足・矛盾・取得失敗が構造化され、重要度順に並び、次の行動は読み取りの調査の種類だけ", () => {
    const i = input({ items: [], applyDeadline: flex("2026-11-16", "23:59") });
    const g = buildInvestigationGaps(i, provenanceFor(i, src({ kind: "list_site", account: "l", origin: "l" })), [{ url: "https://example.invalid/lottery", reason: "robots_blocked" }]);
    expect(g[0]).toMatchObject({ kind: "fetch_failed", field: "page", suggestedActions: ["search_alternative_source", "compare_sources"] });
    expect(g.some((x) => x.field === "items" && x.kind === "missing" && x.priority === "high")).toBe(true);
    expect(g.some((x) => x.field === "applyDeadline" && x.kind === "secondary_only")).toBe(true);
    const all = new Set(g.flatMap((x) => x.suggestedActions));
    for (const a of all) expect(["search_alternative_source", "fetch_linked_page", "compare_sources", "read_image_text", "ask_human"]).toContain(a);
  });
  it("同じ抽選の識別情報は、通販表記・時刻の境界・短縮URLに左右されない", () => {
    const a = lotteryIdentity(input({ chain: { id: null, name: "テストストア ネット通販" }, store: { id: null, name: "通販", prefecture: "" }, applyDeadline: flex("2026-11-13", "11:59"), memo: "応募URL: https://t.co/xyz" }));
    const b = lotteryIdentity(input({ chain: { id: null, name: "テストストア" }, store: { id: null, name: "オンライン", prefecture: "" }, applyDeadline: flex("2026-11-13", "12:00") }));
    expect(a.chainKey).toBe(b.chainKey);
    expect(a.storeClass).toBe("online");
    expect(a.period).toEqual(b.period);
    expect(a.applyUrlKey).toBe(""); // 短縮URLは識別に使わない
  });
});
