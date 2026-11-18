// @vitest-environment node
/**
 * Stage 9E: 実AI（Claude Haiku 5.5・開発専用キー）によるページ単位の評価。承認制（累計100円の上限・台帳）。通常のテストには含めない。
 *   E9E_PAGES=1 E9E_CONFIRM=yes E9E_CAP_JPY=100 npx vitest run src/lib/agent/collection-planner/real-page-eval.test.ts
 * 対象は eval/investigation-9e/page-eval-set.json（実行前に固定）。正解は gold-pages*.json／gold-scenarios.json（AIに渡さない）。
 * 見るもの: ①AIが抽選の告知と判断するか（AIのみ）②ページの主題の検証（固定ロジック）を併せた判定（本番導入時の構成）③系列・商品の読み取り。
 * 停止: 累計上限に達する見込み・1ケース15円・APIエラー連続2回・評価データの整合性。
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPage } from "@/lib/ai/page-kind";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { getExtractor } from "@/lib/ai/provider";
import { loadFrozenPages, loadGoldPages, loadScenarioGold, verifyFrozen } from "@/lib/agent/collection-planner/eval9e";
import { GuardStop, RealRunGuard, type LedgerState } from "@/lib/agent/collection-planner/real-guard";
import { checkRealApi } from "@/lib/agent/real-gate";

const OUT = "eval/runs/investigation-9e";
const LEDGER = `${OUT}/ledger.json`;
const NOW = new Date("2026-11-14T03:00:00Z");

describe.skipIf(process.env.E9E_PAGES !== "1")("Stage 9E 実AIのページ単位の評価", () => {
  it("抽選の告知か否かの判断と、系列・商品の読み取りを評価する", async () => {
    mkdirSync(OUT, { recursive: true });
    const frozen = loadFrozenPages();
    const bad = verifyFrozen(frozen);
    if (bad.length) throw new Error(`凍結した評価データの整合性が失われています: ${bad.slice(0, 3).join(", ")}`);
    const set = JSON.parse(readFileSync("eval/investigation-9e/page-eval-set.json", "utf8")) as { negatives: string[]; lotteries: string[] };
    const gold = loadGoldPages();
    const sg = loadScenarioGold();
    const g = checkRealApi({ env: process.env, confirm: process.env.E9E_CONFIRM === "yes", runsToday: 0 });
    if (!g.ok) throw new Error(g.reason);
    const cap = Number(process.env.E9E_CAP_JPY ?? 0);
    if (!(cap > 0) || cap > 100) throw new Error("承認された費用の上限（E9E_CAP_JPY。100円以下）が必要です");
    let prior: LedgerState | null = null;
    try {
      prior = JSON.parse(readFileSync(LEDGER, "utf8")) as LedgerState;
    } catch {
      /* 初回 */
    }
    const guard = new RealRunGuard({
      capJpy: cap,
      perCaseJpy: 15,
      model: g.model,
      spentBefore: prior?.spentJpy ?? 0,
      persist: (s) => writeFileSync(LEDGER, JSON.stringify({ ...s, entries: [...(prior?.entries ?? []), ...s.entries] }, null, 1)),
    });
    void new Anthropic({ apiKey: "unused" }); // 型の確認用（クライアントは getExtractor の内部にある）
    const base = getExtractor({ ANTHROPIC_API_KEY: g.apiKey, AI_MODEL: g.model });
    if (!base) throw new Error("解析エンジンを作れません");
    const ex = guard.wrapExtractor(base);

    const urls = [...set.negatives.map((u) => ({ u, neg: true })), ...set.lotteries.map((u) => ({ u, neg: false }))];
    const rows: Record<string, unknown>[] = [];
    for (const { u, neg } of urls) {
      if (guard.stopped) break;
      const page = frozen.get(u)!;
      const gp = gold.find((x) => x.url === u)!;
      guard.startCase(u);
      try {
        const out = await ex.extract({ kind: "url", text: `${page.title}\n${page.text}`, sourceUrl: u, now: NOW });
        const e = normalizeExtraction(out.raw, NOW);
        const fixed = classifyPage({ title: page.title, text: `${page.title}\n${page.text}` });
        const sgold = sg.urls[u] ?? sg.urls[u.replace(/\/$/, "")];
        const products = e.items.map((i) => i.name);
        const row = {
          url: u,
          set: gp.set,
          goldActionable: gp.actionable,
          goldKind: gp.kind,
          aiLottery: e.isLotteryAnnouncement,
          fixedKind: fixed.kind,
          fixedActionable: fixed.actionable,
          combined: e.isLotteryAnnouncement && fixed.actionable,
          chain: e.chainName,
          store: e.storeName,
          products,
          chainOk: sgold ? e.chainName.replace(/\s/g, "").includes(sgold.chain.replace(/\s/g, "")) || sgold.chain.includes(e.chainName) : null,
          productOk: sgold ? products.some((p) => p.includes(sgold.product) || sgold.product.includes(p)) : null,
          costJpy: guard.caseSpentJpy,
        };
        rows.push(row);
        // 停止条件: 抽選ではないページを、AIと固定ロジックを併せた判定で抽選の告知としたら（誤った自動登録につながる）止める
        if (neg && row.combined) guard.stop(`誤認識（併用判定）: ${u}`);
      } catch (err) {
        if (err instanceof GuardStop) {
          guard.stop(err.message);
          break;
        }
        rows.push({ url: u, error: (err as Error).message?.slice(0, 160) });
      }
    }
    const scored = rows.filter((r) => r.goldActionable !== undefined && r.goldActionable !== null && !r.error);
    const cm = (pick: (r: Record<string, unknown>) => boolean) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      let tn = 0;
      for (const r of scored) {
        const p = pick(r);
        if (r.goldActionable && p) tp += 1;
        else if (!r.goldActionable && p) fp += 1;
        else if (r.goldActionable && !p) fn += 1;
        else tn += 1;
      }
      return { tp, fp, fn, tn };
    };
    const summary = {
      at: new Date().toISOString(),
      model: g.model,
      pages: rows.length,
      spentJpy: guard.spentJpy,
      stopped: guard.stopped,
      aiOnly: cm((r) => r.aiLottery === true),
      fixedOnly: cm((r) => r.fixedActionable === true),
      combined: cm((r) => r.combined === true),
      chainOk: `${rows.filter((r) => r.chainOk === true).length}/${rows.filter((r) => r.chainOk !== null && r.chainOk !== undefined).length}`,
      productOk: `${rows.filter((r) => r.productOk === true).length}/${rows.filter((r) => r.productOk !== null && r.productOk !== undefined).length}`,
      errors: rows.filter((r) => r.error).length,
      rows,
    };
    writeFileSync(`${OUT}/${process.env.E9E_LABEL ?? "real-pages"}.json`, JSON.stringify(summary, null, 1));
    // 抽選ではないページを併用判定で告知とした（誤認識）が0であること
    expect(summary.combined.fp).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
  }, 900_000);
});
