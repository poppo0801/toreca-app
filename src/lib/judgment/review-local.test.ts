// @vitest-environment node
/** 人の全件目視の確認画面（ローカル専用）の安全性の静的検査。実原文・ネットワークには触れない。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("scripts/review-phase2-local.mjs", "utf8");

describe("確認画面スクリプト: 本人の操作でのみ記録される", () => {
  it("127.0.0.1だけで待ち受け、トークンとHostを検査する。外部へ通信するコードを持たない", () => {
    expect(src).toContain('listen(0, "127.0.0.1"');
    expect(src).toContain("randomBytes");
    expect(src).toMatch(/127\\\.0\\\.0\\\.1/);
    expect(src).not.toMatch(/https?\.request|fetch\(["'`]https?:|node:https|api\.anthropic/);
  });
  it("全件選択済み・AI名義でない確認者名がなければ保存しない。記録はPOSTの保存処理の中だけで書く", () => {
    expect(src).toContain("AI_NAME.test(who)");
    expect(src).toContain("未選択です。保存しません");
    expect(src.match(/writeFileSync\(/g)?.length).toBe(2);
    expect(src.indexOf("writeFileSync(")).toBeGreaterThan(src.indexOf('"/save"'));
  });
  it("--status は件数だけで原文を表示しない", () => {
    const status = src.slice(src.indexOf('"--status"'), src.indexOf("const esc"));
    expect(status).not.toContain("evidence_text");
  });
});
