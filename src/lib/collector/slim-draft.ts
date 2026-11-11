/**
 * 自動収集画面へ渡す候補の草稿から、画面で使わない項目を除く（Stage 7R）。
 * 保存済みの草稿は1件あたり数KB（本文の抜粋・取得項目・再評価の記録など）で、一覧（最大600件）をそのままブラウザへ送ると転送・解析が重くなる。
 * 画面（CandidateView.draft）と編集フォームが参照する項目だけを残す。データベースの草稿は変更しない。
 */
const KEEP = ["update", "provisional", "secondary", "notices", "evidence", "flags", "summary", "modePending", "warnings", "ready", "verdict", "input", "queued"] as const;

export function slimDraft<T>(draft: T): T {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return draft;
  const src = draft as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEEP) if (k in src) out[k] = src[k];
  return out as T;
}
