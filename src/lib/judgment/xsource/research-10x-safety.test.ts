// @vitest-environment node
/** Stage 10X: 実AI評価の関門・実行コマンドが承認を迂回できないこと／検索ツールの安全性（有料呼び出しなし）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkJudgmentRealRun } from "../real-gate";
import { makeSearchTool, SEARCH_FALLBACK_JPY } from "./research-search";

vi.mock("server-only", () => ({}));

describe("実AI評価の関門（承認が無ければ実APIに接続しない）", () => {
  const base = { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: "sk-dev-test" };
  const ok = { env: base, confirm: true, approvedTotalJpy: 25, approvedPerCaseJpy: 3 };
  it("承認の金額・確認・許可・開発環境のどれが欠けても拒否する。本番/Vercelは常に拒否。候補上限を超える承認は拒否", () => {
    expect(checkJudgmentRealRun(ok).ok).toBe(true);
    expect(checkJudgmentRealRun({ ...ok, approvedTotalJpy: 0 }).ok).toBe(false);
    expect(checkJudgmentRealRun({ ...ok, approvedPerCaseJpy: 0 }).ok).toBe(false);
    expect(checkJudgmentRealRun({ ...ok, confirm: false }).ok).toBe(false);
    expect(checkJudgmentRealRun({ ...ok, env: { ...base, JUDGMENT_REAL_EVAL: "" } }).ok).toBe(false);
    expect(checkJudgmentRealRun({ ...ok, env: { ...base, TOREMANE_ENV: "production" } }).ok).toBe(false);
    expect(checkJudgmentRealRun({ ...ok, env: { ...base, VERCEL: "1" } }).ok).toBe(false);
    expect(checkJudgmentRealRun({ ...ok, approvedTotalJpy: 61 }).ok).toBe(false);
    expect(checkJudgmentRealRun({ ...ok, env: { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow" } }).ok).toBe(false); // キーの再利用の明示が無い
  });
});

describe("実行コマンドは承認を迂回できない", () => {
  const runner = readFileSync("scripts/xsource-10x.mjs", "utf8");
  it("承認の金額・確認文に既定値が無く、確認文が承認額と一致しなければ実行しない。1回に1つの target だけ", () => {
    expect(runner).toContain("既定値はありません");
    expect(runner).toContain("APPROVE ${target} ${total}JPY");
    expect(runner).not.toMatch(/approved-total-jpy=\d|JUDGMENT_APPROVED_TOTAL_JPY: "\d/); // 承認額を既定で埋めない
    expect(runner).toMatch(/if \(!TARGETS\[target\]\)/);
    expect(runner).toContain("本番キーは使わない");
  });
  it("実AIの評価コードは、すべて関門（checkJudgmentRealRun）を通ってからクライアントを作り、target と有料フラグが両方揃わないと動かない。上限（回数・費用）を検証する", () => {
    for (const [file, flag, target] of [["research-10u-real.test.ts", "JUDGMENT_10U_REAL", "A"], ["research-10v-real.test.ts", "JUDGMENT_10V_REAL", "B2"], ["research-10v-real.test.ts", "JUDGMENT_10V_REAL", "C"]] as const) {
      const s = readFileSync(`src/lib/judgment/xsource/${file}`, "utf8");
      expect(s).toContain(`env.JUDGMENT_10X_TARGET !== "${target}"`);
      expect(s).toContain(flag);
      expect(s.indexOf("checkJudgmentRealRun(")).toBeLessThan(s.indexOf("new Anthropic("));
      expect(s).toMatch(/budget\.calls\)\.toBeLessThanOrEqual\(90\)/);
    }
  });
});

describe("検索ツール（開発限定・読み取り専用）", () => {
  const provider = (hits: { title: string; url: string; snippet: string }[], cost?: number) => ({ name: "mock", search: vi.fn(async () => (cost === undefined ? hits : { hits, costJpy: cost })) });
  it("検索語に個人情報・URL・認証情報・過長な語は入れない（拒否して検索しない）", async () => {
    const p = provider([]);
    const s = makeSearchTool(p);
    for (const q of ["連絡先 test@example.com の店", "https://example.test/a を探して", "token=abc123 店", "03-1234-5678 店", "", "あ".repeat(121)]) expect((await s(q)).ok, q).toBe(false);
    expect(p.search).not.toHaveBeenCalled();
    expect((await s("新宿 カードショップ 拡張パック 抽選")).ok).toBe(true);
  });
  it("結果は https のURLと短い抜粋だけ（候補＝データ）。費用が不明なら概算を計上（0円にしない）。例外は失敗として扱う", async () => {
    const hits = [{ title: "店", url: "https://shop.example/a", snippet: "連絡 a@b.co" }, { title: "危険", url: "http://insecure.example", snippet: "" }, { title: "x", url: "javascript:alert(1)", snippet: "" }];
    const r = await makeSearchTool(provider(hits))("店 抽選");
    expect(r).toMatchObject({ ok: true, costJpy: SEARCH_FALLBACK_JPY });
    if (r.ok) {
      expect(r.hits.map((h) => h.url)).toEqual(["https://shop.example/a"]);
      expect(r.hits[0].snippet).not.toContain("a@b.co"); // 抜粋も個人情報を伏せる
    }
    expect(await makeSearchTool(provider(hits, 1.7))("店 抽選")).toMatchObject({ costJpy: 1.7 });
    const bad = { name: "x", search: vi.fn(async () => { throw new Error("net"); }) };
    expect(await makeSearchTool(bad)("店 抽選")).toEqual({ ok: false, reason: "search_failed:Error" });
  });
});
