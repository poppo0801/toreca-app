/**
 * カード名 → ポケモン（全国図鑑番号）の照合（相場調査メモの画像表示用。**表示のためだけ**で、カードの記録は変更しない）。
 * 単純な部分一致は誤った画像を出す（「ハイパーボール」「博士の研究」「ミュウツーとミュウ」等）ため、カード名の**形**を限定して照合する:
 *   ① 末尾の種別表記（ex・V・VMAX・VSTAR・GX・☆・括弧書き 等）を除いた残りが、ポケモン名と完全一致
 *   ② 先頭に許可した接頭（メガ・アローラ・ガラル・ヒスイ・パルデア・かがやく 等、または「〇〇の」）が付き、その残りがポケモン名と完全一致
 * 複数のポケモン名を含む・トレーナーズ/エネルギー等の名前・どれにも当てはまらない場合は null（画像を出さない＝安全なプレースホルダー）。
 */
import { ALL_POKEMON_NAMES } from "@/lib/zukan/pokemon-names";

const BY_NAME = new Map<string, number>(ALL_POKEMON_NAMES.map((n, i) => [n.normalize("NFKC"), i + 1]));

/** 末尾の種別表記（繰り返し除去）。例: ブルンゲルex / ミロカロスV / ピカチュウ（ふしぎ）/ ドリュウズ ex */
const SUFFIX = /(?:\s*(?:ex|EX|GX|VMAX|VSTAR|V-UNION|V|ＶＭＡＸ|☆|◇|δ|\([^)]*\)|\[[^\]]*\]|【[^】]*】|〔[^〕]*〕|［[^］]*］))+$/;
/** 先頭に許可する接頭（形態・地方・輝き等）。「〇〇の」（トレーナーのポケモン）は別規則で許可 */
const PREFIXES = ["メガ", "ゲンシ", "アローラ", "ガラル", "ヒスイ", "パルデア", "キョダイ", "かがやく", "ひかる", "ダーク", "ライト", "わるい", "テラスタル", "オリジナル"];

/**
 * 全国図鑑マスター（番号・正式名称・読み仮名）。ポケモンの公式名称は**カタカナ**なので、読み仮名は正式名称から作る（♀♂などの記号を除く）。
 * 五十音順の基準はこの読み仮名（カード名の「ex」等には影響されない）。番号は全国図鑑No（カードの収録番号とは別の情報）。
 */
export interface PokemonMaster {
  no: number;
  name: string;
  reading: string;
}
export function pokemonMaster(no: number): PokemonMaster | null {
  const name = ALL_POKEMON_NAMES[no - 1];
  return name ? { no, name, reading: name.normalize("NFKC").replace(/[♀♂]/g, "") } : null;
}

export interface MatchedPokemon {
  no: number;
  name: string;
}

export function matchPokemonByCardName(cardName: string): MatchedPokemon | null {
  let core = cardName.normalize("NFKC").trim();
  if (!core) return null;
  core = core.replace(/^(?:【[^】]*】|\[[^\]]*\]|〔[^〕]*〕)+\s*/, ""); // 先頭の括弧書き（例: 【プロモ】）
  core = core.replace(SUFFIX, "").replace(/\s+/g, "");
  if (!core) return null;
  const direct = BY_NAME.get(core);
  if (direct) return { no: direct, name: ALL_POKEMON_NAMES[direct - 1] };
  for (const p of PREFIXES) {
    if (core.startsWith(p)) {
      const n = BY_NAME.get(core.slice(p.length));
      if (n) return { no: n, name: ALL_POKEMON_NAMES[n - 1] };
    }
  }
  // 「〇〇の」+ ポケモン名（例: ホップのザシアン・ロケット団のミュウツー）。「の」より後ろが名前と完全一致のときだけ
  const i = core.indexOf("の");
  if (i > 0 && i < core.length - 1) {
    const n = BY_NAME.get(core.slice(i + 1));
    if (n) return { no: n, name: ALL_POKEMON_NAMES[n - 1] };
  }
  return null;
}
