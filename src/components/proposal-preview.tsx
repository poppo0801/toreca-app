"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { generateProposalsAction, missedOpportunityAction, truthProposalAction } from "@/app/(app)/lotteries/candidates/proposal-actions";
import { Button } from "@/components/ui/button";
import { ABSENCE_LABELS, DATE_FIELDS, FIELD_LABELS, LOTTERY_FIELDS } from "@/lib/judgment/xsource/lottery-fields";
import { diffProposal, summarizeProposals } from "@/lib/judgment/xsource/proposal-summary";
import type { ProposalView } from "@/lib/server/proposals/store";

/**
 * 新AIの登録案（プレビュー）。候補の詳細の中に、折りたたみで表示する（Stage 10Z・開発専用。PROPOSAL_PREVIEW=on のローカル環境だけ）。
 * **「承認」は新方式の登録案へのレビュー記録で、抽選は登録されない**（lotteries・応募・購入・通知には書かない）。実際の登録は、従来どおり下の「確認・登録」で行う。
 * 一覧には出さない（詳細だけ）。未確認・根拠不足の項目も省略せず、「確認できていない」ことが分かる形で残す。
 * INTENSIVE_EVALUATION: 抽選管理の全項目（応募開始・発表・購入・受取など）を表示し、根拠（引用・ページの版・判断の段）は折りたたみで確認できる。正解の修正は、直す項目だけを選んで入力する。
 */
const BASIS: Record<string, string> = { observed: "観察", inferred: "推論", unknown: "不明" };
const MODE: Record<string, string> = { mock: "モック（実AIではない）", replay: "再生", real: "実AI" };
const MODE_HINT: Record<string, string> = { real: "実AIが作成した登録案です（正しさは未検証。人が確認してください）" };
const URL_STATUS: Record<string, string> = { url_from_item: "項目自身のリンク", short_unexpanded: "短縮URL未展開", shared_only_unverified: "共通リンクのみ（未確認）", url_missing: "URLなし" };
const REVIEW: Record<string, string> = { hold: "保留", approve_with_edits: "修正して承認（レビュー記録）", reject: "却下" };
const DECISION: Record<string, string> = { register: "本登録案", tentative: "暫定", exclude: "除外案", none: "判断なし" };
const HELD: Record<string, string> = { exclude_without_evidence: "根拠（引用）のある観察が無いまま除外としている", exclude_without_page_evidence: "応募先のページを確認できないまま除外としている", register_unit_unresolved: "本登録案なのに応募単位が未確定", judge_failed: "AIの判断が得られなかった", page_text_loss: "ページの本文の取り出しに欠落の疑い", model_disagreement: "判断のモデル間で結論が食い違った" };
const heldLabel = (r: string): string => HELD[r] ?? (r.startsWith("quote_not_found") ? "引用が原文に見つからない（" + r.split(":")[1] + "）" : r.startsWith("scope_mismatch") ? "別の店舗・商品のページを根拠にしている" : r.startsWith("field_unknown_has_value") ? "不明のはずの項目に値がある" : r);
/** 一覧の行に常に出す項目（値が無くても「未確認」と出す）。それ以外は値があるときだけ出し、無いものは1行にまとめる */
const KEY_FIELDS = ["store", "product", "deadline", "apply_unit"] as const;
const TRUTH: Record<string, string> = { correct: "正しい（変更なし）", corrected: "正解を修正", unknown_later: "後で確認" };
const TRUTH_DECISION: Record<string, string> = { register: "登録", exclude: "除外", hold: "保留" };
const OPPORTUNITY: Record<string, string> = { exists: "ある", absent: "無い", unknown: "不明" };
const USER_FIT: Record<string, string> = { fit: "適合", unfit: "対象外", unknown: "不明" };
const OPP_COUNT: Record<string, string> = { ok: "数は正しい", split: "分けるべき（誤統合）", merge: "まとめるべき（誤分割）", missing: "機会が足りない" };
const ROW_STATUS: Record<string, string> = { value: "正しい値", none: "記載なし", unknown: "不明" };
function Pick({ label, value, set, options, testid }: { label: string; value: string; set: (v: string) => void; options: Record<string, string>; testid: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5 text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)} className="h-9 min-w-0 rounded-md border bg-input px-1 text-xs" data-testid={testid}>
        <option value="">（変更なし）</option>
        {Object.entries(options).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
const FIELD_LABEL: Record<string, string> = { ...FIELD_LABELS, per_person_limit: "口数" };
const UNIT_LABEL: Record<string, string> = { one_form_one: "1フォーム1応募", store_select: "店舗選択式", per_store: "店舗別に独立", per_product: "商品別", unknown: "不明" };
const RECV_LABEL: Record<string, string> = { store: "店頭", shipping: "発送", either: "店頭か発送" };
const showValue = (k: string, v: string | null | undefined): string => (!v ? "" : k === "apply_unit" ? UNIT_LABEL[v] ?? v : k === "receive_method" ? RECV_LABEL[v] ?? v : v);
const truthFieldLabel = (k: string): string => (k.endsWith("__none") ? `${FIELD_LABEL[k.slice(0, -6)] ?? k.slice(0, -6)}（記載なし）` : FIELD_LABEL[k] ?? k);

function SupportMark({ support, basis }: { support: string; basis: string }) {
  if (basis !== "observed" || support === "literal_in_quote" || support === "no_value") return null;
  return (
    <span className="ml-1 text-warn" data-testid="proposal-support-warn">
      {support === "not_found" ? "⚠値が根拠から確認できない" : support === "literal_in_text" ? "△引用には無く本文にある" : support === "near_match" ? "△言い換えの可能性（語が近い）" : support === "enum_value" ? "△選択肢の値（人が確認）" : "△書式を変換して一致"}
    </span>
  );
}

/** 根拠（折りたたみ）: 項目ごとの引用・証拠、根拠にしたページ（ホスト・版）、判断の段（モデル・理由・採用）、AIの判断理由 */
function Evidence({ p }: { p: ProposalView }) {
  const quoted = Object.entries(p.fields).filter(([k, f]) => !k.startsWith("_") && f.quote);
  const trail = p.judge_trail ?? [];
  return (
    <details className="text-[11px]" data-testid="proposal-evidence">
      <summary className="cursor-pointer text-muted-foreground">根拠を見る（引用・ページ・判断の段）</summary>
      <div className="mt-1 space-y-1">
        {quoted.length > 0 && (
          <ul className="space-y-0.5">
            {quoted.map(([k, f]) => (
              <li key={k} className="break-words">
                <span className="font-medium">{FIELD_LABEL[k] ?? k}</span>
                <span className="text-muted-foreground">［{f.evidence ?? "—"}・{BASIS[f.basis] ?? f.basis}］</span>「{f.quote}」
              </li>
            ))}
          </ul>
        )}
        <p className="break-words text-muted-foreground">
          ページ:{" "}
          {p.pages.length === 0
            ? "未取得"
            : p.pages.map((g, i) => {
                const label = `${g.host}${g.viaSearch ? "（検索で発見）" : ""}${g.hash ? `#${g.hash.slice(0, 6)}` : ""}${g.at && Number.isFinite(Date.parse(g.at)) ? `・取得 ${new Date(Date.parse(g.at) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ")}` : ""}`; // 取得時刻は日本時間
                return (
                  <span key={i}>
                    {i > 0 && "・"}
                    {g.url && /^https?:\/\//.test(g.url) ? (
                      <a href={g.url} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                  </span>
                );
              })}
          ／取得元: {URL_STATUS[p.url_status] ?? p.url_status}
        </p>
        {trail.length > 0 && (
          <p className="break-words text-muted-foreground" data-testid="proposal-trail">
            判断の段: {trail.map((s) => `${s.stage === "primary" ? "既定" : "上位"}（${(s.model ?? "").replace(/^claude-/, "") || "—"}${s.reason ? "・" + s.reason : ""}）→${DECISION[s.decision] ?? s.decision}${s.verified ? "・検証済" : "・未検証"}${s.adopted === false ? "・不採用" : s.adopted ? "・採用" : ""}`).join(" ／ ")}
          </p>
        )}
        {p.fields._rationale?.value && <p className="break-words text-muted-foreground">AIの理由: {p.fields._rationale.value}</p>}
        <p className="text-muted-foreground">判断の時点: {p.judged_at?.slice(0, 16).replace("T", " ")}／費用 {p.cost_jpy ?? 0}円／{p.stop_reason ?? "—"}</p>
      </div>
    </details>
  );
}

type Row = { key: string; value: string; status: "value" | "none" | "unknown" };
/** 正解の修正: 直す項目だけを選んで行を足す（正しい項目は再入力しない）。日付の項目は日付と時刻の入力欄 */
function TruthRow({ r, onChange, onRemove, current }: { r: Row; onChange: (r: Row) => void; onRemove: () => void; current: string }) {
  const def = LOTTERY_FIELDS.find((f) => f.key === r.key);
  const [d, t] = r.value.split(" ");
  return (
    <div className="flex flex-wrap items-center gap-1 rounded border p-1" data-testid={`truth-row-${r.key}`}>
      <span className="w-16 shrink-0 text-[11px] font-medium">{FIELD_LABEL[r.key] ?? r.key}</span>
      <select value={r.status} onChange={(e) => onChange({ ...r, status: e.target.value as Row["status"] })} className="h-9 rounded-md border bg-input px-1 text-xs" data-testid={`truth-status-${r.key}`}>
        {Object.entries(ROW_STATUS).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {r.status === "value" &&
        (def?.kind === "enum" ? (
          <select value={r.value} onChange={(e) => onChange({ ...r, value: e.target.value })} className="h-9 min-w-0 flex-1 rounded-md border bg-input px-1 text-xs" data-testid={`truth-edit-${r.key}`}>
            <option value="">（選択）</option>
            {(def.values ?? []).map((v) => (
              <option key={v} value={v}>
                {showValue(r.key, v)}
              </option>
            ))}
          </select>
        ) : DATE_FIELDS.has(r.key) ? (
          <span className="order-last flex w-full min-w-0 gap-1">
            <input type="date" aria-label={`${FIELD_LABEL[r.key]}の日付`} value={d ?? ""} onChange={(e) => onChange({ ...r, value: [e.target.value, t].filter(Boolean).join(" ") })} className="h-9 min-w-0 flex-1 rounded-md border bg-input px-1 text-xs" data-testid={`truth-edit-${r.key}`} />
            <input type="time" aria-label={`${FIELD_LABEL[r.key]}の時刻（任意）`} value={t ?? ""} onChange={(e) => onChange({ ...r, value: [d, e.target.value].filter(Boolean).join(" ") })} className="h-9 w-24 rounded-md border bg-input px-1 text-xs" />
          </span>
        ) : (
          <input value={r.value} onChange={(e) => onChange({ ...r, value: e.target.value })} maxLength={200} placeholder={current || "正しい値"} className="h-9 min-w-0 flex-1 rounded-md border bg-input px-2 text-xs" data-testid={`truth-edit-${r.key}`} />
        ))}
      <button type="button" onClick={onRemove} className="px-1 text-[11px] text-muted-foreground" aria-label={`${FIELD_LABEL[r.key]}の修正をやめる`}>
        ✕
      </button>
    </div>
  );
}

function ProposalCard({ p, onDone }: { p: ProposalView; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const [td, setTd] = useState("");
  const [opp, setOpp] = useState("");
  const [fit, setFit] = useState("");
  const [count, setCount] = useState("");
  const cur = (k: string): string => (k === "apply_unit" ? p.apply_unit : p.fields[k]?.value ?? "");
  const sendTruth = (verdict: "correct" | "corrected" | "unknown_later") =>
    start(async () => {
      setErr("");
      const edits: Record<string, string> = Object.fromEntries(rows.filter((r) => r.status === "value" && r.value.trim() && r.value.trim() !== cur(r.key)).map((r) => [r.key, r.value.trim()]));
      if (count) edits._opportunities = count;
      const r = await truthProposalAction({ proposalId: p.id, verdict, ...(verdict === "corrected" ? { truthDecision: td, opportunity: opp, userFit: fit, edits, unknownFields: rows.filter((x) => x.status === "unknown").map((x) => x.key), notStatedFields: rows.filter((x) => x.status === "none").map((x) => x.key) } : {}), note });
      if (!r.ok) setErr(r.error);
      else {
        setEditing(false);
        setRows([]);
        onDone();
      }
    });
  const extra = LOTTERY_FIELDS.filter((f) => !(KEY_FIELDS as readonly string[]).includes(f.key));
  const shown = extra.filter((f) => p.fields[f.key]?.value);
  const missing = extra.filter((f) => !p.fields[f.key]?.value);
  const askHuman = p.fields._ask_human?.value;
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
      {askHuman && (
        <p className="rounded border border-info px-1.5 py-1 text-[11px] text-info" data-testid="proposal-ask-human">
          確認のお願い: {askHuman}
        </p>
      )}
      <ul className="space-y-0.5" data-testid="proposal-fields">
        {[...KEY_FIELDS.map((k) => ({ key: k as string })), ...shown].map(({ key: k }) => {
          const f = p.fields[k];
          const v = k === "apply_unit" ? UNIT_LABEL[p.apply_unit] : showValue(k, f?.value);
          const basis = k === "apply_unit" ? p.apply_unit_basis : f?.basis ?? "unknown";
          return (
            <li key={k}>
              <span className="font-medium">{FIELD_LABEL[k] ?? k}</span>: {v || "未確認"}
              <span className="text-muted-foreground"> [{BASIS[basis] ?? basis}]</span>
              {f && <SupportMark support={f.support} basis={f.basis} />}
              {p.review?.edits?.[k] !== undefined && <span className="ml-1 text-info" data-testid="proposal-edit">→ 人の修正: {showValue(k, p.review.edits[k])}</span>}
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="proposal-missing">
          {(["unreadable", "not_stated", "not_announced", "anytime", ""] as const)
            .map((st) => [st, missing.filter((f) => ((p.fields[f.key] as { absence?: string } | undefined)?.absence ?? "") === st)] as const)
            .filter(([, fs]) => fs.length)
            .map(([st, fs]) => `${st ? ABSENCE_LABELS[st] : "未取得"}: ${fs.map((f) => f.label).join("・")}`)
            .join("／")}
        </p>
      )}
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
                    {FIELD_LABEL[x.field] ?? x.field}: {showValue(x.field, x.before)} → {showValue(x.field, x.after)}
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
      <Evidence p={p} />
      {p.review?.note && <p className="text-muted-foreground">メモ: {p.review.note}</p>}
      {p.truth && (
        <p className="text-[11px] text-info" data-testid="proposal-truth-state">
          正解の記録: {TRUTH[p.truth.verdict]}
          {p.truth.truth_decision ? `（${TRUTH_DECISION[p.truth.truth_decision]}）` : ""}
          {Object.keys(p.truth.edits ?? {}).filter((k) => k !== "_opportunities").length ? ` 修正: ${Object.entries(p.truth.edits).filter(([k]) => k !== "_opportunities").map(([k, v]) => `${FIELD_LABEL[k] ?? k}=${showValue(k, v)}`).join("・")}` : ""}
          {p.truth.edits?._opportunities ? ` 機会: ${OPP_COUNT[p.truth.edits._opportunities] ?? p.truth.edits._opportunities}` : ""}
          {p.truth.unknown_fields?.length ? ` 不明・記載なし: ${p.truth.unknown_fields.map(truthFieldLabel).join("・")}` : ""}
          {p.truthOutdated ? "（再評価で版が変わりました。再確認してください）" : ""}
        </p>
      )}
      {editing ? (
        <div className="space-y-1.5" data-testid="proposal-truth-form">
          <p className="text-[11px] text-muted-foreground">直す点だけ入力してください（入力しない項目は「未確認」のまま残ります）。</p>
          <div className="grid grid-cols-2 gap-1.5">
            <Pick label="正しい判断" value={td} set={setTd} options={TRUTH_DECISION} testid="truth-decision" />
            <Pick label="応募機会" value={opp} set={setOpp} options={OPPORTUNITY} testid="truth-opportunity" />
            <Pick label="利用者に" value={fit} set={setFit} options={USER_FIT} testid="truth-fit" />
            <Pick label="機会の数" value={count} set={setCount} options={OPP_COUNT} testid="truth-count" />
          </div>
          {rows.map((r, i) => (
            <TruthRow key={r.key} r={r} current={showValue(r.key, cur(r.key))} onChange={(x) => setRows(rows.map((y, j) => (j === i ? x : y)))} onRemove={() => setRows(rows.filter((_, j) => j !== i))} />
          ))}
          <select
            value=""
            onChange={(e) => e.target.value && setRows([...rows, { key: e.target.value, value: "", status: "value" }])}
            className="h-9 w-full rounded-md border bg-input px-1 text-xs"
            data-testid="truth-add-field"
            aria-label="直す項目を追加"
          >
            <option value="">＋直す項目を追加</option>
            {LOTTERY_FIELDS.filter((f) => !rows.some((r) => r.key === f.key)).map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="補足（任意。確認した根拠など）" className="h-9 w-full rounded-md border bg-input px-2 text-xs" data-testid="truth-note" />
          <p className="text-[10px] text-muted-foreground">記録だけです。抽選の登録・削除・通知は行いません。</p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={pending}>
              戻る
            </Button>
            <Button size="sm" onClick={() => sendTruth("corrected")} disabled={pending} data-testid="truth-save">
              正解を保存
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" onClick={() => sendTruth("correct")} disabled={pending} data-testid="truth-correct">
            正しい
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={pending} data-testid="truth-edit-open">
            正解を修正
          </Button>
          <Button size="sm" variant="outline" onClick={() => sendTruth("unknown_later")} disabled={pending} data-testid="truth-later">
            後で確認
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

export function ProposalPreview({ proposals, shadow, candidateId }: { proposals: ProposalView[]; /** 本番シャドー: 読み取りとレビューの記録だけ（登録案の作成ボタンを出さない） */ shadow?: boolean; /** 取りこぼしの記録先の候補 */ candidateId?: string }) {
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
        {candidateId && <MissedForm candidateId={candidateId} onDone={() => router.refresh()} />}
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

/** 登録案に無い応募機会（取りこぼし）の記録。現行が見つけた候補に対する比較で、AI独自の発見ではない。記録だけ（抽選は登録しない） */
function MissedForm({ candidateId, onDone }: { candidateId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <div className="flex justify-end">
        <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => setOpen(true)} data-testid="missed-open">
          登録案に無い応募機会を記録
        </button>
      </div>
    );
  return (
    <div className="space-y-1.5 rounded border border-dashed p-2" data-testid="missed-form">
      <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="例: 2店舗目（〇〇店）の受付が登録案に無い" className="w-full rounded-md border bg-input px-2 py-1 text-xs" data-testid="missed-note" />
      <div className="flex items-center justify-end gap-1.5">
        {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
          閉じる
        </Button>
        <Button
          size="sm"
          disabled={pending || !note.trim()}
          data-testid="missed-save"
          onClick={() =>
            start(async () => {
              const r = await missedOpportunityAction({ candidateId, note });
              setMsg(r.ok ? "記録しました" : r.error);
              if (r.ok) {
                setNote("");
                onDone();
              }
            })
          }
        >
          記録
        </Button>
      </div>
    </div>
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
