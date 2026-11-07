/**
 * Xアカウントの表示名を優先した系列の決定（Stage 6N・純関数）。
 *  - Xユーザー名（@Rises_eStore）をそのまま系列名として登録しない。系列名はマスターの正式名称・別名と照合して決める
 *  - 優先順位: ① 確定済みの対応（アカウントID／ユーザー名）② 表示名とマスターの系列名・別名 ③ 告知の本文から読み取った系列名 ④ ユーザー名（補助。マスターと一致するときだけ）
 *  - 特定できなければ系列名は空にして確認待ちにする（ユーザー名を新しい系列名にしない）
 */
import { matchChain } from "@/lib/lottery-match";
import { parseAccountName } from "@/lib/collector/store-identity";
import type { Chain } from "@/types/domain";

/** 英数字だけにそろえる（Rises_eStore / Rises eStore / rises-estore を同一視する） */
const alnum = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠ー]/g, "");

/** 系列名がXユーザー名そのもの（またはその区切り違い）か */
export function isUsernameLike(chainName: string, username: string): boolean {
  const a = alnum(chainName);
  const u = alnum(username);
  return a.length > 0 && u.length > 0 && a === u;
}

export interface XChainResolution {
  chainName: string;
  chainId: string | null;
  /** どの根拠で決めたか。"" = 特定できなかった */
  basis: "saved" | "display_name" | "extraction" | "username" | "";
  /** 利用者に見せる注意（確認待ちの理由） */
  warnings: string[];
}

export interface XChainInput {
  /** 告知の読み取りで得た系列名（空のことがある） */
  extracted: string;
  username: string;
  displayName: string;
  /** アカウントIDまたはユーザー名で確定済みの対応先 */
  saved?: { chainId: string | null; chainName: string } | null;
  chains: Chain[];
}

const sure = (k: string) => k === "exact" || k === "alias";

/** 正式名称・別名との照合。区切り文字（_ 空白 -）の違いは同一とみなす */
function matchSure(name: string, chains: Chain[]): Chain | null {
  const live = chains.filter((c) => !c.archived);
  const m = matchChain(name, live);
  if (m.item && sure(m.kind)) return m.item;
  const n = alnum(name);
  if (n.length < 2) return null;
  const hits = live.filter((c) => [c.name, ...(c.aliases ?? [])].some((x) => alnum(x) === n));
  return hits.length === 1 ? hits[0] : null;
}

export function resolveXChain(o: XChainInput): XChainResolution {
  const live = o.chains.filter((c) => !c.archived);
  // ① 確定済みの対応
  if (o.saved && (o.saved.chainName || o.saved.chainId)) {
    const c = o.saved.chainId ? live.find((x) => x.id === o.saved!.chainId) : undefined;
    if (c) return { chainName: c.name, chainId: c.id, basis: "saved", warnings: [] };
  }
  // ② 表示名とマスター（正式名称・別名）
  const parsed = parseAccountName(o.displayName, o.username, live);
  if ((parsed.kind === "store" || parsed.kind === "chain") && parsed.chainName) {
    const mi = matchSure(parsed.chainName, live);
    if (mi) return { chainName: mi.name, chainId: mi.id, basis: "display_name", warnings: [] };
  }
  // ③ 告知から読み取った系列名。ただしユーザー名そのものはここでは採用しない
  const ex = o.extracted.trim();
  if (ex && !isUsernameLike(ex, o.username)) {
    const mi = matchSure(ex, live);
    if (mi) return { chainName: mi.name, chainId: mi.id, basis: "extraction", warnings: [] };
    return { chainName: ex, chainId: null, basis: "extraction", warnings: [] };
  }
  // ④ ユーザー名（補助）。マスターの系列名・別名と一致したときだけ
  const u = o.username.trim();
  if (u) {
    const mi = matchSure(u, live);
    if (mi) return { chainName: mi.name, chainId: mi.id, basis: "username", warnings: [] };
  }
  const shown = o.displayName.trim() ? `表示名「${o.displayName.trim()}」` : `@${u}`;
  return { chainName: "", chainId: null, basis: "", warnings: [`系列を特定できません（Xアカウント ${shown}。系列マスターの名称・別名に一致しません）`] };
}

/** 告知の系列名がユーザー名そのもので、マスターにも一致しないときは、系列名として使わない（空にして確認待ちにする） */
export function dropUsernameChain(ex: string, username: string, chains: Chain[]): string {
  if (!ex.trim() || !isUsernameLike(ex, username)) return ex;
  return matchSure(ex, chains) ? ex : "";
}
