/**
 * AIへ渡す参考情報（文脈パケット）の組み立て（Stage 9H-3B・純関数）。
 * これまでAIは本文・画像・URL・告知日だけを受け取り、投稿者のXアカウント（表示名・プロフィール）は固定ロジックだけが参照していた。
 * 参考情報は告知の一部ではない。系列・店舗の手がかりとして渡し、告知に根拠の無い日程・条件には使わせない。
 */
import { excerpt } from "./redact";

export interface ContextInput {
  /** 投稿者のXアカウント */
  account?: { username?: string; displayName?: string; bio?: string; location?: string };
  /** 引用元の投稿者 */
  quotedAccount?: { username?: string; displayName?: string; bio?: string };
  /** 過去の人間の判断（humanHintsFor の結果） */
  humanHints?: string[];
}

export interface AiContext {
  /** 本文の前に付ける参考情報のブロック（空なら付けない） */
  block: string;
  /** 記録用の短い要素 */
  items: string[];
}

const HEAD = "【参考情報（告知本文ではありません）】系列・店舗を判断する手がかりとしてだけ使い、告知本文に書かれていない日程・応募条件・商品には使わない。\n";

export function buildAiContext(i: ContextInput): AiContext {
  const items: string[] = [];
  const a = i.account;
  if (a && (a.displayName || a.username)) {
    items.push(`投稿者のXアカウント: 表示名「${excerpt(a.displayName ?? "", 60)}」／ユーザー名 @${excerpt(a.username ?? "", 30)}${a.bio ? `／プロフィール「${excerpt(a.bio, 120)}」` : ""}${a.location ? `／所在地「${excerpt(a.location, 30)}」` : ""}`);
  }
  const q = i.quotedAccount;
  if (q && (q.displayName || q.username)) items.push(`引用元のアカウント: 表示名「${excerpt(q.displayName ?? "", 60)}」／ユーザー名 @${excerpt(q.username ?? "", 30)}${q.bio ? `／プロフィール「${excerpt(q.bio, 120)}」` : ""}`);
  for (const h of i.humanHints ?? []) items.push(h);
  if (items.length === 0) return { block: "", items: [] };
  return { block: `${HEAD}${items.map((x) => `- ${x}`).join("\n")}\n---\n`, items };
}
