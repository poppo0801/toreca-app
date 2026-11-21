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

describe("確認画面（10O: 補完・登録判断）: 本人の操作でのみ記録・外部へ送らない・何も実行しない", () => {
  const o = readFileSync("scripts/review-10o-local.mjs", "utf8");
  it("127.0.0.1だけ・トークン・Host検査。外部通信・DBアクセスのコードを持たない", () => {
    expect(o).toContain('listen(0, "127.0.0.1"');
    expect(o).toContain("randomBytes");
    expect(o).not.toMatch(/https?\.request|fetch\(["'`]https?:|node:https|api\.anthropic|@supabase/);
  });
  it("全件の選択・AI名義でない確認者名がなければ保存しない。書き込みは保存処理の1か所。実行されないことと、10M/10Nの画面への導線を明記", () => {
    expect(o).toContain("AI_NAME.test(who)");
    expect(o).toContain("未選択です。保存しません");
    expect(o.match(/writeFileSync\(/g)?.length).toBe(1);
    expect(o.indexOf("writeFileSync(")).toBeGreaterThan(o.indexOf('"/save"'));
    expect(o).toContain("実行されません");
    expect(o).toContain("review-10m-local.mjs");
    expect(o).toContain("review-10n-local.mjs");
  });
  it("--status は件数だけで値を表示しない", () => {
    const status = o.slice(o.indexOf('"--status"'), o.indexOf("const esc"));
    expect(status).not.toContain("quotes");
    expect(status).not.toContain("members");
  });
});

describe("確認画面（10Q: 応募単位の推論）: 本人の操作でのみ記録・外部へ送らない・何も実行しない", () => {
  const q = readFileSync("scripts/review-10q-local.mjs", "utf8");
  it("127.0.0.1だけ・トークン・Host検査。外部通信・DBアクセスを持たない。全件選択・AI名義拒否・書き込みは保存処理の1か所。仮説で正解ではないと明記", () => {
    expect(q).toContain('listen(0, "127.0.0.1"');
    expect(q).toContain("randomBytes");
    expect(q).not.toMatch(/https?\.request|fetch\(["'`]https?:|node:https|api\.anthropic|@supabase/);
    expect(q).toContain("AI_NAME.test(who)");
    expect(q).toContain("未選択です。保存しません");
    expect(q.match(/writeFileSync\(/g)?.length).toBe(1);
    expect(q.indexOf("writeFileSync(")).toBeGreaterThan(q.indexOf('"/save"'));
    expect(q).toContain("仮説");
    expect(q).toContain("何も実行されません");
  });
});
