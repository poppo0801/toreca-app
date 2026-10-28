"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { deleteBattle, saveBattle } from "@/app/(app)/battles/actions";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { jstDateString } from "@/lib/datetime";
import { BATTLE_RESULT_LABEL, battleInputSchema, EMPTY_BATTLE_FILTER, filterBattles, sortBattles, tally, tallyBy, TURN_ORDER_LABEL, type BattleFilter, type BattleInput } from "@/lib/battle";
import { cn } from "@/lib/utils";
import type { BattleRecord, BattleResult } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
const RESULT_CLASS: Record<BattleResult, string> = { win: "border-success text-success", lose: "border-danger text-danger", draw: "text-muted-foreground" };
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);

/**
 * 対戦記録。収支・抽選とは独立した記録で、家族共通。既存Excel(Sheet3)の列構成は未確認のため、
 * 基本項目（対戦日・使用デッキ・相手・相手デッキ・勝敗・形式・先攻後攻・備考）だけの暫定構造。
 */
export function BattlesView() {
  const { data, persistent, profile, now } = useApp();
  const [filter, setFilter] = useState<BattleFilter>(EMPTY_BATTLE_FILTER);
  const [edit, setEdit] = useState<{ record: BattleRecord | null } | null>(null);
  const all = useMemo(() => sortBattles(data.battles ?? []), [data.battles]);
  const rows = useMemo(() => filterBattles(all, filter), [all, filter]);
  const t = useMemo(() => tally(rows), [rows]);
  const byDeck = useMemo(() => tallyBy(rows, (b) => b.myDeck), [rows]);
  const byOpp = useMemo(() => tallyBy(rows, (b) => b.opponentDeck), [rows]);
  const decks = useMemo(() => [...new Set(all.map((b) => b.myDeck).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [all]);
  const available = data.battles !== undefined;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Link href="/settings" aria-label="設定へ戻る" className="-ml-1 flex size-9 items-center justify-center rounded-md hover:bg-muted">
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Link>
          <h1 className="text-base font-bold">対戦記録</h1>
        </div>
        {persistent && available && (
          <Button size="sm" onClick={() => setEdit({ record: null })}>
            ＋対戦を記録
          </Button>
        )}
      </div>

      {!available && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">対戦記録は、データベースの更新（マイグレーション）後に使えます。モックデータでは表示されません。</p>}

      {available && (
        <>
          <div className="flex gap-1.5">
            <select aria-label="使用デッキで絞り込み" value={filter.myDeck} onChange={(e) => setFilter({ ...filter, myDeck: e.target.value })} className="h-9 min-w-0 flex-1 rounded-full border bg-input px-3 text-xs">
              <option value="">使用デッキ: すべて</option>
              {decks.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select aria-label="期間で絞り込み" value={filter.from ?? ""} onChange={(e) => setFilter({ ...filter, from: e.target.value || null })} className="h-9 min-w-0 flex-1 rounded-full border bg-input px-3 text-xs">
              <option value="">期間: すべて</option>
              <option value={jstDateString(new Date(now.getTime() - 30 * 86400000))}>直近30日</option>
              <option value={`${jstDateString(now).slice(0, 4)}-01-01`}>今年</option>
            </select>
          </div>

          <dl className="grid grid-cols-4 gap-1.5 text-center" data-testid="battle-summary">
            {(
              [
                ["対戦", `${t.total}`],
                ["勝ち", `${t.win}`],
                ["負け", `${t.lose}`],
                ["勝率", pct(t.winRate)],
              ] as const
            ).map(([l, v]) => (
              <div key={l} className="rounded-lg border bg-card p-2 shadow-card">
                <dt className="text-[11px] text-muted-foreground">{l}</dt>
                <dd className="text-sm font-bold tabular-nums" data-testid={`battle-${l}`}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {t.draw > 0 && <p className="text-xs text-muted-foreground">引き分け{t.draw}件は勝率の母数に含めていません。</p>}

          {byDeck.length > 0 && (
            <section aria-label="使用デッキ別" className="rounded-xl border bg-card p-3 shadow-card">
              <h2 className="mb-1 text-sm font-bold">使用デッキ別</h2>
              <ul className="space-y-0.5 text-xs">
                {byDeck.map((g) => (
                  <li key={g.key} className="flex justify-between gap-2">
                    <span className="truncate">{g.key}</span>
                    <span className="shrink-0 tabular-nums">
                      {g.win}勝{g.lose}敗{g.draw > 0 && `${g.draw}分`}（{pct(g.winRate)}）
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {byOpp.length > 0 && byOpp.some((g) => g.key !== "（未入力）") && (
            <section aria-label="相手デッキ別" className="rounded-xl border bg-card p-3 shadow-card">
              <h2 className="mb-1 text-sm font-bold">相手デッキ別</h2>
              <ul className="space-y-0.5 text-xs">
                {byOpp.slice(0, 8).map((g) => (
                  <li key={g.key} className="flex justify-between gap-2">
                    <span className="truncate">{g.key}</span>
                    <span className="shrink-0 tabular-nums">
                      {g.win}勝{g.lose}敗{g.draw > 0 && `${g.draw}分`}（{pct(g.winRate)}）
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card" data-testid="battle-list" aria-label="対戦履歴">
            {rows.map((b) => {
              const owner = b.profileId ? data.profiles.find((p) => p.id === b.profileId) : undefined;
              return (
                <li key={b.id}>
                  <button type="button" disabled={!persistent} onClick={() => setEdit({ record: b })} data-testid="battle-row" className="flex min-h-14 w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted disabled:hover:bg-transparent">
                    <span className={cn("w-12 shrink-0 rounded border px-1 py-0.5 text-center text-xs font-bold", RESULT_CLASS[b.result])}>{BATTLE_RESULT_LABEL[b.result]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {b.myDeck || "（デッキ未入力）"} <span className="font-normal text-muted-foreground">vs</span> {b.opponentDeck || "（相手デッキ未入力）"}
                      </span>
                      <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        <span>{b.playedOn.slice(5).replace("-", "/")}</span>
                        {b.opponent && <span>{b.opponent}</span>}
                        {b.format && <span>{b.format}</span>}
                        {b.turnOrder && <span>{TURN_ORDER_LABEL[b.turnOrder]}</span>}
                        {owner && <ProfileAvatar profile={owner} size="xs" />}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {rows.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{all.length === 0 ? "対戦記録はまだありません。「＋対戦を記録」から追加できます。" : "この条件の対戦はありません。"}</p>}
          <p className="text-[11px] text-muted-foreground">既存Excelの対戦履歴の取り込みは未実施です（列構成の確認後に対応します）。この記録は収支・抽選とは別に管理されます。</p>
        </>
      )}

      {edit && <BattleSheet key={edit.record?.id ?? "new"} record={edit.record} decks={decks} defaultProfileId={profile.id} onClose={() => setEdit(null)} />}
    </div>
  );
}

function BattleSheet({ record, decks, defaultProfileId, onClose }: { record: BattleRecord | null; decks: string[]; defaultProfileId: string; onClose: () => void }) {
  const { data, profile, reload } = useApp();
  const [v, setV] = useState<BattleInput>(() => ({
    playedOn: record?.playedOn ?? jstDateString(new Date()),
    profileId: record ? record.profileId : defaultProfileId,
    myDeck: record?.myDeck ?? "",
    opponent: record?.opponent ?? "",
    opponentDeck: record?.opponentDeck ?? "",
    result: (record?.result ?? "") as BattleResult,
    turnOrder: record?.turnOrder ?? "",
    format: record?.format ?? "",
    memo: record?.memo ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof BattleInput>(k: K, val: BattleInput[K]) => setV((s) => ({ ...s, [k]: val }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = battleInputSchema.safeParse(v);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
    setBusy(true);
    const res = await saveBattle(record?.id ?? null, v, profile.id);
    setBusy(false);
    if (res.ok) {
      await reload();
      onClose();
    } else setError(res.error);
  };
  const remove = async () => {
    if (!record || !window.confirm("この対戦記録を削除しますか？（一覧から除かれます）")) return;
    setBusy(true);
    const res = await deleteBattle(record.id, profile.id);
    setBusy(false);
    if (res.ok) {
      await reload();
      onClose();
    } else setError(res.error);
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="battle-desc" data-testid="battle-form">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>{record ? "対戦記録を編集" : "対戦を記録"}</SheetTitle>
            <SheetDescription id="battle-desc">収支・抽選とは独立した記録です。</SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <form onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
          <SheetBody className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                <span className="text-[13px] font-medium">対戦日</span>
                <input type="date" value={v.playedOn} onChange={(e) => set("playedOn", e.target.value)} className={field} />
              </label>
              <label className="text-sm">
                <span className="text-[13px] font-medium">対戦形式</span>
                <input value={v.format} onChange={(e) => set("format", e.target.value)} className={field} placeholder="例: ジムバトル" />
              </label>
            </div>
            <fieldset>
              <legend className="text-[13px] font-medium">勝敗</legend>
              <div className="mt-1 grid grid-cols-3 gap-2" role="radiogroup" aria-label="勝敗">
                {(["win", "lose", "draw"] as const).map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={v.result === r} onClick={() => set("result", r)} className={cn("min-h-11 rounded-md border text-sm font-medium", v.result === r ? "border-primary bg-primary text-primary-foreground" : "bg-input")}>
                    {BATTLE_RESULT_LABEL[r]}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                <span className="text-[13px] font-medium">使用デッキ</span>
                <input list="battle-decks" value={v.myDeck} onChange={(e) => set("myDeck", e.target.value)} className={field} />
                <datalist id="battle-decks">
                  {decks.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              </label>
              <label className="text-sm">
                <span className="text-[13px] font-medium">相手デッキ</span>
                <input value={v.opponentDeck} onChange={(e) => set("opponentDeck", e.target.value)} className={field} />
              </label>
              <label className="text-sm">
                <span className="text-[13px] font-medium">対戦相手</span>
                <input value={v.opponent} onChange={(e) => set("opponent", e.target.value)} className={field} />
              </label>
              <label className="text-sm">
                <span className="text-[13px] font-medium">先攻・後攻</span>
                <select value={v.turnOrder} onChange={(e) => set("turnOrder", e.target.value as BattleInput["turnOrder"])} className={field}>
                  <option value="">不明</option>
                  <option value="first">先攻</option>
                  <option value="second">後攻</option>
                </select>
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-[13px] font-medium">対戦した人（任意）</span>
              <select value={v.profileId ?? ""} onChange={(e) => set("profileId", e.target.value || null)} className={field}>
                <option value="">指定しない</option>
                {data.profiles
                  .filter((p) => p.active !== false)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-[13px] font-medium">備考</span>
              <textarea value={v.memo} onChange={(e) => set("memo", e.target.value)} rows={2} className={cn(field, "py-2")} />
            </label>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </SheetBody>
          <div className="flex items-center justify-between gap-2 border-t bg-card px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            {record ? (
              <Button type="button" variant="ghost" onClick={remove} disabled={busy} className="text-danger">
                削除
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
