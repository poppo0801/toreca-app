import { timingSafeEqual } from "node:crypto";

/**
 * 通知ジョブ呼び出しの認証。Authorization: Bearer <CRON_SECRET> のみ許可。
 * 秘密が未設定・短い（32文字未満）の場合は常に拒否する（誤って公開エンドポイントにならない）。
 * 長さの違いで早期終了しないよう、ハッシュ化せず同一長にそろえて定数時間比較する。
 */
export function isAuthorizedCron(authorizationHeader: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32) return false;
  const given = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "")?.[1] ?? "";
  const a = Buffer.alloc(256);
  const b = Buffer.alloc(256);
  a.write(given.slice(0, 256));
  b.write(secret.slice(0, 256));
  return timingSafeEqual(a, b) && given.length === secret.length;
}
