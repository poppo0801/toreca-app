import { deadlinePassed, evaluateCandidate, type CollectionConditions } from "@/lib/collector/conditions";
import { tcgTextsOf } from "@/lib/collector/category";
import { decideRegistration, isUnmanagedConflict, type RegistrationDecision } from "@/lib/collector/attention";
import type { FieldMap } from "@/lib/collector/fields";
import { isRegionReason, judgeRegion, regionExclusionOf, type RegionExclusion } from "@/lib/collector/region";
import { classifyStage } from "@/lib/collector/stage";
import { findDuplicates, matchChain, matchProduct, matchStore, type LotteryDraft, type MatchKind } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import { storeDistance } from "@/lib/store-distance";
import type { AppData, Chain, Product, Store } from "@/types/domain";

/**
 * 確認待ち候補の再評価（Stage 4C 追加）。AIを呼ばず、保存済みの解析結果（draft）を新しいマスター照合・収集条件で見直す純関数。
 *   A: 現在受付中・登録可能（情報が十分・特定でき・重複なし）→ 自動登録
 *   B: マスター照合の失敗だけが理由 → AI再解析なし。新しい照合で解決できれば登録
 *   C: X投稿が情報源で、画像などの追加取得で補える可能性 → X公式API＋統合AI解析（費用の上限内）
 *   D: 情報不足（締切・URL・商品店舗の特定）→ 取得元を再確認して再解析（費用の上限内）
 *   E: 受付終了・過去の抽選 → 履歴として残す価値を確認（既存の抽選と一致すれば紐付け）。それ以外は除外（理由を記録・削除しない）
 *   F: 対象外・既存抽選との重複 → 根拠を記録して除外・統合
 * 既存の手動登録情報は変更しない。候補の物理削除はしない。
 */
export type ReevalClass = "A" | "B" | "C" | "D" | "E" | "F";

export interface StoredDraft {
  input: LotteryInput;
  summary: { chain: MatchKind; store: MatchKind; items: { name: string; kind: MatchKind; matchedName: string | null }[] };
  flags?: Record<string, string>;
  modePending?: boolean;
  warnings?: string[];
  notices?: string[];
  verdict?: string;
  ready?: boolean;
  engine?: string;
  evidence?: unknown;
  secondary?: string[];
  update?: unknown;
  /** 抽選予告として追跡中（Stage 6C） */
  tracking?: { startDate?: string | null } | null;
  /** 項目別の出典（Stage 6D）。state=conflict の項目があれば、登録せず確認待ちに残す */
  fields?: Record<string, { state?: string } | undefined>;
  assessment?: { rank?: string };
}

export interface CandidateLite {
  id: string;
  status: string;
  job_state: string;
  kind: string;
  source_url: string | null;
  dedupe_key: string;
  x_post_id: string | null;
  title: string;
  reasons: string[];
  due_at: string | null;
  lottery_id: string | null;
  draft: unknown;
}

const sure = (k: MatchKind) => k === "exact" || k === "alias" || k === "code";

export interface Rematched {
  input: LotteryInput;
  summary: StoredDraft["summary"];
  candidates: { chain: Chain[]; store: Store[]; items: Product[][] };
  /** 新しい照合で、以前は未照合・不確実だった系列・店舗・商品が確実に特定できた */
  improved: boolean;
}

/** 保存済みの解析結果の系列・店舗・商品を、現在のマスターで照合し直す（確実な一致だけを採用。曖昧なものは候補のまま） */
export function rematch(stored: StoredDraft, data: AppData): Rematched {
  const input = structuredClone(stored.input);
  const summary = structuredClone(stored.summary);
  const candidates: Rematched["candidates"] = { chain: [], store: [], items: [] };
  let improved = false;

  if (!sure(summary.chain) || !input.chain.id) {
    const m = matchChain(input.chain.name, data.chains, { stores: data.stores, storeName: input.store.name });
    if (m.item && sure(m.kind)) {
      input.chain = { id: m.item.id, name: m.item.name };
      summary.chain = m.kind;
      improved = true;
    } else {
      summary.chain = m.kind;
      candidates.chain = m.candidates;
    }
  }
  if (!sure(summary.store) || !input.store.id) {
    const chainName = input.chain.id ? (data.chains.find((c) => c.id === input.chain.id)?.name ?? input.chain.name) : input.chain.name;
    const m = matchStore(input.store.name, input.chain.id ?? null, data.stores, chainName);
    if (m.item && sure(m.kind)) {
      input.store = { id: m.item.id, name: m.item.name, prefecture: input.store.prefecture };
      summary.store = m.kind;
      improved = true;
    } else {
      summary.store = m.kind;
      candidates.store = m.candidates;
    }
  }
  const used = new Set(input.items.map((i) => i.product.id).filter(Boolean) as string[]);
  input.items.forEach((it, i) => {
    const prev = summary.items[i];
    candidates.items[i] = [];
    if (prev && sure(prev.kind) && it.product.id) return;
    const m = matchProduct(it.product.name, "", data.products);
    candidates.items[i] = m.candidates;
    if (m.item && sure(m.kind) && !used.has(m.item.id)) {
      used.add(m.item.id);
      input.items[i] = { ...it, product: { id: m.item.id, name: m.item.officialName } };
      summary.items[i] = { name: it.product.name, kind: m.kind, matchedName: m.item.officialName };
      improved = true;
    } else {
      summary.items[i] = { name: it.product.name, kind: prev?.kind === "exact" || prev?.kind === "alias" ? m.kind : (m.item ? m.kind : (prev?.kind ?? m.kind)), matchedName: prev?.matchedName ?? null };
    }
  });
  return { input, summary, candidates, improved };
}

export const isXCandidate = (c: Pick<CandidateLite, "dedupe_key" | "source_url" | "x_post_id">) =>
  !!c.x_post_id || c.dedupe_key.startsWith("x:") || /^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\//i.test(c.source_url ?? "");

export interface Judgement {
  cls: ReevalClass;
  /** 実行する処理 */
  action: "register" | "duplicate" | "exclude" | "requeue" | "keep" | "skip";
  /** 履歴に残す理由（日本語） */
  reasons: string[];
  /** 処理順（小さいほど先） */
  priority: number;
  rematched: Rematched;
  /** 重複先の抽選 */
  duplicateOf?: { lotteryId: string; reason: string };
  /** 登録に足りない項目（キープのときの理由の更新用） */
  missing: string[];
  deadline: "past" | "open" | "unknown";
  improved: boolean;
  /** 登録の判定（Stage 7A）。action=register のとき、A=通常登録／B=注意付き登録 */
  decision?: RegistrationDecision;
  /** 地域外として除外するときの記録（Stage 7A） */
  exclusion?: RegionExclusion;
}

/** 締切までの日数（日）。不明は null */
function daysToDeadline(c: CandidateLite, input: LotteryInput, now: Date): number | null {
  const f = input.applyDeadline;
  const t = f.precision !== "unknown" && f.date ? new Date(`${f.date}T${f.precision === "date_time" ? f.time || "23:59" : "23:59"}:00+09:00`).getTime() : c.due_at ? new Date(c.due_at).getTime() : NaN;
  return Number.isNaN(t) ? null : (t - now.getTime()) / 86_400_000;
}

/** isReady と同じ規則（run.ts）。循環参照を避けるため、必要な型だけで再実装せず、呼び出し側から渡す */
export type IsReadyFn = (draft: LotteryDraft, input: LotteryInput) => { ready: boolean; missing: string[]; provisional: string[] };

/**
 * 候補1件を分類する。処理の優先順位:
 *  1 受付中で締切が近い(3日以内) / 2 受付中のマスター照合失敗 / 3 X画像の再取得 / 4 その他の受付中 / 5 受付終了 / 6 対象外・重複
 */
export function judge(c: CandidateLite, data: AppData, cond: CollectionConditions, now: Date, isReady: IsReadyFn): Judgement | null {
  const stored = c.draft as StoredDraft | null;
  if (!stored?.input || c.kind !== "new" || stored.update) return null;
  const rm = rematch(stored, data);
  // 登録時と同じく、候補の情報源URLを入力に含める（解析時に保存した入力には既に含まれる）
  if (c.source_url && !(rm.input.sourceUrls ?? []).includes(c.source_url)) rm.input.sourceUrls = [...(rm.input.sourceUrls ?? []), c.source_url].slice(0, 10);
  const input = rm.input;
  const past = deadlinePassed(input.applyDeadline, now);
  const deadline: Judgement["deadline"] = past === true ? "past" : past === false ? "open" : c.due_at && new Date(c.due_at).getTime() < now.getTime() ? "past" : "unknown";
  const base = { rematched: rm, deadline, improved: rm.improved } as const;

  // 既存の抽選との重複（確実な一致のみ）
  const dups = findDuplicates(input, data.lotteries, c.source_url ?? undefined, data, { now });
  const high = dups.find((d) => d.level === "high");
  if (high) return { ...base, cls: "F", action: "duplicate", reasons: [`既存の抽選と一致します（${high.reason}）`], priority: 6, duplicateOf: { lotteryId: high.lotteryId, reason: high.reason }, missing: [] };

  if (deadline === "past") {
    return { ...base, cls: "E", action: "exclude", reasons: ["受付終了（応募締切を過ぎており、既存の抽選・応募・当落とも紐づかないため、履歴登録は不要として除外しました）"], priority: 5, missing: [] };
  }

  const store = data.stores.find((s) => s.id === input.store.id);
  const dist = store ? storeDistance(data, store) : null;
  const dr = stored as unknown as { listInfo?: { title?: string; card?: string; context?: string }; xpost?: { text?: string; quoted?: { text?: string } } };
  const texts = tcgTextsOf({ title: c.title, card: dr.listInfo?.card, context: dr.listInfo?.context, postText: dr.xpost?.text, quotedText: dr.xpost?.quoted?.text });
  const region = judgeRegion({ masterPrefecture: store?.prefecture, address: store?.address, storeName: input.store.id ? "" : input.store.name, statedPrefecture: input.store.prefecture });
  const ev = evaluateCandidate(input, cond, { texts, prefecture: region.prefecture, storeKind: store?.salesKind ?? "physical", distanceKm: dist ? dist.km : null, now });
  if (ev.verdict === "exclude") {
    const exclusion = isRegionReason(ev.reasons) && region.prefecture ? regionExclusionOf(region, { at: now.toISOString(), source: c.source_url ?? "", reason: ev.reasons.join("・") }) : undefined;
    return { ...base, cls: "F", action: "exclude", reasons: [`収集条件の対象外です（${ev.reasons.join("・")}）`], priority: 6, missing: [], exclusion };
  }

  const draftLike = { input, summary: rm.summary, candidates: rm.candidates, modePending: !!stored.modePending } as unknown as LotteryDraft;
  const { missing } = isReady(draftLike, input);
  const days = daysToDeadline(c, input, now);
  const soon = days !== null && days <= 3 ? 0 : 1;
  const hasConflict = Object.values(stored.fields ?? {}).some((f) => f?.state === "conflict");
  // 登録の判定（Stage 7A）: A=十分 → 通常登録 / B=情報不足・軽微な矛盾 → 注意付きで登録 / C=抽選として成立するか判断できない → 確認待ち
  const textConflict = (stored.warnings ?? []).find((w) => /矛盾|食い違/.test(w) && !isUnmanagedConflict(w)) ?? null;
  const chainRow = data.chains.find((x) => x.id === input.chain.id);
  const decision = decideRegistration({ input, verdict: ev.verdict, verdictReasons: ev.reasons, missing, fields: (stored.fields ?? {}) as FieldMap, duplicateCount: dups.length, stage: classifyStage(input, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now)), modePending: !!stored.modePending, textConflict, chainStoreSelectDefault: !!chainRow?.storeSelectDefault, storeResolved: !missing.some((m) => /店舗を確実に特定できません/.test(m)), now: now.toISOString() });
  if (!stored.tracking && ev.verdict !== "upcoming" && (ev.verdict === "match" || ev.verdict === "review") && decision.grade !== "C") {
    const why = decision.grade === "A" ? (rm.improved ? "新しいマスター照合で系列・店舗・商品を確実に特定できたため、AI再解析なしで登録しました" : "情報が十分で既存の抽選と重複しないため登録しました") : `不足・相違は注意として記録し、注意付きで登録しました（${decision.cautions.map((x) => x.message.replace(/（.*$/, "")).slice(0, 3).join("／")}）`;
    return { ...base, cls: rm.improved ? "B" : "A", action: "register", reasons: [why], priority: soon === 0 ? 1 : rm.improved ? 2 : 4, missing: [], decision };
  }

  // 情報源間で食い違う項目がある: 自動では確定せず、確認待ちに残す（情報は揃っていても矛盾あり）
  if (hasConflict) return { ...base, cls: "D", action: "keep", reasons: ["情報源間で食い違う項目があります。確認してから登録してください", ...missing].slice(0, 6), priority: 4, missing };
  // 追跡中の抽選予告（受付前・詳細未発表）: 受付開始前の除外・AI再解析・手動確認へ送らず、追跡を続ける。受付が始まって登録条件を満たせば上で登録される
  if (ev.verdict === "upcoming" || stored.tracking) {
    return { ...base, cls: "D", action: "keep", reasons: [ev.verdict === "upcoming" ? "受付前の抽選として追跡中です" : "抽選予告として追跡中です", ...missing].slice(0, 6), priority: 5, missing };
  }
  // 照合の失敗だけが理由（締切などの情報は十分）→ B（AI再解析はしない。照合が改善していなければそのまま確認待ち）
  const matchOnly = missing.length > 0 && missing.every((m) => /特定できません|判別できません/.test(m)) && input.applyDeadline.precision !== "unknown";
  if (matchOnly) return { ...base, cls: "B", action: "keep", reasons: missing, priority: soon === 0 ? 1 : 2, missing };

  // 情報不足。X投稿は画像などを取得し直す価値がある（C）、それ以外は取得元の再確認（D）
  const lacking = missing.filter((m) => /締切|URL|特定できません|判別できません/.test(m));
  if (lacking.length > 0 || input.applyDeadline.precision === "unknown") {
    const x = isXCandidate(c);
    return { ...base, cls: x ? "C" : "D", action: "requeue", reasons: missing, priority: x ? 3 : 4, missing };
  }
  // 登録に必要な情報は揃っているが、収集条件の「要確認」や解析の注意が残る。追加の取得では解決しないため、AIは呼ばず確認待ちのまま理由だけ更新する
  const why = [...missing, ...(ev.verdict === "review" ? ev.reasons : []), ...(stored.warnings ?? []).slice(0, 3)];
  return { ...base, cls: "D", action: "keep", reasons: why.length > 0 ? why : ["内容を確認してください"], priority: 4, missing };
}
