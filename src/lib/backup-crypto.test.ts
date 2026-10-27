import { describe, expect, it } from "vitest";
// @ts-expect-error -- スクリプト側のJSモジュール（型宣言なし）
import { decryptFiles, encryptFiles } from "../../scripts/lib/backup-crypto.mjs";

const PASS = "correct-horse-battery-staple";
const files = { "_manifest.json": '{"a":1}', "profiles.json": '[{"label":"A"}]' };

describe("バックアップの暗号化", () => {
  it("往復で元に戻り、平文は暗号文に現れない", () => {
    const enc = encryptFiles(files, PASS);
    expect(enc.includes(Buffer.from("profiles"))).toBe(false);
    expect(decryptFiles(enc, PASS)).toEqual(files);
  });
  it("同じ内容でも毎回異なる暗号文（salt/iv）", () => {
    expect(encryptFiles(files, PASS).equals(encryptFiles(files, PASS))).toBe(false);
  });
  it("誤ったパスフレーズ・改ざん・短いパスフレーズは拒否される", () => {
    const enc = encryptFiles(files, PASS);
    expect(() => decryptFiles(enc, "wrong-passphrase-xxxxxxxx")).toThrow("復号できません");
    const bad = Buffer.from(enc);
    bad[bad.length - 1] ^= 1;
    expect(() => decryptFiles(bad, PASS)).toThrow("復号できません");
    expect(() => encryptFiles(files, "short")).toThrow("16文字以上");
  });
});
