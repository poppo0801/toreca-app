// @vitest-environment node
/** Stage 10K: 画像読み取りの保存と再利用（出典つき・原文と別・照合不可）。架空データのみ。画像の再解析・外部通信はしない。 */
import { describe, expect, it, vi } from "vitest";
import { buildEvidence, evidenceFromLastGood, imageReadingsFromExtraction } from "@/lib/collector/evidence";
import { buildJudgmentInput, imageReadingSeed, seedsFromStored, toEvidenceItems } from "./build-input";
import type { JudgmentOutput } from "./contract";
import { verifyJudgment } from "./verify";

vi.mock("server-only", () => ({}));

const NOW = "2099-01-01T00:00:00.000Z";
const post = { text: "架空TCG 抽選のお知らせ。応募方法は画像をご確認ください", links: [] as string[], images: ["https://img.example.com/a.jpg", "http://insecure.example.com/b.jpg"] };
const ex = {
  evidence: {
    applyDeadline: { quote: "応募締切 4/8(水) 23:59 連絡先 dummy@example.invalid", source: "画像2枚目" },
    store: { quote: "サンプル店 北店", source: "本文" },
    applyStart: { quote: "4/1(水)から", source: "画像1枚目" },
    conditions: { quote: "x", source: "画像" },
  },
  confidence: { applyDeadline: "high", applyStart: "low" } as Record<string, string>,
};

describe("画像読み取りの取り出し（既に得ている解析結果の再利用）", () => {
  it("出所が画像のものだけを取り出す（本文・リンク先は対象外）。画像番号・確度・伏せ字を持ち、照合できない（verified=null）", () => {
    const r = imageReadingsFromExtraction(ex, NOW);
    expect(r.map((x) => x.field).sort()).toEqual(["applyDeadline", "applyStart"]); // 短すぎる抜粋（1文字）も除く
    const d = r.find((x) => x.field === "applyDeadline");
    expect(d).toMatchObject({ imageIndex: 2, uncertainty: "high", kind: "ai_reading", verified: null, readAt: NOW });
    expect(d?.text).not.toContain("dummy@example.invalid");
    expect(r.find((x) => x.field === "applyStart")?.uncertainty).toBe("low");
    expect(imageReadingsFromExtraction(null, NOW)).toEqual([]);
    expect(imageReadingsFromExtraction({ evidence: { store: { quote: "サンプル店", source: "本文" } } }, NOW)).toEqual([]);
  });
});

describe("保存: 原文とは別の出典（互換性のある追加項目）", () => {
  it("imageReadings・imageRefs は text に混ぜず別に保存される。https 以外の参照は保存しない。ハッシュは本文のみで決まる", () => {
    const a = buildEvidence({ url: "https://x.example/1", kind: "x_post", post }, NOW);
    const b = buildEvidence({ url: "https://x.example/1", kind: "x_post", post, imageReadings: imageReadingsFromExtraction(ex, NOW), imageRefs: post.images }, NOW);
    expect(b?.text).toBe(a?.text);
    expect(b?.hash).toBe(a?.hash);
    expect(b?.text).not.toContain("4/8");
    expect(b?.imageReadings).toHaveLength(2);
    expect(b?.imageRefs).toEqual(["https://img.example.com/a.jpg"]);
    expect(a && "imageReadings" in a).toBe(false);
  });
  it("読み出し: 旧形式は読める。形式が不正な画像読み取りは捨てる。画像読み取りが無ければ「無い」", () => {
    const b = buildEvidence({ url: "https://x.example/1", kind: "x_post", post, imageReadings: imageReadingsFromExtraction(ex, NOW) }, NOW);
    expect(evidenceFromLastGood({ evidence: b })?.imageReadings).toHaveLength(2);
    expect(evidenceFromLastGood({ evidence: { ...b, imageReadings: [{ kind: "ocr", text: 1 }, "x"] } })?.imageReadings).toBeUndefined();
    expect(imageReadingSeed(evidenceFromLastGood({ evidence: buildEvidence({ url: "https://x.example/1", kind: "x_post", post }, NOW) }))).toBeNull();
  });
});

describe("再判断への入力: 出典つきの画像読み取りとして別の根拠で渡る", () => {
  const stored = buildEvidence({ url: "https://x.example/1", kind: "x_post", post, imageReadings: imageReadingsFromExtraction(ex, NOW) }, NOW);
  it("本文（E1）のあとに kind=image_reading の根拠（E2）が付く。画像の読み取りであることと照合できないことが本文に明記される", () => {
    const items = toEvidenceItems(seedsFromStored("https://x.example/1", stored));
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBeUndefined();
    expect(items[1].kind).toBe("image_reading");
    expect(items[1].text).toContain("画像からのAI読み取り");
    expect(items[1].text).toContain("照合不可");
    expect(items[1].text).toContain("画像2枚目");
    expect(items[1].text).toContain("確度high");
  });
  it("画像読み取りだけを根拠にした fact は不採用（inference は可）。本文でも確認できる fact は通る", async () => {
    const input = await buildJudgmentInput({ caseId: null, title: "", now: new Date(NOW), evidence: seedsFromStored("https://x.example/1", stored), related: [], masters: [], failures: [], regionPrefectures: [] });
    const mk = (basis: "fact" | "inference", ids: string[]): JudgmentOutput => ({
      version: "10e.2",
      caseType: { value: "lottery_announcement", basis: "fact", citations: [{ evidenceId: "E1", quote: "抽選のお知らせ" }] },
      structure: { kind: "one_form_one", basis: "inference", rationale: "テスト", citations: [] },
      opportunities: [{ key: "O1", label: "テスト", applyDeadline: { value: "2099-04-08 23:59", basis, citations: ids.map((id) => ({ evidenceId: id, quote: id === "E2" ? "応募締切" : "抽選のお知らせ" })) } }],
      relations: [], plannedChanges: [], unresolved: [], nextActions: [{ kind: "none", reason: "t" }],
    } as unknown as JudgmentOutput);
    const codes = (o: JudgmentOutput) => verifyJudgment(input, o).map((v) => v.code);
    expect(codes(mk("fact", ["E2"]))).toContain("citation_image_only");
    expect(codes(mk("inference", ["E2"]))).not.toContain("citation_image_only");
    expect(codes(mk("fact", ["E1", "E2"]))).not.toContain("citation_image_only");
  });
});
