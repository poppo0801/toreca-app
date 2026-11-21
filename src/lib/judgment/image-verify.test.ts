// @vitest-environment node
/** Stage 10L: 画像根拠の検証（照合・拒否・根拠の並び・検証層）。架空データのみ。画像・AI・ネットワークには触れない。 */
import { describe, expect, it, vi } from "vitest";
import type { ImageReading } from "@/lib/collector/evidence";
import { buildJudgmentInput, toEvidenceItems } from "./build-input";
import type { JudgmentOutput } from "./contract";
import { sanitizeLines } from "./image-transcriber";
import { checkClaims, imageEvidenceSeeds, lineContainsQuote, summarizeChecks, type ImageTranscript } from "./image-verify";
import { verifyJudgment } from "./verify";

vi.mock("server-only", () => ({}));

const NOW = "2099-01-01T00:00:00.000Z";
const rd = (field: string, text: string, imageIndex: number | null = 1): ImageReading => ({ field, text, source: imageIndex ? `画像${imageIndex}枚目` : "画像", imageIndex, kind: "ai_reading", verified: null, uncertainty: "high", readAt: NOW });
const tr = (imageIndex: number, lines: [string, "clear" | "unclear"][], imageHash = "a".repeat(64)): ImageTranscript => ({ imageIndex, imageHash, fetchedAt: NOW, lines: lines.map(([text, certainty]) => ({ text, certainty })), method: "blind_transcription", model: "test", promptVersion: "t", costJpy: 0.3 });

describe("照合: 2つの独立した読み（収集時の申告と元画像の盲検の書き起こし）が一致したものだけ", () => {
  const t1 = tr(1, [["応募締切 4/8(水) 23:59", "clear"], ["当選発表は 4/12", "unclear"], ["お一人様1回まで", "clear"]]);
  it("NFKCで揃う表記の差は一致、数字や語句が違えば不一致（捏造・誤読の拒否）", () => {
    const t = tr(1, [["応募締切 4/8(水) 23:59", "clear"], ["お一人様1回まで", "clear"]]);
    const ok = checkClaims([rd("applyDeadline", "応募締切 ４/８（水）２３:５９")], [t]);
    expect(ok[0]).toMatchObject({ status: "verified", imageHash: "a".repeat(64), imageIndex: 1 });
    expect(ok[0].line).toContain("応募締切");
    const bad = checkClaims([rd("applyDeadline", "応募締切 4/9(木) 23:59"), rd("conditions", "お一人様2回まで"), rd("applyStart", "応募開始 4/1(水)")], [t]);
    expect(bad.map((x) => x.status)).toEqual(["not_found", "not_found", "not_found"]);
  });
  it("不鮮明な行にだけ実在 → illegible（確定させない）。短すぎる抜粋・画像なし・取得できない画像 → 照合しない", () => {
    expect(checkClaims([rd("resultDate", "当選発表は 4/12")], [t1])[0].status).toBe("illegible");
    expect(checkClaims([rd("x", "お一人様1回")], [t1])[0].status).toBe("not_found"); // 8文字未満は根拠にならない（汎用の語句の誤一致を防ぐ）
    expect(checkClaims([rd("applyDeadline", "応募締切 4/8(水) 23:59", 2)], [t1])[0].status).toBe("no_image"); // 2枚目の書き起こしが無い
    expect(checkClaims([rd("applyDeadline", "応募締切 4/8(水) 23:59")], [])[0].status).toBe("no_image");
    expect(lineContainsQuote("あいうえお", "あい")).toBe(false);
  });
  it("画像番号が不明な申告は、全ての画像を対象にする。複数画像では、一致した画像の番号とハッシュを記録", () => {
    const t = tr(1, [["別の内容 1/1", "clear"]], "b".repeat(64));
    const u = tr(2, [["応募締切 4/8(水) 23:59", "clear"]], "c".repeat(64));
    const c = checkClaims([rd("applyDeadline", "応募締切 4/8(水) 23:59", null)], [t, u]);
    expect(c[0]).toMatchObject({ status: "verified", imageIndex: 2, imageHash: "c".repeat(64) });
    expect(summarizeChecks(c)).toMatchObject({ verified: 1, not_found: 0 });
  });
});

describe("判断の入力: 照合済みと未照合を別の根拠で渡す", () => {
  const readings = [rd("applyDeadline", "応募締切 4/8(水) 23:59"), rd("conditions", "お一人様2回まで")];
  const t = tr(1, [["応募締切 4/8(水) 23:59", "clear"], ["お一人様1回まで", "clear"]]);
  it("照合済みは image_verified（ハッシュ記録済みの旨を明記）、未照合は image_reading（照合できていない理由つき）。未照合の本文は照合済みの根拠に混ざらない", () => {
    const seeds = imageEvidenceSeeds(readings, checkClaims(readings, [t]), "https://evidence.invalid/img", NOW);
    expect(seeds.map((s) => s.kind)).toEqual(["image_verified", "image_reading"]);
    expect(seeds[0].text).toContain("照合済み");
    expect(seeds[0].text).toContain("応募締切 4/8(水) 23:59");
    expect(seeds[0].text).not.toContain("2回");
    expect(seeds[1].text).toContain("お一人様2回まで");
    expect(seeds[1].text).toContain("元画像で確認できず");
    expect(imageEvidenceSeeds([], [], "u", NOW)).toEqual([]);
  });
  it("元画像を取得できなかった場合は、すべて未照合の image_reading のみ（画像由来の事実は fact にならない）", () => {
    const seeds = imageEvidenceSeeds(readings, checkClaims(readings, []), "u", NOW);
    expect(seeds.map((s) => s.kind)).toEqual(["image_reading"]);
    expect(seeds[0].text).toContain("元画像を取得できず");
  });
});

describe("検証層: 画像にしか書かれていない事実は、照合済みの根拠だけ fact にできる", () => {
  const readings = [rd("applyDeadline", "応募締切 4/8(水) 23:59")];
  const verified = imageEvidenceSeeds(readings, checkClaims(readings, [tr(1, [["応募締切 4/8(水) 23:59", "clear"]])]), "u", NOW);
  const unverified = imageEvidenceSeeds(readings, checkClaims(readings, []), "u", NOW);
  const post = { url: "u", via: "x_api", origin: "unknown" as const, text: "架空TCG 抽選のお知らせ 詳細は画像", hash: null, status: "fetched" as const, fetchedAt: null };
  const out = (basis: "fact" | "inference"): JudgmentOutput =>
    ({
      version: "10e.2",
      caseType: { value: "lottery_announcement", basis: "fact", citations: [{ evidenceId: "E1", quote: "抽選のお知らせ" }] },
      structure: { kind: "one_form_one", basis: "inference", rationale: "t", citations: [] },
      opportunities: [{ key: "O1", label: "t", applyDeadline: { value: "2099-04-08 23:59", basis, citations: [{ evidenceId: "E2", quote: "応募締切 4/8(水) 23:59" }] } }],
      relations: [], plannedChanges: [], unresolved: [], nextActions: [{ kind: "none", reason: "t" }],
    }) as unknown as JudgmentOutput;
  it("照合済み（image_verified）への引用は fact で通る。未照合（image_reading）への引用だけの fact は拒否。inference は可", async () => {
    const mk = async (extra: typeof verified) => buildJudgmentInput({ caseId: null, title: "", now: new Date(NOW), evidence: [post, ...extra], related: [], masters: [], failures: [], regionPrefectures: [] });
    const vi1 = await mk(verified);
    expect(toEvidenceItems([post, ...verified])[1].kind).toBe("image_verified");
    expect(verifyJudgment(vi1, out("fact")).map((v) => v.code)).toEqual([]);
    const vi2 = await mk(unverified);
    expect(verifyJudgment(vi2, out("fact")).map((v) => v.code)).toContain("citation_image_only");
    expect(verifyJudgment(vi2, out("inference")).map((v) => v.code)).not.toContain("citation_image_only");
  });
  it("照合済みの根拠にない語句（画像で確認できていない内容）の引用は、引用の検証で拒否される", async () => {
    const i = await buildJudgmentInput({ caseId: null, title: "", now: new Date(NOW), evidence: [post, ...verified], related: [], masters: [], failures: [], regionPrefectures: [] });
    const o = out("fact");
    (o.opportunities[0].applyDeadline as { citations: { evidenceId: string; quote: string }[] }).citations = [{ evidenceId: "E2", quote: "応募締切 4/9(木) 23:59" }];
    expect(verifyJudgment(i, o).map((v) => v.code)).toContain("citation_quote_not_found");
  });
});

describe("書き起こしの出力の整理", () => {
  it("形式が不正な行は捨て、伏せ字を通し、長さ・行数を制限する", () => {
    const lines = sanitizeLines({ lines: [{ text: "応募締切 4/8 連絡先 dummy@example.invalid", certainty: "clear" }, { text: 1, certainty: "clear" }, { text: "x", certainty: "clear" }, { text: "あいうえお", certainty: "maybe" }, ...Array.from({ length: 100 }, (_, i) => ({ text: `行${i}の文字列`, certainty: "unclear" }))] });
    expect(lines.length).toBeLessThanOrEqual(80);
    expect(lines[0].text).not.toContain("dummy@example.invalid");
    expect(lines.every((l) => l.text.length >= 2 && l.text.length <= 200)).toBe(true);
    expect(sanitizeLines(null)).toEqual([]);
    expect(sanitizeLines({ lines: "x" })).toEqual([]);
  });
});
