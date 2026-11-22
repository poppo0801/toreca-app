// @vitest-environment node
/** 本番バックアップ・読み取りの接続先検証（Stage 10F）。純関数のみ。本番・ネットワークには接続しない。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error .mjs（型定義なし）
const bt = (await import("../../../scripts/lib/backup-target.mjs")) as {
  targetLine: (t: string) => string | null;
  verifyQueryTarget: (t: string, ref: string) => { ok: boolean; reason: string; line: string | null };
  remoteQueryArgs: (ref: string, file: string) => string[];
  checkCountDrift: (a: Record<string, number>, b: Record<string, number>) => { ok: boolean; diff: number; total: number; limit: number };
};
const REF = "abcdefghij0123456789";

describe("接続先の表示（Target: 行）の検証: 確認できなければ中止（fail-closed）", () => {
  it("期待する ref を含み、ローカルを示さない表示だけが通る", () => {
    expect(bt.verifyQueryTarget(`WARN: x\nTarget: remote ${REF} (toreca-app) · read-only\n`, REF).ok).toBe(true);
  });
  it("ローカル（local stack・127.0.0.1）・別の ref・表示なし・形式不正の ref は拒否", () => {
    expect(bt.verifyQueryTarget("Target: local stack (127.0.0.1:54322) · default; pass --remote", REF).ok).toBe(false);
    expect(bt.verifyQueryTarget("Target: remote zzzzzzzzzzzzzzzzzzzz (other)", REF).ok).toBe(false);
    expect(bt.verifyQueryTarget("rows only, no target line", REF)).toMatchObject({ ok: false, line: null });
    expect(bt.verifyQueryTarget(`Target: remote ${REF}`, "bad").ok).toBe(false);
    // ローカルの表示に、案内文として本番の ref が含まれていても（`pass --remote for toreca-app (<ref>)`）、ローカルとして拒否する
    expect(bt.verifyQueryTarget(`Target: local stack (127.0.0.1:54322) · default; pass --remote for toreca-app (${REF})`, REF).ok).toBe(false);
  });
  it("CLI引数は --remote=<ref> と --read-only を含み、--linked・書き込み許可を含まない。不正な ref・パスは拒否。Windowsのパスは通る", () => {
    const a = bt.remoteQueryArgs(REF, "C:\\Users\\x\\AppData\\Local\\Temp\\tcg-p2-abc\\q.sql");
    expect(a).toContain(`--remote=${REF}`);
    expect(a).toContain("--read-only");
    expect(a.join(" ")).not.toMatch(/--linked|--yes|--local/);
    expect(() => bt.remoteQueryArgs("bad", "q.sql")).toThrow();
    expect(() => bt.remoteQueryArgs(REF, "q.sql; rm -rf")).toThrow();
  });
});

describe("ダンプとクエリの件数の食い違い（別のDBを見ている疑い）", () => {
  it("取得中の収集による少しの差は許容し、大きな差は拒否する", () => {
    const dump = { a: 10000, b: 5000, c: 6000 };
    expect(bt.checkCountDrift({ ...dump, a: 10020 }, dump).ok).toBe(true);
    const local = { a: 12, b: 3, c: 0 }; // ローカルDBを見ている場合
    expect(bt.checkCountDrift(local, dump).ok).toBe(false);
    expect(bt.checkCountDrift({}, dump).ok).toBe(false);
  });
});

describe("バックアップ・抽出スクリプトの接続先指定", () => {
  it("完全バックアップの読み取りクエリは --remote=<ref> を明示して接続先を検証する。クエリ側に --linked を使わない。ダンプとの食い違い検査がある", () => {
    const src = readFileSync("scripts/full-backup.mjs", "utf8");
    expect(src).toContain("remoteQueryArgs(linked");
    expect(src).toContain("verifyQueryTarget(");
    expect(src).toContain("checkCountDrift(");
    expect(src).not.toMatch(/"db", "query", "--linked"/);
  });
  it("抽出CLIの完全バックアップ確認は、実際の保存先（TorecaBackups/full）の tcg-full-*.tcgbak2 を見る", () => {
    const src = readFileSync("scripts/extract-judgment-phase2.mjs", "utf8");
    expect(src).toContain("TorecaBackups");
    expect(src).toContain('"full"');
  });
});
