import { describe, expect, it } from "vitest";
// @ts-expect-error -- スクリプト側のJSモジュール（型宣言なし）
import { decryptBuffer, encryptBuffer } from "../../scripts/lib/backup-crypto.mjs";
// @ts-expect-error -- スクリプト側のJSモジュール（型宣言なし）
import { extractCopySql, parseCopyBlocks } from "../../scripts/lib/pg-copy.mjs";

const PASS = "correct-horse-battery-staple-123";

describe("Stage 8A: バイナリ対応の暗号化（完全バックアップ）", () => {
  const plain = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) % 256));

  it("暗号化して復号すると、バイト列が一致する（バイナリ対応）", () => {
    const enc = encryptBuffer(plain, PASS);
    expect(enc.subarray(0, 7).toString()).toBe("TCGBAK2");
    expect(enc.includes(plain.subarray(0, 64))).toBe(false); // 平文がそのまま残らない
    expect(decryptBuffer(enc, PASS).equals(plain)).toBe(true);
  });

  it("同じ内容でも毎回異なる暗号文になる（salt・iv が毎回ランダム）", () => {
    expect(encryptBuffer(plain, PASS).equals(encryptBuffer(plain, PASS))).toBe(false);
  });

  it("誤ったパスフレーズ・改ざん・形式違いは復号に失敗する", () => {
    const enc = encryptBuffer(plain, PASS);
    expect(() => decryptBuffer(enc, "wrong-passphrase-wrong-passphrase")).toThrow("復号できません");
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptBuffer(tampered, PASS)).toThrow("復号できません");
    expect(() => decryptBuffer(Buffer.from("not a backup file at all, really not one....................."), PASS)).toThrow("形式");
  });

  it("短いパスフレーズでは暗号化しない", () => {
    expect(() => encryptBuffer(plain, "short")).toThrow("16文字以上");
  });
});

describe("Stage 8A: pg_dump の COPY ブロックの抽出", () => {
  const sql = [
    "SET session_replication_role = replica;",
    'COPY "auth"."audit_log_entries" ("id") FROM stdin;',
    "\\.",
    "",
    'COPY "auth"."users" ("id", "email") FROM stdin;',
    "u1\ta@example.invalid",
    "u2\tb@example.invalid",
    "\\.",
    'COPY "auth"."identities" ("id") FROM stdin;',
    "i1",
    "\\.",
  ].join("\n");

  it("テーブルごとの行数を数える（空のテーブルも）", () => {
    const b = parseCopyBlocks(sql);
    expect(Object.keys(b)).toEqual(["auth.audit_log_entries", "auth.users", "auth.identities"]);
    expect(b["auth.audit_log_entries"].rows).toBe(0);
    expect(b["auth.users"].rows).toBe(2);
    expect(b["auth.identities"].rows).toBe(1);
  });

  it("指定したテーブルのブロックだけを、replica 設定付きのSQLにする", () => {
    const out = extractCopySql(sql, ["auth.users", "auth.identities"]);
    expect(out.startsWith("SET session_replication_role = replica;")).toBe(true);
    expect(out).toContain('COPY "auth"."users"');
    expect(out).toContain("u2\tb@example.invalid");
    expect(out).not.toContain("audit_log_entries");
  });

  it("ダンプに無いテーブルを指定したらエラー（黙って欠けさせない）", () => {
    expect(() => extractCopySql(sql, ["auth.sessions"])).toThrow("auth.sessions");
  });
});
