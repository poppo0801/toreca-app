import webpush from "web-push";

/**
 * Web Push 送信。購読のendpointはクライアントから受け取るため、サーバーが任意URLへ
 * リクエストを送るSSRFにならないよう、既知のプッシュサービスのホストだけを許可する。
 */
const ALLOWED_HOSTS: RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && u.port === "" && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  type: string;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; status: number | null };
export type PushSender = (sub: PushSubscriptionInput, payload: PushPayload) => Promise<PushResult>;

/** VAPID設定済みの送信関数。鍵が未設定なら例外（秘密鍵はサーバーの環境変数のみ）。 */
export function createWebPushSender(): PushSender {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID の設定（NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT）が未設定です");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  return async (sub, payload) => {
    if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, gone: true, status: null };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      return { ok: true };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? null;
      // 404/410: 購読が失効（端末側で解除・アプリ削除など）
      return { ok: false, gone: status === 404 || status === 410, status };
    }
  };
}
