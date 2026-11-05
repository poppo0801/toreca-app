/**
 * Xアカウント（表示名・ユーザーID・プロフィール）からの系列・店舗・所在地の特定（Stage 6H・純関数）。
 *  1 投稿者の表示名・ユーザーIDを取得  2 系列名・店舗名を抽出  3 既存マスターと照合  4 所在地（都道府県）を確定
 * 方針:
 *  - アカウント名だけで所在地を推測・確定しない。都道府県は「店舗マスター」「公式アカウントのプロフィールに明記された住所」「告知の本文・画像」だけを根拠にする
 *  - 同名の店舗が複数あるときは決めない（マスターの都道府県が食い違う場合も）
 *  - 抽選まとめ・情報アカウントは店舗として扱わない（公式の投稿を引用して紹介しているだけ）
 *  - 照合の根拠（basis）を返し、二次情報として明示できるようにする
 */
import { matchChain, matchStore } from "@/lib/lottery-match";
import { PREFECTURE_LIST } from "@/lib/geo";
import type { XProfile } from "@/lib/collector/x-posts";
import type { Chain, Store } from "@/types/domain";

export type AccountKind = "store" | "chain" | "aggregator" | "unknown";

/** 抽選まとめ・情報発信のアカウントらしい表示名（店舗の公式アカウントではない） */
const AGGREGATOR = /抽選|まとめ|情報|速報|通知|ポケカ|ポケモンカード|リセール|転売|販売情報|入荷|在庫|bot|ボット|ニュース|チェッカー|攻略/i;

/** 表示名・ユーザーIDに含まれる系列の目印（マスターに無い系列でも、名前の正規化に使う） */
const CHAIN_KEYWORDS: { name: string; re: RegExp }[] = [
  { name: "TSUTAYA", re: /tsutaya|ツタヤ/i },
  { name: "GEO", re: /\bgeo\b|ゲオ/i },
  { name: "ヤマダ電機", re: /ヤマダ|yamada/i },
  { name: "ヨドバシカメラ", re: /ヨドバシ|yodobashi/i },
  { name: "ビックカメラ", re: /ビックカメラ|biccamera/i },
  { name: "ブックオフ", re: /ブックオフ|bookoff/i },
  { name: "イオン", re: /イオン|aeon/i },
  { name: "トイザらス", re: /トイザらス|toysrus/i },
  { name: "エディオン", re: /エディオン|edion/i },
  { name: "ケーズデンキ", re: /ケーズデンキ|ケーズ/i },
  { name: "ジョーシン", re: /ジョーシン|joshin/i },
];

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** 文章に明記された都道府県。1つに決まるときだけ返す（複数あるとき・無いときは空） */
export function prefectureInText(text: string | null | undefined): string {
  const t = (text ?? "").normalize("NFKC");
  const hits = PREFECTURE_LIST.filter((p) => t.includes(p));
  return new Set(hits).size === 1 ? hits[0] : "";
}

export interface ParsedAccount {
  kind: AccountKind;
  chainName: string;
  storeName: string;
}

/** 表示名から系列名・店舗名を取り出す。店舗名は「○○店」の形で書かれているときだけ */
export function parseAccountName(displayName: string, username: string, chains: Chain[]): ParsedAccount {
  const name = displayName.normalize("NFKC").trim();
  const none: ParsedAccount = { kind: "unknown", chainName: "", storeName: "" };
  if (!name) return none;
  if (AGGREGATOR.test(name) && !/店$|店舗/.test(name.replace(/公式|official/gi, "").trim())) return { kind: "aggregator", chainName: "", storeName: "" };
  // 系列: マスターの名称・別表記（長いものを優先）→ 目印の順
  const cands = chains
    .filter((c) => !c.archived)
    .flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => ({ chain: c.name, n })))
    .filter((x) => norm(x.n).length >= 2)
    .sort((a, b) => norm(b.n).length - norm(a.n).length);
  const nn = norm(name);
  const hit = cands.find((x) => nn.includes(norm(x.n)));
  const kw = CHAIN_KEYWORDS.find((k) => k.re.test(name)) ?? CHAIN_KEYWORDS.find((k) => k.re.test(username));
  const chainName = hit?.chain ?? kw?.name ?? "";
  if (!chainName) return none;
  // 店舗名: 系列名を除いた残りから「○○店」を取る
  let rest = name;
  const alias = hit ? cands.filter((x) => x.chain === hit.chain).map((x) => x.n) : [];
  for (const a of [...alias, ...(kw ? [kw.name] : [])]) rest = rest.replace(new RegExp(a.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  if (kw) rest = rest.replace(kw.re, " ");
  rest = rest.replace(/公式|official|アカウント|【[^】]*】|\[[^\]]*\]|[（(][^）)]*[）)]|@\S+|[|｜:：・\-_]/gi, " ").replace(/\s+/g, " ").trim();
  const m = /([^\s]{1,20}?)店$/.exec(rest) ?? /([^\s]{1,20}?店)\s/.exec(rest + " ");
  const core = m ? m[1].replace(/店$/, "").trim() : "";
  if (core && !/^(各|全国|公式|オンライン|通販|ネット)$/.test(core)) return { kind: "store", chainName, storeName: `${core}店` };
  return { kind: "chain", chainName, storeName: "" };
}

export interface AccountIdentity {
  username: string;
  displayName: string;
  kind: AccountKind;
  chainName: string;
  storeName: string;
  /** 照合できたマスター（確実な一致のみ） */
  chainId: string | null;
  storeId: string | null;
  /** 確定した都道府県（根拠が無ければ空。推測しない） */
  prefecture: string;
  /** 都道府県の根拠: master=店舗マスター／profile=公式アカウントのプロフィールに明記／saved=確認済みの対応づけ／"" */
  prefectureBasis: "master" | "profile" | "saved" | "";
  /** 店舗の照合: master=マスターと一致／name=表示名から読み取り（マスターに無い）／ambiguous=同名が複数／"" */
  storeBasis: "master" | "name" | "saved" | "ambiguous" | "";
  notes: string[];
}

export interface SavedIdentity {
  username: string;
  chainName: string;
  storeName: string;
  chainId: string | null;
  storeId: string | null;
  prefecture: string;
  basis: string;
}

/** プロフィールの所在地欄・自己紹介に明記された都道府県。所在地欄を優先し、自己紹介は店舗の住所らしい記載（郵便番号・市区町村つき）のときだけ使う */
export function prefectureFromProfile(p: XProfile | undefined): string {
  if (!p) return "";
  const loc = prefectureInText(p.location);
  if (loc) return loc;
  const desc = p.description.normalize("NFKC");
  if (/〒\s*\d{3}-?\d{4}|[市区町村郡].{0,12}\d/.test(desc)) return prefectureInText(desc);
  return "";
}

export function identifyAccount(opts: { username: string; profile?: XProfile; chains: Chain[]; stores: Store[]; saved?: SavedIdentity | null }): AccountIdentity {
  const { username, profile } = opts;
  const out: AccountIdentity = { username, displayName: profile?.name ?? "", kind: "unknown", chainName: "", storeName: "", chainId: null, storeId: null, prefecture: "", prefectureBasis: "", storeBasis: "", notes: [] };
  const parsed = parseAccountName(profile?.name ?? "", username, opts.chains);
  // 確認済みの対応づけがあれば再利用する（表示名が取れなくても使える）。まとめアカウントとして判定された投稿者には使わない
  const s = opts.saved;
  if (s && parsed.kind !== "aggregator") {
    const chainOk = !s.chainId || opts.chains.some((c) => c.id === s.chainId && !c.archived);
    const storeOk = !s.storeId || opts.stores.some((x) => x.id === s.storeId && !x.archived);
    if (chainOk && storeOk) {
      const st = s.storeId ? opts.stores.find((x) => x.id === s.storeId) : undefined;
      Object.assign(out, { kind: s.storeName ? "store" : "chain", chainName: s.chainName, storeName: s.storeName, chainId: s.chainId, storeId: s.storeId, storeBasis: "saved" });
      const pref = st?.prefecture || s.prefecture;
      if (pref) Object.assign(out, { prefecture: pref, prefectureBasis: "saved" });
      out.notes.push("確認済みのXアカウントの対応づけを使用");
      return out;
    }
  }
  Object.assign(out, { kind: parsed.kind, chainName: parsed.chainName, storeName: parsed.storeName });
  if (parsed.kind === "aggregator" || parsed.kind === "unknown") return out;

  const cm = matchChain(parsed.chainName, opts.chains);
  const chain = cm.item && (cm.kind === "exact" || cm.kind === "alias") ? cm.item : null;
  if (chain) {
    out.chainId = chain.id;
    out.chainName = chain.name;
  }
  if (parsed.kind === "chain") return out;

  // 店舗: 同じ系列の同名店舗が複数あれば決めない（所在地の裏付けで絞れる場合を除く）
  const profilePref = prefectureFromProfile(profile);
  if (chain) {
    const sm = matchStore(parsed.storeName, chain.id, opts.stores, chain.name);
    const sure = sm.item && (sm.kind === "exact" || sm.kind === "alias");
    if (sure && sm.item) {
      const same = opts.stores.filter((x) => x.chainId === chain.id && !x.archived && norm(x.name) === norm(sm.item!.name));
      const narrowed = same.length > 1 && profilePref ? same.filter((x) => x.prefecture === profilePref) : same;
      if (narrowed.length === 1) {
        const st = narrowed[0];
        Object.assign(out, { storeId: st.id, storeName: st.name, storeBasis: "master" });
        if (st.prefecture) Object.assign(out, { prefecture: st.prefecture, prefectureBasis: "master" });
        if (profilePref && st.prefecture && st.prefecture !== profilePref) {
          out.notes.push(`店舗マスターの都道府県（${st.prefecture}）とプロフィールの所在地（${profilePref}）が異なります`);
          out.storeId = null;
          out.storeBasis = "ambiguous";
          out.prefecture = "";
          out.prefectureBasis = "";
        }
      } else {
        out.storeBasis = "ambiguous";
        out.notes.push("同名の店舗が複数あるため、店舗を確定できません");
      }
    }
  }
  if (!out.storeBasis) out.storeBasis = "name";
  if (!out.prefecture && profilePref && out.storeBasis !== "ambiguous") Object.assign(out, { prefecture: profilePref, prefectureBasis: "profile" });
  return out;
}

/** 告知から店舗が読み取れなかったときの補完。補った項目は二次情報として返す（読み取れた項目は上書きしない） */
export function identityHint(ex: { chainName: string; storeName: string; prefecture: string }, id: AccountIdentity): { chainName: string; storeName: string; prefecture: string; used: string[] } {
  const used: string[] = [];
  let { chainName, storeName, prefecture } = ex;
  const who = `@${id.username}`;
  if (id.kind === "store" || id.kind === "chain") {
    if (!chainName.trim() && id.chainName) {
      chainName = id.chainName;
      used.push(`系列（Xアカウント ${who} の表示名）`);
    }
  }
  if (id.kind === "store" && id.storeBasis !== "ambiguous" && !storeName.trim() && id.storeName && (!ex.chainName.trim() || norm(ex.chainName) === norm(id.chainName))) {
    storeName = id.storeName;
    used.push(`店舗（Xアカウント ${who} の表示名）`);
  }
  if (!prefecture.trim() && id.prefecture && id.storeBasis !== "ambiguous") {
    prefecture = id.prefecture;
    used.push(`都道府県（${id.prefectureBasis === "master" ? "店舗マスター" : id.prefectureBasis === "saved" ? "確認済みの対応づけ" : `Xアカウント ${who} のプロフィールの所在地`}）`);
  }
  return { chainName, storeName, prefecture, used };
}
