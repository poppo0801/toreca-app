/**
 * 応募単位の「判断観点（ヒント）」ストア（Stage 10R・純関数＋データファイル）。**ヒントは判定命令・強制重み・許可リストではない**。
 *  - 各ヒントは「結論の推奨」ではなく、観点（何を検討するか）・併せて見る別の可能性・適用の前提・反例・反証条件・区別するために確認すること・出典と確認状態・更新日を持つ。
 *  - 選択は、**今回観察された事実（タグ）・応募先ホスト・系列の別名・システム**との照合だけ。関連するものを少数（既定4件）だけ渡し、選んだ理由と、適用の前提が確認できたか／不明かを記録する。
 *    **前提が確認できないヒントを、既知の事実として扱わない**（status は met か unknown。not_met は判定しない＝反証は AI が今回の根拠で行う）。
 *  - AIはヒントを採用・反論・無視・再解釈してよく、ヒントと異なる結論や未想定の方式も認める。コードは結論を強制しない（ヒントと結論が違うだけで差し戻さない）。
 *  - 出典の区別: ユーザー提供の一般的経験則（user_provided）／人が確認した実例（human_confirmed）／独立した一次資料で裏付け（independent_source）／AIの未検証仮説（unverified）。
 *    **人の訂正（corrections）だけが蓄積される**（AI名義は拒否）。AIの未確認の判断を事例として追加・強化するAPIは無い。人の訂正も絶対ルール化しない（観点・例外・反例として渡すだけ）。
 */
import { chainsMatch } from "../normalize";
import data from "./apply-unit-knowledge.json";

export type SuggestedUnit = "one_form_one" | "store_select" | "per_store" | "per_store_group" | "per_product" | "shared_all_stores" | "per_round" | "other" | "unknown";
export type SelectionTiming = "at_apply" | "after_win" | "unknown";
export type Confirmation = "user_provided" | "human_confirmed" | "independent_source" | "unverified";

export interface HintEntry {
  id: string;
  kind: "tendency" | "event_example";
  provenance: { source: string; confirmation: Confirmation; aiGenerated: boolean };
  appliesTo: { platformHosts: string[]; chainAliases: string[]; systems: string[] };
  triggers: { tags: string[] };
  /** 検討する観点（結論ではない） */
  perspective: string;
  /** 併せて見る別の可能性 */
  considerAlso: string[];
  /** 適用の前提。tag が今回観察されていれば met、そうでなければ unknown（not_met とは判定しない） */
  preconditions: { id: string; text: string; tag: string }[];
  counterexamples: string[];
  /** 反証条件（これが確認できればこのヒントは当てはまらない） */
  falsifiers: string[];
  /** 区別するために確認すること */
  distinguishBy: string[];
  updatedAt: string;
  expiresAt: string;
  editable: boolean;
}
export interface KnowledgeCorrection {
  knowledgeId: string;
  reason: string;
  /** 人の名義（AI・自動処理の名義は不可） */
  by: string;
  at: string;
  action: "add_counterexample" | "invalidate" | "add_exception";
  detail: string;
}
export interface KnowledgeStore {
  entries: HintEntry[];
  corrections: KnowledgeCorrection[];
}
/** 旧名（10Q）との互換 */
export type KnowledgeEntry = HintEntry;

const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
export const loadKnowledge = (): KnowledgeStore => ({ entries: (data as unknown as { entries: HintEntry[] }).entries, corrections: ((data as unknown as { corrections?: KnowledgeCorrection[] }).corrections ?? []) });

export function validateKnowledge(store: KnowledgeStore): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const e of store.entries) {
    if (ids.has(e.id)) errs.push(`duplicate_id:${e.id}`);
    ids.add(e.id);
    if (!e.provenance?.source || !e.provenance.confirmation || !e.updatedAt || !e.expiresAt) errs.push(`missing_metadata:${e.id}`);
    if (!e.perspective) errs.push(`missing_perspective:${e.id}`);
    if (!["tendency", "event_example"].includes(e.kind)) errs.push(`bad_kind:${e.id}`);
    if ("suggests" in (e as object)) errs.push(`conclusion_field_not_allowed:${e.id}`); // 結論の推奨フィールドを持たない
    for (const c of e.counterexamples) if (!store.entries.some((x) => x.id === c)) errs.push(`unknown_counterexample:${e.id}->${c}`);
  }
  for (const c of store.corrections) if (!ids.has(c.knowledgeId)) errs.push(`correction_for_unknown:${c.knowledgeId}`);
  return errs;
}

/** 人の訂正を追加する（純関数）。AI・自動処理の名義は拒否。理由が必須。AIの未確認の判断を事例にするAPIは存在しない */
export function addCorrection(store: KnowledgeStore, c: KnowledgeCorrection): { ok: true; store: KnowledgeStore } | { ok: false; reason: string } {
  if (!c.by.trim() || AI_NAME.test(c.by)) return { ok: false, reason: "reviewer_must_be_human" };
  if (!c.reason.trim()) return { ok: false, reason: "reason_required" };
  if (!store.entries.some((e) => e.id === c.knowledgeId)) return { ok: false, reason: "unknown_knowledge_id" };
  return { ok: true, store: { entries: store.entries, corrections: [...store.corrections, c] } };
}

/** 訂正を反映した有効なヒント（無効化・期限切れは除く。反証条件・反例の追記を反映。人の訂正も観点・例外として渡すだけで絶対ルールにしない） */
export function effectiveEntries(store: KnowledgeStore, now: Date): HintEntry[] {
  const invalid = new Set(store.corrections.filter((c) => c.action === "invalidate").map((c) => c.knowledgeId));
  return store.entries
    .filter((e) => !invalid.has(e.id) && Date.parse(e.expiresAt) >= now.getTime())
    .map((e) => ({
      ...e,
      falsifiers: [...e.falsifiers, ...store.corrections.filter((c) => c.knowledgeId === e.id && c.action === "add_exception").map((c) => `（人の訂正）${c.detail}`)],
      counterexamples: [...e.counterexamples, ...store.corrections.filter((c) => c.knowledgeId === e.id && c.action === "add_counterexample").map((c) => c.detail)],
    }));
}

// ---------------------------------------------------------------- 今回観察された事実（タグ）: 結論ではなく、文面・構造の観察
const flat = (s: string): string => s.normalize("NFKC");
export interface ObservationInput {
  texts: string[];
  stores: string[];
  hosts: string[];
  /** 応募ページ等から観察できた店舗の選択肢の数（取得できた場合のみ） */
  storeOptionCount?: number;
  /** 応募先が店舗ごとに別である観察（取得できた場合のみ） */
  perStoreUrls?: boolean;
}
/** 文面と構造から、観察できた事実のタグを機械的に付ける（判断ではない。タグが無い＝観察できなかったであって、否定ではない） */
export function observeTags(o: ObservationInput): string[] {
  const t = o.texts.map(flat).join("\n");
  const tags = new Set<string>();
  if (/店頭受取|店舗受取|受取店舗|お?受け?取り店舗|店頭でのお渡し|店頭お渡し/.test(t)) tags.add("pickup_in_store");
  if (/他店舗|複数店舗|重複応募|同時応募|いずれか1店舗|1店舗のみ/.test(t)) tags.add("cross_store_phrase");
  if (/当選後|ご当選後/.test(t)) tags.add("after_win_phrase");
  if (/グループ[A-ZＡ-Ｚ]|[A-DＡ-Ｄ]グループ|[A-DＡ-Ｄ]組/.test(t)) tags.add("group_phrase");
  if (/店舗を選択|店舗選択|店舗をお選び|受取店舗をお選び/.test(t)) tags.add("store_select_phrase");
  if (/商品別|商品ごと|別フォーム|商品[A-ZＡ-Ｚ]の/.test(t)) tags.add("multi_product_phrase");
  if (/第[0-9０-９一二三四五]+回|回目|次回/.test(t)) tags.add("round_phrase");
  if (!o.stores.length) tags.add("store_unspecified");
  else tags.add("store_specific");
  if ((o.storeOptionCount ?? 0) >= 2) tags.add("store_options_visible");
  if (o.perStoreUrls) tags.add("store_specific");
  for (const h of o.hosts) tags.add(`host:${h.toLowerCase().replace(/^www\./, "")}`);
  return [...tags].sort();
}

export interface SelectedHint {
  entry: HintEntry;
  /** 選んだ理由（ホスト・系列・システム・観察タグ） */
  reasons: string[];
  /** 適用の前提ごとの状態。met=今回観察された／unknown=確認できていない（未確認を事実扱いしない） */
  preconditions: { id: string; text: string; status: "met" | "unknown" }[];
}
export interface KnowledgeContext {
  chain: string | null;
  hosts: string[];
  systems?: string[];
  tags: string[];
}

/**
 * 関連するヒントを少数だけ選ぶ（既定4件）。選択は**参考の提示**であって判定ではない:
 *  ・系列の別名（表記揺れは chainsMatch で吸収）・応募先ホスト・システムが一致するもの、または、観察タグがヒントのトリガーに一致するものだけ。無関係な一般知識は渡さない。
 *  ・系列/ホスト/システムの一致を優先し、次に観察タグの一致数が多いもの。
 */
export function selectHints(store: KnowledgeStore, ctx: KnowledgeContext, now: Date, max = 4): SelectedHint[] {
  const hosts = ctx.hosts.map((h) => h.toLowerCase().replace(/^www\./, ""));
  const tags = new Set(ctx.tags);
  const out: (SelectedHint & { rank: number })[] = [];
  for (const e of effectiveEntries(store, now)) {
    const a = e.appliesTo;
    const reasons: string[] = [];
    let rank = 0;
    if (a.platformHosts.some((p) => hosts.some((h) => h === p || h.endsWith(`.${p}`)))) {
      reasons.push("応募先のホストが適用対象");
      rank += 3;
    }
    if (ctx.chain && a.chainAliases.some((al) => chainsMatch(al, ctx.chain) === "same" || ctx.chain!.normalize("NFKC").includes(al.normalize("NFKC")))) {
      reasons.push("系列が適用対象");
      rank += 3;
    }
    if ((ctx.systems ?? []).some((s) => a.systems.includes(s))) {
      reasons.push("抽選システムが適用対象");
      rank += 2;
    }
    const hit = e.triggers.tags.filter((t) => tags.has(t));
    if (hit.length) {
      reasons.push(`観察された事実: ${hit.join(", ")}`);
      rank += hit.length;
    }
    if (!reasons.length) continue;
    // 適用対象が限定されていて、系列・ホスト・システムのいずれも一致しないもの（タグだけが一致）は、タグがトリガーに含まれる場合のみ
    const scoped = a.platformHosts.length || a.chainAliases.length || a.systems.length;
    if (scoped && rank === hit.length && !e.triggers.tags.length) continue;
    out.push({ entry: e, reasons, rank, preconditions: e.preconditions.map((p) => ({ id: p.id, text: p.text, status: tags.has(p.tag) ? ("met" as const) : ("unknown" as const) })) });
  }
  return out.sort((x, y) => y.rank - x.rank || (x.entry.id < y.entry.id ? -1 : 1)).slice(0, max).map((h) => ({ entry: h.entry, reasons: h.reasons, preconditions: h.preconditions }));
}
