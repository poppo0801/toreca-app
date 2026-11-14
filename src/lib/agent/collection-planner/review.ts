/**
 * 提出の独立した検証（Stage 9E・純関数）。AIの外側（固定ロジック）が、提出と取得・解析の事実を突き合わせ、
 * 追加調査で解決できそうな不足・食い違い・未確認の関連リンクを具体的に返す。AIは検証結果を書き換えられない。
 * 返した指摘を受けて追加調査をするか、不明のまま再提出するかは、AIが選ぶ（再調査は同じ予算・上限の中だけ）。
 */
import type { TraceEvent } from "@/lib/agent/core";
import type { AnalysisPreview, PageData, PlanOutput } from "@/lib/agent/collection-planner/types";

const ANNOUNCE_LINK = /抽選|応募|エントリー|受付|お知らせ|ご案内|予約販売/;
const KIND_LABEL: Record<string, string> = { lottery_announcement: "抽選の告知", announcement_index: "告知の一覧", lottery_explainer: "抽選の説明", past_lottery: "終了した抽選", general: "抽選の告知ではないページ" };
const norm = (u: string): string => u.trim().replace(/#.*$/, "");

export function previewsFromTrace(trace: TraceEvent[]): AnalysisPreview[] {
  const out: AnalysisPreview[] = [];
  for (const e of trace) if (e.t === "tool" && e.ok) {
    const d = (e.data ?? {}) as { preview?: AnalysisPreview };
    if (d.preview) out.push(d.preview);
  }
  return out;
}

export interface ReviewFeedback {
  text: string;
  meta: { issues: string[] };
}

export function buildReviewFeedback(i: {
  output: PlanOutput | undefined;
  pages: Map<string, PageData>;
  previews: AnalysisPreview[];
  remaining: { fetches: number };
  analysesLeft: number;
}): ReviewFeedback | null {
  const items: string[] = [];
  const issues: string[] = [];
  const fetched = new Set([...i.pages.keys()].map(norm));
  const unvisited = (p: PageData, n: number) =>
    p.links
      .filter((l) => ANNOUNCE_LINK.test(l.text) && /^https:\/\//.test(l.url) && !fetched.has(norm(l.url)))
      .slice(0, n);
  const canFollow = i.remaining.fetches > 0 && i.analysesLeft > 0;

  for (const pv of i.previews) {
    const page = i.pages.get(norm(pv.url));
    if (!page) continue;
    if (pv.pageKind === "announcement_index" && canFollow) {
      const ls = unvisited(page, 4);
      if (ls.length) {
        issues.push("index_unvisited");
        items.push(`「${pv.url}」は、告知の見出しを並べた一覧ページです（1件の抽選としては登録されません）。個別の告知へのリンクが未確認です: ${ls.map((l) => `${l.text.slice(0, 40)} ${l.url}`).join(" / ")}`);
      }
    } else if (pv.recognized && pv.missing.includes("応募締切") && canFollow) {
      const ls = unvisited(page, 3);
      if (ls.length) {
        issues.push("missing_deadline_unvisited");
        items.push(`「${pv.url}」は抽選の告知と確認できましたが、応募締切が不明です。未確認の関連リンク: ${ls.map((l) => `${l.text.slice(0, 40)} ${l.url}`).join(" / ")}`);
      }
    }
  }
  for (const f of i.output?.findings ?? []) {
    if (f.kind !== "lottery_info" || !f.url) continue;
    const pv = i.previews.find((p) => p.url === norm(f.url ?? ""));
    if (!pv) continue;
    if (f.pageKind && pv.pageKind && f.pageKind !== pv.pageKind) {
      issues.push("kind_disagree");
      items.push(`「${f.url}」: あなたはこのページを「${KIND_LABEL[f.pageKind] ?? f.pageKind}」としましたが、検証（ページの主題と応募の記載の確認）は「${KIND_LABEL[pv.pageKind] ?? pv.pageKind}」でした（${pv.pageKindReason ?? ""}）。本文を見直して、判断を訂正するか、根拠を示してください`);
    }
    const fixed = pv.recognized ? pv.disposition.kind : "not_lottery";
    if (f.action && f.action !== fixed && !(f.action === "investigate" && fixed === "investigate")) {
      issues.push("action_disagree");
      items.push(`「${f.url}」: あなたの判断は「${f.action}」ですが、登録済みの抽選との照合と解析の結果は「${fixed}」でした（${pv.disposition.reason}）。必要なら match_existing_lotteries で確認してください`);
    }
  }
  if (!items.length) return null;
  const text = `検証の結果（システムが取得・解析の事実と照合したものです。あなたの提出は変更していません）:\n${items.map((t) => `- ${t}`).join("\n")}\n\n追加で調べる場合は、必要なツールを呼び出してください（残り: 取得${i.remaining.fetches}回・解析${i.analysesLeft}回）。調べない場合・調べても分からない場合は、不明のまま、もう一度 submit_findings で提出してください。`;
  return { text, meta: { issues } };
}
