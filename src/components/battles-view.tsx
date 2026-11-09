"use client";

import { PageHeading } from "@/components/page-heading";
import { useMemo, useRef, useState } from "react";
import { ChartColumn, SlidersHorizontal, UserRound } from "lucide-react";
import { claimBattle, deleteBattle, saveBattle } from "@/app/(app)/battles/actions";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { jstDateString } from "@/lib/datetime";
import { BATTLE_RESULT_LABEL, battleInputSchema, EMPTY_VIEW_FILTER, filterViews, hasViewFilter, isUnassigned, RESULT_BAR_CLASS, RESULT_COLOR_CLASS, RESULT_SYMBOL, tally, tallyBy, viewsFor, type BattleInput, type BattleView, type BattleViewFilter } from "@/lib/battle";
import { cn } from "@/lib/utils";
import type { BattleResult } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
/** 勝率（勝ち÷(勝ち+負け)）。引き分けは母数に含めない。勝敗が無ければ「－」 */
const pct = (r: number | null) => (r === null ? "－" : `${Math.round(r * 100)}%`);

/** 勝敗の記号（◯青・×赤・△緑）。色だけに頼らず記号でも判別できる。一覧・詳細・分析で共通 */
export function ResultMark({ result, className }: { result: BattleResult; className?: string }) {
  return (
    <span role="img" aria-label={BATTLE_RESULT_LABEL[result]} data-result={result} className={cn("shrink-0 text-xl font-bold leading-none", RESULT_COLOR_CLASS[result], className)}>
      {RESULT_SYMBOL[result]}
    </span>
  );
}

/**
 * 対戦記録（Stage 7G）。表示中のプロフィールが参加した対戦だけを、そのプロフィールから見た形（自分/相手・デッキ・勝敗）で表示する。
 * アプリ内プロフィール同士の対戦は1件だけ保存し、相手側から見ると反転して表示される。
 */
export function BattlesView() {
  const { data, persistent, profile, now } = useApp();
  const [filter, setFilter] = useState<BattleViewFilter>(EMPTY_VIEW_FILTER);
  const [edit, setEdit] = useState<{ view: BattleView | null } | null>(null);
  const [panel, setPanel] = useState<"filter" | "analysis" | null>(null);
  const labelOf = useMemo(() => {
    const m = new Map(data.profiles.map((p) => [p.id, p.label]));
    return (id: string) => m.get(id) ?? "";
  }, [data.profiles]);
  const available = data.battles !== undefined;
  const mine = useMemo(() => viewsFor(data.battles ?? [], profile.id, labelOf), [data.battles, profile.id, labelOf]);
  const rows = useMemo(() => filterViews(mine, filter), [mine, filter]);
  const total = useMemo(() => tally(rows), [rows]);
  const profileById = useMemo(() => new Map(data.profiles.map((p) => [p.id, p])), [data.profiles]);
  const myProfile = (id: string) => profileById.get(id) ?? null;
  const unassigned = useMemo(() => (data.battles ?? []).filter(isUnassigned), [data.battles]);
  const filtered = hasViewFilter(filter);

  return (
    <div className="space-y-2.5">
      <div className="flex h-9 items-center justify-between gap-2">
        <PageHeading navId="battles">対戦記録</PageHeading>
        {available && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="outline" size="icon" className={cn("relative size-9", filtered && "border-primary text-primary-ink")} aria-label={filtered ? "絞り込み（設定中）" : "絞り込み"} onClick={() => setPanel("filter")} data-testid="battle-filter-open">
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              {filtered && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary" aria-hidden="true" />}
            </Button>
            <Button variant="outline" size="icon" className="size-9" aria-label="戦績の分析" onClick={() => setPanel("analysis")} data-testid="battle-analysis-open">
              <ChartColumn className="size-4" aria-hidden="true" />
            </Button>
            {persistent && (
              <Button size="sm" onClick={() => setEdit({ view: null })} data-testid="battle-add">
                ＋対戦を記録
              </Button>
            )}
          </div>
        )}
      </div>

      {!available && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">対戦記録は、データベースの更新（マイグレーション）後に使えます。モックデータでは表示されません。</p>}

      {available && (
        <>
          {/* 総合集計（現在のプロフィールの戦績。絞り込み中はその対象。勝率＝勝ち÷（勝ち＋負け）、引き分けは対戦数に含め勝率の母数には含めない） */}
          <dl className="grid grid-cols-4 divide-x rounded-lg border bg-card py-1.5 text-center shadow-card" data-testid="battle-summary">
            {(
              [
                ["対戦", "total", `${total.total}`],
                ["勝ち", "win", `${total.win}`],
                ["負け", "lose", `${total.lose}`],
                ["勝率", "rate", pct(total.winRate)],
              ] as const
            ).map(([l, id, v]) => (
              <div key={id} className="min-w-0 px-1" data-testid={`sum-${id}`}>
                <dt className="text-[10px] leading-4 text-muted-foreground">{l}</dt>
                <dd className="text-sm font-bold tabular-nums leading-5" data-testid={`sum-${id}-value`}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          <ul className="space-y-2" data-testid="battle-list" aria-label="対戦履歴">
            {rows.map((b) => (
              <li key={b.id}>
                <button type="button" disabled={!persistent} onClick={() => setEdit({ view: b })} data-testid="battle-row" data-result={b.result} className="flex w-full items-stretch overflow-hidden rounded-xl border bg-card text-left shadow-card active:bg-muted/60 disabled:active:bg-card">
                  {/* 左端: 勝敗のアクセントバー（記号と同じ色。細く、カード全体は塗らない） */}
                  <span className={cn("w-1.5 shrink-0", RESULT_BAR_CLASS[b.result])} aria-hidden="true" data-testid="battle-bar" />
                  <span className="min-w-0 flex-1 px-2.5 py-2">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-bold tabular-nums" data-testid="battle-date">
                        {b.playedOn.slice(5).replace("-", "/")}
                      </span>
                      {b.format && (
                        <span className="min-w-0 truncate rounded-full border bg-muted px-2 py-px text-[11px] text-muted-foreground" data-testid="battle-format">
                          {b.format}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block space-y-0.5" data-testid="battle-detail">
                      <PlayerLine profile={myProfile(b.myProfileId)} name={labelOf(b.myProfileId)} deck={b.myDeck} mine testId="battle-me" />
                      <PlayerLine profile={b.opponentProfileId ? myProfile(b.opponentProfileId) : null} name={b.opponentName || "外部の相手"} deck={b.opponentDeck} testId="battle-opp" />
                    </span>
                  </span>
                  {/* 右端: 大きな勝敗記号（上下中央） */}
                  <span className="flex w-14 shrink-0 items-center justify-center">
                    <ResultMark result={b.result} className="text-4xl" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {rows.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{mine.length === 0 ? "対戦記録はまだありません。「＋対戦を記録」から追加できます。" : "この条件の対戦はありません。"}</p>}

          {unassigned.length > 0 && persistent && (
            <details className="rounded-xl border bg-card px-3 py-2 text-sm" data-testid="battle-unassigned">
              <summary className="cursor-pointer font-medium">持ち主が決まっていない記録 {unassigned.length}件</summary>
              <ul className="mt-2 space-y-1.5">
                {unassigned.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 text-xs" data-testid="battle-unassigned-row">
                    <span className="min-w-0 flex-1 truncate">
                      {b.playedOn.slice(5).replace("-", "/")} {b.myDeck || "（デッキ未入力）"} vs {b.opponentDeck || "（相手デッキ未入力）"}
                    </span>
                    <UnassignedActions id={b.id} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {panel === "filter" && <FilterSheet all={mine} filter={filter} now={now} onChange={setFilter} onClose={() => setPanel(null)} />}
      {panel === "analysis" && <AnalysisSheet rows={rows} filtered={filtered} onClose={() => setPanel(null)} />}
      {edit && <BattleSheet key={edit.view?.id ?? "new"} view={edit.view} decks={[...new Set(mine.map((b) => b.myDeck).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"))} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** 対戦カードの1行（プロフィールアイコン・ユーザー名・使用デッキ）。外部の相手は共通の人物アイコン。デッキ名は原則1行、長いときだけ最大2行 */
function PlayerLine({ profile, name, deck, mine, testId }: { profile: Parameters<typeof ProfileAvatar>[0]["profile"] | null; name: string; deck: string; mine?: boolean; testId: string }) {
  return (
    <span className="flex items-center gap-1.5" data-testid={testId}>
      {profile ? (
        <ProfileAvatar profile={profile} size="sm" />
      ) : (
        <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" data-testid="battle-external-icon">
          <UserRound className="size-3.5" />
        </span>
      )}
      <span className={cn("max-w-[5.5rem] shrink-0 truncate text-[11px]", mine ? "font-bold" : "text-muted-foreground")} data-testid="battle-name">
        {name}
      </span>
      <span className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] leading-tight" data-testid="battle-deck">
        {deck || "（デッキ未入力）"}
      </span>
    </span>
  );
}

function UnassignedActions({ id }: { id: string }) {
  const { profile, reload } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setErr(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) await reload();
    else setErr(r.error ?? "失敗しました");
  };
  return (
    <span className="flex shrink-0 items-center gap-1">
      {err && <span className="text-danger">{err}</span>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => claimBattle(id, profile.id))} data-testid="battle-claim">
        自分の記録にする
      </Button>
    </span>
  );
}

/** 絞り込み（使用デッキ・期間・対戦形式）。ボトムシート */
function FilterSheet({ all, filter, now, onChange, onClose }: { all: BattleView[]; filter: BattleViewFilter; now: Date; onChange: (f: BattleViewFilter) => void; onClose: () => void }) {
  const decks = useMemo(() => [...new Set(all.map((b) => b.myDeck).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [all]);
  const formats = useMemo(() => [...new Set(all.map((b) => b.format).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [all]);
  const d30 = jstDateString(new Date(now.getTime() - 30 * 86400000));
  const thisYear = `${jstDateString(now).slice(0, 4)}-01-01`;
  const period = filter.from === d30 ? d30 : filter.from === thisYear ? thisYear : "";
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="battle-filter-desc" data-testid="battle-filter">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>絞り込み</SheetTitle>
            <SheetDescription id="battle-filter-desc" className="sr-only">
              使用デッキ・期間・対戦形式で対戦を絞り込みます
            </SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          <label className="block text-sm">
            <span className="text-[13px] font-medium">使用デッキ</span>
            <select aria-label="使用デッキ" value={filter.myDeck} onChange={(e) => onChange({ ...filter, myDeck: e.target.value })} className={field}>
              <option value="">すべて</option>
              {decks.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-[13px] font-medium">期間</span>
            <select aria-label="期間" value={period} onChange={(e) => onChange({ ...filter, from: e.target.value || null })} className={field}>
              <option value="">すべて</option>
              <option value={d30}>直近30日</option>
              <option value={thisYear}>今年</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-[13px] font-medium">対戦形式</span>
            <select aria-label="対戦形式" value={filter.format} onChange={(e) => onChange({ ...filter, format: e.target.value })} className={field}>
              <option value="">すべて</option>
              {formats.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => onChange(EMPTY_VIEW_FILTER)} disabled={!hasViewFilter(filter)} data-testid="battle-filter-clear">
              条件をクリア
            </Button>
            <Button type="button" onClick={onClose}>
              OK
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** 戦績の分析。通常の一覧とは分け、表示中のプロフィールの対戦（絞り込み中はその条件）を集計する */
function AnalysisSheet({ rows, filtered, onClose }: { rows: BattleView[]; filtered: boolean; onClose: () => void }) {
  const t = useMemo(() => tally(rows), [rows]);
  const byDeck = useMemo(() => tallyBy(rows, (b) => b.myDeck), [rows]);
  const byFormat = useMemo(() => tallyBy(rows, (b) => b.format), [rows]);
  const line = (g: { win: number; lose: number; draw: number; winRate: number | null }) => `${g.win}勝${g.lose}敗${g.draw > 0 ? `${g.draw}分` : ""}（${pct(g.winRate)}）`;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="battle-analysis-desc" data-testid="battle-analysis">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>戦績の分析</SheetTitle>
            <SheetDescription id="battle-analysis-desc">勝率＝勝ち÷（勝ち＋負け）。引き分けは母数に含めません。{filtered ? "絞り込み中の対戦を集計しています。" : ""}</SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          <dl className="grid grid-cols-5 gap-1.5 text-center" data-testid="battle-analysis-summary">
            {(
              [
                ["対戦", "total", `${t.total}`],
                ["勝ち", "win", `${t.win}`],
                ["負け", "lose", `${t.lose}`],
                ["引分", "draw", `${t.draw}`],
                ["勝率", "rate", pct(t.winRate)],
              ] as const
            ).map(([l, id, v]) => (
              <div key={id} className="rounded-lg border bg-card p-2">
                <dt className="text-[11px] text-muted-foreground">{l}</dt>
                <dd className="text-sm font-bold tabular-nums" data-testid={`battle-${id}`}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {([["使用デッキ別", "deck", byDeck], ["対戦形式別", "format", byFormat]] as const).map(([title, id, groups]) => (
            <section key={id} aria-label={title} className="rounded-xl border bg-card p-3" data-testid={`battle-by-${id}`}>
              <h2 className="mb-1 text-sm font-bold">{title}</h2>
              {groups.length === 0 ? (
                <p className="text-xs text-muted-foreground">対戦がありません</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {groups.map((g) => (
                    <li key={g.key} className="flex justify-between gap-2" data-testid={`battle-by-${id}-row`}>
                      <span className="truncate">{g.key}</span>
                      <span className="shrink-0 tabular-nums">{line(g)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function BattleSheet({ view, decks, onClose }: { view: BattleView | null; decks: string[]; onClose: () => void }) {
  const { data, profile, reload } = useApp();
  const opId = useRef(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null);
  const rec = view?.record ?? null;
  // 相手側から見ている共有の対戦は、相手（記録した人）を変えられない
  const readOnlyOpponent = view?.role === "opponent";
  const others = data.profiles.filter((p) => p.active !== false && p.id !== profile.id);
  const [v, setV] = useState<BattleInput>(() => ({
    playedOn: view?.playedOn ?? jstDateString(new Date()),
    profileId: profile.id,
    // 相手側から見ている共有の対戦では、「相手」は記録した人（自分ではない）
    opponentProfileId: view?.role === "opponent" ? (rec?.profileId ?? null) : (rec?.opponentProfileId ?? null),
    myDeck: view?.myDeck ?? "",
    opponent: rec?.opponentProfileId ? "" : (rec?.opponent ?? ""),
    opponentDeck: view?.opponentDeck ?? "",
    result: (view?.result ?? "") as BattleResult,
    turnOrder: view?.turnOrder ?? "",
    format: view?.format ?? "",
    memo: view?.memo ?? "",
  }));
  const [opponentKind, setOpponentKind] = useState<"app" | "external">(rec?.opponentProfileId ? "app" : "external");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof BattleInput>(k: K, val: BattleInput[K]) => setV((s) => ({ ...s, [k]: val }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const input: BattleInput = opponentKind === "app" ? { ...v, opponent: "" } : { ...v, opponentProfileId: null };
    if (opponentKind === "app" && !input.opponentProfileId && !readOnlyOpponent) return setError("対戦相手のプロフィールを選択してください");
    const parsed = battleInputSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
    setBusy(true);
    const res = await saveBattle(rec?.id ?? null, input, profile.id, opId.current);
    setBusy(false);
    if (res.ok) {
      await reload();
      onClose();
    } else setError(res.error);
  };
  const remove = async () => {
    if (!rec || !window.confirm("この対戦記録を削除しますか？（一覧から除かれます。アプリ内の相手の記録からも除かれます）")) return;
    setBusy(true);
    const res = await deleteBattle(rec.id, profile.id);
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
            <SheetTitle>{rec ? "対戦記録を編集" : "対戦を記録"}</SheetTitle>
            <SheetDescription id="battle-desc" className="sr-only">
              対戦日・対戦相手・デッキ・勝敗を入力します
            </SheetDescription>
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
            <fieldset>
              <legend className="text-[13px] font-medium">対戦相手</legend>
              {readOnlyOpponent ? (
                <p className="mt-1 text-sm" data-testid="battle-opponent-fixed">
                  {view?.opponentName || "—"}（アプリ内のユーザー）
                </p>
              ) : (
                <>
                  <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label="対戦相手の種類">
                    {(
                      [
                        ["app", "アプリ内のユーザー"],
                        ["external", "外部の相手"],
                      ] as const
                    ).map(([k, l]) => (
                      <button key={k} type="button" role="radio" aria-checked={opponentKind === k} disabled={k === "app" && others.length === 0} onClick={() => setOpponentKind(k)} className={cn("min-h-10 rounded-md border text-sm font-medium disabled:opacity-50", opponentKind === k ? "border-primary bg-primary text-primary-foreground" : "bg-input")}>
                        {l}
                      </button>
                    ))}
                  </div>
                  {opponentKind === "app" ? (
                    <select aria-label="対戦相手のユーザー" value={v.opponentProfileId ?? ""} onChange={(e) => set("opponentProfileId", e.target.value || null)} className={field}>
                      <option value="">選択してください</option>
                      {others.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input aria-label="外部の相手の名称" value={v.opponent} onChange={(e) => set("opponent", e.target.value)} className={field} placeholder="名称（任意）" />
                  )}
                </>
              )}
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
            </div>
            <label className="block text-sm">
              <span className="text-[13px] font-medium">先攻・後攻</span>
              <select value={v.turnOrder} onChange={(e) => set("turnOrder", e.target.value as BattleInput["turnOrder"])} className={field}>
                <option value="">不明</option>
                <option value="first">先攻</option>
                <option value="second">後攻</option>
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
            {rec ? (
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
