import { chainKey } from "@/lib/lottery-match";

/**
 * 「信頼性なし」で除外した系列の判定（Stage 7Q・純関数）。自動収集だけに適用し、手動登録・既存の抽選カードには触れない。
 * 系列マスターのID（確定した系列）を基準に、系列名・別名・表記ゆれ（「通販」「オンライン」等の語の違い）でも同じ系列として扱う。
 * 情報源のアカウントが特定できなくても（系列名・題名だけで）判定できる。
 */
export interface ExcludedChain {
  ruleId: string;
  chainId: string;
  /** 系列マスターの正式名称 */
  name: string;
  /** 系列マスターの別名（現在登録されているもの） */
  aliases: string[];
  /** 除外した日時（ISO）と理由 */
  at: string;
  reasonCode: string;
  note: string;
}

export type ExcludedVia = "id" | "name" | "text";
export interface ExcludedMatch {
  chain: ExcludedChain;
  via: ExcludedVia;
}

/** 比較用の名称キー。空白・記号・括弧を除いた小文字（chainKey で「通販」「オンライン」等の語も除く） */
export const exclusionNameKey = (s: string): string =>
  chainKey(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・、。,.'"“”‘’「」『』【】[\]()（）〈〉<>!！?？~〜～:：;；/／_\-‐–—]/g, "");

/** 題名・本文の中から名称を探すときに、短すぎる名称（誤検出しやすい）は対象にしない */
const MIN_TEXT_KEY = 4;

export function excludedNameKeys(c: Pick<ExcludedChain, "name" | "aliases">): string[] {
  return [...new Set([c.name, ...c.aliases].map(exclusionNameKey).filter((k) => k.length >= 2))];
}

export interface ExcludedTarget {
  chainId?: string | null;
  /** 解析した系列名（マスターに未登録の名称でもよい） */
  chainName?: string | null;
  /** 題名・本文など（系列名が読み取れないときの手掛かり） */
  texts?: (string | null | undefined)[];
  /**
   * texts の使い方。always=題名に除外系列の名称があれば一致とする（解析の前・候補の作成前）。
   * unresolved=系列が特定できないときだけ使う（解析後。別の系列と確定したものは名称の言及だけで除外しない）
   */
  textMode?: "always" | "unresolved";
}

/** 除外した系列に当たるか。ID → 系列名・別名 → 題名の順。一致しなければ null */
export function matchExcludedChain(excluded: readonly ExcludedChain[], t: ExcludedTarget): ExcludedMatch | null {
  if (excluded.length === 0) return null;
  const myName = t.chainName ? exclusionNameKey(t.chainName) : "";
  for (const c of excluded) {
    if (t.chainId && c.chainId === t.chainId) return { chain: c, via: "id" };
    if (myName.length >= 2 && excludedNameKeys(c).includes(myName)) return { chain: c, via: "name" };
  }
  const useText = t.textMode === "always" || (t.textMode === "unresolved" && !t.chainId && !myName);
  if (useText) {
    const hay = (t.texts ?? []).filter((x): x is string => !!x).map((x) => x.normalize("NFKC").toLowerCase().replace(/[\s・、。,.'"“”‘’「」『』【】[\]()（）〈〉<>!！?？~〜～:：;；/／_\-‐–—]/g, "")).join("\u0000");
    if (hay) for (const c of excluded) if (excludedNameKeys(c).some((k) => k.length >= MIN_TEXT_KEY && hay.includes(k))) return { chain: c, via: "text" };
  }
  return null;
}

const VIA_LABEL: Record<ExcludedVia, string> = { id: "系列マスターのID", name: "系列名・別名", text: "題名の系列名" };

/** 候補の記録に残す理由（除外した理由・日時つき） */
export function excludedChainReason(m: ExcludedMatch): string {
  const d = m.chain.at ? new Date(new Date(m.chain.at).getTime() + 9 * 3600_000).toISOString().slice(0, 10) : "";
  return `信頼性なしとして除外した系列「${m.chain.name}」に一致したため自動収集の対象外にしました（${VIA_LABEL[m.via]}で一致${d ? `・除外指定 ${d}` : ""}）`;
}
