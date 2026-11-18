// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyFeedback } from "./eval-feedback";
import { buildHumanKnowledge, humanHintsFor } from "./human-knowledge";
import { interpretCorrection } from "./form-learning";

/** Stage 9H-3J: 人間評価（9H-3I）の分類と、修正欄の意味の検証。未確定の評価を正解として学習しない */
describe("修正欄の意味の検証", () => {
  it("商品欄に書かれた抽選形態（店舗選択式）は、商品名ではなく抽選形態の指摘。『対象商品ではない』も商品名ではない", () => {
    expect(interpretCorrection("product", "店舗選択式")).toMatchObject({ kind: "form_in_wrong_field", form: "store_select" });
    expect(interpretCorrection("product", "対象商品ではない")).toMatchObject({ kind: "not_target_product" });
    expect(interpretCorrection("product", "ストームエメラルダ")).toMatchObject({ kind: "field" });
    expect(interpretCorrection("lotteryForm", "WEB")).toMatchObject({ kind: "field" });
  });
  it("商品欄の「店舗選択式」は、評価が確定している場合だけ抽選形態の実績になる。商品名の別名・正解商品にはならない。未確定の評価からは何も学習しない", () => {
    const base = (gold: boolean) => ({ setId: "s", results: [{ caseId: "a", aiOriginal: { extracted: { chain: "竜のしっぽ", products: ["ハドウシーカー"], applyDeadline: "2026-11-20" } }, source: { url: "https://x.com/a/status/1" }, human: { verdict: gold ? "partial" : null, usableAsGold: gold, corrections: [{ field: "product", correctValue: "店舗選択式" }], comment: "竜のしっぽは原則店舗選択式" } }] });
    const unconfirmed = buildHumanKnowledge([base(false)]);
    expect(unconfirmed.entries).toHaveLength(0);
    expect(unconfirmed.forms?.records).toHaveLength(0);
    const confirmed = buildHumanKnowledge([base(true)]);
    expect(confirmed.forms?.records.map((r) => r.form)).toEqual(["store_select"]);
    expect(confirmed.entries.some((e) => e.kind === "product_alias")).toBe(false);
  });
  it("「対象商品ではない」は、系列への一般的なコメントではなく『情報源と商品が一致しなかった例』として、確認を促す参考情報になる（今回の告知を優先）", () => {
    const hk = buildHumanKnowledge([{ setId: "s", results: [{ caseId: "b", aiOriginal: { extracted: { chain: "タカラトミーモール", products: ["スターターデッキセット MEGA メガガブリアスex"] } }, human: { verdict: "wrong", usableAsGold: true, corrections: [{ field: "product", correctValue: "対象商品ではない" }], comment: "対象商品ではない" } }] }]);
    expect(hk.entries.map((e) => e.kind)).toEqual(["source_mismatch"]);
    const hint = humanHintsFor(hk, { chain: "タカラトミーモール" }).join("");
    expect(hint).toContain("リンク先のページに見つからなかった例");
    expect(hint).toContain("今回の告知の記載を優先");
  });
});

const FILE = "backups/review-answers/review-answers-rs-9h3i-dc1f633b6e3b6432-2026-11-16T13-25-44-000Z.json";
if (existsSync(FILE)) describe("保存済みの人間評価（9H-3I・12件）の分類", () => {
  const f = JSON.parse(readFileSync(FILE, "utf8")) as { results: { caseId: string; human: { verdict: string | null; usableAsGold: boolean; corrections: { field: string; correctValue: string }[] } }[] };
  const keyFile = "backups/eval-9h3i/review-key-9h3i.json";
  const key = existsSync(keyFile) ? (JSON.parse(readFileSync(keyFile, "utf8")) as { key: Record<string, { caseId: string }> }).key : {};
  const qFile = "backups/eval-9h3i/quarantine.json";
  const q = new Set(existsSync(qFile) ? Object.keys(JSON.parse(readFileSync(qFile, "utf8"))) : []);
  const r = classifyFeedback(f.results as never, { toCaseId: (id) => key[id]?.caseId ?? id, quarantined: q });
  it("正しい7・誤り2・未確定3（評価が未選択）。隔離2件。未確定は学習に使わない", () => {
    expect(r.counts).toMatchObject({ correct: 7, wrong: 2, unconfirmed: 3, learnable: 9 });
    expect(r.counts.quarantined).toBe(q.size);
    const un = r.items.filter((x) => x.bucket === "unconfirmed");
    expect(un.every((x) => !x.learnable)).toBe(true);
    // 竜のしっぽ（隔離・未確定）: 商品欄の『店舗選択式』は商品名として取り込まれない（未確定のため学習もされない）
    const ryu = r.items.find((x) => x.caseId === "k-01782d6c");
    if (ryu) {
      expect(ryu).toMatchObject({ bucket: "unconfirmed", quarantined: true });
      expect(ryu.misplaced[0]).toMatchObject({ kind: "form_in_wrong_field" });
    }
  });
  it("実際の評価ファイルから作る実績に、未確定（竜のしっぽ・LivePocket 2件）の修正が入らない", () => {
    const hk = buildHumanKnowledge([f as never]);
    expect(hk.forms?.records.some((x) => x.chain.includes("竜のしっぽ"))).toBe(false);
    expect(hk.entries.some((e) => e.kind === "product_alias" && /店舗選択/.test(e.canonical))).toBe(false);
  });
});
