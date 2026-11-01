import { Sparkles } from "lucide-react";
import { ANNOUNCE_TARGET_LABEL, REQUIREMENT_LABEL, announceLabels, visibleRequirementTags, type RequirementDetails } from "@/lib/lottery-taxonomy";
import { splitNotes } from "@/lib/notes";
import type { Lottery } from "@/types/domain";

const tagCls = "inline-flex items-center rounded-full border bg-input px-2 py-0.5 text-xs leading-tight";

/** 当落発表方法の表示。標準分類のラベルを並べ、補足（原文）は小さく添える。分類が無い既存データは原文をそのまま表示 */
export function AnnounceView({ lottery }: { lottery: Lottery }) {
  const methods = lottery.announcementMethods ?? [];
  const note = lottery.announcementMethod.trim();
  if (methods.length === 0) return note ? <>{note}</> : <span className="text-muted-foreground">—</span>;
  const target = lottery.announcementTarget ?? "unknown";
  return (
    <div className="space-y-0.5" data-testid="announce-view">
      <div className="flex flex-wrap items-center gap-1">
        {announceLabels(methods, target).map((l) => (
          <span key={l} className={tagCls} data-testid="announce-label">
            {l}
          </span>
        ))}
        {lottery.announcementInferred && (
          <span title="告知には明記がなく、サービスの標準ルールから推定した初期候補です。確認してください" className="inline-flex items-center gap-0.5 text-[11px] text-info" data-testid="announce-inferred">
            <Sparkles className="size-3" aria-hidden="true" />
            推定
          </span>
        )}
      </div>
      {target !== "unknown" && !methods.includes("winner_mail") && <p className="text-[11px] text-muted-foreground">通知対象: {ANNOUNCE_TARGET_LABEL[target]}</p>}
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function detailLines(d: RequirementDetails): string[] {
  const out: string[] = [];
  if (d.minAmountYen) out.push(`${d.minAmountYen.toLocaleString("ja-JP")}円以上の購入`);
  if (d.purchasePeriodFrom || d.purchasePeriodTo) out.push(`購入期間 ${d.purchasePeriodFrom ?? ""}〜${d.purchasePeriodTo ?? ""}`);
  if (d.memberRank) out.push(`会員ランク ${d.memberRank}`);
  if (d.minAge) out.push(`${d.minAge}歳以上`);
  if (d.residentArea) out.push(`居住地域 ${d.residentArea}`);
  if (d.maxStores) out.push(`応募可能 ${d.maxStores}店舗`);
  return out;
}

/** 応募条件の表示。タグ＋（複数のときだけ）結合方法＋具体的な数値。原文・補足は展開して確認する */
export function RequirementView({ lottery }: { lottery: Lottery }) {
  const all = lottery.requirementTags ?? [];
  // 一般的な本人確認（身分証・顔写真付き）は毎回あるため表示しない。データは保持する
  const tags = visibleRequirementTags(all);
  const text = lottery.conditionsText.trim();
  if (all.length === 0) return text ? <>{text}</> : <span className="text-muted-foreground">—</span>;
  const lines = detailLines(lottery.requirementDetails ?? {});
  if (tags.length === 0 && lines.length === 0 && !text) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-1" data-testid="requirement-view">
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((t) => (
          <span key={t} className={tagCls} data-testid="requirement-label">
            {REQUIREMENT_LABEL[t]}
          </span>
        ))}
        {tags.length >= 2 && <span className="text-[11px] text-muted-foreground">（{lottery.requirementLogic === "or" ? "いずれか" : "すべて必要"}）</span>}
      </div>
      {lines.length > 0 && <p className="text-[11px] text-muted-foreground">{lines.join(" ／ ")}</p>}
      {text && (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">補足・原文</summary>
          <p className="mt-0.5 whitespace-pre-wrap break-words">{text}</p>
        </details>
      )}
    </div>
  );
}

/** 備考。複数事項は箇条書き、1項目だけなら通常の文章 */
export function NotesView({ text }: { text: string }) {
  const items = splitNotes(text);
  if (items.length <= 1) return <span className="whitespace-pre-wrap">{text}</span>;
  return (
    <ul className="list-disc space-y-0.5 pl-4" data-testid="notes-list">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}
