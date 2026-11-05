/**
 * 公式Xアカウントと系列・店舗の対応づけ（Stage 6B・純関数）。
 *  - 利用者が登録した対応だけを使う（自動で確定しない）。まとめアカウント（収集元のXアカウント）は紹介元であり、実施店舗として扱わない
 *  - 投稿者だけで店舗を確定させない: 告知（本文・画像）から系列/店舗が読み取れなかった項目だけを補い、補った項目は二次情報として明示する
 *  - 告知から読み取れた系列/店舗が対応先と異なるときは上書きせず、注意を出す（系列の公式アカウントが複数店舗の抽選を告知する場合など）
 */
import { matchChain, matchStore } from "@/lib/lottery-match";
import type { ExtractedLottery } from "@/lib/ai/extraction";
import type { AppData } from "@/types/domain";

export interface XLink {
  username: string;
  role: "official_store" | "official_chain";
  chainId: string | null;
  storeId: string | null;
}

export const normUsername = (u: string) => u.trim().replace(/^@/, "").toLowerCase();

/** 投稿URL（https://x.com/<user>/status/<id>）から投稿者のアカウント名を取り出す */
export function usernameFromPostUrl(url: string | null | undefined): string | null {
  const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(url ?? "");
  return m ? normUsername(m[1]) : null;
}

export interface HintResult {
  extraction: ExtractedLottery;
  /** 補った項目（二次情報として明示する） */
  used: string[];
  /** 告知の内容と対応先が食い違うときの注意 */
  warnings: string[];
}

export function applyAccountHint(ex: ExtractedLottery, link: XLink | undefined, data: AppData): HintResult {
  const out: HintResult = { extraction: ex, used: [], warnings: [] };
  if (!link) return out;
  const store = link.storeId ? data.stores.find((s) => s.id === link.storeId && !s.archived) : undefined;
  const chain = data.chains.find((c) => c.id === (link.chainId ?? store?.chainId) && !c.archived);
  if (!chain) return out;
  const next = { ...ex };
  const who = `@${link.username}`;
  if (!ex.chainName.trim()) {
    next.chainName = chain.name;
    out.used.push(`系列（公式アカウント ${who} の対応づけ）`);
  } else {
    const m = matchChain(ex.chainName, data.chains, { stores: data.stores, storeName: ex.storeName });
    if (m.item && m.item.id !== chain.id) out.warnings.push(`告知の系列「${ex.chainName}」が、投稿者（${who}）に対応づけた系列「${chain.name}」と異なります`);
  }
  if (link.role === "official_store" && store) {
    if (!ex.storeName.trim()) {
      next.storeName = store.name;
      out.used.push(`店舗（公式アカウント ${who} の対応づけ）`);
    } else {
      const m = matchStore(ex.storeName, chain.id, data.stores, chain.name);
      if (m.item && m.item.id !== store.id) out.warnings.push(`告知の店舗「${ex.storeName}」が、投稿者（${who}）に対応づけた店舗「${store.name}」と異なります`);
    }
  }
  out.extraction = next;
  return out;
}
