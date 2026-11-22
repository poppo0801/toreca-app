// @vitest-environment node
/** Stage 10M: 一覧の全項目の確認画面（ローカル専用）の安全性の静的検査。実原文・ネットワークには触れない。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("scripts/review-10m-local.mjs", "utf8");

describe("確認画面（一覧の全項目）: 本人の操作でのみ記録・外部へ送らない", () => {
  it("127.0.0.1だけで待ち受け、トークンとHostを検査する。外部へ通信するコードを持たない", () => {
    expect(src).toContain('listen(0, "127.0.0.1"');
    expect(src).toContain("randomBytes");
    expect(src).not.toMatch(/https?\.request|fetch\(["'`]https?:|node:https|api\.anthropic/);
  });
  it("全項目＋親投稿全体の選択・AI名義でない確認者名がなければ保存しない。記録の書き込みは保存処理の中だけ。accepted は正解ではないと明記", () => {
    expect(src).toContain("AI_NAME.test(who)");
    expect(src).toContain("未選択です。保存しません");
    expect(src.match(/writeFileSync\(/g)?.length).toBe(1);
    expect(src.indexOf("writeFileSync(")).toBeGreaterThan(src.indexOf('"/save"'));
    expect(src).toContain("判断が正しいという意味ではありません");
    for (const s of ["全件発見", "不足", "処理済み", "保留", "失敗", "未処理"]) expect(src).toContain(s);
  });
  it("--status は件数だけで原文を表示しない", () => {
    const status = src.slice(src.indexOf('"--status"'), src.indexOf("const esc"));
    expect(status).not.toContain("parentText");
    expect(status).not.toContain("it.text");
  });
});
