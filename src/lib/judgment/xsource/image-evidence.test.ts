import { describe, expect, it } from "vitest";
import type { ImageReading } from "@/lib/collector/evidence";
import { analyzeImages, dateTokens, mockVision, reconcileReading, type VisionRequest } from "./image-evidence";

const U1 = "https://pbs.example.invalid/m/1.jpg";
const U2 = "https://pbs.example.invalid/m/2.jpg";
const U3 = "https://pbs.example.invalid/m/3.jpg";
const reading = (o: Partial<ImageReading>): ImageReading => ({ field: "applyDeadline", text: "11/30 23:59まで", source: "画像1枚目", imageIndex: 1, kind: "ai_reading", verified: null, uncertainty: "medium", readAt: "2026-11-23T00:00:00Z", ...o });

describe("画像の読み取りと本文の突き合わせ", () => {
  it("日付の抽出: 月日の表記の違い（全角・月日・年つき）を吸収する", () => {
    expect(dateTokens("応募締切 １１月３０日 23:59")).toEqual(["11/30"]);
    expect(dateTokens("2026-12-03 発表 / 12/5")).toEqual(["12/3", "12/5"]);
  });
  it("本文と画像の日付が同じ→本文でも確認／食い違う→矛盾（どちらも確定しない）／本文に日付が無い→画像のみ", () => {
    expect(reconcileReading("applyDeadline", "11/30 23:59", "応募は11月30日まで").status).toBe("confirmed_by_text");
    expect(reconcileReading("applyDeadline", "12/5 23:59", "応募は11月30日まで")).toMatchObject({ status: "conflict", textValues: ["11/30"] });
    expect(reconcileReading("applyDeadline", "12/5 23:59", "詳細は画像をご覧ください").status).toBe("image_only");
  });
  it("日付以外: 本文に含まれれば確認、無ければ画像のみ（矛盾とは断定しない）", () => {
    expect(reconcileReading("対象店舗", "新宿本店", "新宿本店で抽選").status).toBe("confirmed_by_text");
    expect(reconcileReading("対象店舗", "大阪店", "新宿本店で抽選").status).toBe("image_only");
  });
});

describe("analyzeImages: 再利用・解析・失敗の扱い", () => {
  it("収集時に画像番号つきの読み取りがある画像は再利用し、ビジョンを呼ばない（重複課金なし）", async () => {
    const calls: VisionRequest[] = [];
    const r = await analyzeImages({ imageRefs: [U1], existing: [reading({})], postText: "応募は11月30日まで", vision: mockVision({}, calls) });
    expect(calls).toHaveLength(0);
    expect(r.observations[0].status).toBe("reused");
    expect(r.counts).toMatchObject({ images: 1, reused: 1, analyzed: 0 });
    expect(r.reconciled[0].status).toBe("confirmed_by_text");
  });
  it("画像が複数のとき、番号の分からない読み取りは全画像の解析済みにしない（未解析の画像だけ解析する）", async () => {
    const calls: VisionRequest[] = [];
    const r = await analyzeImages({ imageRefs: [U1, U2], existing: [reading({ imageIndex: null })], postText: "x", vision: mockVision({ [U1]: [{ field: "対象店舗", text: "新宿本店" }], [U2]: [{ field: "対象店舗", text: "渋谷店" }] }, calls) });
    expect(calls.map((c) => c.imageIndex)).toEqual([1, 2]);
    expect(r.counts.analyzed).toBe(2);
  });
  it("本文に無い応募期間が画像にあれば『画像のみ・原本未照合』、本文と矛盾すれば『矛盾・未確定』として注記に残る。画像の情報は事実として確定しない", async () => {
    const v = mockVision({ [U1]: [{ field: "応募期間", text: "12/1〜12/5" }], [U2]: [{ field: "applyDeadline", text: "12/20 23:59", uncertainty: "low" }] });
    const r = await analyzeImages({ imageRefs: [U1, U2], existing: [], postText: "応募は11月30日まで。詳細は画像で", vision: v });
    const by = Object.fromEntries(r.reconciled.map((x) => [x.imageIndex, x.status]));
    expect(by[1]).toBe("conflict"); // 本文に11/30があり、画像は12/1〜12/5
    expect(by[2]).toBe("conflict");
    expect(r.counts.conflicts).toBe(2);
    expect(r.notes.join("\n")).toContain("矛盾・未確定");
    expect(r.notes.join("\n")).toContain("どちらも確認済みとしない");
    const only = await analyzeImages({ imageRefs: [U1], existing: [], postText: "詳細は画像をご覧ください", vision: mockVision({ [U1]: [{ field: "応募期間", text: "12/1〜12/5" }] }) });
    expect(only.reconciled[0].status).toBe("image_only");
    expect(only.notes.join("\n")).toContain("原本と未照合・事実として確定しない");
  });
  it("読み取れない・失敗・上限超過・ビジョン無しの画像は『確認できていない』として残る（画像の内容を『無い』にしない）", async () => {
    const v = mockVision({ [U1]: [], [U2]: null });
    const r = await analyzeImages({ imageRefs: [U1, U2, U3], existing: [], postText: "x", vision: v, maxAnalyses: 2 });
    expect(r.observations.map((o) => o.status)).toEqual(["unreadable", "failed", "skipped_limit"]);
    expect(r.notes.join("\n")).toContain("画像1・2・3枚目は内容を確認できていない");
    expect(r.notes.join("\n")).toContain("未確認");
    const none = await analyzeImages({ imageRefs: [U1], existing: [], postText: "x" });
    expect(none.observations[0].status).toBe("not_analyzed");
    expect(none.counts.skipped).toBe(1);
  });
  it("https以外の画像参照は対象にしない", async () => {
    const r = await analyzeImages({ imageRefs: ["http://insecure.example.invalid/a.jpg", U1], existing: [], postText: "x", vision: mockVision({ [U1]: [{ field: "対象店舗", text: "A店" }] }) });
    expect(r.counts.images).toBe(1);
  });
});
