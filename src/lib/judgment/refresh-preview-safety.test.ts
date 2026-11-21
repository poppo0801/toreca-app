// @vitest-environment node
/** Stage 10G の差分プレビュー実行部の安全性（静的検査）。DB・ネットワーク・実AIには触れない。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const real = readFileSync("src/lib/judgment/refresh-preview-real.test.ts", "utf8");
const wrapper = readFileSync("scripts/refresh-preview-10g.mjs", "utf8");
const evidenceExport = readFileSync("scripts/export-refresh-evidence-10g.mjs", "utf8");

describe("10G 差分プレビュー: 書き込みなし・上限・送信前検査", () => {
  it("実行はゲート付き（環境変数・確認フラグ・費用関門）。DBクライアントも外部ページ取得も持たず、判断は sink なし（書き込みなし）", () => {
    expect(real).toContain('env.JUDGMENT_REFRESH_RUN !== "1"');
    expect(real).toContain("checkJudgmentRealRun(");
    expect(real).not.toMatch(/supabase|createClient|safe-fetch|fetch\(/);
    expect(real).not.toMatch(/sink\s*:/);
    expect(wrapper).toContain("--confirm=yes");
    expect(wrapper).toContain("assertLocalTarget");
  });
  it("上限（30件・90回・連続5件失敗・1件ごとの予算）と、送信前の機械検査（伏せ字・漏洩検出・公開告知）を持つ", () => {
    expect(real).toContain("MAX_TARGETS = 30");
    expect(real).toContain("MAX_CALLS = 90");
    expect(real).toContain("MAX_CONSEC_FAIL = 5");
    expect(real).toContain("perCaseCapJpy");
    for (const s of ["redact(", "detectLeaks(", "isPublicNotice("]) expect(real).toContain(s);
  });
  it("原文の書き出しは SELECT のみで、世帯・応募・個人の列を読まない。書き込み系の呼び出しがない", () => {
    expect(evidenceExport).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(evidenceExport).not.toMatch(/household|applications|profiles/);
  });
});
