"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
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
  auto_register: boolean;
  schedule_enabled: boolean;
  schedule_hour_jst: number;
  x_enabled: boolean;
  x_monthly_budget_jpy: number;
  x_max_posts_per_run: number;
  max_ai_per_run: number;
  worker_enabled: boolean;
  worker_batch: number;
  worker_daily_ai_limit: number;
  recheck_hours: number;
}
export interface CandidateView {
  id: string;
  source_id: string | null;
  title: string;
  source_url: string | null;
  status: "auto_registered" | "pending" | "excluded" | "duplicate" | "failed";
  reasons: string[];
  draft: { update?: { changes: { label: string; before: string; after: string }[] } | null; ready?: boolean; verdict?: string; input?: { chain?: { name: string }; store?: { name: string }; items?: { product: { name: string } }[]; applyDeadline?: { precision: string; date?: string; time?: string } }; queued?: unknown } | null;
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

export function AutoCollectView({
  settings,
  sources,
  candidates,
  counts,
  health,
  runs,
  products,
  xConfigured,
  aiConfigured,
  usage,
}: {
  settings: SettingsView;
  sources: SourceView[];
  candidates: CandidateView[];
  /** 全件の数（一覧に表示している件数ではない） */
  counts: Record<(typeof CAND_TABS)[number]["value"], number>;
  health: HealthView;
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
  const [s, setS] = useState(settings);
  const [showAllPref, setShowAllPref] = useState(false);
  const [productQ, setProductQ] = useState("");

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
        reqInclude: s.req_include, reqExclude: s.req_exclude, productMode: s.product_mode, productIds: s.product_ids, statusMode: s.status_mode, autoRegister: s.auto_register,
        scheduleEnabled: s.schedule_enabled, scheduleHourJst: s.schedule_hour_jst, xEnabled: s.x_enabled, xMonthlyBudgetJpy: s.x_monthly_budget_jpy, xMaxPostsPerRun: s.x_max_posts_per_run, maxAiPerRun: s.max_ai_per_run, workerEnabled: s.worker_enabled, workerBatch: s.worker_batch, workerDailyAiLimit: s.worker_daily_ai_limit, recheckHours: s.recheck_hours,
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
  const list = candidates.filter((c) =>
    tab === "queued" ? ["pending", "retry", "processing"].includes(js(c)) : tab === "pending" ? js(c) === "review" : tab === "excluded" ? js(c) === "skipped" : tab === "failed" ? js(c) === "failed" : c.status === tab,
  );
  const readyCount = candidates.filter((c) => js2(c) === "review" && c.draft?.ready && c.draft.verdict === "match" && c.kind !== "update").length;
  const queued = counts.queued;
  const prefShown = showAllPref ? PREFECTURE_LIST : PREFECTURE_LIST.filter((p) => s.prefectures.includes(p));
  const reqTags = REQUIREMENT_TAGS.filter((t) => !HIDDEN_REQUIREMENT_TAGS.includes(t.code) && t.code !== "unknown");
  const productList = products.filter((p) => !productQ || p.name.includes(productQ)).slice(0, 60);

  return (
    <div className="space-y-4" data-testid="collection">
      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void run()} disabled={busy !== null} data-testid="collect-now">
            {busy === "run" ? "収集しています…" : "今すぐ収集"}
          </Button>
          {readyCount > 0 && (
            <Button variant="outline" size="sm" disabled={busy !== null} data-testid="register-ready" onClick={() => void act("ready", { action: "registerReady", actor: profile.id }, (x) => `登録しました: ${x.registered}件${Number(x.failed) > 0 ? `（失敗${x.failed}件）` : ""}`)}>
              登録可能な{readyCount}件をまとめて登録
            </Button>
          )}
          <span className="text-xs text-muted-foreground" data-testid="collect-usage">
            今月: AI解析{usage.aiCalls}回・X取得{usage.xPosts}件（約{usage.xCostJpy}円）／自動収集のNEW {usage.newAuto}件
          </span>
        </div>
        {!aiConfigured && <p className="text-xs text-warn">AIが未設定のため、解析は行われません（候補の取得のみ）。</p>}
        {queued > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="queued-note">
            解析待ちが{queued}件あります。締切が近いものから、AI読み取りの上限の範囲で順に解析します（ワーカーが自動で続けます）。
          </p>
        )}
        <div className="space-y-1 rounded-md bg-muted/50 p-2 text-xs" data-testid="health">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="font-medium" data-testid="health-state" data-state={health.state}>
              {{ running: "処理中", waiting: "待機中（解析待ちあり）", ok: "正常（解析待ちなし）", paused: "自動停止中", budget: "上限で停止中" }[health.state]}
            </span>
            <span className="text-muted-foreground">解析待ち {counts.queued}（処理中 {health.processing}）／確認待ち {counts.pending}／失敗 {counts.failed}／除外 {counts.excluded}</span>
            <details className="inline">
              <summary className="inline cursor-pointer text-info" aria-label="処理状態の説明">ⓘ</summary>
              <span className="block pt-1 text-[11px] text-muted-foreground">
                解析待ちは、バックグラウンドのワーカー（Supabase Cron が数分おきに起動）が、締切が近いものから小分けで解析します。待ち時間が長いものは優先度が上がります。失敗は 15分→1時間→4時間後に最大3回再試行し、上限に達したものは「失敗」に隔離します。AI読み取りの上限（時間・日・月額予算・ワーカーの1日の上限）に達すると、次の読み取りを始めません。
              </span>
            </details>
          </p>
          <p className="text-[11px] text-muted-foreground">
            最終収集 {fmt(health.lastCollectAt)}／ワーカー最終実行 {fmt(health.lastWorkerAt)}／次回の定期収集 {health.nextCollectAt ? fmt(health.nextCollectAt) : "（定期収集は無効）"}／ワーカー今日のAI {health.workerDayUsed}/{settings.worker_daily_ai_limit}
          </p>
          {health.warnings.map((w, i) => (
            <p key={i} className="text-warn" role="alert" data-testid="health-warning">
              ⚠ {w}
            </p>
          ))}
          {health.state === "paused" && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("resume", { action: "resume" }, () => "自動停止を解除しました")}>
              自動停止を解除
            </Button>
          )}
        </div>
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-teal-700 dark:text-teal-300" : "text-danger")} data-testid="collect-msg">
            {msg.text}
          </p>
        )}
      </section>

      <section className="space-y-2 rounded-lg border p-3 text-sm" data-testid="sources">
        <h2 className="font-semibold">収集元</h2>
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
          <div className="flex gap-1.5">
            <Chip on={add.kind === "web"} onClick={() => setAdd({ ...add, kind: "web", value: "" })}>
              Webサイト
            </Chip>
            <Chip on={add.kind === "x"} onClick={() => setAdd({ ...add, kind: "x", value: "" })}>
              Xアカウント
            </Chip>
          </div>
          <input className={input} placeholder="名称（任意）" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} aria-label="収集元の名称" />
          <input className={input} placeholder={add.kind === "web" ? "https://…（抽選情報の一覧ページ）" : "アカウント名（例: pokecachan）"} value={add.value} onChange={(e) => setAdd({ ...add, value: e.target.value })} aria-label={add.kind === "web" ? "収集するURL" : "Xのアカウント名"} />
          <Button size="sm" disabled={busy !== null || !add.value.trim()} onClick={() => void addSource()} data-testid="add-source-submit">
            追加
          </Button>
          <p className="text-[11px] text-muted-foreground">
            {add.kind === "web"
              ? "任意のURLを追加できますが、専用の解析設定が無いサイトは、一覧の外部リンクを告知として読むだけです。リンクが取れない場合は「解析設定が必要」と表示します。robots.txtで許可されていないサイトは取得しません。"
              : "X公式APIで取得します（APIキーと月額予算の設定が必要。設定するまで呼び出しません）。"}
          </p>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border p-3 text-sm" data-testid="conditions">
        <h2 className="font-semibold">収集条件</h2>
        <div className="space-y-1">
          <p className="text-xs font-medium">受付状況</p>
          <div className="flex flex-wrap gap-1.5">
            <Chip on={s.status_mode === "open"} onClick={() => setS({ ...s, status_mode: "open" })}>
              現在応募可能のみ
            </Chip>
            <Chip on={s.status_mode === "open_or_before"} onClick={() => setS({ ...s, status_mode: "open_or_before" })}>
              受付前も含む
            </Chip>
          </div>
          <p className="text-[11px] text-muted-foreground">締切が不明なものは「受付中」とせず、確認待ちにします（時刻を勝手に補いません）。</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium">店頭の対象都道府県（{s.prefectures.length}）</p>
          <div className="flex flex-wrap gap-1.5" data-testid="pref-chips">
            {prefShown.map((p) => (
              <Chip key={p} on={s.prefectures.includes(p)} onClick={() => toggleArr("prefectures", p)}>
                {p}
              </Chip>
            ))}
            <button type="button" className="text-xs text-info underline" onClick={() => setShowAllPref((v) => !v)} data-testid="pref-toggle">
              {showAllPref ? "選択中だけ表示" : "追加・除外する"}
            </button>
          </div>
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="size-4" checked={s.include_online} onChange={(e) => setS({ ...s, include_online: e.target.checked })} />
            通販・発送対応の抽選を全国から収集する
          </label>
          <p className="text-[11px] text-muted-foreground">「全国」の記載だけで発送可能とは判断しません。配送先の制限（居住地域の制限など）がある場合は確認待ちにします。</p>
          <label className="flex items-center gap-2 text-xs">
            自宅からの最大距離（直線）
            <input className="h-8 w-20 rounded-md border bg-input px-2 text-sm" inputMode="numeric" placeholder="制限なし" aria-label="最大距離(km)" value={s.max_distance_km ?? ""} onChange={(e) => setS({ ...s, max_distance_km: /^\d+$/.test(e.target.value) ? Number(e.target.value) : null })} />
            km
          </label>
          <p className="text-[11px] text-muted-foreground">道路距離ではなく直線距離です。店舗の位置が未設定の場合は距離不明として確認待ちにします。通販には適用しません。</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium">応募方法（未選択＝問わない）</p>
          <div className="flex flex-wrap gap-1.5">
            {APPLY_CHANNELS.map((c) => (
              <Chip key={c.code} on={s.apply_methods.includes(c.code)} onClick={() => toggleArr("apply_methods", c.code)}>
                {c.label}
              </Chip>
            ))}
          </div>
          <p className="text-xs font-medium">受取方法（未選択＝問わない）</p>
          <div className="flex flex-wrap gap-1.5">
            {RECEIVE_KINDS.map((c) => (
              <Chip key={c.code} on={s.receive_methods.includes(c.code)} onClick={() => toggleArr("receive_methods", c.code)}>
                {c.label}
              </Chip>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">Web応募＝通販とは判定しません（受取方法は別に判定します）。</p>
        </div>
        <details className="space-y-1">
          <summary className="cursor-pointer text-xs font-medium">応募条件の絞り込み（含む {s.req_include.length}／除外 {s.req_exclude.length}）</summary>
          <p className="text-[11px] text-muted-foreground">「含む」は、選んだ条件のどれかを含む抽選だけ。「除外」は、含む抽選を除きます。応募資格を満たすかは判定しません。一般的な本人確認は対象にしません。</p>
          <div className="space-y-1">
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
          <summary className="cursor-pointer text-xs font-medium">商品の絞り込み（{s.product_mode === "all" ? "ポケモンカード全商品" : s.product_mode === "include" ? `指定した${s.product_ids.length}商品のみ` : `指定した${s.product_ids.length}商品を除外`}）</summary>
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
          <p className="text-[11px] text-muted-foreground">マスターに未登録の新商品も候補から除外しません（指定商品のみの場合は、判別できない商品を確認待ちにします）。</p>
        </details>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" className="size-4" checked={s.auto_register} onChange={(e) => setS({ ...s, auto_register: e.target.checked })} />
          条件に合い、情報が十分な抽選を「全情報」へ自動登録する（★管理対象・応募記録は作りません）
        </label>

        <div className="space-y-1.5 rounded-lg border p-2" data-testid="run-settings">
          <p className="text-xs font-medium">実行・費用の管理</p>
          <label className="flex flex-wrap items-center gap-2 text-xs">
            <input type="checkbox" className="size-4" checked={s.schedule_enabled} onChange={(e) => setS({ ...s, schedule_enabled: e.target.checked })} data-testid="schedule-enabled" />
            定期実行する（毎日
            <select className="h-8 rounded-md border bg-input px-1" value={s.schedule_hour_jst} onChange={(e) => setS({ ...s, schedule_hour_jst: Number(e.target.value) })} aria-label="実行時刻（日本時間）">
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
            ）
          </label>
          <p className="text-[11px] text-muted-foreground">AI解析（有料）を使うため、初期は無効です。定期実行の呼び出し設定（Cron）は別途必要です。定期実行では候補の作成まで行い、登録は手動実行または候補画面から行います。</p>
          <label className="flex items-center gap-2 text-xs">
            1回のAI解析の上限
            <input className="h-8 w-16 rounded-md border bg-input px-2 text-sm" inputMode="numeric" value={s.max_ai_per_run} aria-label="1回のAI解析の上限" onChange={(e) => setS({ ...s, max_ai_per_run: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} />
            件
          </label>
          <label className="flex flex-wrap items-center gap-2 text-xs">
            <input type="checkbox" className="size-4" checked={s.worker_enabled} onChange={(e) => setS({ ...s, worker_enabled: e.target.checked })} data-testid="worker-enabled" />
            解析待ちを自動で解析し続ける（アプリを閉じていても継続）
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            1回
            <input className="h-8 w-14 rounded-md border bg-input px-2 text-sm" inputMode="numeric" value={s.worker_batch} aria-label="ワーカー1回の解析件数" onChange={(e) => setS({ ...s, worker_batch: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} />
            件／1日の上限
            <input className="h-8 w-16 rounded-md border bg-input px-2 text-sm" inputMode="numeric" value={s.worker_daily_ai_limit} aria-label="ワーカーの1日のAI解析上限" onChange={(e) => setS({ ...s, worker_daily_ai_limit: Math.min(500, Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0)) })} />
            件／告知ページの再確認
            <input className="h-8 w-14 rounded-md border bg-input px-2 text-sm" inputMode="numeric" value={s.recheck_hours} aria-label="告知ページを再確認する間隔(時間)" onChange={(e) => setS({ ...s, recheck_hours: Math.min(168, Math.max(1, Number(e.target.value) || 1)) })} />
            時間ごと
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="size-4" checked={s.x_enabled} onChange={(e) => setS({ ...s, x_enabled: e.target.checked })} data-testid="x-enabled" />
            X公式APIを使う（従量課金）
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            月額予算
            <input className="h-8 w-24 rounded-md border bg-input px-2 text-sm" inputMode="numeric" value={s.x_monthly_budget_jpy} aria-label="X APIの月額予算(円)" onChange={(e) => setS({ ...s, x_monthly_budget_jpy: Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
            円／1回の取得上限
            <input className="h-8 w-16 rounded-md border bg-input px-2 text-sm" inputMode="numeric" value={s.x_max_posts_per_run} aria-label="1回の取得上限(投稿)" onChange={(e) => setS({ ...s, x_max_posts_per_run: Math.min(100, Math.max(5, Number(e.target.value) || 5)) })} />
            投稿
          </div>
          <p className="text-[11px] text-muted-foreground" data-testid="x-state">
            APIキー（X_BEARER_TOKEN）: {xConfigured ? "設定済み" : "未設定"}／今月の取得 {usage.xPosts}件（約{usage.xCostJpy}円）。予算が0円、またはキー未設定の間は、X APIを呼びません。1投稿あたり約0.005米ドルの従量課金（公開情報。X Developer Consoleで確認してください）。予算に達すると停止します。
          </p>
        </div>
        <Button onClick={() => void saveSettings()} disabled={busy !== null} data-testid="save-conditions">
          {busy === "save" ? "保存しています…" : "条件を保存"}
        </Button>
      </section>

      <section className="space-y-2 rounded-lg border p-3 text-sm" data-testid="candidates">
        <h2 className="font-semibold">収集候補</h2>
        <div role="tablist" aria-label="候補の種類" className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5 sm:grid-cols-6">
          {CAND_TABS.map((t) => (
            <button key={t.value} role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={cn("min-h-9 rounded-md px-0 text-[11px] font-medium leading-tight", tab === t.value ? "bg-primary text-primary-foreground" : "hover:bg-card")} data-testid={`cand-tab-${t.value}`}>
              {t.label}
              <span className="ml-0.5 opacity-80" data-testid={`cand-count-${t.value}`}>{counts[t.value]}</span>
            </button>
          ))}
        </div>
        <ul className="divide-y">
          {list.map((c) => {
            const d = c.draft?.input;
            const queuedOnly = ["pending", "retry", "processing"].includes(c.job_state ?? "");
            return (
              <li key={c.id} className="space-y-1 py-2 text-xs" data-testid="candidate-row">
                <p className="font-medium">{d ? `${d.chain?.name ?? ""} ${d.store?.name ?? ""} ${d.items?.[0]?.product.name ?? ""}`.trim() || c.title : c.title}</p>
                {d?.applyDeadline && (
                  <p className="text-muted-foreground">締切: {d.applyDeadline.precision === "unknown" ? "不明" : `${d.applyDeadline.date ?? ""}${d.applyDeadline.time ? ` ${d.applyDeadline.time}` : ""}`}</p>
                )}
                {queuedOnly && (
                  <p className="text-muted-foreground">
                    {c.job_state === "processing" ? "解析中" : c.job_state === "retry" ? `再試行待ち（${c.attempts ?? 0}回失敗）` : "解析待ち"}
                    {c.due_at && `／一覧の締切 ${fmt(c.due_at)}`}
                  </p>
                )}
                {c.kind === "update" && c.draft?.update && (
                  <p className="font-medium text-info">更新の提案（既存の抽選）</p>
                )}
                {c.reasons.length > 0 && <ul className="list-disc pl-4 text-muted-foreground">{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                <div className="flex flex-wrap gap-1.5">
                  {c.source_url && (
                    <a href={c.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center text-info underline">
                      元の情報を開く
                    </a>
                  )}
                  {c.kind === "update" && c.draft?.update && (
                    <Button size="sm" disabled={busy !== null} data-testid="cand-apply-update" onClick={() => void act("a" + c.id, { action: "applyUpdate", id: c.id }, (x) => `反映しました（${x.applied}項目）`)}>
                      更新を反映
                    </Button>
                  )}
                  {c.job_state === "review" && c.kind !== "update" && d && (
                    <Button size="sm" disabled={busy !== null} onClick={() => void act("r" + c.id, { action: "register", id: c.id, actor: profile.id }, () => "登録しました（全情報に追加。★管理対象ではありません）")} data-testid="cand-register">
                      登録
                    </Button>
                  )}
                  {(c.status === "pending" || c.status === "failed" || c.status === "duplicate") && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("x" + c.id, { action: "exclude", id: c.id })}>
                      除外
                    </Button>
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
                </div>
              </li>
            );
          })}
          {list.length === 0 && <li className="py-2 text-xs text-muted-foreground">該当する候補はありません。</li>}
        </ul>
      </section>

      <section className="space-y-2 rounded-lg border p-3 text-sm" data-testid="runs">
        <h2 className="font-semibold">収集履歴</h2>
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
      </section>
    </div>
  );
}
