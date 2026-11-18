"use client";

import { useEffect, useState } from "react";
import { loadJudgmentsAction, type JudgmentRow } from "@/app/(app)/settings/investigation/actions";
import { CASE_FIELD_KEYS, CASE_FIELD_LABEL } from "@/lib/case-model/types";

/**
 * 判断履歴（開発用。Stage 9H-3C）。収集した候補ごとに、AIが受け取った情報・AIの判断・固定ロジックや調査による変更と理由・最終の登録候補・不足/未確認・情報源の根拠を確認する。
 * 既存の調査画面（InvestigationView）の一部。開発環境でのみ表示される（本番では画面ごと404）。読み取りのみ。
 */
const STATE: Record<string, string> = { confirmed: "確定", inferred: "推定", unverified: "未確認", conflict: "矛盾", missing: "不明", manual: "人間確定" };
const KIND: Record<string, string> = { adopted: "採用", changed: "変更", dropped: "破棄", held: "保留", rejected: "拒否", noted: "記録" };
const BY: Record<string, string> = { ai: "AI", fixed: "固定ロジック", master: "マスター照合", human: "人間", seed: "既知の値", investigation: "調査" };
const NEED: Record<string, string> = { fetch_restricted: "取得制限", required_missing: "必須情報の不足", conflict: "情報源の矛盾", chain_unidentified: "系列不明", store_unidentified: "店舗不明", form_undecidable: "店舗選択式か判断できない", duplicate_doubt: "重複の疑い", weak_evidence: "根拠が弱い", spot_check: "抜き取り再確認" };
const label = (k: string) => CASE_FIELD_LABEL[k as keyof typeof CASE_FIELD_LABEL] ?? k;
const silent = (reason: string) => reason.includes("理由の記録なし");

export function JudgmentPanel() {
  const [rows, setRows] = useState<JudgmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadJudgmentsAction().then((r) => {
      if (!live) return;
      if (r.ok) setRows(r.rows);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="space-y-1.5" data-testid="judgments">
      <h2 className="text-sm font-semibold">判断履歴（収集した候補）</h2>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {!rows && !error ? <p className="text-xs text-muted-foreground">読み込み中…</p> : null}
      {rows && rows.length === 0 ? <p className="text-xs text-muted-foreground">判断履歴はまだありません（開発環境で COLLECT_UNIFIED=on のとき、収集した候補に保存されます）</p> : null}
      {rows?.map((r) => <JudgmentItem key={r.id} row={r} />)}
    </section>
  );
}

function JudgmentItem({ row }: { row: JudgmentRow }) {
  const j = row.judgment;
  const changes = j.decisions.filter((d) => ["changed", "dropped", "held", "rejected", "adopted"].includes(d.kind));
  const silentCount = changes.filter((d) => silent(d.reason) && (d.kind === "changed" || d.kind === "dropped")).length;
  const missing = CASE_FIELD_KEYS.filter((k) => !j.final[k] || j.final[k]?.state === "missing");
  const weak = CASE_FIELD_KEYS.filter((k) => j.final[k] && ["unverified", "conflict"].includes(j.final[k]!.state));
  const inv = j.investigation;
  return (
    <details className="rounded-md border border-border bg-card" data-testid="judgment-item">
      <summary className="cursor-pointer break-words px-2 py-1.5 text-xs">
        <span className="font-medium">{row.title || row.url}</span>
        <span className="ml-1 text-muted-foreground">（{row.status}・変更{changes.length}件{silentCount ? `・理由なし${silentCount}件` : ""}）</span>
      </summary>
      <div className="space-y-2 border-t border-border px-2 py-2 text-xs">
        <div>
          <p className="font-semibold">AIが受け取った情報</p>
          {j.aiInput ? (
            <>
              <p className="text-muted-foreground">{j.aiInput.kind}・本文{j.aiInput.textLength}字・画像{j.aiInput.imageCount}枚（ハッシュ {j.aiInput.textDigest}）</p>
              <p className="break-words whitespace-pre-wrap rounded bg-muted/40 px-1.5 py-1">{j.aiInput.textExcerpt || "（本文なし）"}</p>
              {j.aiInput.context.length ? <p className="break-words text-muted-foreground">参考情報: {j.aiInput.context.join(" ／ ")}</p> : null}
            </>
          ) : (
            <p className="text-muted-foreground">記録なし</p>
          )}
        </div>
        <div>
          <p className="font-semibold">AIが判断した内容 → 最終の登録候補</p>
          <ul className="space-y-0.5">
            {CASE_FIELD_KEYS.filter((k) => j.ai[k] || j.final[k]).map((k) => (
              <li key={k} className="break-words">
                <span className="text-muted-foreground">{label(k)}: </span>
                {j.ai[k]?.value ?? "—"} <span className="text-muted-foreground">→</span> <strong>{j.final[k]?.value ?? "—"}</strong>
                {j.final[k] ? <span className="text-muted-foreground">［{STATE[j.final[k]!.state] ?? j.final[k]!.state}{j.final[k]!.evidence?.tier ? `・${j.final[k]!.evidence!.tier === "primary" ? "一次" : "二次"}` : ""}{j.final[k]!.evidence?.basis ? `・${j.final[k]!.evidence!.basis === "organizer_body" ? "主催者本文" : "受付表示"}` : ""}］</span> : null}
                {j.final[k]?.evidence?.url ? <span className="block break-all text-muted-foreground">根拠: {j.final[k]!.evidence!.url}{j.final[k]!.evidence!.quote ? `「${j.final[k]!.evidence!.quote}」` : ""}</span> : null}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-semibold">固定ロジック・調査による変更と理由</p>
          {changes.length === 0 ? <p className="text-muted-foreground">変更なし</p> : null}
          <ul className="space-y-0.5">
            {changes.map((d, i) => (
              <li key={i} className={`break-words ${silent(d.reason) ? "text-danger" : ""}`}>
                {KIND[d.kind] ?? d.kind}・{d.field === "general" || d.field === "duplicate" || d.field === "decision" ? d.field : label(d.field)}（{BY[d.by] ?? d.by}）{d.before !== null || d.after !== null ? `: ${d.before ?? "—"} → ${d.after ?? "—"}` : ""}
                <span className="block text-muted-foreground">{d.reason}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-semibold">不足・未確認</p>
          <p className="break-words">不明: {missing.length ? missing.map(label).join("・") : "なし"}</p>
          <p className="break-words">未確認・矛盾: {weak.length ? weak.map(label).join("・") : "なし"}</p>
          {j.unreflected.length ? <p className="break-words text-muted-foreground">未反映の情報: {j.unreflected.map((u) => `${label(u.key)}「${u.value}」（${u.reason}）`).join("、")}</p> : null}
          {j.validations.length ? <p className="break-words text-muted-foreground">検証の指摘: {j.validations.join(" ／ ")}</p> : null}
          {j.duplicates.length ? <p className="break-words text-muted-foreground">重複の根拠: {j.duplicates.join(" ／ ")}</p> : null}
        </div>
        <div>
          <p className="font-semibold">調査</p>
          {inv ? (
            <p className="break-words">
              {inv.needed ? `必要（${inv.reasons.map((x) => NEED[x.code] ?? x.code).join("・")}）` : "不要"}・{inv.executed ? `実行（採用${inv.outcome?.applied ?? 0}・保留${inv.outcome?.held ?? 0}・未反映${inv.outcome?.unreflected ?? 0}${inv.outcome?.stopReason ? `・終了: ${inv.outcome.stopReason}` : ""}）` : `未実行${inv.skipped ? `（${inv.skipped}）` : ""}`}
              {inv.remaining?.length ? `・登録候補にも残った理由: ${inv.remaining.map((x) => NEED[x.code] ?? x.code).join("・")}` : ""}
              {inv.spotCheck ? `・抜き取り再確認: ${inv.spotCheck.eligible ? "対象" : "対象外"}（割合${inv.spotCheck.rate}・今回は実行しない）` : ""}
            </p>
          ) : (
            <p className="text-muted-foreground">記録なし</p>
          )}
        </div>
        {j.sources.length ? (
          <div>
            <p className="font-semibold">情報源の根拠</p>
            <ul className="space-y-0.5">
              {j.sources.map((s, i) => (
                <li key={i} className="break-all">
                  {s.tier === "primary" ? "一次" : "二次"}・{s.kind}・{s.status}: {s.url}
                  {s.note ? <span className="block text-muted-foreground">{s.note}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {j.humanHints.length ? <p className="break-words text-muted-foreground">使った人間の判断（参考）: {j.humanHints.join(" ／ ")}</p> : null}
      </div>
    </details>
  );
}
