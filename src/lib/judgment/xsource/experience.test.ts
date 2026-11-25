import { describe, expect, it } from "vitest";
import { advise, buildExperience, BUCKETS, discoverFeatures, evaluateHints, foundBucketsOf, shouldAdopt, type ExperienceRecord, type HintTrial } from "./experience";

const NOW = "2026-11-23T00:00:00Z";
const day = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const page = (service: string, shop: string) => `${service} ${shop} 抽選受付 ${service} 注意事項 ${shop} お申込み ${"あ".repeat(400)} ${shop} ${service}`;
const feat = (service: string, shop: string) => discoverFeatures({ url: `https://${service}.example.invalid/e/123`, text: page(service, shop), slots: 1, imageCount: 0 });
const exp = (service: string, shop: string, bucket: number, v: ExperienceRecord["verification"], at = day(10)): ExperienceRecord => ({ features: feat(service, shop), docChars: 2000, foundBuckets: Array.from({ length: BUCKETS }, (_, i) => (i === bucket ? 1 : 0)), verification: v, at });

describe("特徴の発見: 固定ルールではなく、客観的な性質を広く記録する", () => {
  it("ホスト・URLの形・長さ・構造の数・画像の有無・頻出語が候補特徴に入る（サイト名のルールは持たない）", () => {
    const f = feat("livepocket", "晴れる屋");
    expect(f).toContain("host:livepocket.example.invalid");
    expect(f.some((x) => x.startsWith("path:"))).toBe(true);
    expect(f.some((x) => x.startsWith("len:"))).toBe(true);
    expect(f).toContain("tok:livepocket");
    expect(f).toContain("tok:晴れる屋");
    expect(f).toContain("slots:1");
  });
});

describe("経験の反映: 検証済みの経験が十分なときだけ、最初に見せる位置を提案する", () => {
  const verified = (n: number) => Array.from({ length: n }, (_, i) => exp("livepocket", `晴れる屋${i % 2}`, 8, i % 2 ? "human" : "gold"));
  it("経験が無い・AIの観察だけ（自己強化の防止）では、ヒントを出さない（理由を区別して返す）", () => {
    const f = feat("livepocket", "晴れる屋");
    expect(advise({ features: f, docChars: 2000, experiences: [], now: NOW }).withheld).toBe("no_experience");
    const aiOnly = Array.from({ length: 30 }, () => exp("livepocket", "晴れる屋", 8, "ai_unverified"));
    const r = advise({ features: f, docChars: 2000, experiences: aiOnly, now: NOW });
    expect(r.hints).toHaveLength(0);
    expect(r.withheld).toBe("insufficient_verified");
  });
  it("検証済み（人・gold）の類似経験が十分なら、重要条件が多かった位置（本文の80%付近）を提案する。理由・支持数・検証重みつき", () => {
    const r = advise({ features: feat("livepocket", "晴れる屋"), docChars: 2000, experiences: verified(6), now: NOW });
    expect(r.withheld).toBeNull();
    expect(r.hints.length).toBeGreaterThan(0);
    const h = r.hints[0];
    expect(h.from <= 1700 && h.to > 1700).toBe(true); // 80%付近の位置を含む
    expect(h.to).toBeLessThanOrEqual(2000);
    expect(h.why).toContain("検証済み重み");
    expect(h.why).toContain("仮説");
    expect(r.used.verifiedWeight).toBeGreaterThanOrEqual(2);
  });
  it("特徴が似ていないページには適用しない（別サービスの経験を流用しない）", () => {
    const other = discoverFeatures({ url: "https://another.example.invalid/zzz/9", text: "全く別の文章です。".repeat(60) });
    const r = advise({ features: other, docChars: 2000, experiences: verified(8), now: NOW });
    expect(r.hints).toHaveLength(0);
  });
  it("古い経験は重みが下がり、ページ構造の変化に適応する（新しい経験が優勢になる）", () => {
    const oldOnes = Array.from({ length: 8 }, (_, i) => exp("livepocket", `晴れる屋${i}`, 8, "human", day(900)));
    const stale = advise({ features: feat("livepocket", "晴れる屋"), docChars: 2000, experiences: oldOnes, now: NOW });
    expect(stale.hints).toHaveLength(0); // 古すぎて検証重みが不足
    const mixed = [...oldOnes, ...Array.from({ length: 6 }, (_, i) => exp("livepocket", `晴れる屋${i}`, 2, "human", day(5)))];
    const r = advise({ features: feat("livepocket", "晴れる屋"), docChars: 2000, experiences: mixed, now: NOW });
    expect(r.hints[0].from).toBeLessThan(800); // 新しい経験の位置（20%付近）が優先
  });
  it("位置に偏りが無い経験からはヒントを出さない（通常の閲覧と同じ）", () => {
    const flat = Array.from({ length: 10 }, (_, i) => exp("livepocket", `晴れる屋${i}`, i % BUCKETS, "human"));
    const r = advise({ features: feat("livepocket", "晴れる屋"), docChars: 2000, experiences: flat, now: NOW });
    expect(r.hints).toHaveLength(0);
    expect(r.withheld).toBe("no_pattern");
  });
});

describe("経験の記録: 検証できた引用の位置だけを数える", () => {
  it("本文に実在する引用の相対位置を数え、見つからない・短い引用は数えない。位置が分からなければ経験を作らない", () => {
    const text = `${"あ".repeat(800)}受付期間は11月30日23:59までです${"い".repeat(190)}`;
    expect(foundBucketsOf(text, ["受付期間は11月30日23:59までです", "存在しない文", "短い"]).reduce((s, x) => s + x, 0)).toBe(1);
    expect(foundBucketsOf(text, ["受付期間は11月30日23:59までです"])[7]).toBe(1);
    expect(buildExperience({ features: ["a"], text, quotes: ["存在しない引用です。"], verification: "human", at: NOW })).toBeNull();
    expect(buildExperience({ features: ["a"], text, quotes: ["受付期間は11月30日23:59までです"], verification: "human", at: NOW })?.foundBuckets[7]).toBe(1);
  });
});

describe("評価: 改善が実証されないヒントは採用しない", () => {
  const trial = (truth: number[], hinted: [number, number][], baseline: [number, number][] = [[0, 600]]): HintTrial => ({ truth, docChars: 2000, hinted: hinted.map(([from, to]) => ({ from, to })), baseline: baseline.map(([from, to]) => ({ from, to })) });
  it("重要条件が最初の提示範囲に入った割合（ヒント無し/あり）を比較する", () => {
    const e = evaluateHints(Array.from({ length: 10 }, () => trial([1700, 100], [[1500, 2000]])));
    expect(e).toMatchObject({ points: 20, baselineHit: 0.5, hintedHit: 1 });
    expect(shouldAdopt(e)).toBe(true);
  });
  it("評価点が少ない・改善が無いときは採用しない", () => {
    expect(shouldAdopt(evaluateHints([trial([1700], [[1500, 2000]])]))).toBe(false); // 点が少ない
    const none = evaluateHints(Array.from({ length: 30 }, () => trial([100], [[1500, 2000]])));
    expect(none.gain).toBe(0);
    expect(shouldAdopt(none)).toBe(false);
  });
});
