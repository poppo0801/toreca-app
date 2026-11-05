"use client";

import { useRouter } from "next/navigation";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app-provider";
import { LotteryFormDialog } from "@/components/lottery-form";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import type { LotteryDraft } from "@/lib/lottery-match";
import { RunCounts, RunStateLabel } from "@/components/collection-result-notice";
import type { PipelineMetrics } from "@/lib/collector/metrics";
import { runTitle, type RunSummary } from "@/lib/collector/run-summary";
import { APPLY_CHANNELS, RECEIVE_KINDS } from "@/lib/collector/conditions";
import { PREFECTURE_LIST } from "@/lib/geo";
import { HIDDEN_REQUIREMENT_TAGS, REQUIREMENT_TAGS } from "@/lib/lottery-taxonomy";
import { cn } from "@/lib/utils";

export interface SourceView {
  id: string;
  kind: "web" | "x";
  name: string;
  url: string | null;
  x_username: string | null;
  x_user_id: string | null;
  adapter: string;
  enabled: boolean;
  interval_hours: number;
  status: string;
  error_message: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_item_count: number;
  last_new_count: number;
  last_result?: "new" | "changed" | "no_new" | "failed" | null;
  consecutive_failures?: number;
}
export interface SettingsView {
  prefectures: string[];
  include_online: boolean;
  max_distance_km: number | null;
  apply_methods: string[];
  receive_methods: string[];
  req_include: string[];
  req_exclude: string[];
  product_mode: "all" | "include" | "exclude";
  product_ids: string[];
  status_mode: "open" | "open_or_before";
  /** 受付前の抽選予告も追跡する（既定ON） */
  track_upcoming: boolean;
  auto_register: boolean;
  schedule_enabled: boolean;
  schedule_hour_jst: number;
  x_enabled: boolean;
  x_monthly_budget_jpy: number;
  x_max_posts_per_run: number;
  max_ai_per_run: number;
  worker_enabled: boolean;
  worker_batch: number;
  recheck_hours: number;
}
export interface CandidateView {
  id: string;
  source_id: string | null;
  title: string;
  source_url: string | null;
  status: "auto_registered" | "pending" | "excluded" | "duplicate" | "failed";
  reasons: string[];
  draft: { update?: { changes: { label: string; before: string; after: string }[] } | null; provisional?: string[]; secondary?: string[]; notices?: string[]; evidence?: Record<string, unknown>; flags?: Record<string, string>; summary?: unknown; modePending?: boolean; warnings?: string[]; ready?: boolean; verdict?: string; input?: { chain?: { name: string }; store?: { name: string }; items?: { product: { name: string } }[]; applyDeadline?: { precision: string; date?: string; time?: string } }; queued?: unknown } | null;
  lottery_id: string | null;
  fetched_at: string;
  job_state?: string;
  kind?: string;
  attempts?: number;
  next_run_at?: string | null;
  last_error?: string | null;
  due_at?: string | null;
  last_changed_at?: string | null;
}
export interface StatRow {
  day: string;
  discovered_new: number;
  discovered_initial: number;
  changed: number;
  duplicates: number;
  excluded: number;
  ai_calls: number;
  ai_success: number;
  ai_failed: number;
  registered_new: number;
  updated_existing: number;
  review_added: number;
  queue_remaining: number | null;
  provisional_registered?: number;
  failed_jobs?: number;
  input_tokens: number;
  output_tokens: number;
  cost_jpy: number;
}
export interface OpsView {
  todayDiscovered: number;
  todayDiscoveredInitial: number;
  todayAi: number;
  todayRegistered: number;
  monthCostJpy: number;
  budgetJpy: number;
  rate: number;
  avgPerCallJpy: number | null;
  monthCalls: number;
  budgetBlocked: boolean;
  lastProgressAt: string | null;
  dueTodayQueued: number;
}
export interface HealthView {
  state: "running" | "waiting" | "ok" | "paused" | "budget";
  warnings: string[];
  lastCollectAt: string | null;
  lastWorkerAt: string | null;
  nextCollectAt: string | null;
  processing: number;
  pausedReason: string | null;
  workerDayUsed: number;
}
export interface RunView {
  id: string;
  trigger: string;
  phase?: string;
  processed_count?: number;
  changed_count?: number;
  skipped_count?: number;
  stop_reason?: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  web_fetched: number;
  x_posts: number;
  x_calls: number;
  ai_calls: number;
  new_count: number;
  registered_count: number;
  error_count: number;
  summary: { name: string; status: string; message: string }[];
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  never: { label: "未取得", cls: "text-muted-foreground" },
  ok: { label: "取得成功", cls: "border-teal-600/50 text-teal-700 dark:text-teal-300" },
  error: { label: "取得失敗", cls: "border-danger text-danger" },
  needs_setup: { label: "解析設定が必要", cls: "border-warn text-warn" },
  unavailable: { label: "取得不可", cls: "border-danger text-danger" },
  not_configured: { label: "APIキー未設定", cls: "border-warn text-warn" },
  blocked: { label: "アクセス制限", cls: "border-danger text-danger" },
  disabled: { label: "無効（未実行）", cls: "text-muted-foreground" },
};
const CAND_TABS = [
  { value: "pending", label: "確認待ち" },
  { value: "queued", label: "解析待ち" },
  { value: "auto_registered", label: "登録済み" },
  { value: "excluded", label: "除外" },
  { value: "duplicate", label: "重複" },
  { value: "failed", label: "取得失敗" },
] as const;

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const input = "h-9 w-full min-w-0 rounded-md border bg-input px-2 text-sm";

function Chip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} data-testid={testId} className={cn("inline-flex min-h-8 items-center rounded-full border px-2.5 text-xs", on ? "border-primary bg-primary/10 font-medium text-primary-ink" : "bg-input text-muted-foreground")}>
      {children}
    </button>
  );
}

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await fetch("/api/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => null)) ?? { ok: false, error: "応答を読み取れませんでした" };
  } catch {
    return { ok: false, error: "通信に失敗しました" };
  }
}

/** 確認待ちの理由を、同じ意味の重複をまとめた短い項目名にする（詳細は展開して確認） */
const TOPIC_ORDER = ["締切", "地域", "系列", "店舗", "商品", "応募方式", "応募方法", "受取方法", "応募開始", "当選発表", "購入期間", "応募制限", "条件", "その他"] as const;
type Topic = (typeof TOPIC_ORDER)[number];
const FLAG_TOPIC: Record<string, Topic> = {
  chain: "系列", store: "店舗", items: "商品", multiMode: "応募方式", applyStart: "応募開始", applyDeadline: "締切", resultDate: "当選発表",
  procedureStart: "購入期間", procedureDeadline: "購入期間", applyMethod: "応募方法", receiveMethod: "受取方法", limit: "応募制限", conditions: "条件",
};
const REASON_TOPIC: [RegExp, Topic][] = [
  [/締切/, "締切"], [/地域|都道府県/, "地域"], [/系列/, "系列"], [/店舗/, "店舗"], [/商品/, "商品"], [/受取|受け取り/, "受取方法"], [/応募方法|応募URL|URL/, "応募方法"],
];
export function reviewTopics(c: { reasons: string[]; draft: { flags?: Record<string, string> } | null }): string[] {
  const set = new Set<string>();
  for (const r of c.reasons) for (const [re, t] of REASON_TOPIC) if (re.test(r)) set.add(t);
  for (const [k, v] of Object.entries(c.draft?.flags ?? {})) {
    // 保存すると仮登録されるだけの案内は、確認が必要な項目としては数えない
    if (FLAG_TOPIC[k] && v && !/仮登録されます/.test(v)) set.add(FLAG_TOPIC[k]);
  }
  if (set.size === 0 && c.reasons.length > 0) set.add("その他");
  return TOPIC_ORDER.filter((t) => set.has(t));
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const hrs = (v: number | null) => (v === null ? "—" : v >= 48 ? `${Math.round(v / 24)}日` : `${Math.round(v)}時間`);

/** 直近30日の品質指標。登録率だけでなく、所要時間・締切前の割合・重複・滞留・AI費用を見る */
function MetricsPanel({ m }: { m: PipelineMetrics }) {
  return (
    <div className="space-y-1.5 rounded-md bg-muted/50 p-2 text-xs" data-testid="pipeline-metrics">
      <p className="font-medium">品質指標（直近30日・{m.total}件）</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        <Kv label="登録成功率" value={pct(m.registrationRate)} />
        <Kv label="発見→登録" value={hrs(m.avgHoursToRegister)} />
        <Kv label="締切前に登録" value={pct(m.registeredBeforeDeadlineRate)} />
        <Kv label="重複登録率" value={pct(m.duplicateRate)} />
        <Kv label="確認待ち滞留(平均)" value={hrs(m.reviewAvgHours)} />
        <Kv label="AI費用" value={`${m.aiCostJpy}円（${m.aiCalls}回）`} />
      </dl>
      {m.failedByKind.length > 0 && (
        <p data-testid="failed-by-kind" className="text-muted-foreground">
          失敗の原因: {m.failedByKind.map((f) => `${f.label} ${f.count}`).join("・")}
        </p>
      )}
    </div>
  );
}

/**
 * 区画（動作状況・条件・利用設定・統計）。見出しをタップして開閉する（初期状態は①だけ展開）。
 * 閉じていても中身は保持する（入力途中の設定は消えない）。閉じている間は、概要（summary）と、重大な問題（alert）を見出しに出す。
 */
export function Block({ no, title, tip, testId, children, defaultOpen = false, summary, alert, forceOpen }: { no: string; title: string; tip?: string; testId: string; children?: React.ReactNode; defaultOpen?: boolean; summary?: string; alert?: string | null; forceOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = open || !!forceOpen;
  return (
    <section id={testId} className="scroll-mt-24 rounded-lg border text-sm" data-testid={testId} data-open={shown ? "true" : "false"}>
      <h2 className="flex items-center gap-1.5 px-3 py-2 font-semibold">
        <button type="button" className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={shown} aria-controls={`${testId}-body`} onClick={() => setOpen((v) => !v)} data-testid={`${testId}-toggle`}>
          <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", shown && "rotate-90")} aria-hidden="true" />
          <span className="text-muted-foreground" aria-hidden="true">{no}</span>
          <span>{title}</span>
          {!shown && summary && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground" data-testid={`${testId}-summary`}>{summary}</span>}
        </button>
        {!shown && alert && <span className="shrink-0 text-xs font-medium text-warn" role="alert" data-testid={`${testId}-alert`}>⚠ {alert}</span>}
        {tip && <InfoTip text={tip} label={title + "の説明"} />}
      </h2>
      <div id={`${testId}-body`} hidden={!shown} className="space-y-3 border-t p-3">
        {children}
      </div>
    </section>
  );
}

/** 設定項目1つ（項目名＋ⓘ＋入力）。項目同士は親の divide で区切る */
function SetRow({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1 text-xs font-medium">
        {label}
        {tip && <InfoTip text={tip} label={label + "の説明"} />}
      </p>
      {children}
    </div>
  );
}

/** ラベルと値のまとまり（値は折り返さない） */
function Kv({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("font-semibold", tone === "warn" && "text-warn")}>{value}</dd>
    </div>
  );
}

/** 数値入力＋単位（数値と単位は離さない） */
function Num({ value, unit, label, onChange, wide }: { value: number; unit: string; label: string; onChange: (v: number) => void; wide?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <input className={cn("h-8 rounded-md border bg-input px-2 text-sm", wide ? "w-24" : "w-16")} inputMode="numeric" value={String(value)} aria-label={label} onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "")) || 0)} />
      <span>{unit}</span>
    </span>
  );
}

export function AutoCollectView({
  settings,
  sources,
  candidates,
  counts,
  health,
  ops,
  stats,
  runs,
  products,
  xConfigured,
  aiConfigured,
  usage,
  metrics,
  runSummaries,
}: {
  settings: SettingsView;
  /** 直近30日の品質指標（サーバーで集計） */
  metrics?: PipelineMetrics;
  /** 収集実行ごとの結果（定期・手動。複数のワーカー実行にまたがる解析も同じ収集に紐づく） */
  runSummaries?: RunSummary[];
  sources: SourceView[];
  candidates: CandidateView[];
  /** 全件の数（一覧に表示している件数ではない） */
  counts: Record<(typeof CAND_TABS)[number]["value"], number>;
  health: HealthView;
  ops: OpsView;
  stats: StatRow[];
  runs: RunView[];
  products: { id: string; name: string }[];
  xConfigured: boolean;
  aiConfigured: boolean;
  usage: { xPosts: number; xCostJpy: number; aiCalls: number; newAuto: number };
}) {
  const router = useRouter();
  const { profile, reload } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<(typeof CAND_TABS)[number]["value"]>("pending");
  // URLのハッシュ（#history など）で指定された区画は開いて表示する
  const [hashOpen, setHashOpen] = useState("");
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (!h) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URLのハッシュに応じた表示状態の同期
    setHashOpen(h);
    const t = window.setTimeout(() => document.getElementById(h)?.scrollIntoView({ block: "start" }), 100);
    return () => window.clearTimeout(t);
  }, []);
  const [s, setS] = useState(settings);
  const [showAllPref, setShowAllPref] = useState(false);
  const [productQ, setProductQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<CandidateView | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string) => setExpanded((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [budgetInput, setBudgetInput] = useState({ budget: String(ops.budgetJpy), rate: String(ops.rate) });

  const act = async (key: string, body: Record<string, unknown>, okText?: (r: { ok: boolean; [k: string]: unknown }) => string) => {
    setBusy(key);
    setMsg(null);
    const r = await call(body);
    setBusy(null);
    setMsg({ ok: r.ok, text: r.ok ? (okText?.(r) ?? "完了しました") : (r.error ?? "失敗しました") });
    router.refresh();
    if (r.ok) void reload();
    return r;
  };

  const run = async (sourceId?: string) => {
    const r = await act(sourceId ? `run-${sourceId}` : "run", { action: "run", actor: profile.id, sourceId }, (x) => {
      const n = (x.notices as string[] | undefined) ?? [];
      return `収集しました: 新しい候補${x.newCount}件・解析前に除外${x.screened}件・AI解析${x.aiCalls}回・自動登録${x.registered}件・X取得${x.xPosts}件・解析待ち残り${x.queued}件${n.length ? `（${n.join(" / ")}）` : ""}`;
    });
    return r;
  };

  const toggleArr = (key: "prefectures" | "apply_methods" | "receive_methods" | "req_include" | "req_exclude" | "product_ids", v: string) =>
    setS((cur) => ({ ...cur, [key]: cur[key].includes(v) ? cur[key].filter((x) => x !== v) : [...cur[key], v] }));

  const saveSettings = () =>
    act("save", {
      action: "saveSettings",
      settings: {
        prefectures: s.prefectures, includeOnline: s.include_online, maxDistanceKm: s.max_distance_km, applyMethods: s.apply_methods, receiveMethods: s.receive_methods,
        reqInclude: s.req_include, reqExclude: s.req_exclude, productMode: s.product_mode, productIds: s.product_ids, statusMode: s.status_mode, trackUpcoming: s.track_upcoming !== false, autoRegister: s.auto_register,
        scheduleEnabled: s.schedule_enabled, scheduleHourJst: s.schedule_hour_jst, xEnabled: s.x_enabled, xMonthlyBudgetJpy: s.x_monthly_budget_jpy, xMaxPostsPerRun: s.x_max_posts_per_run, maxAiPerRun: s.max_ai_per_run, workerEnabled: s.worker_enabled, workerBatch: s.worker_batch, recheckHours: s.recheck_hours,
      },
    });

  const [add, setAdd] = useState<{ kind: "web" | "x"; name: string; value: string }>({ kind: "web", name: "", value: "" });
  const addSource = async () => {
    const body = add.kind === "web" ? { kind: "web", name: add.name || add.value, url: add.value } : { kind: "x", name: add.name || add.value, username: add.value };
    const r = await act("add", { action: "addSource", source: body });
    if (r.ok) setAdd({ ...add, name: "", value: "" });
  };

  const js = (c: CandidateView) => c.job_state ?? "";
  const js2 = (c: CandidateView) => c.job_state ?? "";
  const rate = stats.reduce(
    (a, r) => ({ total: a.total + r.ai_success, reg: a.reg + r.registered_new, prov: a.prov + (r.provisional_registered ?? 0), review: a.review + r.review_added, dup: a.dup + r.duplicates, excl: a.excl + r.excluded, failed: a.failed + (r.failed_jobs ?? 0) }),
    { total: 0, reg: 0, prov: 0, review: 0, dup: 0, excl: 0, failed: 0 },
  );
  const toggleSel = (id: string) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const list = candidates.filter((c) =>
    tab === "queued" ? ["pending", "retry", "processing"].includes(js(c)) : tab === "pending" ? js(c) === "review" : tab === "excluded" ? js(c) === "skipped" : tab === "failed" ? js(c) === "failed" : c.status === tab,
  );
  const readyCount = candidates.filter((c) => js2(c) === "review" && c.draft?.ready && c.draft.verdict === "match" && c.kind !== "update").length;
  const prefShown = showAllPref ? PREFECTURE_LIST : PREFECTURE_LIST.filter((p) => s.prefectures.includes(p));
  const reqTags = REQUIREMENT_TAGS.filter((t) => !HIDDEN_REQUIREMENT_TAGS.includes(t.code) && t.code !== "unknown");
  const productList = products.filter((p) => !productQ || p.name.includes(productQ)).slice(0, 60);

  return (
    <div className="space-y-4" data-testid="collection">
      {/* ① 自動収集の動作状況（現在の状態。設定ではない） */}
      <Block no="①" title="動作状況" testId="status" defaultOpen tip="解析待ちは、バックグラウンドのワーカー（Supabase Cron が数分おきに起動）が、締切が近いものから小分けで解析します。待ち時間が長いものは優先度が上がります。失敗は 15分→1時間→4時間後に最大3回再試行し、上限に達したものは「失敗」に隔離します。AI読み取りの上限（時間・日・月額予算・ワーカーの1日の上限）に達すると、次の読み取りを始めません。">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void run()} disabled={busy !== null} data-testid="collect-now">
            {busy === "run" ? "収集しています…" : "今すぐ収集"}
          </Button>
          {readyCount > 0 && (
            <Button variant="outline" size="sm" disabled={busy !== null} data-testid="register-ready" onClick={() => void act("ready", { action: "registerReady", actor: profile.id }, (x) => `登録しました: ${x.registered}件${Number(x.failed) > 0 ? `（失敗${x.failed}件）` : ""}`)}>
              登録可能な{readyCount}件をまとめて登録
            </Button>
          )}
          {health.state === "paused" && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("resume", { action: "resume" }, () => "自動停止を解除しました")}>
              自動停止を解除
            </Button>
          )}
        </div>
        <div className="space-y-1.5 rounded-md bg-muted/50 p-2 text-xs" data-testid="health">
          <p className="font-medium" data-testid="health-state" data-state={health.state}>
            {{ running: "処理中", waiting: "稼働中（解析待ちを順次処理）", ok: "正常（解析待ちなし）", paused: "自動停止中", budget: "月額予算で停止中" }[health.state]}
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <Kv label="最終収集" value={fmt(health.lastCollectAt)} />
            <Kv label="次回予定" value={health.nextCollectAt ? fmt(health.nextCollectAt) : "定期収集は無効"} />
            <Kv label="処理待ち" value={`解析待ち ${counts.queued}（処理中 ${health.processing}）`} />
            <Kv label="エラー" value={counts.failed > 0 || health.warnings.length > 0 ? `失敗 ${counts.failed}件` : "なし"} tone={counts.failed > 0 || health.warnings.length > 0 ? "warn" : undefined} />
            <Kv label="ワーカー最終" value={fmt(health.lastWorkerAt)} />
            <Kv label="今日のAI解析" value={`${health.workerDayUsed}件`} />
          </dl>
          {health.warnings.map((w, i) => (
            <p key={i} className="text-warn" role="alert" data-testid="health-warning">
              ⚠ {w}
            </p>
          ))}
        </div>
        {!aiConfigured && <p className="text-xs text-warn">AIが未設定のため、解析は行われません（候補の取得のみ）。</p>}
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-teal-700 dark:text-teal-300" : "text-danger")} data-testid="collect-msg">
            {msg.text}
          </p>
        )}
      </Block>

      {/* ② 収集対象・条件（設定） */}
      <Block no="②" title="収集対象・条件" testId="conditions" forceOpen={hashOpen === "conditions"} summary={`都道府県${settings.prefectures.length}・自動登録${settings.auto_register ? "ON" : "OFF"}`}>
        <div className="divide-y [&>*]:py-2.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          <SetRow label="受付状況" tip="締切が不明なものは「受付中」とせず、確認待ちにします（時刻を勝手に補いません）。">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={s.status_mode === "open"} onClick={() => setS({ ...s, status_mode: "open" })}>
                現在応募可能のみ
              </Chip>
              <Chip on={s.status_mode === "open_or_before"} onClick={() => setS({ ...s, status_mode: "open_or_before" })}>
                受付前も含む
              </Chip>
            </div>
          </SetRow>
          <SetRow label="受付前の抽選予告" tip="「現在応募可能のみ」のときも、受付前・詳細未発表の抽選を破棄せず、受付が始まるまで追跡します（応募可能としては表示しません）。続報が見つかれば同じ抽選として更新します。">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={s.track_upcoming !== false} onClick={() => setS({ ...s, track_upcoming: true })}>
                追跡する
              </Chip>
              <Chip on={s.track_upcoming === false} onClick={() => setS({ ...s, track_upcoming: false })}>
                追跡しない
              </Chip>
            </div>
          </SetRow>
          <SetRow label={`店頭の対象地域（${s.prefectures.length}）`}>
            <div className="flex flex-wrap gap-1.5" data-testid="pref-chips">
              {prefShown.map((p) => (
                <Chip key={p} on={s.prefectures.includes(p)} onClick={() => toggleArr("prefectures", p)}>
                  {p}
                </Chip>
              ))}
              <button type="button" className="min-h-8 text-xs text-info underline" onClick={() => setShowAllPref((v) => !v)} data-testid="pref-toggle">
                {showAllPref ? "選択中だけ表示" : "追加・除外する"}
              </button>
            </div>
          </SetRow>
          <SetRow label="通販" tip="「全国」の記載だけで発送可能とは判断しません。配送先の制限（居住地域の制限など）がある場合は確認待ちにします。">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="size-4" checked={s.include_online} onChange={(e) => setS({ ...s, include_online: e.target.checked })} />
              <span>通販・発送対応を全国から収集</span>
            </label>
          </SetRow>
          <SetRow label="自宅からの最大距離" tip="道路距離ではなく直線距離です。店舗の位置が未設定の場合は距離不明として確認待ちにします。通販には適用しません。">
            <label className="flex items-center gap-1.5 text-xs">
              <input className="h-8 w-20 rounded-md border bg-input px-2 text-sm" inputMode="numeric" placeholder="制限なし" aria-label="最大距離(km)" value={s.max_distance_km ?? ""} onChange={(e) => setS({ ...s, max_distance_km: /^\d+$/.test(e.target.value) ? Number(e.target.value) : null })} />
              <span className="whitespace-nowrap">km</span>
            </label>
          </SetRow>
          <SetRow label="応募方法・受取方法" tip="未選択は「問わない」。Web応募＝通販とは判定しません（受取方法は別に判定します）。">
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {APPLY_CHANNELS.map((c) => (
                  <Chip key={c.code} on={s.apply_methods.includes(c.code)} onClick={() => toggleArr("apply_methods", c.code)}>
                    {c.label}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {RECEIVE_KINDS.map((c) => (
                  <Chip key={c.code} on={s.receive_methods.includes(c.code)} onClick={() => toggleArr("receive_methods", c.code)}>
                    {c.label}
                  </Chip>
                ))}
              </div>
            </div>
          </SetRow>
          <details className="space-y-1">
            <summary className="flex cursor-pointer items-center gap-1 text-xs font-medium">
              応募条件の絞り込み<span className="whitespace-nowrap font-normal text-muted-foreground">（含む {s.req_include.length}／除外 {s.req_exclude.length}）</span>
              <InfoTip text="「含む」は、選んだ条件のどれかを含む抽選だけ。「除外」は、含む抽選を除きます。応募資格を満たすかは判定しません。一般的な本人確認は対象にしません。" />
            </summary>
            <div className="space-y-1 pt-1">
              {(["req_include", "req_exclude"] as const).map((k) => (
                <div key={k} className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">{k === "req_include" ? "含む条件" : "除外する条件"}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {reqTags.map((t) => (
                      <Chip key={t.code} on={s[k].includes(t.code)} onClick={() => toggleArr(k, t.code)}>
                        {t.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
          <details className="space-y-1">
            <summary className="flex cursor-pointer items-center gap-1 text-xs font-medium">
              商品の絞り込み<span className="font-normal text-muted-foreground">（{s.product_mode === "all" ? "全商品" : s.product_mode === "include" ? `指定${s.product_ids.length}商品のみ` : `指定${s.product_ids.length}商品を除外`}）</span>
              <InfoTip text="マスターに未登録の新商品も候補から除外しません（指定商品のみの場合は、判別できない商品を確認待ちにします）。" />
            </summary>
            <div className="space-y-1.5 pt-1">
              <div className="flex gap-1.5">
                {(["all", "include", "exclude"] as const).map((m) => (
                  <Chip key={m} on={s.product_mode === m} onClick={() => setS({ ...s, product_mode: m })}>
                    {m === "all" ? "全商品" : m === "include" ? "指定商品のみ" : "指定商品を除外"}
                  </Chip>
                ))}
              </div>
              {s.product_mode !== "all" && (
                <div className="space-y-1">
                  <input className={input} placeholder="商品名で検索" value={productQ} onChange={(e) => setProductQ(e.target.value)} aria-label="商品を検索" />
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                    {productList.map((p) => (
                      <Chip key={p.id} on={s.product_ids.includes(p.id)} onClick={() => toggleArr("product_ids", p.id)}>
                        {p.name}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
          <SetRow label="自動登録" tip="★管理対象・応募記録は作りません。既存の手動登録の内容は上書きしません。">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="size-4" checked={s.auto_register} onChange={(e) => setS({ ...s, auto_register: e.target.checked })} />
              <span>条件に合い情報が十分な抽選を「全情報」へ自動登録</span>
            </label>
          </SetRow>
        </div>

        <div className="space-y-2 border-t pt-3" data-testid="sources">
          <h3 className="text-xs font-bold">収集元</h3>
          <ul className="divide-y">
            {sources.map((src) => {
              const st = STATUS_LABEL[src.status] ?? STATUS_LABEL.never;
              return (
                <li key={src.id} className="space-y-1 py-2" data-testid="source-row">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="rounded border px-1 text-[11px]">{src.kind === "web" ? "Web" : "X"}</span>
                    <span className="font-medium">{src.name}</span>
                    <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", st.cls)} data-testid="source-status">
                      {src.enabled ? st.label : "無効"}
                    </span>
                    <label className="ml-auto flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={src.enabled} className="size-4" aria-label={`${src.name}を有効にする`} onChange={(e) => void act("t" + src.id, { action: "toggleSource", id: src.id, enabled: e.target.checked })} />
                      有効
                    </label>
                  </div>
                  <p className="break-all text-[11px] text-muted-foreground">{src.kind === "web" ? src.url : `@${src.x_username}${src.x_user_id ? `（ID ${src.x_user_id}）` : ""}`}</p>
                  <p className="text-[11px] text-muted-foreground" data-testid="source-fresh">
                    最終確認 {fmt(src.last_attempt_at)}／最終成功 {fmt(src.last_success_at)}／取得{src.last_item_count}件・新規候補{src.last_new_count}件
                    {src.last_result && ` ／${{ new: "新規情報あり", changed: "内容変更あり", no_new: "新規情報なし", failed: "収集失敗" }[src.last_result]}`}
                    {(src.consecutive_failures ?? 0) >= 3 && ` ／${src.consecutive_failures}回連続で失敗`}
                  </p>
                  {src.error_message && src.status !== "ok" && (
                    <p className="text-[11px] text-danger" data-testid="source-error">
                      {src.error_message}
                    </p>
                  )}
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" disabled={busy !== null || !src.enabled} onClick={() => void run(src.id)}>
                      この元だけ実行
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm(`「${src.name}」を削除しますか？（収集済みの候補・登録済みの抽選は残ります）`)) void act("d" + src.id, { action: "deleteSource", id: src.id });
                      }}
                    >
                      削除
                    </Button>
                  </div>
                </li>
              );
            })}
            {sources.length === 0 && <li className="py-2 text-xs text-muted-foreground">収集元がありません。</li>}
          </ul>
          <div className="space-y-1.5 rounded-lg border p-2" data-testid="add-source">
            <div className="flex items-center gap-1.5">
              <Chip on={add.kind === "web"} onClick={() => setAdd({ ...add, kind: "web", value: "" })}>
                Webサイト
              </Chip>
              <Chip on={add.kind === "x"} onClick={() => setAdd({ ...add, kind: "x", value: "" })}>
                Xアカウント
              </Chip>
              <InfoTip
                text={
                  add.kind === "web"
                    ? "任意のURLを追加できますが、専用の解析設定が無いサイトは、一覧の外部リンクを告知として読むだけです。リンクが取れない場合は「解析設定が必要」と表示します。robots.txtで許可されていないサイトは取得しません。"
                    : "X公式APIで取得します（APIキーと月額予算の設定が必要。設定するまで呼び出しません）。"
                }
              />
            </div>
            <input className={input} placeholder="名称（任意）" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} aria-label="収集元の名称" />
            <input className={input} placeholder={add.kind === "web" ? "https://…（抽選情報の一覧ページ）" : "アカウント名（例: pokecachan）"} value={add.value} onChange={(e) => setAdd({ ...add, value: e.target.value })} aria-label={add.kind === "web" ? "収集するURL" : "Xのアカウント名"} />
            <Button size="sm" disabled={busy !== null || !add.value.trim()} onClick={() => void addSource()} data-testid="add-source-submit">
              追加
            </Button>
          </div>
        </div>
      </Block>

      {/* ③ AI・X APIの利用設定（設定値と現在の使用量） */}
      <Block no="③" title="AI・X APIの利用設定" testId="run-settings" forceOpen={hashOpen === "run-settings"} summary={`今月 ${Math.round(ops.monthCostJpy).toLocaleString("ja-JP")}円／${ops.budgetJpy.toLocaleString("ja-JP")}円`} alert={health.state === "paused" ? "自動停止中" : health.state === "budget" ? "月額予算で停止中" : null}>
        <div className="divide-y [&>*]:py-2.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          <SetRow label="定期実行" tip="AI解析（有料）を使うため、初期は無効です。定期実行の呼び出し設定（Cron）は別途必要です。定期実行では候補の作成まで行い、登録は手動実行または候補画面から行います。">
            <label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <input type="checkbox" className="size-4" checked={s.schedule_enabled} onChange={(e) => setS({ ...s, schedule_enabled: e.target.checked })} data-testid="schedule-enabled" />
              <span className="whitespace-nowrap">毎日</span>
              <select className="h-8 rounded-md border bg-input px-1" value={s.schedule_hour_jst} onChange={(e) => setS({ ...s, schedule_hour_jst: Number(e.target.value) })} aria-label="実行時刻（日本時間）">
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </select>
              <span className="whitespace-nowrap">に実行</span>
            </label>
          </SetRow>
          <SetRow label="AI解析の上限">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
              <span className="whitespace-nowrap text-muted-foreground">1回の収集</span>
              <Num value={s.max_ai_per_run} unit="件" label="1回のAI解析の上限" onChange={(v) => setS({ ...s, max_ai_per_run: Math.min(50, Math.max(1, v || 1)) })} />
              <span className="whitespace-nowrap text-muted-foreground">ワーカー1回</span>
              <Num value={s.worker_batch} unit="件" label="ワーカー1回の解析件数" onChange={(v) => setS({ ...s, worker_batch: Math.min(20, Math.max(1, v || 1)) })} />
            </div>
          </SetRow>
          <SetRow label="解析ワーカー" tip="アプリを閉じていても、解析待ちを自動で解析し続けます。告知ページは指定の間隔で再確認します。">
            <div className="space-y-1.5 text-xs">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4" checked={s.worker_enabled} onChange={(e) => setS({ ...s, worker_enabled: e.target.checked })} data-testid="worker-enabled" />
                <span>解析待ちを自動で解析する</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="whitespace-nowrap text-muted-foreground">告知ページの再確認</span>
                <Num value={s.recheck_hours} unit="時間ごと" label="告知ページを再確認する間隔(時間)" onChange={(v) => setS({ ...s, recheck_hours: Math.min(168, Math.max(1, v || 1)) })} />
              </div>
            </div>
          </SetRow>
          <SetRow label="X公式API（従量課金）">
            <div className="space-y-1.5 text-xs">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4" checked={s.x_enabled} onChange={(e) => setS({ ...s, x_enabled: e.target.checked })} data-testid="x-enabled" />
                <span>X公式APIを使う</span>
              </label>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                <span className="whitespace-nowrap text-muted-foreground">月額予算</span>
                <Num value={s.x_monthly_budget_jpy} unit="円" wide label="X APIの月額予算(円)" onChange={(v) => setS({ ...s, x_monthly_budget_jpy: Math.max(0, v) })} />
                <span className="whitespace-nowrap text-muted-foreground">1回の取得上限</span>
                <Num value={s.x_max_posts_per_run} unit="投稿" label="1回の取得上限(投稿)" onChange={(v) => setS({ ...s, x_max_posts_per_run: Math.min(100, Math.max(5, v || 5)) })} />
              </div>
              <p className="text-[11px] text-muted-foreground" data-testid="x-state">
                <span className="whitespace-nowrap">APIキー（X_BEARER_TOKEN）: {xConfigured ? "設定済み" : "未設定"}</span>
                <InfoTip text="予算が0円、またはキー未設定の間は、X APIを呼びません。1投稿あたり約0.005米ドルの従量課金（公開情報。X Developer Consoleで確認してください）。予算に達すると停止します。" />
              </p>
            </div>
          </SetRow>
          <SetRow label="AI月額予算" tip="AIの利用記録の実際の入出力トークン数に、モデル別の単価（Anthropic公式の料金ページで確認した値）と為替レートを掛けた推定です。画像・再試行も記録した分は含みます。月の区切りは日本時間です。X APIの料金は別に集計します。残額が「1回の見込み（約8円）×件数」に満たない分は、安全のため新しい解析を始めません。実際の請求額はAnthropic Consoleで確認してください。アプリ内の停止条件であり、外部サービスの課金上限は変更しません。">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs" data-testid="budget">
              <Num value={Number(budgetInput.budget || 0)} unit="円" wide label="AI月額予算(円)" onChange={(v) => setBudgetInput({ ...budgetInput, budget: String(v) })} />
              <span className="whitespace-nowrap">為替 1ドル=</span>
              <input className="h-8 w-16 rounded-md border bg-input px-2 text-sm" inputMode="decimal" value={budgetInput.rate} aria-label="為替レート(円)" onChange={(e) => setBudgetInput({ ...budgetInput, rate: e.target.value.replace(/[^\d.]/g, "") })} />
              <span className="whitespace-nowrap">円</span>
              <Button size="sm" variant="outline" disabled={busy !== null} data-testid="save-budget" onClick={() => void act("bud", { action: "setAiBudget", budgetJpy: Number(budgetInput.budget || 0), rate: Number(budgetInput.rate || 150), actor: profile.id }, () => "予算とレートを保存しました")}>
                保存
              </Button>
            </div>
          </SetRow>
          {/* 現在の使用量（設定値ではなく、いまの実績） */}
          <div className="space-y-1" data-testid="ops">
            <p className="text-xs font-medium">現在の使用量</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-muted/50 p-2 text-xs">
              <div>
                <dt className="text-[11px] text-muted-foreground">本日のAI解析</dt>
                <dd className="whitespace-nowrap font-semibold" data-testid="ops-ai">
                  {ops.todayAi}件
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-muted-foreground">今月のAI費用（推定）／予算</dt>
                <dd className="font-semibold" data-testid="ops-cost">
                  <span className="whitespace-nowrap">{Math.round(ops.monthCostJpy).toLocaleString("ja-JP")}円／{ops.budgetJpy.toLocaleString("ja-JP")}円</span>
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-muted-foreground">今月のX取得</dt>
                <dd className="whitespace-nowrap font-semibold" data-testid="collect-usage">{usage.xPosts}件（約{usage.xCostJpy}円）</dd>
              </div>
              <div>
                <dt className="text-[11px] text-muted-foreground">今月のAI解析</dt>
                <dd className="font-semibold" data-testid="avg-cost">
                  <span className="whitespace-nowrap">{ops.monthCalls}回</span>
                  {ops.avgPerCallJpy !== null && <span className="text-[11px] font-normal text-muted-foreground">（平均 約{ops.avgPerCallJpy.toFixed(2)}円）</span>}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <Button onClick={() => void saveSettings()} disabled={busy !== null} data-testid="save-conditions">
          {busy === "save" ? "保存しています…" : "設定を保存"}
        </Button>
      </Block>

      {/* ④ 統計・処理履歴（過去の実績） */}
      <Block no="④" title="統計・処理履歴" testId="history" forceOpen={hashOpen === "history"} summary={`確認待ち${counts.pending}・登録済み${counts.auto_registered}`} alert={counts.failed > 0 ? `失敗${counts.failed}件` : null}>
        {runSummaries && runSummaries.length > 0 && (
          <div className="space-y-1.5" data-testid="run-summaries">
            <p className="text-xs font-medium">収集ごとの結果（その収集で発見した候補だけを集計）</p>
            <ul className="space-y-1.5">
              {runSummaries.map((s) => (
                <li key={s.runId} className="space-y-1 rounded-md border p-2" data-testid="run-summary">
                  <p className="flex items-center gap-2 text-xs font-medium">
                    {runTitle(s)}
                    <RunStateLabel s={s} />
                    {!s.legacy && s.costJpy > 0 && <span className="font-normal text-muted-foreground">AI約{s.costJpy}円</span>}
                  </p>
                  <RunCounts s={s} compact />
                  {!s.legacy && (s.excluded > 0 || s.duplicates > 0) && (
                    <p className="text-[11px] text-muted-foreground">
                      対象外 {s.excluded}件・重複 {s.duplicates}件
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {metrics && <MetricsPanel m={metrics} />}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-4" data-testid="ops-stats">
          <div>
            <dt className="text-[11px] text-muted-foreground">本日の新規発見</dt>
            <dd className="font-semibold" data-testid="ops-discovered">
              {ops.todayDiscovered}件{ops.todayDiscoveredInitial > 0 && <span className="text-[11px] font-normal text-muted-foreground">（初回取込{ops.todayDiscoveredInitial}）</span>}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">本日の新規登録</dt>
            <dd className="font-semibold" data-testid="ops-registered">{ops.todayRegistered}件</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">確認待ち</dt>
            <dd className="font-semibold" data-testid="ops-pending">{counts.pending}件</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">取得失敗</dt>
            <dd className="font-semibold">{counts.failed}件</dd>
          </div>
          <div className="col-span-2 sm:col-span-4" data-testid="ops-rate">
            <dt className="flex items-center gap-1 text-[11px] text-muted-foreground">
              自動登録率
              <InfoTip text="AI解析が完了した候補のうち、自動登録できた割合（直近30日）。仮登録を伴うものを含みます。" />
            </dt>
            <dd className="font-semibold">
              {rate.total > 0 ? `${Math.round((rate.reg / rate.total) * 100)}%` : "—"}
              <span className="text-[11px] font-normal text-muted-foreground">
                {" "}30日: 解析{rate.total}→登録{rate.reg}（仮{rate.prov}）／確認待ち+{rate.review}／重複{rate.dup}／対象外{rate.excl}／失敗{rate.failed}
              </span>
            </dd>
          </div>
        </dl>
        <details data-testid="stats">
          <summary className="min-h-8 cursor-pointer text-xs font-medium text-info">日別の統計（30日）</summary>
          <div className="mt-2 space-y-2">
            <div className="flex h-16 items-end gap-px" role="img" aria-label="日別の新規発見・AI解析・登録の推移" data-testid="stats-chart">
              {[...stats].reverse().map((r) => {
                const mx = Math.max(1, ...stats.map((x) => Math.max(x.discovered_new + x.discovered_initial, x.ai_calls, x.registered_new)));
                const bar = (v: number, cls: string, label: string) => <span key={label} title={`${r.day} ${label} ${v}`} className={cn("w-full min-w-px rounded-t", cls)} style={{ height: `${Math.max(v > 0 ? 3 : 0, (v / mx) * 60)}px` }} />;
                return (
                  <span key={r.day} className="flex flex-1 items-end gap-px">
                    {bar(r.discovered_new + r.discovered_initial, "bg-info/70", "新規発見")}
                    {bar(r.ai_calls, "bg-muted-foreground/60", "AI解析")}
                    {bar(r.registered_new, "bg-success", "登録")}
                  </span>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              <span className="text-info">■</span> 新規発見　<span className="text-muted-foreground">■</span> AI解析　<span className="text-success">■</span> 実際に登録
            </p>
            <div className="max-h-72 overflow-auto rounded border">
              <table className="w-full text-[11px]" data-testid="stats-table">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr>
                    <th className="p-1">日付</th>
                    <th className="p-1">新規発見</th>
                    <th className="p-1">更新検出</th>
                    <th className="p-1">重複</th>
                    <th className="p-1">除外</th>
                    <th className="p-1">AI(成功/失敗)</th>
                    <th className="p-1">登録(仮)</th>
                    <th className="p-1">更新反映</th>
                    <th className="p-1">確認待ち+</th>
                    <th className="p-1">失敗</th>
                    <th className="p-1">解析待ち残</th>
                    <th className="p-1">トークン(入/出)</th>
                    <th className="p-1">費用</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((r) => (
                    <tr key={r.day} className="border-t" data-testid="stats-row">
                      <td className="p-1">{r.day.slice(5)}</td>
                      <td className="p-1">{r.discovered_new}{r.discovered_initial > 0 && <span className="text-muted-foreground">＋初回{r.discovered_initial}</span>}</td>
                      <td className="p-1">{r.changed}</td>
                      <td className="p-1">{r.duplicates}</td>
                      <td className="p-1">{r.excluded}</td>
                      <td className="p-1">{r.ai_calls}（{r.ai_success}/{r.ai_failed}）</td>
                      <td className="p-1">{r.registered_new}{(r.provisional_registered ?? 0) > 0 && <span className="text-muted-foreground">（{r.provisional_registered}）</span>}</td>
                      <td className="p-1">{r.updated_existing}</td>
                      <td className="p-1">{r.review_added}</td>
                      <td className="p-1">{r.failed_jobs ?? 0}</td>
                      <td className="p-1">{r.queue_remaining ?? "—"}</td>
                      <td className="p-1">{r.input_tokens.toLocaleString("ja-JP")}/{r.output_tokens.toLocaleString("ja-JP")}</td>
                      <td className="p-1">{Number(r.cost_jpy).toFixed(2)}円</td>
                    </tr>
                  ))}
                  {stats.length === 0 && (
                    <tr>
                      <td colSpan={13} className="p-2 text-muted-foreground">
                        まだ統計がありません。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </details>
        <div className="space-y-1 border-t pt-3" data-testid="runs">
          <h3 className="text-xs font-bold">処理履歴</h3>
          <ul className="divide-y text-xs">
            {runs.map((r) => (
              <li key={r.id} className="space-y-0.5 py-1.5">
                <p>
                  <span className="text-muted-foreground">{fmt(r.started_at)}</span> {r.trigger === "cron" ? "定期" : "手動"}・{r.status === "done" ? "完了" : r.status === "running" ? "実行中" : "失敗"}／新規{r.new_count}・登録{r.registered_count}・AI{r.ai_calls}・X取得{r.x_posts}・エラー{r.error_count}
                </p>
                {(r.summary ?? []).map((x, i) => (
                  <p key={i} className="pl-2 text-[11px] text-muted-foreground">
                    {x.name}: {x.message}
                  </p>
                ))}
              </li>
            ))}
            {runs.length === 0 && <li className="py-1.5 text-muted-foreground">まだ収集していません。</li>}
          </ul>
        </div>
      </Block>

      <section id="candidates" className="scroll-mt-24 space-y-2 rounded-lg border p-3 text-sm" data-testid="candidates">
        <h2 className="font-semibold">収集候補</h2>
        <div role="tablist" aria-label="候補の種類" className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5 sm:grid-cols-6">
          {CAND_TABS.map((t) => (
            <button key={t.value} role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={cn("min-h-9 rounded-md px-0 text-[11px] font-medium leading-tight", tab === t.value ? "bg-primary text-primary-foreground" : "hover:bg-card")} data-testid={`cand-tab-${t.value}`}>
              {t.label}
              <span className="ml-0.5 opacity-80" data-testid={`cand-count-${t.value}`}>{counts[t.value]}</span>
            </button>
          ))}
        </div>
        {tab === "pending" && list.some((c) => c.job_state === "review" && c.kind !== "update") && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="bulk-bar">
            <Button size="sm" variant="outline" onClick={() => setSel(new Set(list.filter((c) => c.job_state === "review" && c.kind !== "update").map((c) => c.id)))} data-testid="bulk-all">
              すべて選択
            </Button>
            <Button size="sm" variant="outline" disabled={sel.size === 0} onClick={() => setSel(new Set())}>
              解除
            </Button>
            <Button size="sm" disabled={busy !== null || sel.size === 0} data-testid="bulk-register" onClick={() => void act("br", { action: "bulkRegister", ids: [...sel].slice(0, 50), actor: profile.id }, (x) => `登録しました: ${x.registered}件${Number(x.failed) > 0 ? `（失敗${x.failed}件）` : ""}`).then(() => setSel(new Set()))}>
              選択を登録（{sel.size}）
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null || sel.size === 0} data-testid="bulk-exclude" onClick={() => void act("bx", { action: "bulkExclude", ids: [...sel].slice(0, 100) }, (x) => `除外しました: ${x.excluded}件`).then(() => setSel(new Set()))}>
              選択を除外
            </Button>
          </div>
        )}
        <ul className="divide-y">
          {list.map((c) => {
            const d = c.draft?.input;
            const queuedOnly = ["pending", "retry", "processing"].includes(c.job_state ?? "");
            const topics = reviewTopics(c);
            const uniqueReasons = [...new Set(c.reasons)];
            return (
              <li key={c.id} className="space-y-1 py-2 text-xs" data-testid="candidate-row">
                <p className="flex items-start gap-1.5 font-medium">
                  {c.job_state === "review" && c.kind !== "update" && (
                    <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={sel.has(c.id)} onChange={() => toggleSel(c.id)} aria-label="選択" data-testid="cand-select" />
                  )}
                  <span>{d ? `${d.chain?.name ?? ""} ${d.store?.name ?? ""} ${d.items?.[0]?.product.name ?? ""}`.trim() || c.title : c.title}</span>
                </p>
                <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                  {d?.applyDeadline && <span>締切: {d.applyDeadline.precision === "unknown" ? "不明" : `${d.applyDeadline.date ?? ""}${d.applyDeadline.time ? ` ${d.applyDeadline.time}` : ""}`}</span>}
                  {topics.length > 0 && (
                    <span className="font-medium text-warn" data-testid="cand-topics">
                      要確認：{topics.slice(0, 5).join("・")}
                      {topics.length > 5 && "ほか"}
                    </span>
                  )}
                  {queuedOnly && (
                    <span>
                      {c.job_state === "processing" ? "解析中" : c.job_state === "retry" ? `再試行待ち（${c.attempts ?? 0}回失敗）` : "解析待ち"}
                      {c.due_at && `／一覧の締切 ${fmt(c.due_at)}`}
                    </span>
                  )}
                  {c.kind === "update" && c.draft?.update && <span className="font-medium text-info">更新の提案（既存の抽選）</span>}
                  {(c.reasons.length > 0 || d) && (
                    <button type="button" className="inline-flex min-h-6 items-center gap-0.5 text-info underline" aria-expanded={expanded.has(c.id)} onClick={() => toggleOpen(c.id)} data-testid="cand-detail-toggle">
                      詳細
                    </button>
                  )}
                </p>
                {expanded.has(c.id) && (
                  <div className="space-y-1 rounded-md border bg-muted/50 p-2 text-[11px] leading-relaxed" data-testid="cand-detail">
                    {uniqueReasons.length > 0 && <ul className="list-disc pl-4">{uniqueReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                    {d && (
                      <p className="text-muted-foreground">
                        AI解析: 系列「{d.chain?.name || "不明"}」／店舗「{d.store?.name || "不明"}」／商品「{(d.items ?? []).map((x) => x.product.name).filter(Boolean).join("、") || "不明"}」
                      </p>
                    )}
                    {(c.draft?.provisional?.length ?? 0) > 0 && (
                      <p className="text-info" data-testid="cand-provisional">
                        登録すると、未登録の{c.draft!.provisional!.join("・")}を仮登録します（マスター管理で確認・編集できます）
                      </p>
                    )}
                    {(c.draft?.secondary?.length ?? 0) > 0 && <p className="text-warn">二次情報（まとめサイトの一覧）から補った項目: {c.draft!.secondary!.join("・")}</p>}
                    {(c.draft?.notices ?? []).map((n, i) => (
                      <p key={i} className={/未取得|解析できていません/.test(n) ? "text-warn" : "text-muted-foreground"}>{n}</p>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  {c.kind === "update" && c.draft?.update && (
                    <Button size="sm" disabled={busy !== null} data-testid="cand-apply-update" onClick={() => void act("a" + c.id, { action: "applyUpdate", id: c.id }, (x) => `反映しました（${x.applied}項目）`)}>
                      更新を反映
                    </Button>
                  )}
                  {c.job_state === "review" && c.kind !== "update" && d && (
                    <Button size="sm" disabled={busy !== null} data-testid="cand-edit" onClick={() => setEditing(c)}>
                      編集して登録
                    </Button>
                  )}
                  {c.source_url && (
                    <a href={c.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center text-info underline" data-testid="cand-source">
                      元の情報
                    </a>
                  )}
                  {c.status === "excluded" && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("u" + c.id, { action: "restore", id: c.id })}>
                      確認待ちに戻す
                    </Button>
                  )}
                  {c.lottery_id && (
                    <a href={`/lotteries?focus=${c.lottery_id}`} className="inline-flex min-h-8 items-center underline">
                      抽選を開く
                    </a>
                  )}
                  {(c.job_state === "review" || c.job_state === "failed" || c.status === "pending" || c.status === "failed" || c.status === "duplicate") && c.kind !== "update" && (
                    <details className="relative ml-auto" data-testid="cand-menu">
                      <summary className="inline-flex min-h-8 min-w-8 cursor-pointer list-none items-center justify-center rounded-md border px-2" aria-label="その他の操作">
                        <MoreHorizontal className="size-4" aria-hidden="true" />
                      </summary>
                      <div className="absolute right-0 z-10 mt-1 flex w-40 flex-col gap-1 rounded-md border bg-card p-1.5 shadow-md">
                        {c.job_state === "review" && d && (
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("r" + c.id, { action: "register", id: c.id, actor: profile.id }, () => "登録しました（全情報に追加。★管理対象ではありません）")} data-testid="cand-register">
                            そのまま登録
                          </Button>
                        )}
                        {(c.job_state === "review" || c.job_state === "failed") && c.source_url && !/ロボット|許可していません/.test(c.last_error ?? "") && (
                          <Button size="sm" variant="outline" disabled={busy !== null} data-testid="cand-reanalyze" onClick={() => void act("re" + c.id, { action: "reanalyze", id: c.id }, () => "再解析待ちに戻しました（ワーカーが解析します）")}>
                            再解析
                          </Button>
                        )}
                        {(c.status === "pending" || c.status === "failed" || c.status === "duplicate") && (
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("x" + c.id, { action: "exclude", id: c.id })} data-testid="cand-exclude">
                            除外
                          </Button>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
          {list.length === 0 && <li className="py-2 text-xs text-muted-foreground">該当する候補はありません。</li>}
        </ul>
      </section>

      {editing?.draft?.input && (
        <LotteryFormDialog
          open
          lottery={null}
          onOpenChange={(v) => !v && setEditing(null)}
          prefill={{
            draft: { input: editing.draft.input, flags: (editing.draft.flags ?? {}) as never, modePending: Boolean(editing.draft.modePending), duplicates: [], warnings: editing.draft.warnings ?? [], evidence: (editing.draft.evidence ?? {}) as never, generalNotes: [], candidates: { chain: [], store: [], items: [] }, summary: (editing.draft.summary ?? { chain: "none", store: "none", items: [] }) as never } as unknown as LotteryDraft,
            runId: null,
          }}
          onSaved={(lotteryId) => {
            const id = editing.id;
            setEditing(null);
            if (lotteryId) void act("mr" + id, { action: "markRegistered", id, lotteryId }, () => "登録しました");
          }}
        />
      )}
    </div>
  );
}
