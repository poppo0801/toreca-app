/**
 * 当落発表方法・応募条件・店舗区分の標準分類（Stage 5L）。
 * 手動登録・AI解析・Excel取込・将来のStage 4C自動収集が同じ定義と正規化を使う。
 * 元の文章（announcement_method / conditions_text）は補足・原文として残し、ここでの分類は上書きしない。
 */

// ---------------------------------------------------------------- 当落発表方法
export const ANNOUNCE_METHODS = [
  { code: "result_mail", label: "当落メール" },
  { code: "winner_mail", label: "当選者のみメール" },
  { code: "result_page", label: "結果確認ページ" },
  { code: "app", label: "公式アプリ" },
  { code: "x_dm", label: "XのDM" },
  { code: "line", label: "LINE" },
  { code: "sms", label: "SMS" },
  { code: "in_store", label: "店頭発表" },
  { code: "sns_post", label: "SNS投稿" },
  { code: "phone", label: "電話" },
  { code: "other", label: "その他" },
  { code: "unknown", label: "不明" },
] as const;
export type AnnounceMethod = (typeof ANNOUNCE_METHODS)[number]["code"];
export const ANNOUNCE_LABEL = Object.fromEntries(ANNOUNCE_METHODS.map((m) => [m.code, m.label])) as Record<AnnounceMethod, string>;
const ANNOUNCE_CODES = new Set<string>(ANNOUNCE_METHODS.map((m) => m.code));

/** 通知対象。経路（メール・LINEなど）とは独立に持つ。unknown=未確認 */
export const ANNOUNCE_TARGETS = [
  { code: "unknown", label: "不明" },
  { code: "both", label: "当選・落選の両方" },
  { code: "winners_only", label: "当選者のみ" },
] as const;
export type AnnounceTarget = (typeof ANNOUNCE_TARGETS)[number]["code"];
export const ANNOUNCE_TARGET_LABEL = Object.fromEntries(ANNOUNCE_TARGETS.map((t) => [t.code, t.label])) as Record<AnnounceTarget, string>;

export const isAnnounceMethod = (v: unknown): v is AnnounceMethod => typeof v === "string" && ANNOUNCE_CODES.has(v);
export const isAnnounceTarget = (v: unknown): v is AnnounceTarget => v === "unknown" || v === "both" || v === "winners_only";

/** 重複を除き、定義順に並べる。「不明」は他の方法があるときは外す */
export function normalizeAnnounceMethods(input: readonly unknown[]): AnnounceMethod[] {
  const set = new Set(input.filter(isAnnounceMethod));
  // 当落メールと当選者のみメールは同時に持たない（より限定的な方を残す）
  if (set.has("winner_mail") && set.has("result_mail")) set.delete("result_mail");
  if (set.size > 1) set.delete("unknown");
  return ANNOUNCE_METHODS.map((m) => m.code).filter((c) => set.has(c));
}

/** 発表方法のラベル（複数は「＋」でつなぐ）。当選者のみ通知は、メール以外の経路にも「（当選者のみ）」を付ける */
export function announceLabels(methods: readonly AnnounceMethod[], target: AnnounceTarget): string[] {
  return methods.map((m) => (target === "winners_only" && m !== "winner_mail" && m !== "result_page" && m !== "in_store" && m !== "sns_post" && m !== "unknown" && m !== "other" ? `${ANNOUNCE_LABEL[m]}（当選者のみ）` : ANNOUNCE_LABEL[m]));
}

interface Rule {
  re: RegExp;
  method: AnnounceMethod;
}
const ANNOUNCE_RULES: Rule[] = [
  { re: /当選者(のみ|にのみ|だけ|様のみ)[^。\n]{0,12}(メール|e-?mail)|(メール|e-?mail)[^。\n]{0,12}当選者(のみ|にのみ|だけ)/i, method: "winner_mail" },
  { re: /当落(結果)?[^。\n]{0,8}(メール|e-?mail)|(当選|落選)[・/／、]?(当選|落選)?[^。\n]{0,6}(メール|e-?mail)/i, method: "result_mail" },
  { re: /(マイページ|結果確認|応募履歴|申込履歴|申し込み履歴|購入履歴|抽選結果ページ|結果ページ|特設ページ|サイト上)[^。\n]{0,12}(確認|掲載|表示|発表)|結果は[^。\n]{0,20}(ページ|サイト)/, method: "result_page" },
  { re: /公式アプリ|アプリ(内|にて|から|で)[^。\n]{0,6}(通知|確認|発表|連絡)|プッシュ通知/, method: "app" },
  { re: /(X|Twitter|ツイッター)[^。\n]{0,6}(DM|ダイレクトメッセージ)|DM(にて|で|が)?[^。\n]{0,6}(連絡|通知|お知らせ)/i, method: "x_dm" },
  { re: /LINE[^。\n]{0,10}(連絡|通知|メッセージ|お知らせ|発表)/i, method: "line" },
  { re: /SMS|ショートメッセージ|ショートメール/i, method: "sms" },
  { re: /店頭[^。\n]{0,8}(発表|掲示|掲載|張り出)|店内[^。\n]{0,6}(掲示|発表)/, method: "in_store" },
  { re: /(公式)?(X|Twitter|ツイッター|SNS|Instagram|インスタ)[^。\n]{0,8}(で|にて|上で)?[^。\n]{0,4}(発表|投稿|告知|掲載)/i, method: "sns_post" },
  { re: /電話[^。\n]{0,8}(連絡|通知|にて|で)|お電話/, method: "phone" },
  { re: /メール(にて|で|を)?[^。\n]{0,6}(連絡|通知|お知らせ|送信|配信)/, method: "result_mail" },
];
const WINNERS_ONLY_RE = /当選者(のみ|にのみ|だけ|様のみ|限定)|当選した(方|場合)のみ|当選者以外[^。\n]{0,10}(連絡|通知|ありません|ございません)|落選(の)?(連絡|通知|メール)[^。\n]{0,6}(ありません|ございません|なし|いたしません)/;
const BOTH_RE = /当落(結果)?[^。\n]{0,8}(メール|通知|連絡)|当選・落選|当選.{0,3}落選.{0,8}(連絡|通知|メール)|落選(の)?(連絡|通知|メール)[^。\n]{0,6}(お送り|送信|いたします|します)/;

export interface AnnounceClassification {
  methods: AnnounceMethod[];
  target: AnnounceTarget;
  /** 文章から分類できたか（できなければ methods は ["unknown"] もしくは空） */
  matched: boolean;
}

/** 発表方法の自由記述を標準分類にする（ルールベース）。確実でない場合は「不明/その他」にし、推測で断定しない */
export function classifyAnnouncement(text: string): AnnounceClassification {
  const t = text.normalize("NFKC").trim();
  if (!t) return { methods: [], target: "unknown", matched: false };
  const found: AnnounceMethod[] = [];
  for (const r of ANNOUNCE_RULES) if (r.re.test(t) && !found.includes(r.method)) found.push(r.method);
  let target: AnnounceTarget = "unknown";
  if (WINNERS_ONLY_RE.test(t)) target = "winners_only";
  else if (BOTH_RE.test(t)) target = "both";
  if (target === "winners_only" && found.includes("result_mail") && !found.includes("winner_mail")) found.push("winner_mail");
  const methods = normalizeAnnounceMethods(found);
  if (methods.length === 0) return { methods: ["other"], target, matched: false };
  return { methods, target, matched: true };
}

// ---------------------------------------------------------------- LivePocket など抽選サービスの標準ルール
export interface ServiceRule {
  id: string;
  label: string;
  /** 情報源URL・本文から、そのサービスを使う抽選か（明確な場合だけ true） */
  detect: (ctx: { urls: readonly string[]; text: string }) => boolean;
  /** 告知に明記が無いときの初期候補。確認済みの情報としては扱わない（announcement_inferred=true） */
  announce: { methods: AnnounceMethod[]; target: AnnounceTarget };
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** 新しいサービスはここに追加する（Stage 4C以降も同じ仕組みで補完する） */
export const SERVICE_RULES: ServiceRule[] = [
  {
    id: "livepocket",
    label: "LivePocket",
    detect: ({ urls, text }) => urls.some((u) => /(^|\.)livepocket\.jp$/.test(host(u))) || /live\s?pocket|ライブポケット/i.test(text.normalize("NFKC")),
    // 当選処理時に当選メール、落選確定時に落選メール。申込履歴からも確認できる。通知対象は告知で確認できるまで不明のまま
    announce: { methods: ["result_mail", "result_page"], target: "unknown" },
  },
];

export interface AnnounceResolved {
  methods: AnnounceMethod[];
  target: AnnounceTarget;
  /** ルールによる推定（告知に明記が無い）。確認済みとは区別して表示する */
  inferred: boolean;
  /** 補完に使ったサービスのID */
  service?: string;
}

/**
 * 告知の文章（優先）と、サービス標準ルール（補完）から発表方法を決める。
 * 告知に明記された方法があれば、それだけを使う。明記が無く、サービスが明確なときだけ推定で補う。
 */
export function resolveAnnouncement(args: { text: string; methods?: readonly AnnounceMethod[]; target?: AnnounceTarget; urls: readonly string[]; body?: string }): AnnounceResolved {
  const explicit = normalizeAnnounceMethods(args.methods ?? []).filter((m) => m !== "unknown");
  const cls = classifyAnnouncement(args.text);
  const textMethods = cls.matched ? cls.methods : [];
  const methods = explicit.length > 0 ? explicit : textMethods;
  const target = args.target && args.target !== "unknown" ? args.target : cls.target;
  if (methods.length > 0) return { methods, target, inferred: false };
  const ctxText = `${args.text}\n${args.body ?? ""}`;
  for (const rule of SERVICE_RULES) {
    if (rule.detect({ urls: args.urls, text: ctxText })) return { methods: rule.announce.methods, target: rule.announce.target, inferred: true, service: rule.id };
  }
  return { methods: args.methods && args.methods.length > 0 ? normalizeAnnounceMethods(args.methods) : [], target, inferred: false };
}

// ---------------------------------------------------------------- 応募条件
export const REQUIREMENT_GROUPS = [
  { id: "member", label: "会員" },
  { id: "purchase", label: "購入実績" },
  { id: "identity", label: "本人確認" },
  { id: "sns", label: "SNS・アカウント" },
  { id: "area", label: "地域・来店" },
  { id: "limit", label: "応募制限" },
  { id: "other", label: "その他" },
] as const;
export type RequirementGroup = (typeof REQUIREMENT_GROUPS)[number]["id"];

export const REQUIREMENT_TAGS = [
  { code: "member_registration", label: "会員登録", group: "member" },
  { code: "member_card", label: "会員証・ポイントカード", group: "member" },
  { code: "app_member", label: "公式アプリ会員", group: "member" },
  { code: "purchase_history", label: "購入履歴", group: "purchase" },
  { code: "purchase_amount", label: "一定金額以上の購入", group: "purchase" },
  { code: "purchase_period", label: "特定期間内の購入", group: "purchase" },
  { code: "id_check", label: "身分証提示", group: "identity" },
  { code: "photo_id", label: "顔写真付き身分証", group: "identity" },
  { code: "other_verification", label: "その他本人確認", group: "identity" },
  { code: "x_account", label: "Xアカウント", group: "sns" },
  { code: "x_follow", label: "Xフォロー", group: "sns" },
  { code: "x_repost", label: "Xリポスト", group: "sns" },
  { code: "line_register", label: "LINE登録", group: "sns" },
  { code: "livepocket_account", label: "LivePocketアカウント", group: "sns" },
  { code: "other_account", label: "その他外部サービスアカウント", group: "sns" },
  { code: "resident_area", label: "居住地域制限", group: "area" },
  { code: "in_store_apply", label: "店頭応募", group: "area" },
  { code: "in_store_receive", label: "店頭受取必須", group: "area" },
  { code: "designated_store", label: "指定店舗での購入", group: "area" },
  { code: "once_per_person", label: "1人1回", group: "limit" },
  { code: "once_per_family", label: "1家族1回", group: "limit" },
  { code: "one_store_only", label: "1店舗のみ", group: "limit" },
  { code: "multi_store_ok", label: "複数店舗応募可能", group: "limit" },
  { code: "age_limit", label: "年齢制限", group: "limit" },
  { code: "ticket", label: "応募券", group: "other" },
  { code: "serial_code", label: "シリアルコード", group: "other" },
  { code: "other", label: "その他", group: "other" },
  { code: "unknown", label: "条件不明", group: "other" },
] as const;
export type RequirementTag = (typeof REQUIREMENT_TAGS)[number]["code"];
export const REQUIREMENT_LABEL = Object.fromEntries(REQUIREMENT_TAGS.map((t) => [t.code, t.label])) as Record<RequirementTag, string>;
const REQ_CODES = new Set<string>(REQUIREMENT_TAGS.map((t) => t.code));
export const isRequirementTag = (v: unknown): v is RequirementTag => typeof v === "string" && REQ_CODES.has(v);

export type RequirementLogic = "and" | "or";
export const isRequirementLogic = (v: unknown): v is RequirementLogic => v === "and" || v === "or";

/** 定義順・重複なし。「条件不明」は他の条件があるときは外す。1家族1回/1人1回は矛盾しないので両方可 */
export function normalizeRequirementTags(input: readonly unknown[]): RequirementTag[] {
  const set = new Set(input.filter(isRequirementTag));
  if (set.size > 1) set.delete("unknown");
  if (set.has("one_store_only") && set.has("multi_store_ok")) set.delete("multi_store_ok");
  return REQUIREMENT_TAGS.map((t) => t.code).filter((c) => set.has(c));
}

/**
 * 具体的な条件の構造化項目。不明な値は入れない（推測で埋めない）。
 * 構造化できない複雑な条件は conditions_text（補足・原文）に残す。
 */
export interface RequirementDetails {
  /** 購入金額（円） */
  minAmountYen?: number;
  /** 購入対象期間 YYYY-MM-DD */
  purchasePeriodFrom?: string;
  purchasePeriodTo?: string;
  /** 会員ランク名 */
  memberRank?: string;
  /** 年齢（歳以上） */
  minAge?: number;
  /** 居住地域 */
  residentArea?: string;
  /** 応募可能な店舗数 */
  maxStores?: number;
}
export const REQUIREMENT_DETAIL_KEYS = ["minAmountYen", "purchasePeriodFrom", "purchasePeriodTo", "memberRank", "minAge", "residentArea", "maxStores"] as const;

const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const posInt = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined);

/** 未知のキー・不正な値を落とす。DB（jsonb）・Excel・AIの出力を通す共通の検証 */
export function sanitizeRequirementDetails(v: unknown): RequirementDetails {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const out: RequirementDetails = {};
  const amt = posInt(o.minAmountYen, 10_000_000);
  if (amt !== undefined) out.minAmountYen = amt;
  if (isYmd(o.purchasePeriodFrom)) out.purchasePeriodFrom = o.purchasePeriodFrom;
  if (isYmd(o.purchasePeriodTo)) out.purchasePeriodTo = o.purchasePeriodTo;
  if (typeof o.memberRank === "string" && o.memberRank.trim()) out.memberRank = o.memberRank.trim().slice(0, 40);
  const age = posInt(o.minAge, 120);
  if (age !== undefined) out.minAge = age;
  if (typeof o.residentArea === "string" && o.residentArea.trim()) out.residentArea = o.residentArea.trim().slice(0, 60);
  const stores = posInt(o.maxStores, 99);
  if (stores !== undefined) out.maxStores = stores;
  return out;
}

const REQ_RULES: { re: RegExp; tag: RequirementTag }[] = [
  { re: /ポイントカード|会員証|メンバーズカード|会員カード/, tag: "member_card" },
  { re: /(アプリ)会員|公式アプリ(の)?(登録|会員|ダウンロード)/, tag: "app_member" },
  { re: /会員(登録|限定|様限定|のみ)|メンバー(登録|限定)|無料会員|会員である/, tag: "member_registration" },
  { re: /購入(履歴|実績)|過去に(.{0,8})購入/, tag: "purchase_history" },
  { re: /[0-9,]+円\s*(以上|から).{0,8}(購入|お買い上げ|買い物)|(購入|お買い上げ).{0,10}[0-9,]+円\s*以上/, tag: "purchase_amount" },
  { re: /(\d+月\d+日|\d{4}[\/年]\d+).{0,10}(まで|以降|から).{0,12}(購入|お買い上げ)/, tag: "purchase_period" },
  { re: /顔写真付き|写真付き(の)?(身分証|本人確認)|運転免許|マイナンバーカード|パスポート/, tag: "photo_id" },
  { re: /身分証|本人確認書類/, tag: "id_check" },
  { re: /本人確認/, tag: "other_verification" },
  { re: /(X|Twitter|ツイッター)[^。\n]{0,6}(アカウント)/i, tag: "x_account" },
  { re: /(X|Twitter|ツイッター)[^。\n]{0,10}フォロー|フォロー(して|が必要|必須)/i, tag: "x_follow" },
  { re: /リポスト|リツイート|RT/, tag: "x_repost" },
  { re: /LINE(公式)?[^。\n]{0,8}(登録|友だち|友達)|友だち追加/i, tag: "line_register" },
  { re: /live\s?pocket|ライブポケット/i, tag: "livepocket_account" },
  { re: /(居住|在住|お住まい)[^。\n]{0,8}(地域|エリア|県|都道府県|限定)|(県|都|府|道)(内|在住)(限定|の方)/, tag: "resident_area" },
  { re: /店頭(での)?(応募|申込|申し込み|受付)|来店(して)?(応募|申込)/, tag: "in_store_apply" },
  { re: /店頭(での)?(受取|受け取り|お渡し|引換|引き換え)(のみ|限定|必須)?|来店(受取|受け取り)/, tag: "in_store_receive" },
  { re: /(指定|対象)店舗(での|で)?(購入|お買い上げ)/, tag: "designated_store" },
  { re: /(お?1|一)人(様)?(お?1|一)回|1人1口|お1人様1回|1アカウント1回/, tag: "once_per_person" },
  { re: /(1|一)(家族|世帯|ご家庭)(あたり|につき)?(1|一)回|1世帯1回|同一世帯/, tag: "once_per_family" },
  { re: /(1|一)店舗(のみ|まで|限り)|店舗は(1|一)つ/, tag: "one_store_only" },
  { re: /複数店舗(へ|に)?(の)?(応募|申込|申し込み)(可|が可能|できます)|(他|ほか)の店舗(にも|でも)応募(可|できます)/, tag: "multi_store_ok" },
  { re: /\d+歳(以上|未満)|年齢(制限|確認)|未成年/, tag: "age_limit" },
  { re: /応募券|抽選券|整理券/, tag: "ticket" },
  { re: /シリアル(コード|番号)/, tag: "serial_code" },
];

export interface RequirementClassification {
  tags: RequirementTag[];
  details: RequirementDetails;
  matched: boolean;
}

/** 応募条件の自由記述を標準分類にする（ルールベース）。金額などは文章から明確に読めたときだけ構造化 */
export function classifyRequirements(text: string): RequirementClassification {
  const t = text.normalize("NFKC").trim();
  if (!t) return { tags: [], details: {}, matched: false };
  const found: RequirementTag[] = [];
  for (const r of REQ_RULES) if (r.re.test(t)) found.push(r.tag);
  const details: RequirementDetails = {};
  const amt = /([0-9][0-9,]*)円\s*以上/.exec(t);
  if (amt && found.includes("purchase_amount")) {
    const n = Number(amt[1].replace(/,/g, ""));
    const v = posInt(n, 10_000_000);
    if (v !== undefined) details.minAmountYen = v;
  }
  const age = /(\d{1,3})歳以上/.exec(t);
  if (age && found.includes("age_limit")) {
    const v = posInt(Number(age[1]), 120);
    if (v !== undefined) details.minAge = v;
  }
  const tags = normalizeRequirementTags(found);
  if (tags.length === 0) return { tags: ["other"], details: {}, matched: false };
  return { tags, details, matched: true };
}

// ---------------------------------------------------------------- 店舗区分と地域表示
export const STORE_KINDS = [
  { code: "physical", label: "実店舗" },
  { code: "online_only", label: "オンライン専用" },
  { code: "both", label: "実店舗・オンライン兼用" },
] as const;
export type StoreKind = (typeof STORE_KINDS)[number]["code"];
export const STORE_KIND_LABEL = Object.fromEntries(STORE_KINDS.map((k) => [k.code, k.label])) as Record<StoreKind, string>;
export const isStoreKind = (v: unknown): v is StoreKind => v === "physical" || v === "online_only" || v === "both";

export interface PlaceInfo {
  /** カードの地域表示（都道府県 or 通販）。null=出さない */
  label: string | null;
  /** 店頭・発送を選べる（発送可を示す） */
  canShip: boolean;
  /** 距離などの位置情報を出してよい（オンライン専用店舗・発送のみは出さない） */
  showLocation: boolean;
}

/**
 * 地域表示の規則。Webで応募することと、通販で受け取ることは別。
 *  - オンライン専用店舗 / 発送のみの抽選 → 通販（距離なし）
 *  - 実店舗の店頭受取 → 都道府県
 *  - 店頭・発送から選択 → 都道府県＋発送可
 */
export function placeInfo(args: { receiveMethod: "store" | "shipping" | "either" | "unknown"; prefecture?: string | null; storeKind?: StoreKind | null }): PlaceInfo {
  const pref = args.prefecture?.trim() || null;
  const kind = args.storeKind ?? "physical";
  if (kind === "online_only" || args.receiveMethod === "shipping") return { label: "通販", canShip: false, showLocation: false };
  if (args.receiveMethod === "either") return { label: pref, canShip: true, showLocation: true };
  // 受取方法が不明なら、都道府県を推測で出さない
  if (args.receiveMethod === "unknown") return { label: null, canShip: false, showLocation: true };
  return { label: pref, canShip: false, showLocation: true };
}
