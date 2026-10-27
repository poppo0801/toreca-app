// バックアップの暗号化（Node標準の crypto のみ。外部ツール・外部サービス不要）。
// 形式: "TCGBAK1"(7B) | salt(16B) | iv(12B) | GCM認証タグ(16B) | 暗号文。鍵は passphrase から scrypt で導出。
// 中身は {version, files:{ファイル名: テキスト}} のJSONをgzipしたもの。改ざん・誤ったパスフレーズは復号時に必ず失敗する。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = Buffer.from("TCGBAK1");
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const key = (pass, salt) => scryptSync(pass, salt, 32, SCRYPT);

export function encryptFiles(files, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 16) throw new Error("パスフレーズは16文字以上が必要です");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(passphrase, salt), iv);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify({ version: 1, files }), "utf8"))), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function decryptFiles(buf, passphrase) {
  if (buf.length < 51 || !buf.subarray(0, 7).equals(MAGIC)) throw new Error("バックアップファイルの形式が正しくありません");
  const salt = buf.subarray(7, 23);
  const iv = buf.subarray(23, 35);
  const tag = buf.subarray(35, 51);
  const d = createDecipheriv("aes-256-gcm", key(passphrase, salt), iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  try {
    const plain = Buffer.concat([d.update(buf.subarray(51)), d.final()]);
    return JSON.parse(gunzipSync(plain).toString("utf8")).files;
  } catch {
    throw new Error("復号できません（パスフレーズが違うか、ファイルが壊れています）");
  }
}
