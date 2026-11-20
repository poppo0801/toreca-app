// @vitest-environment node
/**
 * Stage 9Y: 「AIで情報を補完」の文書・URL入力の実動作確認（実API。少額の費用が発生）。
 *  既存の取り込み（runExtraction）をそのまま使い、テキスト1件・URL1件だけ呼ぶ。DBには接続しない・何も登録しない。
 *  実行: E9Y=1 E9Y_CONFIRM=yes E9Y_URL=<公開ページ> npx vitest run tests/eval9y.real.test.ts
 *  APIキーは開発専用（AGENT_ANTHROPIC_API_KEY）。本番のキーは使わない。
 */
import { describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { runExtraction } from "@/lib/server/lottery-extract-service";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const ON = process.env.E9Y === "1" && process.env.E9Y_CONFIRM === "yes";
const key = process.env.AGENT_ANTHROPIC_API_KEY;
const NOW = new Date("2026-11-20T03:00:00Z");

const TEXT = `【抽選販売のお知らせ】テスト書店 梅田店
ポケモンカードゲーム 拡張パック「テスト商品」BOX 1箱 抽選販売
応募期間: 2026年11月25日(水) 10:00 〜 11月30日(月) 23:59
当選発表: 12月2日(水)までにメールでご連絡
受取: 店頭受取のみ。お一人様1口まで。`;

describe.skipIf(!ON || !key)("9Y 実AI: 補完の文書・URL入力", () => {
  const extractor = () => getExtractor({ ANTHROPIC_API_KEY: key, AI_MODEL: "claude-haiku-5-5" });
  it("文書: 本文から日付・商品を読み取れる", async () => {
    const r = await runExtraction({ kind: "text", text: TEXT }, { extractor: extractor(), now: NOW });
    console.log("TEXT", JSON.stringify(r.ok ? { chain: r.extraction.chainName, store: r.extraction.storeName, items: r.extraction.items.map((i) => i.name), start: r.extraction.applyStart, deadline: r.extraction.applyDeadline, result: r.extraction.resultDate, usage: r.usage } : r));
    expect(r.ok).toBe(true);
  }, 90_000);
  it("URL: 公開ページを取得して読み取れる", async () => {
    const url = process.env.E9Y_URL;
    if (!url) return;
    const r = await runExtraction({ kind: "url", url }, { extractor: extractor(), now: NOW });
    console.log("URL", JSON.stringify(r.ok ? { chain: r.extraction.chainName, store: r.extraction.storeName, items: r.extraction.items.map((i) => i.name), start: r.extraction.applyStart, deadline: r.extraction.applyDeadline, result: r.extraction.resultDate, usage: r.usage } : { code: r.code, message: r.message, usage: r.usage }));
    expect(r.kind).toBe("url");
  }, 90_000);
});
