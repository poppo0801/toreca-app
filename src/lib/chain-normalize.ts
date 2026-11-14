/**
 * 系列名の正規化（Stage 9C・純関数）。AI解析・手動登録・自動収集・重複判定・マスター検索で共通に使う。
 *
 * 目的: 「BOOK・OFF」と「BOOKOFF」、「GEO（ゲオ）」と「GEO」、「イトーヨーカドーネット通販」と「イトーヨーカドー」のような
 * 表記揺れを、同じ「系列」として扱う。ただし「系列」と「店舗・通販チャネル」は別の概念:
 *   - 系列の統一: 表記（記号・括弧書きの読み・法人格・販売チャネルの語）の違いだけを同一視する
 *   - 通販チャネル: 「ネット通販」「オンラインストア」などの語は、系列名からは外し、チャネル（online）として別に返す。
 *     店舗マスターの統合には使わない（通販の店舗は系列内の別の店舗として扱う）
 * 異なる系列を名称が似ているだけで同一視しない（部分一致は行わない。同一視するのは、正規化した結果が完全に一致するときだけ）。
 */

/** 系列名の表記揺れ（カナ表記・英字表記）。正規化の最後に1つの代表キーへそろえる */
const CHAIN_SYNONYMS: [RegExp, string][] = [
  [/^(ブックオフ|bookoff)(スーパーバザー)?/, "bookoff"],
  [/^(ツタヤ|tsutaya)/, "tsutaya"],
  [/^(ゲオ|geo)(?![a-z])/, "geo"],
  [/^(ヤマダ電機|ヤマダデンキ|yamada)/, "yamada"],
  [/^(ビックカメラ|biccamera)/, "biccamera"],
  [/^(ヨドバシ|ヨドバシカメラ|yodobashi)/, "yodobashi"],
  [/^(イオン|aeon)(?!九州)/, "aeon"],
  [/^(古本市場|ふるいち)/, "furuichi"],
];

/** 販売チャネルを表す語（系列名の末尾に付く。系列を変えない） */
const CHANNEL_SUFFIX = /(ネット通販サイト|ネット通販|ネットショッピング|ネットショップ|ネットストア|通販サイト|オンラインショッピング|オンラインショップ|オンラインストア|オンライン通販|オンライン|通販部|通販|公式サイト|公式ストア|公式ショップ|公式|ショップ|ストア|web|ウェブ)+$/;

const CORP = /(株式会社|有限会社|\(株\)|（株）)/g;
/** 名称の区切り・装飾の記号（長音「ー」は語の一部なので残す） */
const SYMBOLS = /[・･\.．,，、。'’"“”`´\-‐–—―_\/／\\|｜:：;；!！?？~〜～#＃*＊&＆+＋=＝]/g;

export interface ChainNameParts {
  /** 系列の照合キー（表記揺れ・チャネル語を除いた正規形） */
  key: string;
  /** 名称から読み取れた販売チャネル（通販・オンライン）。なければ null */
  channel: "online" | null;
  /** 括弧書きの読み（「GEO（ゲオ）」の「ゲオ」など）。照合の補助 */
  readings: string[];
}

/** 括弧書きを取り出して除く。除いたあとに名称が残らないときは、括弧の中身を名称として使う */
function splitBrackets(s: string): { base: string; inner: string[] } {
  const inner: string[] = [];
  const base = s.replace(/[（(［\[【〈<]([^）)］\]】〉>]*)[）)］\]】〉>]/g, (_m, g: string) => {
    if (g.trim()) inner.push(g.trim());
    return " ";
  });
  return { base, inner };
}

const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(CORP, "").replace(SYMBOLS, "").replace(/[\s　]+/g, "");

export function parseChainName(raw: string): ChainNameParts {
  const nk = (raw ?? "").normalize("NFKC");
  const { base, inner } = splitBrackets(nk);
  // 括弧を除いた名称が空なら、括弧の中身を名称とする（「（ゲオ）」だけ、など）
  const primary = fold(base) || fold(inner[0] ?? "");
  const readings = inner.map(fold).filter(Boolean);
  let core = primary;
  let channel: "online" | null = null;
  const stripped = core.replace(CHANNEL_SUFFIX, "");
  if (stripped && stripped !== core) {
    // チャネル語を除いて系列名が残るときだけ除く（「オンライン」だけの名称は、そのまま）
    core = stripped;
    channel = "online";
  }
  for (const [re, canon] of CHAIN_SYNONYMS) {
    if (re.test(core)) {
      core = core.replace(re, canon);
      break;
    }
  }
  return { key: core, channel, readings };
}

/** 系列の照合キー（表記揺れ・チャネル語を除いた正規形） */
export function chainCanonicalKey(raw: string): string {
  return parseChainName(raw).key;
}

/**
 * 2つの系列名が、表記の違いだけで同じ系列か。
 * 正規形が完全に一致する、または一方の括弧書きの読みが他方の正規形に一致する（「GEO（ゲオ）」と「ゲオ」）ときだけ true。
 */
export function sameChainName(a: string, b: string): boolean {
  const x = parseChainName(a);
  const y = parseChainName(b);
  if (!x.key || !y.key) return false;
  if (x.key === y.key) return true;
  const canon = (s: string) => parseChainName(s).key;
  return x.readings.some((r) => canon(r) === y.key) || y.readings.some((r) => canon(r) === x.key);
}

/** 名称がチャネル（通販・オンライン）を表しているか。系列の統一ではなく、店舗・チャネルの判断に使う */
export function chainNameChannel(raw: string): "online" | null {
  return parseChainName(raw).channel;
}
