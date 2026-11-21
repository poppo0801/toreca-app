// @vitest-environment node
/** Stage 10N: 応募機会の確認画面（ローカル専用）の安全性の静的検査。実データ・ネットワークには触れない。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("scripts/review-10n-local.mjs", "utf8");

describe("確認画面（応募機会）: 本人の操作でのみ記録・外部へ送らない・データを変更しない", () => {
  it("127.0.0.1だけで待ち受け、トークンとHostを検査する。外部へ通信するコードを持たない", () => {
    expect(src).toContain('listen(0, "127.0.0.1"');
    expect(src).toContain("randomBytes");
    expect(src).toContain("127\.0\.0\.1");
    expect(src).not.toMatch(/https?\.request|fetch\(["'`]https?:|node:https|api\.anthropic|@supabase/);
  });
  it("全件の選択・AI名義でない確認者名がなければ保存しない。書き込みは保存処理の1か所だけ（ローカルの確認記録のみ）", () => {
    expect(src).toContain("AI_NAME.test(who)");
    expect(src).toContain("未選択です。保存しません");
    expect(src.match(/writeFileSync\(/g)?.length).toBe(1);
    expect(src.indexOf("writeFileSync(")).toBeGreaterThan(src.indexOf('"/save"'));
    expect(src).toContain("実行されません");
    expect(src).toContain("誤統合");
  });
  it("--status は件数だけで値を表示しない", () => {
    const status = src.slice(src.indexOf('"--status"'), src.indexOf("const esc"));
    expect(status).not.toContain("fields");
    expect(status).not.toContain("members");
  });
});
