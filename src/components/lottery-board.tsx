"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useProgressiveCount } from "@/lib/use-progressive";
import { PAGE_HEADING_ROW, PageHeading } from "@/components/page-heading";
import { ApplyExitProvider, useApplyExitController } from "@/components/apply-exit";
import { useSearchParams } from "next/navigation";
import { ChartColumn, CircleHelp, LayoutList, Rows3, Search, SlidersHorizontal, Table2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { reviewCandidateCountAction } from "@/app/(app)/lotteries/candidates/count-action";
import { useAiJobs } from "@/components/ai-jobs-provider";
import { countActiveFilters, FilterSheet } from "@/components/lottery-filter-sheet";
import { LotteryFormDialog } from "@/components/lottery-form";
import { LotteryCard } from "@/components/lottery-card";
import { LotteryGroupCard } from "@/components/lottery-group-card";
import { LotteryGroupSheet } from "@/components/lottery-group-sheet";
import { GroupManageContext } from "@/components/group-manage-context";
import { buildListRows } from "@/lib/lottery-group";
import { LotteryMatrix } from "@/components/lottery-matrix";
import { OngoingSection } from "@/components/ongoing-section";
import { SwipeCard } from "@/components/swipe-card";
import { SwipeGuide } from "@/components/swipe-guide";
import { useTabSwipe } from "@/components/use-tab-swipe";
import { adjacentTab } from "@/lib/tab-swipe";
import { UndoToastProvider } from "@/components/undo-toast";
import { StatusLegend } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_FILTERS,
  defaultFiltersFor,
  selectLotteries,
  type AllFilter,
  type Filters,
  type SkipView,
  type SortMode,
  type StatusFilter,
  type Tab,
} from "@/lib/lottery-view";
import { tabDots } from "@/lib/notifications";
import { useTapGate } from "@/lib/tap-guard";
import { KANSAI3, loadRegion, REGION_LABEL, regionMode, saveRegion, validateRegion } from "@/lib/region-filter";
import { readPref, readSession, writePref, writeSession } from "@/services/local-device-store";
import { cn } from "@/lib/utils";
import { UserScopeProvider } from "@/components/user-scope";
import { DEFAULT_USER_SCOPE, loadUserScope, resolveUserScope, saveUserScope, type UserScopePref } from "@/lib/user-scope";

/** 並びは 全情報 → 要チェック → 応募済み → 当選。初期表示は要チェック */
const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "全情報" },
  { value: "managed", label: "要チェック" },
  { value: "applied", label: "応募済み" },
  { value: "won", label: "当選" },
];

const VIEW = ["list", "matrix"] as const;

/** 状態の絞り込みの選択肢（現在のプロフィール基準）。「受付中・未応募」は全情報・要チェックだけの既定 */
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "default", label: "状態: 受付中・未応募" },
  { value: "open", label: "状態: 受付中" },
  { value: "closed", label: "状態: 受付終了" },
  { value: "unapplied", label: "状態: 未応募" },
  { value: "applied", label: "状態: 応募済み" },
  { value: "won", label: "状態: 当選" },
  { value: "lost", label: "状態: 落選" },
  { value: "any", label: "状態: すべて" },
];
const STATUS_VALUES = STATUS_OPTIONS.map((o) => o.value);

interface SessionState {
  tab: Tab;
  filters: Filters;
}

/** 保存された画面状態の検証（古い形式・壊れた値は使わない） */
function validateSession(v: unknown): SessionState | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<SessionState>;
  if (!s.tab || !TABS.some((t) => t.value === s.tab) || !s.filters || typeof s.filters !== "object") return null;
  const f: Record<string, string | string[]> = { ...DEFAULT_FILTERS };
  let hasRegion = false;
  for (const k of Object.keys(DEFAULT_FILTERS)) {
    const val = (s.filters as unknown as Record<string, unknown>)[k];
    if (typeof val === "string") f[k] = val;
    if (k === "prefectures" && validateRegion(val)) {
      f[k] = val as string[];
      hasRegion = true;
    }
  }
  if (!hasRegion) f.prefectures = [...KANSAI3]; // 古い形式の保存値は、既定の地域（関西3県）にする
  if (!STATUS_VALUES.includes(f.status as StatusFilter)) f.status = DEFAULT_FILTERS.status;
  return { tab: s.tab, filters: f as unknown as Filters };
}

export function LotteryBoard() {
  return (
    <UndoToastProvider>
      <LotteryBoardInner />
    </UndoToastProvider>
  );
}

function LotteryBoardInner() {
  const { data, now, persistent, profile, settings, saveSettings } = useApp();
  // 抽選候補（自動収集の確認待ち）の件数。0件・取得失敗なら何も出さない
  const [candCount, setCandCount] = useState(0);
  // 管理者のプロフィールのみ（Stage 7J）。他のプロフィールでは件数も取得しない
  const isAdmin = profile.isAdmin === true;
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    void reviewCandidateCountAction().then((n) => alive && setCandCount(n)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isAdmin]);
  const params = useSearchParams();
  const focusId = params.get("focus");
  const { unseen: unseenJobs } = useAiJobs();
  const [registering, setRegistering] = useState(false);
  // 抽選グループの管理画面（親カードの「グループを管理」）。一覧側で持つ（子が減って親カードが通常のカードに戻っても、画面が消えない）
  const [groupManaging, setGroupManaging] = useState<import("@/types/domain").Lottery | null>(null);
  // ＋登録は抽選情報の登録画面を直接開く
  const [tab, setTab] = useState<Tab>("managed");
  // 地域は端末に保存した選択（未保存は関西3県）を既定にする。通販・所在地不明は地域では除外しない
  const [region, setRegion] = useState<string[]>([...KANSAI3]);
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS, prefectures: [...KANSAI3] });
  // シンプル／詳細はプロフィール別の設定（既定は詳細＝従来の情報量）
  const cardView = settings.cardView ?? "detail";
  const gate = useTapGate(); // 表示切替・フィルターの誤った連続発火を300msだけ無視する
  const [view, setView] = useState<(typeof VIEW)[number]>("list");
  const [actionOnly, setActionOnly] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [legend, setLegend] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  // 応募済み・当選タブの対象ユーザー（端末ごと・プロフィールごとに記憶）。既定は自分＋紐づくサブ
  const [userScope, setUserScope] = useState<UserScopePref>(DEFAULT_USER_SCOPE);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末ローカル設定の復元（プロフィールを切り替えたら、そのプロフィールの設定へ）
    setUserScope(loadUserScope(profile.id));
  }, [profile.id]);
  const viewScope = useMemo(() => resolveUserScope(data.profiles, profile.id, userScope), [data.profiles, profile.id, userScope]);

  // 端末別の表示設定と、このタブでの前回のタブ・フィルターを復元（Providerがマウント後に描画するのでSSR差異なし）
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 端末ローカル設定の復元 */
    setView(readPref("view", VIEW, "list"));
    const saved = readSession("board", validateSession);
    const savedRegion = loadRegion();
    if (savedRegion) setRegion(savedRegion);
    if (saved && !focusId) {
      setTab(saved.tab);
      setFilters(saved.filters);
    } else if (savedRegion) {
      setFilters((f) => ({ ...f, prefectures: savedRegion }));
    }
    setRestored(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    // 復元は初回のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // 通知から開いたとき（focus）は、その抽選を見せるための一時的な表示なので保存しない
    if (restored && !focusId) writeSession("board", { tab, filters });
  }, [restored, focusId, tab, filters]);

  // 通知から開いた抽選を表示する: 含まれる最初のタブを選び、絞り込みを解除して、カードまでスクロールする
  useEffect(() => {
    if (!focusId) return;
    const target = data.lotteries.find((l) => l.id === focusId);
    if (!target) return;
    const order: Tab[] = ["managed", "applied", "won", "all"];
    const found = order.find((t) => selectLotteries(data, t, { ...DEFAULT_FILTERS, skip: "include", status: "any" }, now, profile.id).some((l) => l.id === focusId)) ?? "all";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URLパラメータに応じた表示状態の同期
    setTab(found);
    setFilters({ ...DEFAULT_FILTERS, skip: "include", status: "any" });
    setView("list");
    setHighlight(focusId);
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-lottery-id="${focusId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 150);
    return () => window.clearTimeout(timer);
    // data は初回表示の判定にだけ使う（以降の更新でスクロールし直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  // タブを切り替えたとき、状態の絞り込みはそのタブの既定へ戻す（全情報と要チェックは同じ既定なので、選んだ状態を保つ）
  const selectTab = (next: Tab) => {
    const before = defaultFiltersFor(tab).status;
    const after = defaultFiltersFor(next).status;
    if (before !== after) setFilters((f) => ({ ...f, status: after }));
    setTab(next);
  };
  // タブ切替モード（プロフィール別の設定）: 横スワイプで隣のタブへ。端のタブではそれ以上動かない。小さなスライドで切り替える（再読み込みなし）
  const tabSwipe = (settings.swipeMode ?? "card") === "tab";
  const [slide, setSlide] = useState<"next" | "prev" | null>(null);
  useTabSwipe(tabSwipe, (dir) => {
    const next = adjacentTab(TABS.map((t) => t.value), tab, dir);
    if (!next) return;
    setSlide(dir);
    selectTab(next);
  });

  // ★・応募・スワイプで今のタブから外れるカードは、共通の退出アニメーションで見送る（一覧表示のみ）。
  // 保存後も今のタブ・絞り込みに残るカードは、そのまま残す（isShown で判定）
  const exit = useApplyExitController({
    enabled: view === "list",
    resetKey: `${profile.id}|${tab}|${filters.status}|${view}`,
    isShown: (id) => selectLotteries(data, tab, filters, now, profile.id, undefined, viewScope).some((l) => l.id === id),
  });
  const lotteries = useMemo(() => selectLotteries(data, tab, filters, now, profile.id, exit.keepIds, viewScope), [data, tab, filters, now, profile.id, exit.keepIds, viewScope]);
  // 新着 = 全情報タブに出ている抽選（件数と同じ集合: 既定の絞り込み・スルー除外）のうち、まだ詳細を確認していないもの。必ず件数以下になる（Stage 6K）。
  // 以前は絞り込み前の全抽選から数えていたため、受付終了・応募済みの新着が混ざって件数を超えていた
  // 件数が多くても最初の画面分だけをすぐ描画し、残りは続けて足す（フォーカス先は必ず含める）
  // 複数店舗抽選は、グループの親カード1枚にまとめる（子は従来どおり独立した抽選。Stage 8U-2）。段階描画・フォーカスは行（親カード1枚＝1行）の単位
  const rows = useMemo(() => buildListRows(lotteries, data), [lotteries, data]);
  const focusTarget = highlight ?? focusId;
  const focusIdx = focusTarget ? rows.findIndex((r) => (r.kind === "single" ? r.lottery.id === focusTarget : r.members.some((m) => m.id === focusTarget))) : -1;
  const shownCount = useProgressiveCount(rows.length, tab, { needed: focusIdx >= 0 ? focusIdx + 1 : 0 });
  const newCount = useMemo(() => selectLotteries(data, "all", defaultFiltersFor("all"), now, profile.id).filter((l) => l.isNew).length, [data, now, profile.id]);
  const dots = useMemo(() => tabDots(data, profile.id, now, viewScope), [data, profile.id, now, viewScope]);
  const prefectures = useMemo(() => [...new Set(data.stores.map((s) => s.prefecture).filter(Boolean))], [data.stores]);
  const showSkip = true;
  const statusDefault = defaultFiltersFor(tab).status;
  // 詳細フィルターで条件を変えている数（検索語は検索欄に出ているので含めない）
  const baseFilters = { ...defaultFiltersFor(tab), prefectures: region };
  const activeCount = countActiveFilters(filters, baseFilters, { tab, showSkip, userScope });
  const filterKey = JSON.stringify(filters);
  const hasFilter = activeCount > 0 || filters.query.trim() !== "";

  /** 抽選1件のカード（スワイプ・退出アニメーション込み）。通常の一覧と、グループの展開後の子カードで共通 */
  const renderLottery = (l: (typeof lotteries)[number]) => {
        const phase = exit.phases[l.id];
        const sliding = phase === "sliding";
        const dir = exit.dirs[l.id] ?? "right";
        const collapsing = phase === "collapsing";
        return (
          <li
            key={l.id}
            data-exit={phase}
            // 高さを詰める（collapsing）のは、横へのスライドが終わって画面外へ出たあと。スライド中は高さを変えない
            className={cn("grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,margin] duration-[280ms] ease-out motion-reduce:transition-none", collapsing && "invisible")}
            style={collapsing ? { gridTemplateRows: "0fr", marginBottom: 0 } : { gridTemplateRows: "1fr" }}
          >
            <div className={cn("min-h-0 min-w-0", collapsing && "overflow-hidden", sliding && (dir === "left" ? "animate-[apply-exit-slide-left_0.32s_cubic-bezier(0.4,0,1,1)_forwards]" : "animate-[apply-exit-slide-right_0.32s_cubic-bezier(0.4,0,1,1)_forwards]"), "motion-reduce:animate-none")}>
              <SwipeCard lottery={l} tab={tab}>
                <LotteryCard lottery={l} tab={tab} view={cardView} highlighted={highlight === l.id} />
              </SwipeCard>
            </div>
          </li>
        );

  };

  return (
    <UserScopeProvider pref={userScope}>
    <GroupManageContext.Provider value={setGroupManaging}>
    <div>
      {/* 固定領域: 見出し＋タブ。この下の検索・フィルター・カードだけがスクロールする */}
      <div className="sticky top-[var(--header-h)] z-20 -mx-3 space-y-1.5 border-b bg-background px-3 pb-1.5 md:-mx-6 md:px-6">
        <div className={PAGE_HEADING_ROW}>
          <PageHeading navId="lotteries">抽選管理</PageHeading>
          <div className="flex min-w-0 items-center gap-1">
            {isAdmin && candCount > 0 && (
              <Link href="/lotteries/candidates" className="flex h-8 shrink-0 items-center rounded-full border border-primary px-2.5 text-xs font-bold text-primary-ink" data-testid="candidates-link">
                抽選候補 {candCount}件
              </Link>
            )}
            <Link href="/records" aria-label="応募実績・当選率を見る" className="flex size-9 items-center justify-center rounded-md hover:bg-muted">
              <ChartColumn className="size-[18px]" aria-hidden="true" />
            </Link>
            <button
              type="button"
              aria-label="アイコンの意味を表示"
              aria-pressed={legend}
              onClick={() => gate() && setLegend((v) => !v)}
              className="flex size-9 items-center justify-center rounded-md hover:bg-muted"
            >
              <CircleHelp className="size-[18px]" aria-hidden="true" />
            </button>
            {persistent ? (
              <>
                <Button size="sm" className="relative" onClick={() => setRegistering(true)} data-testid="register">
                  ＋登録
                  {unseenJobs > 0 && <span className="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-card bg-info" data-testid="bulk-badge" aria-label={`まとめて登録の確認待ち ${unseenJobs}件`} />}
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">デモデータ（保存されません）</span>
            )}
          </div>
        </div>
        <div role="tablist" aria-label="抽選の表示切替" className="grid grid-cols-4 rounded-lg bg-muted p-0.5">
          {TABS.map((t) => {
            const count = selectLotteries(data, t.value, defaultFiltersFor(t.value), now, profile.id, undefined, viewScope).length;
            const selected = tab === t.value;
            const dot = (t.value === "applied" && dots.appliedDot) || (t.value === "won" && dots.wonDot);
            return (
              <button
                key={t.value}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => selectTab(t.value)}
                className={cn("min-h-10 rounded-md px-0 py-0.5 text-xs font-medium leading-tight", selected ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-card")}
              >
                {/* 2行: 上段=赤丸＋名前（赤丸はタブ名の左。文字に重ねない）／下段=件数（新着のバッジは件数の右）。全タブで同じ高さ・位置にそろえる */}
                <span className="flex flex-col items-center justify-center whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {dot && <span data-testid={`tab-dot-${t.value}`} aria-label="未対応あり" className="size-2 shrink-0 rounded-full bg-danger" />}
                    {t.label}
                  </span>
                  <span className="inline-flex h-4 items-center gap-0.5 text-[11px] tabular-nums" data-testid={`tab-count-${t.value}`}>
                    <span className="opacity-80">{count}</span>
                    {t.value === "all" && newCount > 0 && (
                      <span data-testid="tab-new" aria-label={`新着${newCount}件（表示中のうち未確認）`} className="rounded-full bg-info px-1 text-[10px] font-bold leading-4 text-white tabular-nums">
                        新{newCount}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {registering && <LotteryFormDialog open lottery={null} onOpenChange={setRegistering} />}
      {groupManaging && <LotteryGroupSheet anchor={groupManaging} onClose={() => setGroupManaging(null)} />}

      <div className={cn("space-y-2 pt-2", slide && "motion-safe:animate-[tab-slide-in-from-right_0.22s_ease-out]", slide === "prev" && "motion-safe:animate-[tab-slide-in-from-left_0.22s_ease-out]")} data-testid="board-content" data-swipe-mode={tabSwipe ? "tab" : "card"} onAnimationEnd={() => setSlide(null)}>
        {legend && (
          <div className="rounded-lg border bg-card p-2 shadow-card" data-testid="legend">
            <p className="mb-1 text-xs font-bold">応募状態アイコン</p>
            <StatusLegend />
            <p className="mb-1 mt-2 text-xs font-bold">スワイプ操作（スマホ）</p>
            <SwipeGuide className="space-y-0.5 text-xs" />
          </div>
        )}

        <div className="flex gap-1.5">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">検索</span>
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={filters.query}
              onChange={(e) => set("query", e.target.value)}
              placeholder="店舗・系列・商品で検索"
              className="h-10 w-full rounded-md border bg-input pl-9 pr-3 text-sm"
            />
          </label>
          <Button variant="outline" size="icon" className="relative size-10" aria-label="絞り込みを開く" data-testid="filter-open" onClick={() => gate() && setAdvanced(true)}>
            <SlidersHorizontal className="size-4" />
            {activeCount > 0 && (
              <span data-testid="filter-count" className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-10"
            aria-pressed={cardView === "detail"}
            aria-label={cardView === "detail" ? "シンプル表示にする" : "詳細表示にする"}
            data-testid="view-toggle"
            onClick={() => gate() && void saveSettings({ cardView: cardView === "detail" ? "simple" : "detail" })}
          >
            {cardView === "detail" ? <Rows3 className="size-4" /> : <LayoutList className="size-4" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-10"
            aria-pressed={view === "matrix"}
            aria-label={view === "matrix" ? "リスト表示にする" : "応募マトリクスにする"}
            onClick={() => {
              if (!gate()) return;
              const next = view === "matrix" ? "list" : "matrix";
              setView(next);
              writePref("view", next);
            }}
          >
            <Table2 className="size-4" />
          </Button>
        </div>

        {view === "matrix" && (
          <label className="flex h-8 items-center gap-1.5 text-xs">
            <input type="checkbox" checked={actionOnly} onChange={(e) => setActionOnly(e.target.checked)} className="size-4" />
            要対応のみ
          </label>
        )}
        {/* 絞り込みはボトムシート（状態・系列・店舗・商品・応募方法・受取方法・都道府県などを組み合わせて「適用」）。開くたびに現在の条件から作り直す */}
        {advanced && (
          <FilterSheet
            key={`${tab}|${filterKey}`}
            open
            onOpenChange={setAdvanced}
            data={data}
            filters={filters}
            base={baseFilters}
            tab={tab}
            showSkip={showSkip}
            statusOptions={STATUS_OPTIONS.filter((o) => o.value !== "default" || statusDefault === "default")}
            prefectures={prefectures}
            userScope={userScope}
            selfId={profile.id}
            onUserScope={(v) => {
              setUserScope(v);
              saveUserScope(profile.id, v);
            }}
            onApply={(f) => {
              setFilters(f);
              setRegion(f.prefectures);
              saveRegion(f.prefectures);
            }}
          />
        )}

        {view === "matrix" ? (
          <LotteryMatrix lotteries={lotteries} actionOnly={actionOnly} />
        ) : (
          <ApplyExitProvider value={exit.api}>
            {/* カードが画面の横へはみ出して横スクロールや残像にならないよう、横方向をクリップする（ring が欠けないよう左右に1の余白）。
                グリッドの列は minmax(0,1fr) で、中身の最小幅（折り返さない文字など）に引き伸ばされないようにする */}
            <ul className="-mx-1 space-y-2.5 overflow-x-clip px-1" aria-label="抽選一覧">
              {rows.slice(0, shownCount).map((r) =>
                r.kind === "single" ? (
                  renderLottery(r.lottery)
                ) : (
                  <li key={r.key} className="grid grid-cols-[minmax(0,1fr)]">
                    <LotteryGroupCard row={r} renderChild={renderLottery} forceOpen={focusTarget ? r.members.some((m) => m.id === focusTarget) : false} onManage={setGroupManaging} />
                  </li>
                ),
              )}
            </ul>
          </ApplyExitProvider>
        )}

        {tab === "applied" && view === "list" && <OngoingSection />}

        {lotteries.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p>該当する抽選がありません。</p>
            {hasFilter && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setFilters(baseFilters)}>
                フィルタを解除
              </Button>
            )}
            {filters.prefectures.length > 0 && (
              <p className="mt-2 text-xs" data-testid="region-hint">
                地域: {REGION_LABEL[regionMode(filters.prefectures, prefectures)]}で絞り込み中（通販・発送のみは対象外にしません）
                <button type="button" className="ml-2 min-h-8 text-info underline" onClick={() => { setFilters((f) => ({ ...f, prefectures: [] })); setRegion([]); saveRegion([]); }}>
                  すべての地域を表示
                </button>
              </p>
            )}
            {tab === "managed" && !hasFilter && <p className="mt-1">「全情報」から★を付けると、ここに表示されます。</p>}
          </div>
        )}
      </div>
    </div>
    </GroupManageContext.Provider>
    </UserScopeProvider>
  );
}
