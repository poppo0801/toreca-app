"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { generateProposalsAction, reviewProposalAction } from "@/app/(app)/lotteries/candidates/proposal-actions";
import { Button } from "@/components/ui/button";
import { diffProposal, summarizeProposals } from "@/lib/judgment/xsource/proposal-summary";
import type { ProposalView } from "@/lib/server/proposals/store";

/**
 * 新AIの登録案（プレビュー）。候補の詳細の中に、折りたたみで表示する（Stage 10Z・開発専用。PROPOSAL_PREVIEW=on のローカル環境だけ）。
 * **「承認」は新方式の登録案へのレビュー記録で、抽選は登録されない**（lotteries・応募・購入・通知には書かない）。実際の登録は、従来どおり下の「確認・登録」で行う。
 * 一覧には出さない（詳細だけ）。未確認・根拠不足の項目も省略せず、「確認できていない」ことが分かる形で残す。
 */
const BASIS: Record<string, string> = { observed: "観察", inferred: "推論", unknown: "不明" };
const MODE: Record<string, string> = { mock: "モック（実AIではない）", replay: "再生", real: "実AI" };
const MODE_HINT: Record<string, string> = { real: "実AIが作成した登録案です（正しさは未検証。人が確認してください）" };
const URL_STATUS: Record<string, string> = { url_from_item: "項目自身のリンク", short_unexpanded: "短縮URL未展開", shared_only_unverified: "共通リンクのみ（未確認）", url_missing: "URLなし" };
const REVIEW: Record<string, string> = { hold: "保留", approve_with_edits: "修正して承認（レビュー記録）", reject: "却下" };
const DECISION: Record<string, string> = { register: "本登録案", tentative: "暫定", exclude: "除外案", none: "判断なし" };
const HELD: Record<string, string> = { exclude_without_evidence: "根拠（引用）のある観察が無いまま除外としている", exclude_without_page_evidence: "応募先のページを確認できないまま除外としている", register_unit_unresolved: "本登録案なのに応募単位が未確定", judge_failed: "AIの判断が得られなかった", page_text_loss: "ページの本文の取り出しに欠落の疑い" };
const heldLabel = (r: string): string => HELD[r] ?? (r.startsWith("quote_not_found") ? "引用が原文に見つからない（" + r.split(":")[1] + "）" : r.startsWith("scope_mismatch") ? "別の店舗・商品のページを根拠にしている" : r.startsWith("field_unknown_has_value") ? "不明のはずの項目に値がある" : r);
const KEY_FIELDS = ["store", "product", "deadline", "apply_unit"] as const;
const FIELD_LABEL: Record<string, string> = { store: "店舗", product: "商品", deadline: "締切", apply_unit: "応募単位" };
const UNIT_LABEL: Record<string, string> = { one_form_one: "1フォーム1応募", store_select: "店舗選択式", per_store: "店舗別に独立", per_product: "商品別", unknown: "不明" };

function SupportMark({ support, basis }: { support: string; basis: string }) {
  if (basis !== "observed" || support === "literal_in_quote" || support === "no_value") return null;
  return (
    <span className="ml-1 text-warn" data-testid="proposal-support-warn">
      {support === "not_found" ? "⚠値が根拠から確認できない" : support === "literal_in_text" ? "△引用には無く本文にある" : support === "near_match" ? "△言い換えの可能性（語が近い）" : support === "enum_value" ? "△選択肢の値（人が確認）" : "△書式を変換して一致"}
    </span>
  );
}

function ProposalCard({ p, onDone }: { p: ProposalView; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(KEY_FIELDS.map((k) => [k, k === "apply_unit" ? p.apply_unit : p.fields[k]?.value ?? ""])));
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const send = (decision: string, edits?: Record<string, string>) =>
    start(async () => {
      setErr("");
      const r = await reviewProposalAction({ proposalId: p.id, decision, edits, note });
      if (!r.ok) setErr(r.error);
      else {
        setEditing(false);
        onDone();
      }
    });
  const changed = Object.fromEntries(Object.entries(vals).filter(([k, v]) => v.trim() !== (k === "apply_unit" ? p.apply_unit : p.fields[k]?.value ?? "")));
  return (
    <li className="space-y-1.5 rounded-lg border bg-muted/30 p-2" data-testid="proposal-card" data-item={p.item_no}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-medium">{p.item_label || `項目${p.item_no}`}</span>
        <span className={"rounded border px-1 text-[10px] " + (p.decision === "exclude" ? "border-warn text-warn" : "")} data-testid="proposal-decision">{DECISION[p.decision] ?? p.decision}{!p.verified || p.held_reasons.length ? "・要確認" : ""}</span>
        <span className="rounded border px-1 text-[10px]" data-testid="proposal-mode">{MODE[p.mode] ?? p.mode}</span>
        <span className="rounded border px-1 text-[10px]">{URL_STATUS[p.url_status] ?? p.url_status}</span>
        {p.review && (
          <span className="rounded border border-info px-1 text-[10px] text-info" data-testid="proposal-review-state">
            {REVIEW[p.review.decision]}
            {p.reviewOutdated ? "（再評価で内容が変わりました。再確認してください）" : ""}
          </span>
        )}
      </div>
      <ul className="space-y-0.5" data-testid="proposal-fields">
        {KEY_FIELDS.map((k) => {
          const f = p.fields[k];
          const v = k === "apply_unit" ? UNIT_LABEL[p.apply_unit] : f?.value;
          const basis = k === "apply_unit" ? p.apply_unit_basis : f?.basis ?? "unknown";
          return (
            <li key={k}>
              <span className="font-medium">{FIELD_LABEL[k]}</span>: {v || "未確認"}
              <span className="text-muted-foreground"> [{BASIS[basis] ?? basis}]</span>
              {f && <SupportMark support={f.support} basis={f.basis} />}
              {p.review?.edits?.[k] !== undefined && <span className="ml-1 text-info" data-testid="proposal-edit">→ 人の修正: {k === "apply_unit" ? UNIT_LABEL[p.review.edits[k]] ?? p.review.edits[k] : p.review.edits[k]}</span>}
            </li>
          );
        })}
      </ul>
      {p.unknowns.length > 0 && (
        <p className="text-warn" data-testid="proposal-unknowns">
          未確認: {p.unknowns.map((u) => `${FIELD_LABEL[u.what] ?? u.what}（${u.why}）`).join("／")}
        </p>
      )}
      {p.held_reasons.length > 0 && (
        <p className="text-warn" data-testid="proposal-held">
          検証の指摘: {p.held_reasons.map(heldLabel).join("／")}
          {p.decision === "exclude" ? "（除外案は、人が確認するまで採用しない）" : ""}
        </p>
      )}
      {p.possibly_same.length > 0 && <p className="text-warn">同じ応募機会の可能性がある別の登録案が {p.possibly_same.length} 件あります（統合はしていません）</p>}
      {p.reviewOutdated && p.reviewedVersion && (
        <div className="rounded border border-warn p-1.5 text-warn" data-testid="proposal-diff">
          <p className="font-medium">再評価で変わった点（前回レビューは v{p.reviewedVersion.version}・現行は v{p.version}）</p>
          {(() => {
            const d = diffProposal(p.reviewedVersion, p);
            return d.length ? (
              <ul className="list-disc pl-4">
                {d.map((x) => (
                  <li key={x.field}>
                    {FIELD_LABEL[x.field] ?? x.field}: {x.field === "apply_unit" ? UNIT_LABEL[x.before] ?? x.before : x.before} → {x.field === "apply_unit" ? UNIT_LABEL[x.after] ?? x.after : x.after}
                  </li>
                ))}
              </ul>
            ) : (
              <p>主要な項目の値は同じです（根拠・未確認事項が変わった可能性があります）。</p>
            );
          })()}
        </div>
      )}
      {MODE_HINT[p.mode] && <p className="text-[10px] text-muted-foreground">{MODE_HINT[p.mode]}{p.model_id ? `（${p.model_id}）` : ""}</p>}
      <p className="text-[10px] text-muted-foreground">
        {p.pages.map((g) => g.host).join("・") || "ページ未取得"}／費用 {p.cost_jpy ?? 0}円／{p.stop_reason ?? "—"}
      </p>
      {p.review?.note && <p className="text-muted-foreground">メモ: {p.review.note}</p>}
      {editing ? (
        <div className="space-y-1.5" data-testid="proposal-edit-form">
          {KEY_FIELDS.map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <span className="w-14 shrink-0">{FIELD_LABEL[k]}</span>
              {k === "apply_unit" ? (
                <select value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} className="h-9 min-w-0 flex-1 rounded-md border bg-input px-2 text-xs" data-testid={`proposal-edit-${k}`}>
                  {Object.entries(UNIT_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} maxLength={200} className="h-9 min-w-0 flex-1 rounded-md border bg-input px-2 text-xs" data-testid={`proposal-edit-${k}`} />
              )}
            </label>
          ))}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="メモ（確認した根拠など）" className="h-9 w-full rounded-md border bg-input px-2 text-xs" data-testid="proposal-note" />
          <p className="text-[10px] text-muted-foreground">承認はレビューの記録です。抽選は登録されません。</p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={pending}>
              戻る
            </Button>
            <Button size="sm" onClick={() => send("approve_with_edits", changed)} disabled={pending} data-testid="proposal-approve">
              修正して承認
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" onClick={() => send("hold")} disabled={pending} data-testid="proposal-hold">
            保留
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={pending} data-testid="proposal-edit-open">
            修正して承認
          </Button>
          <Button size="sm" variant="outline" onClick={() => send("reject")} disabled={pending} data-testid="proposal-reject">
            却下
          </Button>
        </div>
      )}
      {err && (
        <p className="text-danger" role="alert">
          {err}
        </p>
      )}
    </li>
  );
}

export function ProposalPreview({ proposals, shadow }: { proposals: ProposalView[]; /** 本番シャドー: 読み取りとレビューの記録だけ（登録案の作成ボタンを出さない） */ shadow?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState("");
  const generate = () =>
    start(async () => {
      const r = await generateProposalsAction();
      setMsg(r.ok ? `作成 ${r.inserted}／変更なし ${r.unchanged}／新しい版 ${r.superseded}` : r.error);
      router.refresh();
    });
  return (
    <details className="rounded-lg border p-2" data-testid="proposal-preview" open={proposals.length > 0}>
      <summary className="cursor-pointer text-xs font-medium">新AIの登録案（プレビュー）{proposals.length > 0 ? `　${proposals.length}件` : ""}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-[11px] text-muted-foreground">{shadow ? "並行稼働の試験結果です（現行の候補とは独立）。承認は記録だけで、抽選は登録されません。" : "開発用のプレビューです。承認は記録だけで、抽選は登録されません。"}</p>
        {proposals.length === 0 ? (
          <p className="text-muted-foreground" data-testid="proposal-empty">
            まだ登録案がありません。
          </p>
        ) : (
          <ul className="space-y-2">
            {proposals.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={() => router.refresh()} />
            ))}
          </ul>
        )}
        {!shadow && (
        <div className="flex items-center justify-end gap-2">
          {msg && <span className="text-[11px] text-muted-foreground" data-testid="proposal-gen-msg">{msg}</span>}
          <Button size="sm" variant="outline" onClick={generate} disabled={busy} data-testid="proposal-generate">
            登録案を作る（モック・費用0）
          </Button>
        </div>
        )}
      </div>
    </details>
  );
}

/** 新AIの登録案の集計（候補一覧の上に1行）。レビュー・修正・費用・解決率。人の修正は「AIの値と食い違った記録」で、モデルの学習ではない */
export function ProposalSummaryLine({ proposals }: { proposals: Record<string, ProposalView[]> }) {
  const all = Object.values(proposals).flat();
  const s = summarizeProposals(all.map((p) => ({ candidate_id: p.candidate_id, mode: p.mode, cost_jpy: p.cost_jpy, review: p.review, reviewOutdated: p.reviewOutdated })));
  return (
    <p className="rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground" data-testid="proposal-summary">
      新AIの登録案（開発用）: {s.candidates}候補・{s.proposals}件／レビュー済 {s.reviewed}件（修正あり {s.withHumanEdits}・却下 {s.reject}・保留 {s.hold}）／解決率 {s.resolutionRate === null ? "—" : Math.round(s.resolutionRate * 100) + "%"}／費用 {s.costJpy}円
    </p>
  );
}
