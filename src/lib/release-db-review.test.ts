// @vitest-environment node
/** 本番移行の入口（release-db.mjs）の確認済みリスト（REVIEWED）が、改行コードの環境差で崩れないこと・記録された内容のハッシュが実ファイルと一致すること（本番には接続しない）。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync("scripts/release-db.mjs", "utf8").split("\r\n").join("\n");
const CRLF = String.fromCharCode(13, 10);
const normalize = (s: string): string => s.split(CRLF).join("\n");
const lfSha = (f: string): string => createHash("sha256").update(normalize(readFileSync(`supabase/migrations/${f}`, "utf8"))).digest("hex").slice(0, 12);

describe("release-db.mjs の確認済みリスト（REVIEWED）", () => {
  it("内容のハッシュは改行コードを正規化して求める（CRLF/LF の環境で同じ値）", () => {
    const line = script.split("\n").find((l) => l.includes("const sha = createHash")) ?? "";
    expect(line).toContain('"utf8"'); // 文字列として読み、改行を正規化してからハッシュする
    expect(line).toContain("replace(/");
    expect(line).toContain("\\r\\n");
    expect(line).not.toMatch(/readFileSync\(join\("supabase\/migrations", f\)\)\.digest/); // バイト列のままのハッシュに戻っていない
  });
  it("登録されているエントリのハッシュが、実ファイルの内容（LF正規化）と一致する（ファイルが変われば無効になる設計の確認）", () => {
    const entries = [...script.matchAll(/"(\d{14}_[a-z0-9_]+\.sql)": \{ sha: "([0-9a-f]{12})"/g)].map((m) => [m[1], m[2]]);
    expect(entries.length).toBeGreaterThan(0);
    for (const [file, sha] of entries) expect(lfSha(file), file).toBe(sha);
  });
  it("EOLを正規化したハッシュは、CRLF/LFのどちらで保存されていても同じ", () => {
    const h = (s: string) => createHash("sha256").update(normalize(s)).digest("hex");
    expect(h("a\nb\n")).toBe(h("a" + CRLF + "b" + CRLF));
  });
});
