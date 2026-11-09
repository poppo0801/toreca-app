"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteRuleAction, setRuleActiveAction, updateRuleAction } from "@/app/(app)/settings/collection/rule-actions";
import { Button } from "@/components/ui/button";
import { EXCLUDE_REASON_LABEL, USER_RULE_KIND_LABEL, type UserRuleKind } from "@/lib/collector/user-rules";
import { PREFECTURE_LIST } from "@/lib/geo";

export interface RuleView {
  id: string;
  kind: UserRuleKind;
  label: string;
  chain_name: string;
  store_name: string;
  prefecture: string;
  city: string;
  keywords: string[];
  note: string;
  active: boolean;
  created_at: string;
  /** エリア外系列: 現在、対象地域に店舗があるか（あれば適用されない） */
  chainInArea?: boolean;
}
export interface ExclusionLogView {
  id: string;
  candidate_id: string;
  reason_code: keyof typeof EXCLUDE_REASON_LABEL;
  detail: { title?: string; chainName?: string; storeName?: string; keywords?: string[] } | null;
  rule_id: string | null;
  created_at: string;
}

const field = "mt-1 min-h-10 w-full rounded-md border bg-input px-2 text-sm";
const fmt = (iso: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(iso));

function summary(r: RuleView): string {
  if (r.kind === "region_store") return [r.chain_name, r.store_name].filter(Boolean).join(" ") + (r.prefecture ? `（${r.prefecture}${r.city}）` : "（地域未確認）");
  if (r.kind === "area_chain") return r.chain_name || r.label;
  return `キーワード: ${r.keywords.join("、")}`;
}

/**
 * 除外ルールの見直し（Stage 7H）。候補の除外で確定したルールだけを一覧し、内容確認・編集・無効化・再有効化・削除ができる。
 * 履歴（除外した候補の記録）は、ルールを削除しても残る。
 */
export function UserRulesList({ rules, log }: { rules: RuleView[]; log: ExclusionLogView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: "", note: "", prefecture: "", city: "", keywords: "" });

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setMsg(r.ok ? done : (r.error ?? "失敗しました"));
    if (r.ok) {
      setEditing(null);
      router.refresh();
    }
  };
  const startEdit = (r: RuleView) => {
    setEditing(r.id);
    setDraft({ label: r.label, note: r.note, prefecture: r.prefecture, city: r.city, keywords: r.keywords.join("、") });
  };

  return (
    <div className="space-y-2 text-xs" data-testid="user-rules">
      {msg && (
        <p role="status" className="text-muted-foreground" data-testid="rule-msg">
          {msg}
        </p>
      )}
      {rules.length === 0 && <p className="text-muted-foreground">除外ルールはありません。抽選候補の「除外」で理由を選ぶと、必要なものだけルールが作られます。</p>}
      <ul className="space-y-1.5">
        {rules.map((r) => (
          <li key={r.id} className="rounded-lg border p-2" data-testid="rule-row" data-active={r.active}>
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="rounded border px-1 font-medium">{USER_RULE_KIND_LABEL[r.kind]}</span>
              <span className="min-w-0 break-words font-medium">{summary(r)}</span>
              <span className={r.active ? "text-success" : "text-muted-foreground"}>{r.active ? "有効" : "無効"}</span>
              <span className="text-muted-foreground">{fmt(r.created_at)}</span>
            </p>
            {r.note && <p className="text-muted-foreground">理由: {r.note}</p>}
            {r.kind === "area_chain" && r.active && (
              <p className={r.chainInArea ? "text-warn" : "text-muted-foreground"} data-testid="rule-area-status">
                {r.chainInArea ? "現在は対象地域に店舗があるため、このルールは適用されません。見直しをご検討ください。" : "対象地域に店舗が登録されていない間だけ適用します（店舗が追加されると自動的に適用されなくなります）。"}
              </p>
            )}
            {editing === r.id ? (
              <div className="mt-1.5 space-y-1.5">
                {r.kind === "region_store" && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <label>
                      都道府県
                      <select className={field} value={draft.prefecture} onChange={(e) => setDraft({ ...draft, prefecture: e.target.value })}>
                        <option value="">未確認</option>
                        {PREFECTURE_LIST.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      市区町村
                      <input className={field} value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
                    </label>
                  </div>
                )}
                {r.kind === "other_game" && (
                  <label className="block">
                    キーワード（「、」区切り）
                    <input className={field} value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />
                  </label>
                )}
                <label className="block">
                  理由
                  <input className={field} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                </label>
                <div className="flex gap-1.5">
                  <Button size="sm" disabled={busy} data-testid="rule-save" onClick={() => void run(() => updateRuleAction(r.id, { label: draft.label, note: draft.note, prefecture: draft.prefecture, city: draft.city, keywords: draft.keywords.split(/[、,\s]+/).filter(Boolean) }), "更新しました")}>
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    キャンセル
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => startEdit(r)} data-testid="rule-edit">
                  編集
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => setRuleActiveAction(r.id, !r.active), r.active ? "無効にしました（履歴は残ります）" : "有効にしました")} data-testid="rule-toggle">
                  {r.active ? "無効にする" : "再び有効にする"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("このルールを削除しますか？（除外した候補の履歴は残ります）")) void run(() => deleteRuleAction(r.id), "削除しました");
                  }}
                  data-testid="rule-delete"
                >
                  削除
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {log.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">除外の履歴（直近{log.length}件）</summary>
          <ul className="mt-1 space-y-0.5" data-testid="exclusion-log">
            {log.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-2 text-muted-foreground">
                <span>{fmt(l.created_at)}</span>
                <span className="font-medium text-foreground">{EXCLUDE_REASON_LABEL[l.reason_code]}</span>
                <span className="min-w-0 break-words">{l.detail?.title || [l.detail?.chainName, l.detail?.storeName].filter(Boolean).join(" ")}</span>
                {l.rule_id && <span>ルールあり</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
