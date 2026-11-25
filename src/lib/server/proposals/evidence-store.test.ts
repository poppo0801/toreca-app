// @vitest-environment node
/**
 * 証拠の保存・計測・人の修正の照合（無課金・DBなし）。
 *  - 識別子（itemFingerprint）: 番号・URLに依存せず、本文が変われば変わる。人の修正は識別子が一致する項目に付いて移る
 *  - 保存用の文書: 切り詰めの事実（truncated・理由）が残る。計測行には原文・URLが含まれない
 */
import { describe, expect, it } from "vitest";
import { itemFingerprint } from "@/lib/judgment/xsource/proposal";
import type { Evidence, ResearchResult } from "@/lib/judgment/xsource/research-loop";
import { correctionUnmatched, findCorrection, type HumanCorrection } from "./generate";
import { MAX_DOC_CHARS, coverageStatsOf, documentFromEvidence } from "./evidence-store";

const plan = (groupLabel: string, itemText: string) => ({ groupLabel, itemText });
const corr = (itemNo: number, fp: string | null, label: string | null = null): HumanCorrection => ({ itemNo, values: { store: `修正${itemNo}` }, label, fingerprint: fp });

describe("項目の識別子と人の修正の照合", () => {
  const a = plan("《新宿本店（東京）- 2件》", "・拡張パック 抽選 11/30 https://t.co/aaa111");
  const b = plan("《新宿本店（東京）- 2件》", "・拡張BOX 抽選 11/30 https://t.co/bbb222");
  it("URLの短縮形・空白・記号の揺れでは変わらず、本文が違えば（同じ見出しでも）変わる", () => {
    expect(itemFingerprint(a)).toBe(itemFingerprint(plan(a.groupLabel, "・拡張パック　抽選 11/30 https://t.co/zzz999")));
    expect(itemFingerprint(a)).not.toBe(itemFingerprint(b));
    expect(itemFingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("【再現・回帰】同じ見出しの下で項目が入れ替わっても、修正は同じ本文の項目に付いて移る（番号では当てない）", () => {
    const list = [corr(2, itemFingerprint(b))]; // 修正は『拡張BOX』の項目（旧・番号2）
    expect(findCorrection(list, 1, b)?.values.store).toBe("修正2"); // 入れ替わって番号1になっても、BOXの項目に適用
    expect(findCorrection(list, 2, a)).toBeUndefined(); // 番号2になった『拡張パック』には移らない（見出しが同じでも）
    expect(correctionUnmatched(list, 2, a)).toBe(true); // 番号2に以前の修正があったのに合わない＝人の再確認が必要
    expect(correctionUnmatched(list, 1, b)).toBe(false);
  });
  it("識別子の無い古い版は、同じ番号で見出しが一致するときだけ（従来より緩くしない）。見出しが違えば適用しない", () => {
    const old = [corr(2, null, a.groupLabel)];
    expect(findCorrection(old, 2, a)?.values.store).toBe("修正2");
    expect(findCorrection(old, 1, a)).toBeUndefined(); // 番号が違う
    expect(findCorrection(old, 2, plan("《渋谷西口店（東京）- 1件》", "x"))).toBeUndefined();
    expect(findCorrection([corr(2, null, null)], 2, a)).toBeUndefined(); // 照合できない＝適用しない
  });
});

const ev = (o: Partial<Evidence> = {}): Evidence => ({ id: "p1", kind: "page", url: "https://shop-a.example.invalid/e/1?x=1", fetchedAt: "2026-11-23T00:00:00.000Z", contentHash: "h", text: "【新宿本店】本文".repeat(10), structure: null, independent: true, ...o });
describe("保存用の文書・計測行", () => {
  it("全文を保存対象にし、切り詰め（収集時の上限・保存上限）の事実と理由を残す。ページ以外・URLなしは対象外", () => {
    const d = documentFromEvidence(ev())!;
    expect(d).toMatchObject({ truncated: false, sourceChars: d.textChars, origin: "unknown" });
    expect(d.contentHash).toMatch(/^[0-9a-f]{32}$/);
    const c = documentFromEvidence(ev({ text: "あ".repeat(3000), notice: "x" }), { collectorTruncatedAt: 3000 })!;
    expect(c).toMatchObject({ truncated: true, truncatedReason: "collector_limit", sourceChars: null });
    const big = documentFromEvidence(ev({ text: "あ".repeat(MAX_DOC_CHARS + 10) }))!;
    expect(big).toMatchObject({ truncated: true, truncatedReason: "doc_max_chars", textChars: MAX_DOC_CHARS, sourceChars: MAX_DOC_CHARS + 10 });
    expect(documentFromEvidence(ev({ kind: "seed" }))).toBeNull();
    expect(documentFromEvidence(ev({ url: null }))).toBeNull();
  });
  it("計測行は原文・URLを含まない（ホスト名・字数・位置・件数・結果のみ）。ページが無い項目も1行残る", () => {
    const text = "原文のひみつ".repeat(3000);
    const result = { investigation: { state: "ended", reason: "sufficient", turns: 2 }, registration: { decision: "tentative", output: null, verified: false, held: { reasons: ["register_unit_unresolved"] }, proposals: [] }, evidence: [ev({ text, reads: [{ from: 5000, to: 6000 }] })], history: [{ key: "k", host: "shop-a.example.invalid", outcome: "ok", at: "t", progress: true }], budget: { costJpy: 0.4 } } as unknown as ResearchResult;
    const rows = coverageStatsOf({ proposalKey: "a".repeat(24), result, mode: "real", collectorLimit: 3000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: "shop-a.example.invalid", viewMode: "indexed", reads: 1, readChars: 1000, firstReadAt: 5000, fetchOutcome: "ok", decision: "tentative", costJpy: 0.4 });
    expect(JSON.stringify(rows)).not.toContain("ひみつ");
    expect(JSON.stringify(rows)).not.toContain("/e/1");
    const none = coverageStatsOf({ proposalKey: null, result: { ...result, evidence: [], history: [{ key: "k", host: "h", outcome: "not_public", at: "t", progress: false }] } as unknown as ResearchResult, mode: "mock" });
    expect(none).toMatchObject([{ host: "none", fetchOutcome: "not_public", viewMode: "full" }]);
  });
});
