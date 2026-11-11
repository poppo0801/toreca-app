/** 店舗所在地エージェントの共通関数（Stage 8D-3）。ドメイン・名称の正規化 */
const REGISTRABLE = /([a-z0-9-]+\.(?:co|or|ne|ac|go|ed)\.jp|[a-z0-9-]+\.[a-z]{2,})$/i;
/** URL のホスト（登録ドメイン相当）。第三者サイトの「独立性」の判定に使う */
export function domainOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return REGISTRABLE.exec(host)?.[1] ?? host;
  } catch {
    return "";
  }
}

export const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
/** 店舗名から系列名と「店」を除いた、店舗を見分ける語（例: 「テスト書店 駅前店」→「駅前」） */
export function distinctiveToken(chain: string, store: string): string {
  let s = norm(store);
  const c = norm(chain);
  if (c && s.startsWith(c)) s = s.slice(c.length);
  s = s.replace(/店$/, "");
  // 短すぎる語（例: 「本店」→「本」）は他の語に紛れるため、店舗名そのものを使う
  return s.length >= 2 ? s : norm(store);
}
