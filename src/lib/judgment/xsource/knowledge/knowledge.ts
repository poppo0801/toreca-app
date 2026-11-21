/**
 * 応募単位の参考知識ストア（Stage 10Q・純関数＋データファイル）。**固定ルールではなく、AIに渡す参考知識**。
 *  - データは `apply-unit-knowledge.json`（編集可能）。出典・適用対象（プラットフォーム/系列/抽選方式）・例外・観測日時・信頼度・反例・有効期限を持つ。
 *  - コードに「この系列ならこう」という絶対判定を埋め込まない。選択は適用対象と文脈の照合（系列名の表記揺れは既存の chainsMatch で吸収）だけ。
 *  - 一般化された傾向（tendency）と特定イベントの実例（event_example）を分ける。
 *  - **人の訂正（corrections）だけが事例を強める**。AIの未確認の判断を事例として追加・強化しない（addCorrection は人の名義を要求し、AI名義を拒否する）。
 *  - 期限切れの知識は選択しない（再確認の対象）。
 */
import { chainsMatch } from "../normalize";
import data from "./apply-unit-knowledge.json";

export type SuggestedUnit = "one_form_one" | "store_select" | "per_store" | "per_store_group" | "per_product" | "shared_all_stores" | "per_round" | "unknown";
export type SelectionTiming = "at_apply" | "after_win" | "unknown";

export interface KnowledgeEntry {
  id: string;
  kind: "tendency" | "event_example";
  source: string;
  appliesTo: { platformHosts: string[]; chainAliases: string[]; systems: string[] };
  statement: string;
  suggests: { unit: SuggestedUnit; selectionTiming: SelectionTiming };
  exceptions: string[];
  observedAt: string;
  confidence: "high" | "medium" | "low";
  counterexamples: string[];
  expiresAt: string;
  editable: boolean;
}
export interface KnowledgeCorrection {
  knowledgeId: string;
  reason: string;
  /** 人の名義（AI・自動処理の名義は不可） */
  by: string;
  at: string;
  /** 訂正の内容: 反例として追加 / 無効化 / 例外の追記 */
  action: "add_counterexample" | "invalidate" | "add_exception";
  detail: string;
}
export interface KnowledgeStore {
  entries: KnowledgeEntry[];
  corrections: KnowledgeCorrection[];
}

const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
export const loadKnowledge = (): KnowledgeStore => ({ entries: (data as unknown as { entries: KnowledgeEntry[] }).entries, corrections: ((data as unknown as { corrections?: KnowledgeCorrection[] }).corrections ?? []) });

export function validateKnowledge(store: KnowledgeStore): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const e of store.entries) {
    if (ids.has(e.id)) errs.push(`duplicate_id:${e.id}`);
    ids.add(e.id);
    if (!e.source || !e.observedAt || !e.expiresAt) errs.push(`missing_metadata:${e.id}`);
    if (!["tendency", "event_example"].includes(e.kind)) errs.push(`bad_kind:${e.id}`);
    for (const c of e.counterexamples) if (!store.entries.some((x) => x.id === c)) errs.push(`unknown_counterexample:${e.id}->${c}`);
  }
  for (const c of store.corrections) if (!ids.has(c.knowledgeId)) errs.push(`correction_for_unknown:${c.knowledgeId}`);
  return errs;
}

/** 人の訂正を追加する（純関数: 新しいストアを返す）。AI・自動処理の名義は拒否。理由が必須。AIの未確認の判断を事例にするAPIは存在しない */
export function addCorrection(store: KnowledgeStore, c: KnowledgeCorrection): { ok: true; store: KnowledgeStore } | { ok: false; reason: string } {
  if (!c.by.trim() || AI_NAME.test(c.by)) return { ok: false, reason: "reviewer_must_be_human" };
  if (!c.reason.trim()) return { ok: false, reason: "reason_required" };
  if (!store.entries.some((e) => e.id === c.knowledgeId)) return { ok: false, reason: "unknown_knowledge_id" };
  return { ok: true, store: { entries: store.entries, corrections: [...store.corrections, c] } };
}

/** 訂正を反映した有効な知識（無効化されたものは除く。例外・反例の追記を反映） */
export function effectiveEntries(store: KnowledgeStore, now: Date): KnowledgeEntry[] {
  const invalid = new Set(store.corrections.filter((c) => c.action === "invalidate").map((c) => c.knowledgeId));
  return store.entries
    .filter((e) => !invalid.has(e.id) && Date.parse(e.expiresAt) >= now.getTime())
    .map((e) => ({
      ...e,
      exceptions: [...e.exceptions, ...store.corrections.filter((c) => c.knowledgeId === e.id && c.action === "add_exception").map((c) => c.detail)],
      counterexamples: [...e.counterexamples, ...store.corrections.filter((c) => c.knowledgeId === e.id && c.action === "add_counterexample").map((c) => c.detail)],
    }));
}

export interface KnowledgeContext {
  chain: string | null;
  /** 応募先URLのホスト（分かるもの） */
  hosts: string[];
  /** 応募方式・システムの名前（分かるもの。例: livepocket） */
  systems?: string[];
}

/**
 * 今回の文脈に当てはまる知識の選択。適用対象（ホスト・系列の別名・システム）のいずれかが一致するもの＋適用対象が無い一般的な知識。
 * 系列の表記揺れは chainsMatch で吸収。**選択は参考知識の提示であって判定ではない**（AIが今回の根拠と突き合わせる）。
 */
export function selectKnowledge(store: KnowledgeStore, ctx: KnowledgeContext, now: Date): KnowledgeEntry[] {
  const hosts = ctx.hosts.map((h) => h.toLowerCase().replace(/^www\./, ""));
  return effectiveEntries(store, now).filter((e) => {
    const a = e.appliesTo;
    const general = !a.platformHosts.length && !a.chainAliases.length && !a.systems.length;
    if (general) return true;
    const byHost = a.platformHosts.some((p) => hosts.some((h) => h === p || h.endsWith(`.${p}`)));
    const byChain = !!ctx.chain && a.chainAliases.some((al) => chainsMatch(al, ctx.chain) === "same" || ctx.chain!.normalize("NFKC").includes(al.normalize("NFKC")));
    const bySystem = (ctx.systems ?? []).some((s) => a.systems.includes(s));
    return byHost || byChain || bySystem;
  });
}
