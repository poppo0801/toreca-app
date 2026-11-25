/**
 * 応募単位の定義（版付き・純関数）。docs/APPLY_UNIT_DEFINITION.md が正本。
 *
 * 中心の問い: 「利用者が実際に、何回・どの範囲で応募できるか」。
 * ページ数・フォーム数・投稿単位は**証拠の一部（signals）**であり、それだけで「独立して応募できる」とは断定しない。
 * 既存の列挙（one_form_one / store_select / per_store / per_product …）は互換のために残し、ここでは「構造（entry）」と「制限（limit）」の2軸に分けて読む。
 * 確度: confirmed = 原文に構造と制限の明示がある／provisional = 一部の明示または列挙値のみ（暫定）／unknown = 判断できない。
 * 不確かなときは unknown・暫定にする。goldに合わせた後付けの解釈調整はしない（版を分けて人の承認を得る）。
 */
/** 既存の応募単位の列挙（登録案・gold・画面で共通の値。gold確認のコードに依存しないよう、ここで型だけ持つ） */
export type LegacyUnit = "one_form_one" | "store_select" | "per_store" | "per_product" | "per_round" | "multi_independent_per_submit" | "unknown";

export const APPLY_SCOPE_VERSION = "apply-scope-v1";

/** 応募の機会の構造 */
export type EntryStructure = "single_entry" | "per_store_independent" | "store_select_one_entry" | "per_product" | "per_round" | "multi_independent_per_submit" | "unknown";
/** 制限の対象者 */
export type LimitSubject = "person" | "account" | "household" | "unspecified" | "unknown";
/** 制限が及ぶ範囲（「お1人様1回」がどこまでを指すか） */
export type LimitScope = "this_entry" | "per_store" | "per_product" | "total" | "unknown";
export type ScopeConfidence = "confirmed" | "provisional" | "unknown";

export interface ApplyScope {
  version: typeof APPLY_SCOPE_VERSION;
  entry: EntryStructure;
  limit: { subject: LimitSubject; scope: LimitScope; count: number | null };
  /** 同じ人が複数の機会に応募できるか（制限の範囲から読める場合だけ。読めなければ unknown） */
  multiApply: "yes" | "no" | "unknown";
  confidence: ScopeConfidence;
  /** 証拠の一部。これだけでは独立応募と断定しない */
  signals: { pages: number | null; forms: number | null; posts: number | null };
  notes: string[];
}

const nf = (s: string): string => s.normalize("NFKC");

/** 既存の列挙 → 構造。列挙だけでは構造は暫定（provisional）であり、原文の明示があれば confirmed に上げる */
export function entryFromLegacy(u: LegacyUnit | null | undefined): EntryStructure {
  switch (u) {
    case "one_form_one": return "single_entry";
    case "store_select": return "store_select_one_entry";
    case "per_store": return "per_store_independent";
    case "per_product": return "per_product";
    case "per_round": return "per_round";
    case "multi_independent_per_submit": return "multi_independent_per_submit";
    default: return "unknown";
  }
}

/** 原文から制限（対象者・回数・範囲）を読む。範囲を示す語が無い「お1人様1回」は、範囲を unknown のままにする（この枠だけか全体かが決まらない） */
export function readLimit(texts: readonly string[]): ApplyScope["limit"] & { stated: boolean } {
  const t = nf(texts.join("\n"));
  const subject: LimitSubject = /(アカウント|ID|会員)(?:\s*)?(ごと|につき|あたり|1|１)/i.test(t) ? "account" : /(世帯|ご家族|同一住所)/.test(t) ? "household" : /(お?1人|一人|おひとり|ひとり|1名|お一人)/.test(t) ? "person" : /(重複応募|複数応募|二重応募)/.test(t) ? "unspecified" : "unknown";
  const cm = t.match(/(?:お?1人様?|一人様?|おひとり様?|1名様?|1アカウント|1ID|1会員|1世帯)\s*(?:あたり|につき)?\s*(\d+)\s*(回|口|点|セット|個)/) ?? t.match(/(\d+)\s*(回|口)\s*(?:まで|のみ|限り)/);
  const count = cm ? Number(cm[1]) : null;
  let scope: LimitScope = "unknown";
  if (/(各店|店舗ごと|店舗別|1店舗につき|店舗につき|店ごと)/.test(t)) scope = "per_store";
  else if (/(商品ごと|各商品|1商品につき|商品につき|品目ごと)/.test(t)) scope = "per_product";
  else if (/(全店舗|全店|店舗合計|合計|重複(した)?応募は(無効|できません|不可)|複数(店舗|のお店)?へ?の?(同時)?応募は(できません|不可|無効))/.test(t)) scope = "total";
  return { subject, scope, count, stated: subject !== "unknown" || count !== null || scope !== "unknown" };
}

export interface ScopeInput {
  /** AIまたはgoldの既存列挙（あれば） */
  legacyUnit?: LegacyUnit | null;
  /** 応募単位・制限の根拠として示された原文の引用（観察できたものだけ） */
  quotes?: readonly string[];
  signals?: Partial<ApplyScope["signals"]>;
}

/** 構造を読むための明示語（原文の引用に書かれているとき、構造を confirmed にできる） */
const STORE_SELECT_SAY = /(店舗を(お)?選(択|び)|受取店舗を(お)?選|お(好|選)みの店舗|店舗選択|プルダウン)/;
const PER_STORE_SAY = /(各店舗(ごと)?(に|で)?(別々|それぞれ)?(の)?(ご)?応募|店舗ごと(に|の)(ご)?応募|店舗別(の)?(ご)?応募|それぞれの店舗(に|で)(ご)?応募)/;
const PER_PRODUCT_SAY = /(商品ごと(に|の)(ご)?応募|商品別(の)?(ご)?応募|各商品(に|の)(ご)?応募)/;

export function assessApplyScope(i: ScopeInput): ApplyScope {
  const quotes = (i.quotes ?? []).filter((q) => q && q.trim());
  const t = nf(quotes.join("\n"));
  const legacy = entryFromLegacy(i.legacyUnit);
  const lim = readLimit(quotes);
  const notes: string[] = [];
  let entry: EntryStructure = legacy;
  let confirmedEntry = false;
  // 原文の明示があれば、構造をそこから読む。列挙値と食い違う場合は列挙値を信用せず unknown（暫定）にする
  const said: EntryStructure | null = STORE_SELECT_SAY.test(t) ? "store_select_one_entry" : PER_STORE_SAY.test(t) ? "per_store_independent" : PER_PRODUCT_SAY.test(t) ? "per_product" : null;
  if (said) {
    if (legacy === "unknown" || legacy === said) { entry = said; confirmedEntry = true; }
    else { entry = "unknown"; notes.push(`列挙値(${legacy})と原文の明示(${said})が食い違う`); }
  }
  const signals = { pages: i.signals?.pages ?? null, forms: i.signals?.forms ?? null, posts: i.signals?.posts ?? null };
  if (!confirmedEntry && entry !== "unknown") notes.push("構造は列挙値のみ（ページ数・フォーム数・投稿単位は証拠の一部で、独立応募の断定にならない）");
  // 同じ人が複数機会に応募できるか: 制限の範囲が読めるときだけ
  let multiApply: ApplyScope["multiApply"] = "unknown";
  if (lim.scope === "total") multiApply = "no";
  else if (lim.scope === "per_store" || lim.scope === "per_product") multiApply = "yes";
  if (lim.stated && lim.scope === "unknown") notes.push("制限の範囲（この枠だけか、全体か）が原文から決まらない");
  const confidence: ScopeConfidence = entry === "unknown" ? "unknown" : confirmedEntry && lim.stated ? "confirmed" : "provisional";
  return { version: APPLY_SCOPE_VERSION, entry, limit: { subject: lim.subject, scope: lim.scope, count: lim.count }, multiApply, confidence, signals, notes };
}

/**
 * 利用者が応募できる独立した機会の数（確定できる場合だけ）。店舗数が与えられ、構造が店舗別独立と確認できるときだけ数を返す。
 * 不確かなら certain=false（件数を断定しない）。ページ数・フォーム数だけからは決めない。
 */
export function independentEntryCount(s: ApplyScope, storeCount: number | null): { count: number | null; certain: boolean } {
  if (s.confidence === "unknown") return { count: null, certain: false };
  if (s.entry === "single_entry" || s.entry === "store_select_one_entry") return { count: 1, certain: s.confidence === "confirmed" };
  if (s.entry === "per_store_independent") return storeCount !== null ? { count: storeCount, certain: s.confidence === "confirmed" } : { count: null, certain: false };
  return { count: null, certain: false };
}

export type UnitAgreement = "agree" | "scope_ambiguous" | "disagree" | "unmeasured";
/**
 * AIの列挙とgoldの列挙の食い違いを、「明確な誤り」と「定義が決まらないための食い違い」に分ける（採点値は変えない。報告用の別観点）。
 * 食い違いが one_form_one ↔ per_store/store_select の間で、gold側の根拠が構造を明示していない（confirmed でない）なら scope_ambiguous。
 */
export function classifyUnitAgreement(a: { ai: string | null | undefined; gold: string | null | undefined; goldQuotes: readonly string[] }): UnitAgreement {
  if (!a.gold || !a.ai) return "unmeasured";
  if (a.ai === a.gold) return "agree";
  const pair = new Set([a.ai, a.gold]);
  const coarse = pair.has("one_form_one") && (pair.has("per_store") || pair.has("store_select"));
  if (!coarse) return "disagree";
  const g = assessApplyScope({ legacyUnit: a.gold as LegacyUnit, quotes: a.goldQuotes });
  return g.confidence === "confirmed" ? "disagree" : "scope_ambiguous";
}
