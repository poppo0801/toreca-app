/**
 * 地域（都道府県）の判定（Stage 7A・純関数）。店舗の住所・店舗名・告知の都道府県から、根拠つきで都道府県を決める。
 * 方針: 根拠が十分なときだけ地域を決める。曖昧（複数の都道府県に当てはまる・複数店舗の一覧・辞書にない）なら「不明」とし、地域外と断定しない。
 */
import { CITY_BY_PREF, PREF_SHORT } from "@/lib/collector/region-cities";
import { PREFECTURE_LIST } from "@/lib/geo";

export type RegionBasis = "address" | "stated_prefecture" | "store_name_prefecture" | "store_name_city" | "master" | "conflict" | "none";
export interface RegionJudgement {
  /** 根拠が食い違ったとき（basis=conflict）の、それぞれの根拠。除外ではなく追加確認の対象。追跡できるよう記録に残す */
  conflict?: { prefecture: string; basis: RegionBasis; note: string }[];
  /** 判定した都道府県（不明なら空） */
  prefecture: string;
  /** 判定した市区町村・地名（あれば） */
  city: string;
  basis: RegionBasis;
  /** 根拠の説明（除外履歴・詳細表示用） */
  note: string;
  /** 複数店舗の一覧（全国の店舗一覧など）で、特定の1店舗に決められない */
  multiStore: boolean;
}

const norm = (s: string) => s.normalize("NFKC").trim();

/** 辞書: 地名 → 都道府県（複数の都道府県に載っている名称は曖昧なので除く）。市・区・町・村の語尾は除いて登録する */
const CITY_INDEX: Map<string, string> = (() => {
  const seen = new Map<string, Set<string>>();
  for (const [pref, names] of Object.entries(CITY_BY_PREF)) {
    for (const raw of names.split(/\s+/).filter(Boolean)) {
      const name = raw.replace(/市$/, "");
      if (!seen.has(name)) seen.set(name, new Set());
      seen.get(name)?.add(pref);
    }
  }
  const out = new Map<string, string>();
  for (const [name, prefs] of seen) if (prefs.size === 1) out.set(name, [...prefs][0]);
  return out;
})();
/** 長い地名から順に照合する（「大和郡山」を「大和」より優先する） */
const CITY_NAMES = [...CITY_INDEX.keys()].sort((a, b) => b.length - a.length);

/** 都道府県名（「兵庫県」「兵庫」）を探す。複数見つかれば曖昧なので空 */
function prefecturesIn(text: string): string[] {
  const hits = new Set<string>();
  for (const p of PREFECTURE_LIST) if (text.includes(p)) hits.add(p);
  if (hits.size === 0) {
    for (const [short, full] of Object.entries(PREF_SHORT)) if (short.length >= 2 && text.includes(short)) hits.add(full);
  }
  return [...hits];
}

/** 複数店舗の一覧・総称を表す名称か（これは特定の1店舗ではないので、名称の地名で地域を決めない） */
export function looksMultiStore(storeName: string): boolean {
  const s = norm(storeName);
  if (!s) return false;
  return /[・、,，/／]|他|各店|全店|店舗一覧|対象店舗|取扱店舗|取り扱い店舗|など|ほか|\d+店舗/.test(s);
}

/** 「藤沢市」「豊橋市」のように市区町村が明示された表記、または辞書にある地名から都道府県を探す。見つからなければ null。複数の都道府県に当てはまれば null */
export function cityToPrefecture(text: string, opts: { explicitOnly?: boolean } = {}): { prefecture: string; city: string } | null {
  const s = norm(text);
  if (!s) return null;
  const found = new Map<string, string>(); // pref → city
  let rest = s;
  for (const name of CITY_NAMES) {
    if (!rest.includes(name)) continue;
    // 一文字の地名（津・関など）は「津市」のように市が付く表記だけ。明示的な市区町村のみ許可する場合も同様に「市/区/町/村」の語尾を要求する
    const explicit = new RegExp(name.length < 2 ? `${name}市` : `${name}(市|区|町|村)`).test(rest);
    if ((name.length < 2 || opts.explicitOnly) && !explicit) continue;
    found.set(CITY_INDEX.get(name) as string, name);
    rest = rest.split(name).join(" "); // 長い地名に含まれる短い地名（大和郡山と大和）を二重に数えない
  }
  if (found.size !== 1) return null;
  const [[prefecture, city]] = [...found];
  return { prefecture, city };
}

export interface RegionInput {
  /** 店舗マスターの都道府県（登録済みなら最優先） */
  masterPrefecture?: string | null;
  /** 店舗マスターの住所 */
  address?: string | null;
  /** 告知から読み取った店舗名 */
  storeName?: string | null;
  /** 告知・一覧に書かれた都道府県 */
  statedPrefecture?: string | null;
}

/**
 * 都道府県を判定する。順序: 店舗マスターの都道府県 → 住所 → 告知の都道府県 → 店舗名に含まれる都道府県名 → 店舗名に含まれる市区町村名。
 * 店舗名の地名は、1店舗を指す名称のときだけ使う（複数店舗の一覧は multiStore として、地域を決めない）。
 */
export function judgeRegion(r: RegionInput): RegionJudgement {
  const none = (note: string, multiStore = false): RegionJudgement => ({ prefecture: "", city: "", basis: "none", note, multiStore });
  const master = norm(r.masterPrefecture ?? "");
  if (master && (PREFECTURE_LIST as readonly string[]).includes(master)) return { prefecture: master, city: "", basis: "master", note: `店舗マスターの都道府県（${master}）`, multiStore: false };
  const address = norm(r.address ?? "");
  if (address) {
    const head = PREFECTURE_LIST.find((p) => address.startsWith(p));
    if (head) return { prefecture: head, city: "", basis: "address", note: `店舗住所の都道府県（${head}）`, multiStore: false };
    const c = cityToPrefecture(address, { explicitOnly: true });
    if (c) return { prefecture: c.prefecture, city: c.city, basis: "address", note: `店舗住所の市区町村（${c.city}）から${c.prefecture}と判定`, multiStore: false };
  }
  const stated = norm(r.statedPrefecture ?? "");
  const statedHits = stated ? prefecturesIn(stated) : [];
  const storeName = norm(r.storeName ?? "");
  const multi = looksMultiStore(storeName);
  if (statedHits.length === 1 && !multi) {
    // 9H-3N: 告知に出る都道府県は「告知に登場する地名」であり、抽選対象の店舗の所在地とは限らない（複数店舗の告知で、別の店舗の都道府県が紐づくことがある。
    // 例: 「キデイランド各店」の告知に「吉祥寺店（東京都）」があり、抽選対象の三宮店（兵庫県）が東京都と判定されて除外された）。
    // 店舗名そのものから別の都道府県が読めるときは、どちらかを推測で選ばず「不明（要確認）」にして、両方の根拠を残す。不明は地域外として除外しない。
    const fromName = storeName ? regionFromStoreName(storeName) : null;
    if (fromName && fromName.prefecture !== statedHits[0]) {
      return {
        prefecture: "",
        city: fromName.city,
        basis: "conflict",
        note: `告知の都道府県（${statedHits[0]}）と、店舗名の地名（${fromName.note}）が食い違うため、地域は特定しません（店舗の所在地の確認が必要）`,
        multiStore: false,
        conflict: [
          { prefecture: statedHits[0], basis: "stated_prefecture", note: `告知に記載された都道府県（${statedHits[0]}）。抽選対象の店舗の所在地とは限らない` },
          { prefecture: fromName.prefecture, basis: fromName.basis, note: fromName.note },
        ],
      };
    }
    return { prefecture: statedHits[0], city: "", basis: "stated_prefecture", note: `告知に記載された都道府県（${statedHits[0]}）`, multiStore: false };
  }
  if (!storeName) return none("地域を判定できる情報がありません");
  if (multi) return none("複数店舗の一覧のため、地域は特定しません", true);
  const named = prefecturesIn(storeName);
  if (named.length === 1) return { prefecture: named[0], city: "", basis: "store_name_prefecture", note: `店舗名に含まれる地域名から${named[0]}と判定`, multiStore: false };
  if (named.length > 1) return none("店舗名に複数の地域名が含まれるため、地域は特定しません");
  const c = cityToPrefecture(storeName);
  if (c) return { prefecture: c.prefecture, city: c.city, basis: "store_name_city", note: `店舗名の地名「${c.city}」から${c.prefecture}と判定`, multiStore: false };
  return none("店舗名から地域を判定できません");
}

/** 店舗名そのものから読める都道府県（店舗名に含まれる都道府県名・市区町村名。複数・曖昧なら null） */
function regionFromStoreName(storeName: string): { prefecture: string; city: string; basis: RegionBasis; note: string } | null {
  const s = norm(storeName);
  if (!s || looksMultiStore(s)) return null;
  const named = prefecturesIn(s);
  if (named.length === 1) {
    const full = named[0];
    // 9H-3O: 店舗名の途中に現れる県名の略称は、別の地名の一部のことがある（「勝田東石川店」の「石川」・「所沢山口店」の「山口」）。
    // 食い違いの根拠にするのは、県名そのもの（兵庫県）か、店舗名の先頭・漢字以外の直後にある地名だけ
    const shortName = Object.entries(PREF_SHORT).find(([, f]) => f === full)?.[0];
    if (!s.includes(full) && !(shortName && standaloneToken(s, shortName))) return null;
    return { prefecture: full, city: "", basis: "store_name_prefecture", note: `店舗名に含まれる地域名から${full}` };
  }
  if (named.length > 1) return null;
  const c = cityToPrefecture(s);
  // 市区町村名も同様に、漢字の直後（「新守山」の「守山」＝名古屋市の地区で、滋賀県の守山市ではない）なら、食い違いの根拠にしない
  return c && standaloneToken(s, c.city) ? { prefecture: c.prefecture, city: c.city, basis: "store_name_city", note: `店舗名の地名「${c.city}」から${c.prefecture}` } : null;
}

/** 地名が店舗名の先頭にあるか、直前が漢字以外（カタカナ・英数字・空白など）か。別の地名の途中に含まれる語（石川・山口・守山など）を除く */
function standaloneToken(name: string, token: string): boolean {
  const i = name.indexOf(token);
  if (i < 0) return false;
  if (i === 0) return true;
  return !/[㐀-鿿々〆]/.test(name[i - 1]);
}

/** 地域外として自動除外した記録（候補の draft.exclusion に残す。物理削除はせず、誤判定時は除外一覧から確認・復元できる） */
export interface RegionExclusion {
  kind: "region";
  at: string;
  /** 情報元（候補の情報源URL） */
  source: string;
  prefecture: string;
  city: string;
  basis: RegionBasis;
  /** 判定根拠 */
  note: string;
  /** 除外理由（画面に出す文） */
  reason: string;
  /** 判定に使った入力と、食い違った根拠（追跡用。Stage 9H-3N）。除外の理由を後から確認できるように残す */
  conflict?: { prefecture: string; basis: RegionBasis; note: string }[];
}
export function regionExclusionOf(j: RegionJudgement, o: { at: string; source: string; reason: string }): RegionExclusion {
  return { kind: "region", at: o.at, source: o.source.slice(0, 300), prefecture: j.prefecture, city: j.city, basis: j.basis, note: j.note, reason: o.reason.slice(0, 200), ...(j.conflict ? { conflict: j.conflict } : {}) };
}
/** 除外理由が「対象外の地域」か */
export const isRegionReason = (reasons: string[]) => reasons.some((r) => /対象外の地域/.test(r));
