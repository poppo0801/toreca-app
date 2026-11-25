/**
 * 新AIの「登録案」への変換（Stage 10Z・純関数）。調査ループ（runResearch）の結果を、保存・人のレビューのための1行（応募機会候補＝投稿ID＋項目番号）にする。
 *  - **意味判断は増やさない**: 項目の値・根拠の種類・応募単位はAIの出力をそのまま運ぶ。列挙の値に完全に一致しないものは unknown にするだけ（名前一致・系列別の固定ルールは足さない）。
 *  - 未取得・根拠不足の項目も、unknown として**消さずに保持**する（人のレビューに残す）。
 *  - 値の導出の確認（support）は、引用の実在（検証層）とは別: 値が引用・本文から導けるかを、機械的に分類する（literal／正規化して一致／本文にあるが引用に無い／見つからない）。**正しさの判定ではない**。
 *  - 同じ応募機会の可能性は「可能性」として示すだけで、統合しない（誤統合の防止）。人が確定した値・レビューはここでは扱わない（上書きしない）。
 */
import { createHash } from "node:crypto";
import type { ItemPlan, StoredXPost } from "./x-origin";
import { FULL_VIEW_CHARS, shownRanges, type Evidence, type ResearchResult } from "./research-loop";
import { canonUrl } from "./normalize";

/**
 * 最終の扱い（登録境界）。AIの判断（register/exclude）が検証を通っていないときは、暫定（tentative）として扱う。
 * 根拠が無効・欠落している断定で本登録・除外を通さない。tentative・none はそのまま。保存済みの古い行（AIの申告のまま保存されたもの）にも同じ規則を当てる。
 */
export function effectiveDecision(r: { decision: ProposalRecord["decision"]; verified: boolean }): ProposalRecord["decision"] {
  return (r.decision === "register" || r.decision === "exclude") && !r.verified ? "tentative" : r.decision;
}

export const PROPOSAL_PROMPT_VERSION = "10z-7";
export type ProposalMode = "mock" | "replay" | "real";
export type ApplyUnit = "one_form_one" | "store_select" | "per_store" | "per_product" | "unknown";
/** near_match: 言い換え・書式・括弧の違いを除くと、値の語が本文にほぼ含まれる（数字は完全一致が条件）。enum_value: 応募単位のような**列挙値**（語の一致では確認できない。人が確認する） */
export type SupportKind = "literal_in_quote" | "literal_in_text" | "normalized_match" | "near_match" | "enum_value" | "not_found" | "no_value";

export interface ProposalField {
  value: string | null;
  basis: "observed" | "inferred" | "unknown";
  quote: string | null;
  evidence: string | null;
  support: SupportKind;
}

export interface ProposalRecord {
  candidateId: string;
  proposalKey: string;
  inputHash: string;
  postId: string | null;
  itemNo: number;
  itemLabel: string;
  /** 項目の本文・見出しから作る識別子（人の修正を別の項目へ移さないための照合）。番号・URLの短縮形に依存しない */
  itemFingerprint: string;
  urlStatus: ItemPlan["status"];
  sourceUrls: string[];
  linkHosts: { host: string; origin: string }[];
  decision: "register" | "tentative" | "exclude" | "none";
  verified: boolean;
  heldReasons: string[];
  endReason: string;
  fields: Record<string, ProposalField>;
  applyUnit: ApplyUnit;
  applyUnitBasis: "observed" | "inferred" | "unknown";
  unknowns: { what: string; why: string }[];
  /** viaSearch: そのページのURLが、AIの検索結果に含まれていた（検索で見つけた候補を取得した）。URLが最初から与えられたものと区別する（B2の自律発見の観測用） */
  pages: { host: string; scope: string | null; slots: number; textLoss: boolean; viaSearch: boolean }[];
  possiblySame: string[];
  mode: ProposalMode;
  modelId: string | null;
  promptVersion: string;
  costJpy: number | null;
  turns: number;
  stopReason: string;
  fetchedAt: string | null;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const nf = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/**
 * 項目の識別子。項目番号は、再収集・本文の並び替えで別の項目を指すことがあるため、項目の本文（見出し＋原文。URL・空白・記号の揺れを除く）から作る。
 * 同じ見出しの下で本文まで同じ項目は区別できない（その場合は同じ識別子＝同じ内容の項目として扱う）。
 */
export function itemFingerprint(plan: Pick<ItemPlan, "groupLabel" | "itemText">): string {
  const body = `${plan.groupLabel}|${plan.itemText}`.normalize("NFKC").replace(/https?:\/\/\S+/g, "").replace(/[\s\u3000・、。,.\-ー_*＊※]+/g, "").toLowerCase();
  return sha(body).slice(0, 16);
}

/** 応募機会候補の安定した識別（候補ID・投稿ID・項目番号）。再評価・再取得でも変わらない */
export const proposalKey = (candidateId: string, postId: string | null, itemNo: number): string => sha(`${candidateId}|${postId ?? ""}|${itemNo}`).slice(0, 24);

/** 入力（項目の原文・リンクの出所・取得したページの内容）のハッシュ。同じなら再評価しても新しい版を作らない */
export function inputHash(plan: ItemPlan, evidence: readonly Evidence[], protectedValues?: Record<string, string>, modelId?: string | null): string {
  const pages = evidence.filter((e) => e.kind === "page").map((e) => e.contentHash).sort();
  // 人が確定した値（レビューの修正）も入力の一部: 修正が変わったら再評価の結果が変わりうるため、新しい版にする（古い版・レビューは残る）
  const prot = protectedValues ? Object.entries(protectedValues).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(";") : "";
  // プロンプト版も入力の一部: 版を上げた再評価は、同じ原文・同じページでも新しい版として残す（版別に比較でき、費用をかけた結果が「変更なし」で捨てられない）
  return sha(`${plan.seedText}|${(plan.notes ?? []).join("¦")}|${pages.join(",")}|${evidence.filter((e) => e.kind === "page").map((e) => e.notice ?? "").sort().join("¦")}|${prot}|${PROPOSAL_PROMPT_VERSION}${modelId ? `|${modelId}` : ""}`).slice(0, 16); // 判断モデルも入力の一部: モデルを変えた比較は、同じ原文・同じページでも別の版として残す
}

/** 値が引用・本文から導けるかの機械的な分類（正しさの判定ではない）。日付・数字は書式の違い（11/27・11月27日・2026年11月27日）を吸収して照合する */
export function valueSupport(value: string | null, quote: string | null, text: string): SupportKind {
  if (!value || !value.trim()) return "no_value";
  const v = nf(value);
  if (v.length >= 2 && quote && nf(quote).includes(v)) return "literal_in_quote";
  if (v.length >= 2 && nf(text).includes(v)) return "literal_in_text";
  const dv = dateParts(value);
  if (dv) {
    const hay = `${quote ?? ""}\n${text}`;
    for (const d of datesIn(hay)) if (d.m === dv.m && d.d === dv.d && (!dv.y || !d.y || dv.y === d.y)) return "normalized_match";
  }
  // 言い換え・括弧・空白の違いを除いた語の近さ（4文字連続の一致率が80%以上）。数字の並びは、すべて本文にそのまま含まれるときだけ（金額・日付の取り違えを近いとは言わない）
  const strip = (x: string): string => nf(x).replace(/[「」『』【】()（）・:：、,，.。]+/g, "");
  const vs = strip(value);
  const ts = strip(`${quote ?? ""}\n${text}`);
  const digits = vs.match(/\d+/g) ?? [];
  if (vs.length >= 8 && digits.every((d) => ts.includes(d))) {
    let hit = 0;
    let n = 0;
    for (let i = 0; i + 4 <= vs.length; i++) {
      n++;
      if (ts.includes(vs.slice(i, i + 4))) hit++;
    }
    if (n && hit / n >= 0.8) return "near_match";
  }
  return "not_found";
}
const dateParts = (s: string): { y: number | null; m: number; d: number } | null => {
  const t = s.normalize("NFKC");
  const a = /(?:(\d{4})[年/.\-])?(\d{1,2})[月/.\-](\d{1,2})日?/.exec(t);
  return a ? { y: a[1] ? Number(a[1]) : null, m: Number(a[2]), d: Number(a[3]) } : null;
};
const datesIn = (s: string): { y: number | null; m: number; d: number }[] => {
  const out: { y: number | null; m: number; d: number }[] = [];
  const re = /(?:(\d{4})[年/.\-])?(\d{1,2})[月/.\-](\d{1,2})日?/g;
  const t = s.normalize("NFKC");
  for (let m = re.exec(t); m; m = re.exec(t)) out.push({ y: m[1] ? Number(m[1]) : null, m: Number(m[2]), d: Number(m[3]) });
  return out;
};

const UNIT_TOKENS: Record<string, ApplyUnit> = { one_form_one: "one_form_one", store_select: "store_select", per_store: "per_store", store_independent: "per_store", per_product: "per_product", single: "one_form_one" };
/** AIが出した応募単位の項目（項目名は自由。apply_unit・応募単位・applicationUnit・unit）を、列挙に完全一致するときだけ採用する（推測しない） */
export function unitOf(fields: Record<string, ProposalField>): { unit: ApplyUnit; basis: "observed" | "inferred" | "unknown" } {
  const key = Object.keys(fields).find((k) => /apply_?unit|応募単位|applicationunit|^unit$/i.test(k));
  const f = key ? fields[key] : undefined;
  // 値は列挙の語（one_form_one 等）。AIが注釈を後ろに付けた出力（例: "one_form_one（お一人様1回まで）"）は、先頭の列挙の語だけを採用する（P2 で、この注釈つきの値が unknown に落ちて、AIの判断が失われた）。語の推測はしない（先頭が列挙の語でなければ unknown）
  const token = f?.value ? /^[a-z_]+/.exec(f.value.trim())?.[0] : undefined;
  const u = token ? UNIT_TOKENS[token] : undefined;
  return u && f ? { unit: u, basis: f.basis } : { unit: "unknown", basis: "unknown" };
}

const hostOfUrl = (u: string): string => {
  try {
    return canonUrl(u).host;
  } catch {
    return "";
  }
};

export function toProposalRecords(a: {
  candidateId: string;
  post: StoredXPost;
  run: { results: { plan: ItemPlan; result: ResearchResult }[] };
  mode: ProposalMode;
  modelId: string | null;
  fetchedAt: string | null;
  /** 人が確定した値（項目ごと）。入力のハッシュに含める */
  protectedFor?: (itemNo: number, plan: ItemPlan) => Record<string, string> | undefined;
  /** 以前の人の修正があるが、項目が変わった（識別子が一致しない）ため適用しなかった項目。未確認事項として残す */
  correctionSkipped?: (itemNo: number, plan: ItemPlan) => boolean;
}): ProposalRecord[] {
  const recs: ProposalRecord[] = a.run.results.map(({ plan, result }) => {
    const out = result.registration.output;
    const pageText = result.evidence.filter((e) => e.kind === "page").map((e) => e.text).join("\n") + "\n" + result.evidence.filter((e) => e.kind === "seed").map((e) => e.text).join("\n");
    const byId = new Map(result.evidence.map((e) => [e.id, e]));
    const fields: Record<string, ProposalField> = {};
    for (const [k, f] of Object.entries(out?.fields ?? {}).slice(0, 12)) {
      const ev = f.evidenceId ? byId.get(f.evidenceId) : undefined;
      const isUnitField = /apply_?unit|応募単位|applicationunit|^unit$/i.test(k);
      const unitToken = f.value ? /^[a-z_]+/.exec(f.value.trim())?.[0] : undefined;
      const support: SupportKind = isUnitField && f.value && f.basis !== "unknown" && unitToken && UNIT_TOKENS[unitToken] ? "enum_value" : valueSupport(f.value, f.quote ?? null, ev?.text ?? pageText);
      fields[k.slice(0, 40)] = { value: f.value, basis: f.basis, quote: f.quote ? f.quote.slice(0, 160) : null, evidence: f.evidenceId ?? null, support };
    }
    // 判断の理由（AIの記述。次の分析のために保存する。項目ではなく、予約キー _rationale として持つ。画面の項目には出さない）
    if (out?.rationale) fields._rationale = { value: out.rationale.slice(0, 300), basis: "inferred", quote: null, evidence: null, support: "no_value" };
    const { unit, basis } = unitOf(fields);
    const unknowns: ProposalRecord["unknowns"] = [];
    if (plan.status === "url_missing") unknowns.push({ what: "応募先URL", why: "この項目にURLが無い（応募単位は未確認）" });
    if (plan.status === "short_unexpanded") unknowns.push({ what: "応募先URL", why: "短縮URLの展開結果が無く追跡していない" });
    if (plan.status === "shared_only_unverified") unknowns.push({ what: "応募先URL", why: "親投稿共通のリンクだけで、この項目への対応が未確認" });
    for (const [k, f] of Object.entries(fields)) if (f.basis === "unknown") unknowns.push({ what: k, why: "AIが不明と判断（根拠なし）" });
    for (const h of result.registration.held?.reasons ?? []) unknowns.push({ what: "検証", why: h.slice(0, 80) });
    // 任意項目の検証失敗: その項目の主張は採用しない（不明として明示。ほかの根拠のある項目は残す）
    for (const w of result.registration.warnings ?? []) unknowns.push({ what: `任意項目の根拠が未確認: ${w.slice(w.indexOf(":") + 1)}`.slice(0, 40), why: w.slice(0, 80) });
    // AIの判断（本登録・除外）が検証を通らなかったときは、最終の扱いを暫定に下げた事実を残す（AIの判断は書き換えない）
    if (result.registration.decision !== result.registration.finalDecision && result.registration.decision !== "none") unknowns.push({ what: "AIの判断", why: `AIは${result.registration.decision}としたが、根拠の検証を通らないため暫定（tentative）として扱う`.slice(0, 80) });
    const cov: ProposalRecord["unknowns"] = [];
    if (a.correctionSkipped?.(plan.itemNo, plan)) cov.push({ what: "人の修正", why: "以前の人の修正は、項目が変わったため適用していない（再確認が必要）" });
    // 収集時の文脈（本文の切り詰め・画像の未確認）は、未確認事項として必ず残す
    for (const n of plan.notes ?? []) if (n.startsWith("この投稿の本文は") || n.startsWith("投稿に画像があるが")) cov.push({ what: n.startsWith("この投稿") ? "投稿の欠落" : "画像の内容", why: n.slice(0, 80) });
    for (const e of result.evidence) {
      if (e.kind !== "page") continue;
      if (e.notice) cov.push({ what: "ページの一部", why: e.notice.slice(0, 80) });
      if (e.text.length > FULL_VIEW_CHARS) {
        const shown = shownRanges(e).reduce((t, r) => t + (r.to - r.from), 0);
        if (shown < e.text.length) cov.push({ what: "ページの未確認範囲", why: `本文${e.text.length}字のうち${e.text.length - shown}字はAIに提示・参照されていない（記載が無いとは限らない）` });
      }
    }
    if (!out) unknowns.push({ what: "AIの判断", why: "判断が得られなかった（調査は保持）" });
    else if (out.outputNote === "fields_defaulted") unknowns.push({ what: "AIの判断", why: "項目の出力が省略された（主張なしとして扱った。判断の成功とは数えない）" });
    const searched = new Set(result.searches.map((s) => canonUrl(s.url).key));
    const pages = result.evidence.filter((e) => e.kind === "page").map((e) => ({ host: e.url ? hostOfUrl(e.url) : "", scope: e.scope ? `${e.scope.origin}/${e.scope.verdict}` : null, slots: e.structure?.slots.length ?? 0, textLoss: !!e.textLoss?.length, viaSearch: !!e.url && searched.has(canonUrl(e.url).key) }));
    return {
      candidateId: a.candidateId,
      proposalKey: proposalKey(a.candidateId, a.post.postId, plan.itemNo),
      inputHash: inputHash(plan, result.evidence, a.protectedFor?.(plan.itemNo, plan), a.modelId),
      postId: a.post.postId.slice(0, 40),
      itemNo: plan.itemNo,
      itemLabel: plan.groupLabel.slice(0, 120),
      itemFingerprint: itemFingerprint(plan),
      urlStatus: plan.status,
      sourceUrls: plan.scopedUrls.slice(0, 5),
      linkHosts: plan.links.slice(0, 12).map((l) => ({ host: hostOfUrl(l.url), origin: l.origin })),
      decision: result.registration.finalDecision,
      verified: result.registration.verified,
      heldReasons: (result.registration.held?.reasons ?? []).slice(0, 16),
      endReason: result.investigation.reason,
      fields,
      applyUnit: unit,
      applyUnitBasis: basis,
      unknowns: [...cov, ...unknowns].slice(0, 12), // 切断・未確認範囲・人の修正の未適用は、他より先に残す（情報なしと区別する）
      pages: pages.slice(0, 8),
      possiblySame: [],
      mode: a.mode,
      modelId: a.modelId,
      promptVersion: PROPOSAL_PROMPT_VERSION,
      costJpy: result.budget.costJpy,
      turns: result.investigation.turns,
      // 停止理由＋検索の提示/実行（P2: 検索が提示されなかった事実を残す）。例: unreachable|searched:1／sufficient|search_not_offered
      stopReason: `${result.investigation.reason}|${result.searchOffered ? `searched:${result.searches.length ? new Set(result.searches.map((s) => s.query)).size : 0}` : "search_not_offered"}${(result.quoteAudit ?? []).length > 1 ? `|rev:${(result.quoteAudit ?? []).length - 1}` : ""}`.slice(0, 60), // rev:N = 検証に通らず訂正を求めた回数（自己修正の成功率は rev:N かつ verified で測る）
      fetchedAt: a.fetchedAt,
    };
  });
  return markPossiblySame(recs);
}

/** 同じ店舗・商品の値を持つ別の登録案を「同じ応募機会の可能性」として示す（統合はしない）。値が空・unknown のものは対象にしない */
export function markPossiblySame(recs: ProposalRecord[]): ProposalRecord[] {
  const sig = (r: ProposalRecord): string | null => {
    const store = Object.entries(r.fields).find(([k]) => /store|店舗/i.test(k))?.[1];
    const product = Object.entries(r.fields).find(([k]) => /product|商品/i.test(k))?.[1];
    if (!store?.value || !product?.value || store.basis === "unknown" || product.basis === "unknown") return null;
    return `${nf(store.value)}|${nf(product.value)}`;
  };
  const groups = new Map<string, string[]>();
  for (const r of recs) {
    const s = sig(r);
    if (s) groups.set(s, [...(groups.get(s) ?? []), r.proposalKey]);
  }
  return recs.map((r) => {
    const s = sig(r);
    const g = s ? groups.get(s) ?? [] : [];
    return { ...r, possiblySame: g.filter((k) => k !== r.proposalKey).slice(0, 10) };
  });
}

/**
 * 登録案の集計（人が確認する前の機械的な指標。**正答率ではない**）。引用の実在（検証）と、値が引用・本文から導けるか（support）を**別に**数える。
 * 正解との一致（誤統合・誤分割・未発見・過剰保留・根拠なし確定）は、独立 gold がある事例だけ `scoreAgainstGold` で別に採点する。
 */
export function proposalMetrics(recs: ProposalRecord[]): {
  proposals: number;
  quoteVerified: number;
  quoteNotVerified: number;
  observedFields: number;
  support: Record<SupportKind, number>;
  unknownFields: number;
  noUrl: number;
  withUnknowns: number;
  decisions: Record<string, number>;
} {
  const support: Record<SupportKind, number> = { literal_in_quote: 0, literal_in_text: 0, normalized_match: 0, near_match: 0, enum_value: 0, not_found: 0, no_value: 0 };
  const decisions: Record<string, number> = {};
  let observed = 0;
  let unknown = 0;
  for (const r of recs) {
    decisions[r.decision] = (decisions[r.decision] ?? 0) + 1;
    for (const f of Object.values(r.fields)) {
      if (f.basis === "observed") {
        observed++;
        support[f.support]++;
      } else if (f.basis === "unknown") unknown++;
    }
  }
  return { proposals: recs.length, quoteVerified: recs.filter((r) => r.verified).length, quoteNotVerified: recs.filter((r) => !r.verified).length, observedFields: observed, support, unknownFields: unknown, noUrl: recs.filter((r) => r.urlStatus === "url_missing").length, withUnknowns: recs.filter((r) => r.unknowns.length > 0).length, decisions };
}
