/**
 * 系列名の解決（Stage 9H-3G・純関数）。AIが読み取った系列名を、登録済みの系列マスターと人間が確定した別名に合わせる。
 *
 * 優先順位: 1) 登録済み系列（正式名・別名・表記揺れの正規形が一致）→ 登録名を使う
 *          2) 人間が確定した別名（過去の評価で「A」を「B」に直した）→ 確定名を使い、確定名がマスターにあればマスター名
 *          3) どれにも一致しない → 名前は変えず、似た名前の候補を示す（自動で寄せない）
 * 同名・類似名の別系列を誤統合しない: 寄せるのは「正規形が完全に一致」「マスターの別名が一致」「人間が確定した別名」のときだけ。部分一致では寄せない。
 * 系列名の訂正と、店舗選択式の判断は独立して扱う（この関数は店舗・形態に触れない）。
 */
import { chainCanonicalKey, sameChainName } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import type { HumanKnowledge } from "./human-knowledge";

export interface MasterChain {
  id: string;
  name: string;
  aliases?: string[];
  archived?: boolean;
}

export type ChainResolution =
  | { source: "master"; name: string; id: string; changed: boolean; note: string }
  | { source: "human_alias"; name: string; id: string | null; changed: boolean; note: string }
  | { source: "none"; name: string; id: null; changed: false; note: string; candidates: string[] };

/** 人間が確定した系列名の別名 */
export function humanChainAliases(k: HumanKnowledge | undefined | null): { alias: string; canonical: string }[] {
  const out: { alias: string; canonical: string }[] = [];
  for (const e of k?.entries ?? []) if (e.kind === "chain_alias") out.push({ alias: e.alias, canonical: e.canonical });
  return out;
}

const findMaster = (name: string, masters: MasterChain[]): MasterChain | null => {
  const act = masters.filter((m) => !m.archived);
  const hits = act.filter((m) => [m.name, ...(m.aliases ?? [])].some((n) => sameChainName(n, name)));
  // 複数に一致するときは決めない（同じ表記が複数の系列に当たる＝別系列かもしれない）
  return hits.length === 1 ? hits[0] : null;
};

/** 似た名前の候補（部分一致・共通する語。自動では寄せず、提示だけ） */
function similar(name: string, masters: MasterChain[]): string[] {
  const k = chainCanonicalKey(name);
  const n = normName(name);
  if (k.length < 3) return [];
  return masters
    .filter((m) => !m.archived)
    .filter((m) => {
      const mk = chainCanonicalKey(m.name);
      return mk !== k && mk.length >= 3 && (mk.includes(k) || k.includes(mk) || (n.length >= 3 && normName(m.name).includes(n)));
    })
    .map((m) => m.name)
    .slice(0, 5);
}

export function resolveChainName(input: { name: string; masters: MasterChain[]; human?: HumanKnowledge | null }): ChainResolution {
  const name = input.name.trim();
  if (!name) return { source: "none", name, id: null, changed: false, note: "系列名が空です", candidates: [] };
  const m = findMaster(name, input.masters);
  if (m) return { source: "master", name: m.name, id: m.id, changed: m.name !== name, note: m.name !== name ? `登録済みの系列「${m.name}」に合わせた（「${name}」は表記揺れ・別名）` : "登録済みの系列と一致" };
  for (const a of humanChainAliases(input.human)) {
    if (!sameChainName(a.alias, name) && normName(a.alias) !== normName(name)) continue;
    const master = findMaster(a.canonical, input.masters);
    if (master) return { source: "master", name: master.name, id: master.id, changed: master.name !== name, note: `人間が確定した別名（「${a.alias}」→「${a.canonical}」）から、登録済みの系列「${master.name}」に合わせた` };
    return { source: "human_alias", name: a.canonical, id: null, changed: a.canonical !== name, note: `人間が確定した別名（「${a.alias}」→「${a.canonical}」）に合わせた（登録済みの系列には未登録）` };
  }
  const cands = similar(name, input.masters);
  return { source: "none", name, id: null, changed: false, note: cands.length ? `登録済みの系列に一致しません。似た名前の系列があります: ${cands.join("・")}（自動では寄せません）` : "登録済みの系列に一致しません（新しい系列の可能性）", candidates: cands };
}
