/**
 * 収集候補の自動振り分け（Stage 5T）の純関数。
 *   auto_register=自動登録 / auto_exclude=自動除外 / auto_retry=保留（自動で再調査を続ける） / manual=要手動確認
 * 再試行の回数・間隔は内部で管理し、利用者の設定には出さない。締切が近い候補は、規定回数に達していなくても早めに手動確認へ移す。
 */
import type { FailKind } from "@/lib/collector/queue";
import { PRODUCT_UNREGISTERED } from "@/lib/collector/ready";

export type Triage = "auto_register" | "auto_exclude" | "auto_retry" | "manual";
export const TRIAGE_LABEL: Record<Triage, string> = { auto_register: "自動登録", auto_exclude: "自動除外", auto_retry: "自動再調査", manual: "要手動確認" };

const H = 3600_000;
const MIN = 60_000;

// ---------------------------------------------------------------- 保留（自動再調査）の間隔と上限（内部）
/** 保留に入った回数（1から）に応じた次回調査までの間隔: 30分 → 2時間 → 6時間 → 12時間 → 24時間 → 24時間 */
const HOLD_INTERVALS = [30 * MIN, 2 * H, 6 * H, 12 * H, 24 * H, 24 * H];
export const MAX_HOLD = HOLD_INTERVALS.length;
/** 締切の何時間前までに解決しなければ、規定回数に達していなくても手動確認へ移すか */
export const URGENT_HOURS = 24;
/** 要チェックの系列・優先収集メモに一致する候補は、より早めに知らせる */
export const URGENT_HOURS_IMPORTANT = 48;

export function holdIntervalMs(holdCount: number): number {
  return HOLD_INTERVALS[Math.min(Math.max(holdCount, 1), MAX_HOLD) - 1];
}

// ---------------------------------------------------------------- 締切までの緊急度
export type Urgency = "overdue" | "today" | "tomorrow" | "soon" | "later" | "unknown";
export const URGENCY_LABEL: Record<Urgency, string> = { overdue: "受付終了", today: "本日締切", tomorrow: "明日締切", soon: "締切が近い", later: "締切まで余裕あり", unknown: "締切不明" };
const jstYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export function urgencyOf(dueAt: Date | null, now: Date): Urgency {
  if (!dueAt) return "unknown";
  if (dueAt.getTime() < now.getTime()) return "overdue";
  const today = jstYmd(now);
  const due = jstYmd(dueAt);
  if (due === today) return "today";
  if (due === jstYmd(new Date(now.getTime() + 24 * H))) return "tomorrow";
  return dueAt.getTime() - now.getTime() <= 72 * H ? "soon" : "later";
}
/** 要手動確認の並び順: 締切が近い順→締切不明（後回しにしない）→余裕あり。小さいほど先 */
export function manualRank(u: Urgency): number {
  return { overdue: 5, today: 0, tomorrow: 1, soon: 2, unknown: 3, later: 4 }[u];
}

// ---------------------------------------------------------------- 不足の分類
/**
 * 不足・保留の理由を、解決方法で分類する。
 *   source=別の情報源・再取得で解決できる可能性 / user=利用者の判断が必要（矛盾など） / minor=不明のまま登録できる項目
 */
export type GapClass = "source" | "user" | "minor";
export function classifyGap(text: string): GapClass {
  if (/発表日|受取方法|詳細な応募条件|当選発表/.test(text) && !/締切|店舗|商品|系列|応募先/.test(text)) return "minor";
  if (/矛盾|重複の疑い|同一の抽選か|似た抽選/.test(text)) return "user";
  return "source";
}

export interface HoldInput {
  now: Date;
  dueAt: Date | null;
  /** 不足・保留の理由（missing と reasons） */
  gaps: string[];
  holdCount: number;
  failKind: FailKind | null;
  /** 別の許可された情報源で取得を試して、必要な情報が得られなかった */
  altTried: boolean;
  /** 優先収集メモに一致、または要チェックの系列 */
  important: boolean;
  /** 抽選予告として追跡中（具体的な系列がある受付前・詳細未発表の抽選）。回数や締切の近さだけを理由に要手動確認へ移さない */
  tracking?: { startDate: string | null; lastNewsAt: string } | null;
}

/** 続報が無いまま追跡を続ける上限（日）。これを過ぎた予告は自動で終了する（履歴は残す） */
export const TRACKING_STALE_DAYS = 60;

/** 追跡中の予告の次回調査までの間隔。受付開始が近いほど短くする（優先度を上げる） */
export function trackingIntervalMs(startDate: string | null, now: Date): number {
  if (!startDate) return 12 * H;
  const start = new Date(`${startDate}T00:00:00+09:00`).getTime();
  const left = start - now.getTime();
  if (left <= 0) return 30 * MIN; // 受付開始日になった: 続報・本登録の判定をすぐ行う
  if (left <= 48 * H) return 2 * H;
  if (left <= 7 * 24 * H) return 6 * H;
  return 12 * H;
}
export interface HoldDecision {
  triage: Triage;
  reason: string;
  /** auto_retry のときの次回調査までの待ち時間 */
  nextMs: number | null;
  urgency: Urgency;
}

/** 解決できなかった候補を、自動除外／保留／要手動確認のどれにするか */
export function decideHold(h: HoldInput): HoldDecision {
  const urgency = urgencyOf(h.dueAt, h.now);
  if (urgency === "overdue") return { triage: "auto_exclude", reason: "受付終了のため自動で除外しました（応募締切を過ぎています）", nextMs: null, urgency };
  // 商品マスター未登録は再調査で解決しない。利用者が商品を確認する（既存商品の選択・新規登録・除外）
  if (h.gaps.some((g) => g.startsWith(PRODUCT_UNREGISTERED))) return { triage: "manual", reason: `${PRODUCT_UNREGISTERED}。商品を確認してください`, nextMs: null, urgency };
  const classes = h.gaps.map(classifyGap);
  if (h.tracking && !classes.includes("user")) {
    const idle = (h.now.getTime() - new Date(h.tracking.lastNewsAt).getTime()) / (24 * H);
    if (Number.isFinite(idle) && idle > TRACKING_STALE_DAYS) return { triage: "auto_exclude", reason: `抽選予告の続報が${TRACKING_STALE_DAYS}日以上ないため、追跡を終了しました`, nextMs: null, urgency };
    return { triage: "auto_retry", reason: "抽選予告として追跡しています（続報があれば同じ抽選として更新します）", nextMs: trackingIntervalMs(h.tracking.startDate, h.now), urgency };
  }
  if (classes.includes("user")) return { triage: "manual", reason: `利用者の判断が必要です: ${h.gaps.find((g) => classifyGap(g) === "user")}`, nextMs: null, urgency };
  const left = h.dueAt ? h.dueAt.getTime() - h.now.getTime() : null;
  const urgentMs = (h.important ? URGENT_HOURS_IMPORTANT : URGENT_HOURS) * H;
  // 締切が近いのに必要な情報が揃わない → 数日後まで再調査を続けても意味がないので、早めに知らせる
  if (left !== null && left <= urgentMs) return { triage: "manual", reason: `${URGENCY_LABEL[urgency]}ですが、必要な情報を取得できていません`, nextMs: null, urgency };
  // 再試行しても変わらない失敗（取得制限など）で、代替の情報源でも得られなかった
  if (h.failKind && ["robots", "not_found", "js_render"].includes(h.failKind) && h.altTried) return { triage: "manual", reason: `${URGENCY_LABEL[urgency]}。取得できないページで、代替の情報源でも必要な情報を得られませんでした`, nextMs: null, urgency };
  if (h.holdCount >= MAX_HOLD) return { triage: "manual", reason: "自動で再調査を繰り返しましたが、必要な情報を取得できませんでした", nextMs: null, urgency };
  const interval = holdIntervalMs(h.holdCount + 1);
  // 締切が近づくほど短い間隔で確認する（締切までの残りの1/4を上限、最短15分）
  const nextMs = left !== null ? Math.max(15 * MIN, Math.min(interval, Math.floor(left / 4))) : interval;
  return { triage: "auto_retry", reason: "情報が不足しているため、自動で再調査を続けます", nextMs, urgency };
}

/** 保留（自動再調査）／要手動確認の記録に使う列（collection_candidates の更新用） */
export function triagePatch(hd: HoldDecision, c: { hold_count?: number | null }, now: Date): Record<string, unknown> {
  const nowIso = now.toISOString();
  if (hd.triage === "auto_retry") return { triage: "auto_retry", triage_reason: hd.reason.slice(0, 300), hold_count: (c.hold_count ?? 0) + 1, next_run_at: new Date(now.getTime() + (hd.nextMs ?? 3600_000)).toISOString(), manual_state: null };
  if (hd.triage === "manual") return { triage: "manual", triage_reason: hd.reason.slice(0, 300), manual_reason: hd.reason.slice(0, 300), manual_since: nowIso, manual_state: "open" };
  return { triage: hd.triage, triage_reason: hd.reason.slice(0, 300) };
}

/**
 * X投稿の添付画像を取得し直す価値があるか。画像が取得できていなかった旨の記録があり、再取得の回数が少ないものだけ。
 * 同じ入力（画像なし）の再解析を繰り返さないよう、AI解析が3回を超えた候補・保留2回目以降は対象にしない。
 */
export function needsImageRetry(c: { isX: boolean; aiCalls: number; holdCount: number; texts: string[] }): boolean {
  if (!c.isX || c.aiCalls > 2 || c.holdCount > 1) return false;
  return c.texts.some((t) => /画像未取得|画像を確認|画像.{0,12}(確認できません|含まれていません|取得できません)|解析できていません/.test(t));
}

// ---------------------------------------------------------------- 取得元の関係（元の情報源・短縮URL・応募サービス）
export type HostRole = "shortener" | "apply_service" | "aggregator" | "x" | "other";
const SHORTENERS = new Set(["t.co", "bit.ly", "buff.ly", "ow.ly", "tinyurl.com", "lin.ee", "amzn.to", "goo.gl"]);
const APPLY_SERVICES = new Set(["shoplottery.e-starbox.com", "e-starbox.com", "livepocket.jp", "t.livepocket.jp", "forms.gle", "docs.google.com", "form.run", "peatix.com", "select-type.com", "yappli.plus"]);
const AGGREGATORS = new Set(["pokeso.jp", "torecabiyori.com"]);
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
export function hostRole(host: string | null): HostRole {
  if (!host) return "other";
  if (SHORTENERS.has(host)) return "shortener";
  if (APPLY_SERVICES.has(host) || [...APPLY_SERVICES].some((s) => host.endsWith(`.${s}`))) return "apply_service";
  if (AGGREGATORS.has(host)) return "aggregator";
  if (host === "x.com" || host === "twitter.com") return "x";
  return "other";
}

/**
 * 取得困難の記録のキー。応募サービス（e-starbox など）の失敗は、サービス全体ではなく「サービス×系列/店舗」の組み合わせで記録する。
 * これにより、共通の応募サービスが取得できないことを理由に、そのサービスを使う店舗全体を一律に取得不可と判定しない。
 */
export function hardSourceKeys(p: { url: string | null; chainId?: string | null; storeId?: string | null; chainName?: string; storeName?: string }): { scope: "chain" | "store" | "service" | "domain"; key: string; label: string }[] {
  const host = hostOf(p.url);
  const role = hostRole(host);
  const out: { scope: "chain" | "store" | "service" | "domain"; key: string; label: string }[] = [];
  if (p.storeId) out.push({ scope: "store", key: `${p.storeId}|${role === "apply_service" ? host : "-"}`, label: [p.storeName, role === "apply_service" ? host : null].filter(Boolean).join(" / ") });
  else if (p.chainId) out.push({ scope: "chain", key: `${p.chainId}|${role === "apply_service" ? host : "-"}`, label: [p.chainName, role === "apply_service" ? host : null].filter(Boolean).join(" / ") });
  if (host && role !== "shortener") out.push({ scope: role === "apply_service" ? "service" : "domain", key: host, label: host });
  return out;
}

/** 取得困難の記録から、次回に優先する代替取得の方法（過去に成功したもの）を選ぶ */
export function preferredAlt(rec: { alt_source: string | null; alt_success: number; alt_fail: number } | null): string | null {
  if (!rec?.alt_source) return null;
  return rec.alt_success > rec.alt_fail ? rec.alt_source : null;
}

// ---------------------------------------------------------------- 収集元の除外ルール
export type ExclusionScope = "store" | "chain" | "x_account" | "domain" | "source_post";
export interface ExclusionRule {
  id: string;
  scope: ExclusionScope;
  key: string;
  active: boolean;
  reason_code: string;
  label?: string;
}
export interface ExclusionTarget {
  storeId?: string | null;
  chainId?: string | null;
  xUsername?: string | null;
  /** 取得したページ・投稿のURL */
  url?: string | null;
  sourcePostKey?: string | null;
}
/**
 * 候補が有効な除外ルールに当たるか。範囲ごとに明示的に一致したときだけ（X全体・e-starbox全体などを意図せず除外しない）。
 * domain は、まとめサイト・短縮URL・共通の応募サービス・X のドメイン全体は対象にできない。
 */
export function matchExclusion(rules: ExclusionRule[], t: ExclusionTarget): ExclusionRule | null {
  const host = hostOf(t.url);
  for (const r of rules) {
    if (!r.active) continue;
    if (r.scope === "store" && t.storeId && r.key === t.storeId) return r;
    if (r.scope === "chain" && t.chainId && r.key === t.chainId) return r;
    if (r.scope === "x_account" && t.xUsername && r.key.toLowerCase() === t.xUsername.toLowerCase().replace(/^@/, "")) return r;
    if (r.scope === "source_post" && t.sourcePostKey && r.key === t.sourcePostKey) return r;
    if (r.scope === "domain" && host && r.key === host && domainExcludable(host)) return r;
  }
  return null;
}
/** ドメイン全体の除外ができるのは、特定の個別サイトだけ。X・まとめサイト・短縮URL・共通の応募サービスは不可 */
export function domainExcludable(host: string | null): boolean {
  return hostRole(host) === "other";
}

export const EXCLUSION_REASONS = [
  { code: "untrusted_shop", label: "信頼性に疑問があるショップ" },
  { code: "out_of_scope_product", label: "収集対象外の商品" },
  { code: "out_of_area", label: "地域・距離が対象外" },
  { code: "conditions_mismatch", label: "応募条件が合わない" },
  { code: "duplicate", label: "重複情報" },
  { code: "wrong_info", label: "誤った情報・AI解析ミス" },
  { code: "not_lottery", label: "抽選ではない" },
  { code: "other", label: "その他" },
] as const;
export type ExclusionReasonCode = (typeof EXCLUSION_REASONS)[number]["code"];
export const EXCLUSION_LABEL = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r.code, r.label])) as Record<ExclusionReasonCode, string>;
/**
 * 「今後この収集元を除外」を提案できる理由。応募資格がない・条件が合わない（特定プロフィールの問題）は、収集元全体の除外には使わない。
 * 重複・地域・商品も、収集元そのものの問題ではない。
 */
export function canExcludeSource(code: string): boolean {
  return code === "untrusted_shop" || code === "wrong_info" || code === "not_lottery" || code === "other";
}

/**
 * 除外理由 → 収集精度の改善への反映先（記録しただけで自動学習したことにはしない）。
 * 反映するのは明示的なルールと解析入力だけで、利用者が指定していないショップを自動でブラックリストに追加しない。
 */
export function feedbackTarget(code: string): { target: "source_rule" | "product_filter" | "area_condition" | "dedupe_review" | "ai_feedback" | "none"; note: string } {
  switch (code) {
    case "untrusted_shop":
      return { target: "source_rule", note: "利用者が収集元の除外を選んだ場合だけ、明示的な除外ルールに反映" };
    case "out_of_scope_product":
      return { target: "product_filter", note: "AI解析の前の商品フィルタの確認材料" };
    case "out_of_area":
      return { target: "area_condition", note: "収集条件（地域・距離）の見直し材料" };
    case "duplicate":
      return { target: "dedupe_review", note: "重複判定の確認材料" };
    case "wrong_info":
      return { target: "ai_feedback", note: "AI抽出のフィードバックとして記録（解析入力の改善材料）" };
    default:
      return { target: "none", note: "記録のみ" };
  }
}

/**
 * 低情報量（情報充実度 D・E）の候補を、要手動確認へ送らず、低優先度の自動追跡・再調査にとどめる（Stage 6D）。
 *  - 要手動確認へ移すのは、利用者の判断が要るもの（商品マスター未登録・矛盾）と、締切が近い（24時間以内）ものだけ。情報が少ないというだけでは通知しない
 *  - 低情報量という理由だけで自動除外はしない（受付終了・明確な対象外は従来どおり除外）
 */
export function lowInfoOverride(hd: HoldDecision, rank: "A" | "B" | "C" | "D" | "E" | undefined, dueAt: Date | null, now: Date): HoldDecision {
  if (hd.triage !== "manual" || (rank !== "D" && rank !== "E")) return hd;
  if (hd.reason.startsWith(PRODUCT_UNREGISTERED) || /利用者の判断が必要/.test(hd.reason)) return hd;
  const left = dueAt ? dueAt.getTime() - now.getTime() : null;
  if (left !== null && left <= URGENT_HOURS * H) return hd; // 締切が近い: 警告として手動確認に残す
  return { triage: "auto_retry", reason: rank === "E" ? "識別できる情報が少ないため、低優先度で追跡・再調査を続けます" : "情報が少ないため、自動追跡・再調査を続けます（要手動確認にはしません）", nextMs: 24 * H, urgency: hd.urgency };
}
