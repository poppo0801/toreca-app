/**
 * 複数の情報源の項目単位の統合（Stage 6D・純関数）。
 * 同じ抽選について、情報が複数の情報源（まとめサイト・店舗公式X・Xまとめアカウント・店舗の公式ページ）に分散しているとき、
 * 候補全体を上書きせず、項目ごとに「採用した値・情報源・取得日時・公式か二次情報か・確定/未確認/矛盾」を管理して補完する。
 *  - 不足している項目を優先して補完する。既に値がある項目は、情報源の優先順位（公式サイト > 公式X > Xまとめ > まとめサイト）で判断する
 *  - 食い違う項目は、どちらかに決めず「矛盾」として記録する（同じ情報源の新しい投稿による更新は、更新として扱う）
 *  - 同じ元の投稿をコピーした情報（まとめアカウントが公式の投稿を引用した場合など）は、独立した裏付けとして数えない
 *  - 手動で確定した項目（manual）は上書きしない
 */
import { normName } from "@/lib/norm";
import { productKey, type MatchKind } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import { relateDateTimes } from "./date-phrases";

export type FieldKey = "chain" | "store" | "items" | "applyStart" | "applyDeadline" | "resultDate" | "announcement" | "applyMethod" | "applyUrl" | "conditions" | "procedureStart" | "procedureDeadline" | "receiveStart" | "receiveDeadline" | "receiveMethod" | "location";
export const FIELD_LABEL: Record<FieldKey, string> = {
  chain: "系列",
  store: "店舗",
  items: "商品",
  applyStart: "応募開始",
  applyDeadline: "応募締切",
  resultDate: "当選発表日",
  announcement: "発表方法",
  applyMethod: "応募方法",
  applyUrl: "応募URL",
  conditions: "応募条件",
  procedureStart: "購入開始",
  procedureDeadline: "購入期限",
  receiveStart: "受取開始",
  receiveDeadline: "受取期限",
  receiveMethod: "受取方法",
  location: "所在地",
};
export const FIELD_KEYS = Object.keys(FIELD_LABEL) as FieldKey[];

/** 情報源の種類。数値が大きいほど優先（主催系列・店舗の公式情報 > 公式X > Xまとめアカウント > 抽選まとめサイト） */
export type SourceKind = "official_site" | "official_x" | "aggregator_x" | "list_site" | "unknown";
export const SOURCE_RANK: Record<SourceKind, number> = { official_site: 4, official_x: 3, aggregator_x: 2, list_site: 1, unknown: 0 };
export const SOURCE_LABEL: Record<SourceKind, string> = { official_site: "公式", official_x: "公式X", aggregator_x: "Xまとめ", list_site: "まとめサイト", unknown: "不明" };
export const isOfficial = (k: SourceKind) => k === "official_site" || k === "official_x";

export type FieldState = "confirmed" | "unverified" | "conflict";

export interface FieldSource {
  /** 情報源のURL（投稿URL・ページURL） */
  url: string;
  kind: SourceKind;
  /** X投稿ID（あれば） */
  postId?: string;
  /** 情報の出どころ（元の投稿・ページ）。同じ出どころの情報は独立した裏付けとして数えない */
  origin: string;
  /** 情報源のアカウント・ホスト（同じ情報源の新しい情報による更新の判定に使う） */
  account?: string;
  at: string;
  /**
   * Stage 9G: 値の出どころの層。organizer_body=主催者が書いた説明本文（LivePocket等の本文）/ platform_meta=サービス側の表示（「販売受付期間」など）。
   * 日時が食い違うとき、主催者の本文をサービス側の表示より優先する（無条件に同一視しない）。省略時は区別しない
   */
  basis?: "organizer_body" | "platform_meta";
}

export interface FieldProv {
  /** 採用した値（表示用） */
  value: string;
  source: FieldSource;
  state: FieldState;
  /** 独立した出どころの数（2以上で確定とみなす。公式情報は1でも確定） */
  origins: string[];
  /** 矛盾する別の値（どちらにも決めていない） */
  alt?: { value: string; source: FieldSource };
  /** 手動で確定した項目は自動で上書きしない */
  manual?: boolean;
}
export type FieldMap = Partial<Record<FieldKey, FieldProv>>;

export interface Side {
  input: LotteryInput;
  summary: { chain: MatchKind; store: MatchKind; items: { name: string; kind: MatchKind; matchedName: string | null }[] };
  fields: FieldMap;
  /** この側の情報源（新しく解析した候補の情報源） */
  source: FieldSource;
}

export interface Conflict {
  field: FieldKey;
  label: string;
  a: { value: string; url: string };
  b: { value: string; url: string };
  /** 応募締切の食い違い: earlier=早い方を暫定採用 / far_apart=日付が離れていて別の抽選・別の意味の可能性（置き換えない） */
  provisional?: "earlier" | "far_apart";
}

export interface MergeResult {
  input: LotteryInput;
  summary: Side["summary"];
  fields: FieldMap;
  conflicts: Conflict[];
  /** 他の情報源から補った項目 */
  filled: FieldKey[];
  /** 同じ情報源の新しい情報で更新した項目 */
  updated: FieldKey[];
}

// ---------------------------------------------------------------- 項目の取り出し
type Flex = { precision: string; date?: string | null; time?: string | null } | undefined;
const flexKnown = (f: Flex) => !!f && f.precision !== "unknown" && !!f.date;
const flexText = (f: Flex) => (flexKnown(f) ? `${f!.date}${f!.precision === "date_time" && f!.time ? ` ${f!.time}` : ""}` : "");
/** 応募URL: 応募先のURL（メモの「応募URL:」行）。取得時に抽選の入力欄が無いため、メモに残している */
export const applyUrlOf = (i: LotteryInput) => /応募URL:\s*(\S+)/.exec(i.memo ?? "")?.[1] ?? "";
const unknownish = (v: string | undefined | null) => !v || v === "unknown";

export function valueOf(k: FieldKey, i: LotteryInput): string {
  switch (k) {
    case "chain":
      return i.chain.id || i.chain.name.trim() ? i.chain.name.trim() || `id:${i.chain.id}` : "";
    case "store":
      return i.store.id || i.store.name.trim() ? i.store.name.trim() || `id:${i.store.id}` : "";
    case "items":
      return i.items.map((x) => x.product.name.trim()).filter(Boolean).join(" / ");
    case "applyStart":
      return flexText(i.applyStart);
    case "applyDeadline":
      return flexText(i.applyDeadline);
    case "resultDate":
      return flexText(i.resultDate);
    case "procedureStart":
      return flexText(i.procedureStart);
    case "procedureDeadline":
      return flexText(i.procedureDeadline);
    case "receiveStart":
      return flexText(i.receiveStart);
    case "receiveDeadline":
      return flexText(i.receiveDeadline);
    case "receiveMethod":
      return unknownish(i.receiveMethod) ? "" : i.receiveMethod;
    case "applyMethod":
      return unknownish(i.applyMethod) ? "" : i.applyMethod;
    case "applyUrl":
      return applyUrlOf(i);
    case "announcement":
      return [(i.announcementMethods ?? []).join(","), i.announcementMethod?.trim() ?? "", i.announcementUrl ?? ""].filter(Boolean).join(" ");
    case "conditions":
      return [i.conditionsText?.trim() ?? "", (i.requirementTags ?? []).join(",")].filter(Boolean).join(" ");
    case "location":
      return i.store.prefecture?.trim() ?? "";
  }
}

/** 比較用に正規化した値（表記の揺れで「矛盾」にしない） */
function comparable(k: FieldKey, i: LotteryInput): string {
  switch (k) {
    case "chain":
      return normName(i.chain.name).replace(/(オンラインショップ|オンラインストア|オンライン|通販部|通販|公式|ショップ|ストア)$/g, "");
    case "store":
      return normName(i.store.name);
    case "items":
      return i.items.map((x) => productKey(x.product.name)).filter(Boolean).sort().join("|");
    case "applyUrl": {
      const u = applyUrlOf(i).replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
      // 短縮URL（t.co 等）は、展開先が分からないため他のURLとは比較できない（矛盾にしない）
      return /^https?:\/\/(t\.co|bit\.ly|buff\.ly|ow\.ly|tinyurl\.com|lin\.ee|amzn\.to|goo\.gl)\//.test(u) ? "short" : u;
    }
    case "announcement":
    case "conditions":
      // 文言の違いは矛盾としない（有無だけを補完の対象にする）
      return valueOf(k, i) ? "present" : "";
    case "location":
      return normName(i.store.prefecture ?? "");
    default:
      return valueOf(k, i);
  }
}

/** 項目を取り込む（コピー）。取り込み先に同じ項目のまとまりを書き込む */
function copyField(k: FieldKey, from: LotteryInput, to: LotteryInput, fromSummary: Side["summary"], toSummary: Side["summary"]): void {
  switch (k) {
    case "chain":
      to.chain = { ...from.chain };
      toSummary.chain = fromSummary.chain;
      break;
    case "store":
      to.store = { ...from.store, prefecture: from.store.prefecture || to.store.prefecture };
      toSummary.store = fromSummary.store;
      break;
    case "items":
      to.items = from.items.map((x) => ({ ...x, product: { ...x.product } }));
      to.multiMode = from.multiMode;
      toSummary.items = fromSummary.items.map((x) => ({ ...x }));
      break;
    case "applyStart":
      to.applyStart = { ...from.applyStart };
      break;
    case "applyDeadline":
      to.applyDeadline = { ...from.applyDeadline };
      break;
    case "resultDate":
      to.resultDate = { ...from.resultDate };
      to.resultEndDate = from.resultEndDate;
      break;
    case "procedureStart":
      to.procedureStart = from.procedureStart ? ({ ...from.procedureStart } as never) : undefined;
      break;
    case "procedureDeadline":
      to.procedureDeadline = { ...from.procedureDeadline };
      break;
    case "receiveStart":
      to.receiveStart = from.receiveStart ? ({ ...from.receiveStart } as never) : undefined;
      to.procedureSplit = from.procedureSplit || to.procedureSplit;
      break;
    case "receiveDeadline":
      to.receiveDeadline = from.receiveDeadline ? ({ ...from.receiveDeadline } as never) : undefined;
      to.procedureSplit = from.procedureSplit || to.procedureSplit;
      break;
    case "receiveMethod":
      to.receiveMethod = from.receiveMethod;
      break;
    case "applyMethod":
      to.applyMethod = from.applyMethod;
      break;
    case "applyUrl": {
      const u = applyUrlOf(from);
      const memo = (to.memo ?? "").replace(/応募URL:\s*\S+\n?/, "").trim();
      to.memo = [`応募URL: ${u}`, memo].filter(Boolean).join("\n").slice(0, 2000);
      break;
    }
    case "announcement":
      to.announcementMethod = from.announcementMethod;
      to.announcementMethods = [...(from.announcementMethods ?? [])];
      to.announcementTarget = from.announcementTarget;
      to.announcementInferred = from.announcementInferred;
      to.announcementUrl = from.announcementUrl;
      break;
    case "conditions":
      to.conditionsText = from.conditionsText;
      to.verificationText = from.verificationText;
      to.requirementTags = [...(from.requirementTags ?? [])];
      to.requirementLogic = from.requirementLogic;
      to.requirementDetails = { ...(from.requirementDetails ?? {}) };
      break;
    case "location":
      to.store = { ...to.store, prefecture: from.store.prefecture };
      break;
  }
}

/** 項目の出典を作る（解析結果の項目ごと）。値がある項目だけ記録する */
export function provenanceFor(input: LotteryInput, source: FieldSource, opts: { manual?: boolean } = {}): FieldMap {
  const out: FieldMap = {};
  for (const k of FIELD_KEYS) {
    const v = valueOf(k, input);
    if (!v) continue;
    out[k] = { value: v.slice(0, 120), source, state: isOfficial(source.kind) ? "confirmed" : "unverified", origins: [source.origin], ...(opts.manual ? { manual: true } : {}) };
  }
  return out;
}

const sameSource = (a: FieldSource, b: FieldSource) => !!a.account && a.account === b.account;

/**
 * 2つの側（carrier=主、other=補う側）を項目単位で統合する。入力は変更しない。
 *  - 主に値が無く、補う側にある → 補う
 *  - 両方に同じ値 → 独立した出どころが増えれば確定に
 *  - 違う値 → 同じ情報源で補う側が新しい→更新／手動確定は維持／それ以外は矛盾（どちらにも決めない。優先順位の高い値を仮に残し、矛盾を記録）
 */
export function mergeSides(carrier: Side, other: Side): MergeResult {
  const input: LotteryInput = JSON.parse(JSON.stringify(carrier.input));
  const summary: Side["summary"] = JSON.parse(JSON.stringify(carrier.summary));
  const fields: FieldMap = JSON.parse(JSON.stringify(carrier.fields));
  const conflicts: Conflict[] = [];
  const filled: FieldKey[] = [];
  const updated: FieldKey[] = [];
  for (const k of FIELD_KEYS) {
    const cv = valueOf(k, carrier.input);
    const ov = valueOf(k, other.input);
    const cp = fields[k];
    const op = other.fields[k];
    const osrc = op?.source ?? other.source;
    const csrc = cp?.source ?? carrier.source;
    if (!ov) continue;
    if (!cv) {
      copyField(k, other.input, input, other.summary, summary);
      fields[k] = { value: ov.slice(0, 120), source: osrc, state: isOfficial(osrc.kind) ? "confirmed" : "unverified", origins: [osrc.origin] };
      filled.push(k);
      continue;
    }
    const cc = comparable(k, carrier.input);
    const oc = comparable(k, other.input);
    // 短縮URLと実URL: 実URLの方を採用する（矛盾にしない）。「店頭・発送どちらも可」と限定した受取方法: 矛盾にしない
    if (k === "applyUrl" && (cc === "short" || oc === "short") && cc !== oc) {
      if (cc === "short") {
        copyField(k, other.input, input, other.summary, summary);
        fields[k] = { value: ov.slice(0, 120), source: osrc, state: isOfficial(osrc.kind) ? "confirmed" : "unverified", origins: [osrc.origin] };
        updated.push(k);
      }
      continue;
    }
    if (k === "receiveMethod" && cc !== oc && (cv === "either" || ov === "either")) continue;
    if (cc === oc) {
      // 同じ値: 独立した出どころ（元の投稿が異なる）が増えれば確定
      const origins = [...new Set([...(cp?.origins ?? [csrc.origin]), ...(op?.origins ?? [osrc.origin])])];
      const prev = fields[k];
      if (prev) fields[k] = { ...prev, origins, state: prev.state === "conflict" ? "conflict" : origins.length >= 2 || isOfficial(prev.source.kind) ? "confirmed" : "unverified" };
      continue;
    }
    // 違う値
    if (cp?.manual) continue; // 手動で確定した項目は上書きしない
    // 日時の意味が同じ表記差（11:59と12:00・23:59と翌0:00の境界表現、同じ日の日付のみと時刻つき）は矛盾にしない。安全側（早い方・詳しい方）を採用する（Stage 9G）
    if (k === "applyDeadline" || k === "applyStart" || k === "resultDate") {
      const rel = relateDateTimes({ date: carrier.input[k].date ?? "", time: carrier.input[k].time }, { date: other.input[k].date ?? "", time: other.input[k].time });
      if (rel.same && rel.adopt) {
        const keep = rel.adopt.date === (carrier.input[k].date ?? "") && (rel.adopt.time ?? "") === (carrier.input[k].time ?? "");
        if (!keep) {
          copyField(k, other.input, input, other.summary, summary);
          fields[k] = { value: ov.slice(0, 120), source: osrc, state: cp?.state ?? "unverified", origins: [...new Set([...(cp?.origins ?? [csrc.origin]), osrc.origin])] };
        } else if (cp) fields[k] = { ...cp, origins: [...new Set([...cp.origins, osrc.origin])] };
        updated.push(k);
        continue;
      }
      // 主催者の説明本文とサービス側の表示で食い違うときは、主催者の本文を採用する（矛盾として止めない）
      if (osrc.basis && csrc.basis && osrc.basis !== csrc.basis) {
        if (osrc.basis === "organizer_body") {
          copyField(k, other.input, input, other.summary, summary);
          fields[k] = { value: ov.slice(0, 120), source: osrc, state: isOfficial(osrc.kind) ? "confirmed" : "unverified", origins: [osrc.origin], alt: { value: cv.slice(0, 120), source: csrc } };
        }
        updated.push(k);
        continue;
      }
    }
    if (sameSource(csrc, osrc)) {
      // 同じ情報源（同じアカウント・ホスト）の情報は、新しい方が更新後の値。矛盾としない
      if (osrc.at > csrc.at) {
        copyField(k, other.input, input, other.summary, summary);
        fields[k] = { value: ov.slice(0, 120), source: osrc, state: isOfficial(osrc.kind) ? "confirmed" : "unverified", origins: [osrc.origin] };
      }
      updated.push(k);
      continue;
    }
    // 同じ出どころ（コピー）の値が違う場合も矛盾として記録する。優先順位が高い値を仮に残す
    let winner: "other" | "carrier" = SOURCE_RANK[osrc.kind] > SOURCE_RANK[csrc.kind] ? "other" : "carrier";
    // 応募締切が食い違い、公式情報で確定できない（優先順位が同じ）ときは、応募漏れを防ぐため早い方を暫定採用する（確定情報としては扱わない）。
    // 日付が2週間以上離れているときは別の抽選・別の意味の日付の可能性があるため、早い方への置き換えはしない（Stage 7A）
    let provisional: Conflict["provisional"];
    if (k === "applyDeadline" && SOURCE_RANK[osrc.kind] === SOURCE_RANK[csrc.kind]) {
      const dc = cv.slice(0, 10);
      const dop = ov.slice(0, 10);
      const gap = Math.abs(Date.parse(dc) - Date.parse(dop)) / 86_400_000;
      if (Number.isFinite(gap) && gap <= 14) {
        provisional = "earlier";
        winner = dop < dc ? "other" : "carrier";
      } else if (Number.isFinite(gap)) provisional = "far_apart";
    }
    if (winner === "other") {
      copyField(k, other.input, input, other.summary, summary);
      fields[k] = { value: ov.slice(0, 120), source: osrc, state: "conflict", origins: op?.origins ?? [osrc.origin], alt: { value: cv.slice(0, 120), source: csrc } };
    } else {
      fields[k] = { ...(cp as FieldProv), state: "conflict", alt: { value: ov.slice(0, 120), source: osrc } };
    }
    conflicts.push({ field: k, label: FIELD_LABEL[k], a: { value: cv.slice(0, 80), url: csrc.url }, b: { value: ov.slice(0, 80), url: osrc.url }, ...(provisional ? { provisional } : {}) });
  }
  // 情報源URLの統合（上限10件）
  input.sourceUrls = [...new Set([...(input.sourceUrls ?? []), ...(other.input.sourceUrls ?? [])])].slice(0, 10);
  return { input, summary, fields, conflicts, filled, updated };
}

/** 矛盾のある項目の一覧（表示用） */
export function conflictLabels(fields: FieldMap | undefined | null): string[] {
  if (!fields) return [];
  return FIELD_KEYS.filter((k) => fields[k]?.state === "conflict").map((k) => FIELD_LABEL[k]);
}

// ---------------------------------------------------------------- 情報源の分類
export interface SourceContext {
  /** 公式Xアカウントの対応づけ（利用者が登録）のアカウント名（小文字） */
  officialAccounts: Set<string>;
  /** 収集元に登録したまとめアカウント（小文字） */
  aggregatorAccounts: Set<string>;
  /** まとめサイトのホスト */
  listHosts: Set<string>;
}

export function classifySource(url: string, ctx: SourceContext): { kind: SourceKind; account?: string; postId?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: "unknown" };
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const x = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/.exec(u.pathname);
  if ((host === "x.com" || host === "twitter.com") && x) {
    const acc = x[1].toLowerCase();
    if (ctx.officialAccounts.has(acc)) return { kind: "official_x", account: acc, postId: x[2] };
    return { kind: ctx.aggregatorAccounts.has(acc) ? "aggregator_x" : "aggregator_x", account: acc, postId: x[2] };
  }
  if (ctx.listHosts.has(host)) return { kind: "list_site", account: host };
  if (host === "t.co") return { kind: "unknown", account: host };
  return { kind: "official_site", account: host };
}
