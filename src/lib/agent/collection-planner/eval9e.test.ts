import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPage } from "@/lib/ai/page-kind";
import { loadFrozenPages, loadGoldPages, scoreClassification, verifyFrozen } from "@/lib/agent/collection-planner/eval9e";
import { GuardStop, RealRunGuard } from "@/lib/agent/collection-planner/real-guard";

/**
 * Stage 9E: ページの主題の判定の評価（実在のページ。無料・オフライン・API呼び出しなし）。
 *  旧方式: 「抽選」の語があれば抽選の告知（9Dまでのルール抽出）／新方式: ページの主題・応募の記載・構造で判定（classifyPage）
 *  正解は gold-pages.json（AI・分類器の出力ではなく、実在の抽選の情報源／ページ本文を読んで決めたもの）。
 *  注意: 分類器の調整に使ったページ（real・live1・live2の一部）と、調整後に取得したページは区別して報告する（live2 の1件は、取得後の確認で見つかった誤りを直した）。
 */
const frozen = loadFrozenPages();
const gold = loadGoldPages();
const legacy = (url: string) => {
  const p = frozen.get(url)!;
  const hit = /抽選|エントリー受付|応募受付/.test(`${p.title}\n${p.text}`);
  return { kind: hit ? "lottery_announcement" : "general", actionable: hit };
};
const current = (url: string) => {
  const p = frozen.get(url)!;
  return classifyPage({ title: p.title, text: `${p.title}\n${p.text}` });
};

describe("Stage 9E: 凍結した評価データ", () => {
  it("ページ本文のハッシュが凍結時と一致する（改変・欠落があれば評価を止める）", () => {
    expect(verifyFrozen(frozen)).toEqual([]);
  });
  it("正解データの全URLが凍結ページにある", () => {
    for (const g of gold) expect(frozen.has(g.url), g.url).toBe(true);
  });
});

describe("Stage 9E: 抽選ではないページの誤認識（実在のページ）", () => {
  const before = scoreClassification(gold, legacy);
  const after = scoreClassification(gold, current);
  it("旧方式（語の一致）は、トップ・一覧・お知らせを抽選の告知と誤認識する", () => {
    expect(before.fp).toBeGreaterThanOrEqual(6);
    expect(before.fn).toBe(0);
  });
  it("新方式は、実在の抽選の告知を見落とさず、抽選ではないページを登録の対象にしない", () => {
    expect(after.fn).toBe(0);
    expect(after.fp).toBe(0);
    expect(after.scored).toBeGreaterThanOrEqual(80);
    if (process.env.WRITE_EVAL === "1") {
      mkdirSync("eval/runs/investigation-9e", { recursive: true });
      const bySet = (sc: typeof after, f: (g: (typeof gold)[number]) => boolean) => scoreClassification(gold.filter(f), (u) => (sc === before ? legacy(u) : current(u)));
      const sets = ["real", "live1", "live2"].map((s) => ({ set: s, before: bySet(before, (g) => g.set === s), after: bySet(after, (g) => g.set === s) }));
      writeFileSync("eval/runs/investigation-9e/page-class.json", JSON.stringify({ before, after, sets }, null, 1));
    }
  });
});

describe("Stage 9E: 実API評価の費用・停止の関門", () => {
  const mk = (o: Partial<ConstructorParameters<typeof RealRunGuard>[0]> = {}) => new RealRunGuard({ capJpy: 100, perCaseJpy: 15, model: "claude-haiku-5-5", ...o });
  it("累計の上限に達する見込みなら、呼び出す前に止める", () => {
    const g = mk({ spentBefore: 99.5 });
    expect(() => g.precheck(1)).toThrow(GuardStop);
    expect(() => g.precheck(0.4)).not.toThrow();
  });
  it("1ケースの上限に達する見込みなら、そのケースを止める（次のケースへは進める）", () => {
    const g = mk();
    g.startCase("a");
    g.charge("agent", 10_000_000, 20_000_000); // 約 $11 ≒ 1,700円相当の大きな使用量を仮に記録（上限の判定の確認）
    expect(() => g.precheck(0.1)).toThrow(/1ケース|累計/);
    const g2 = mk();
    g2.startCase("a");
    g2.charge("agent", 20_000_000, 4_000_000); // $4 ≒ 600円
    g2.startCase("b");
    expect(g2.caseSpentJpy).toBe(0);
  });
  it("APIエラーが連続2回で全体を止める。成功すると連続回数は戻る。stop() 後は呼び出せない", () => {
    const g = mk();
    g.apiError();
    g.charge("agent", 100, 100);
    g.apiError();
    expect(g.stopped).toBeNull();
    g.apiError();
    expect(g.stopped).toMatch(/連続2回/);
    expect(() => g.precheck(0)).toThrow(/停止/);
    const h = mk();
    h.stop("誤った自動登録を検出");
    expect(() => h.precheck(0)).toThrow(GuardStop);
  });
  it("クライアントの包み: 上限を超える見込みの呼び出しはAPIへ送らない。使用量は台帳へ記録する", async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls += 1;
          return { usage: { input_tokens: 1000, output_tokens: 500 }, content: [], stop_reason: "end_turn" };
        },
      },
    };
    const g = mk({ spentBefore: 99.99 });
    const w = g.wrapClient(client as never);
    await expect(w.messages.create({ model: "claude-haiku-5-5", max_tokens: 4000, messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(GuardStop);
    expect(calls).toBe(0);
    const g2 = mk();
    g2.startCase("c1");
    await mk().wrapClient(client as never).messages.create({ model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "x" }] });
    await g2.wrapClient(client as never).messages.create({ model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "x" }] });
    expect(calls).toBe(2);
    expect(g2.entries).toHaveLength(1);
    expect(g2.spentJpy).toBeGreaterThan(0);
  });
});
