/**
 * 調査経験・画像解析結果の保存と読戻し（Phase 2。migration 119）。
 *  - 追記専用。書き込みはサービス権限のみ（RLS）。失敗は握り潰さず件数で返し、呼び出し側は処理を止めない（保存の失敗で調査結果を失わない）。
 *  - 経験には原文・URL全体・個人情報を含めない（ホスト名・特徴語・位置の統計のみ）。AIの観察だけの経験（ai_unverified）は、検証済みの経験が不足なら提案に使われない（experience.ts）。
 */
import { canonUrl } from "@/lib/judgment/xsource/normalize";
import { buildExperience, discoverFeatures, EXPERIENCE_VERSION, type ExperienceRecord, type ReadHint, type Verification } from "@/lib/judgment/xsource/experience";
import type { ImageObservation, VisionReading } from "@/lib/judgment/xsource/image-evidence";
import type { Evidence, ResearchResult } from "@/lib/judgment/xsource/research-loop";
import type { Db } from "@/lib/server/lottery-service";
import { loadBestDocument } from "./evidence-store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { from: (n: string) => any };
const t = (db: Db, name: string) => (db as unknown as Loose).from(name);

export type ExperienceMode = "mock" | "replay" | "real";
export interface ExperienceRow extends ExperienceRecord {
  host: string;
  source: "proposal_run" | "human_review" | "gold_eval";
  failedFields: string[];
  hintUsed: boolean;
  hintHit: boolean | null;
  mode: ExperienceMode;
  candidateId: string | null;
  proposalKey: string | null;
}

/** 直近の経験（新しい順）。提案の材料。最大 limit 件（古い経験は重みも小さい） */
export async function loadExperiences(db: Db, householdId: string, limit = 400): Promise<ExperienceRecord[]> {
  try {
    const r = (await t(db, "investigation_experiences").select("id,features,doc_chars,found_buckets,verification,recorded_at,failed_fields,experience_version").eq("household_id", householdId).order("recorded_at", { ascending: false }).limit(limit)) as { data: Record<string, unknown>[] | null };
    return (r.data ?? []).map((x) => ({ id: String(x.id), features: (x.features as string[]) ?? [], docChars: Number(x.doc_chars), foundBuckets: (x.found_buckets as number[]) ?? [], verification: x.verification as Verification, at: String(x.recorded_at), failedFields: (x.failed_fields as string[]) ?? [], version: Number(x.experience_version ?? EXPERIENCE_VERSION) }));
  } catch {
    return [];
  }
}

export async function saveExperience(db: Db, householdId: string, e: ExperienceRow): Promise<boolean> {
  try {
    const r = (await t(db, "investigation_experiences").insert({
      household_id: householdId,
      candidate_id: e.candidateId,
      proposal_key: e.proposalKey,
      host: e.host.slice(0, 120),
      features: e.features.slice(0, 80),
      doc_chars: e.docChars,
      found_buckets: e.foundBuckets,
      verification: e.verification,
      source: e.source,
      failed_fields: e.failedFields.slice(0, 12),
      hint_used: e.hintUsed,
      hint_hit: e.hintHit,
      experience_version: e.version ?? EXPERIENCE_VERSION,
      mode: e.mode,
      recorded_at: e.at,
    })) as { error: unknown };
    return !r.error;
  } catch {
    return false;
  }
}

const hostOf = (url: string | null): string => (url ? canonUrl(url).host : "").slice(0, 120) || "unknown";

/** 重要条件の位置（字位置）が、ヒントの範囲に入っているか。ヒントを出さなかった調査は null */
function hintHitOf(text: string, quotes: readonly string[], hints: readonly ReadHint[]): boolean | null {
  if (!hints.length) return null;
  return quotes.some((q) => {
    const at = text.indexOf(q.trim());
    return at >= 0 && hints.some((h) => at >= h.from && at < h.to);
  });
}

/**
 * 1項目の調査結果から、ページごとの経験を作る。検証できた根拠（引用が本文に実在し、導出できた項目）の位置だけを記録する。
 * 検証の強さは ai_unverified（AIの調査結果。人・gold の確認までは仮説）。人の確認は recordHumanExperience が別に追記する。
 */
export function experiencesFromResult(a: { result: ResearchResult; candidateId: string; proposalKey: string | null; mode: ExperienceMode; at: string; hintsByUrl?: Map<string, ReadHint[]> }): ExperienceRow[] {
  const fields = a.result.registration.output?.fields ?? {};
  const out: ExperienceRow[] = [];
  for (const e of a.result.evidence.filter((x): x is Evidence & { url: string } => x.kind === "page" && !!x.url)) {
    // 観察（原文から確認）として登録された項目の引用のうち、本文に実在するものだけが位置の材料になる（buildExperience が実在を確かめる）
    const quotes = Object.values(fields).filter((f) => f.evidenceId === e.id && f.basis === "observed" && f.quote).map((f) => f.quote as string);
    const exp = buildExperience({ features: discoverFeatures({ url: e.url, text: e.text, slots: e.structure?.slots.length, relatedEvents: e.structure?.relatedEvents.length }), text: e.text, quotes, verification: "ai_unverified", at: a.at });
    if (!exp) continue;
    const hints = a.hintsByUrl?.get(canonUrl(e.url).key) ?? [];
    out.push({ ...exp, host: hostOf(e.url), source: "proposal_run", failedFields: [], hintUsed: hints.length > 0, hintHit: hintHitOf(e.text, quotes, hints), mode: a.mode, candidateId: a.candidateId, proposalKey: a.proposalKey });
  }
  return out;
}

/**
 * 人の確認（approve_with_edits）の結果を、検証済み（human）の経験として追記する。人が直さなかった項目の引用だけを「正しい位置」とし、直した項目は failed_fields に残す。
 * 本文は候補に保存された全文（evidence_documents）から読む。無ければ何もしない。
 */
export async function recordHumanExperience(a: { db: Db; householdId: string; proposalId: string; edits: Record<string, string>; at: string; mode?: ExperienceMode }): Promise<{ saved: number }> {
  try {
    const r = (await t(a.db, "registration_proposals").select("candidate_id,proposal_key,fields,source_urls").eq("id", a.proposalId).eq("household_id", a.householdId).maybeSingle()) as { data: { candidate_id: string; proposal_key: string; fields: Record<string, { quote: string | null; support: string; evidence?: string | null }>; source_urls: string[] } | null };
    const p = r.data;
    if (!p) return { saved: 0 };
    const edited = new Set(Object.keys(a.edits).filter((k) => a.edits[k] !== undefined));
    const quotes = Object.entries(p.fields ?? {}).filter(([k, f]) => !edited.has(k) && f.quote && (f.support === "literal_in_quote" || f.support === "normalized_match")).map(([, f]) => f.quote as string);
    let saved = 0;
    for (const url of (p.source_urls ?? []).slice(0, 4)) {
      const doc = await loadBestDocument(a.db, a.householdId, p.candidate_id, url);
      if (!doc) continue;
      const exp = buildExperience({ features: discoverFeatures({ url: doc.url, text: doc.text, slots: doc.structure?.slots.length, relatedEvents: doc.structure?.relatedEvents.length }), text: doc.text, quotes, verification: "human", at: a.at, failedFields: [...edited] });
      if (!exp) continue;
      if (await saveExperience(a.db, a.householdId, { ...exp, host: hostOf(doc.url), source: "human_review", failedFields: [...edited].slice(0, 12), hintUsed: false, hintHit: null, mode: a.mode ?? "mock", candidateId: p.candidate_id, proposalKey: p.proposal_key })) saved++;
    }
    return { saved };
  } catch {
    return { saved: 0 };
  }
}

// ------------------------------------------------------------------ 画像の解析結果の再利用
/** 同じURLの解析結果を、取得し直さずに再利用してよい期間（日）。これを過ぎたら画像を取り直し、内容（ハッシュ）が同じなら再利用・違えば再解析する */
export const IMAGE_REUSE_DAYS = 7;
/** 取得できなかった画像（robots・期限切れ等）を、再び取りに行かない期間（日） */
export const IMAGE_FAILED_RETRY_DAYS = 3;
/** 保存してよい失敗（再試行しても同じ結果になる理由）。通信・タイムアウト・上限・停止などの一時的な失敗は保存せず、次回再試行する */
export const PERSISTENT_FAILURES = new Set(["private_url", "robots", "auth_required", "not_found", "unsupported_type", "spoofed_type", "too_large_bytes", "too_large_pixels", "corrupt", "invalid_url", "blocked"]);

export interface LoadedImageObservation {
  status: "analyzed" | "unreadable" | "failed";
  readings: VisionReading[];
  failureReason: string | null;
  sha256: string | null;
  observedAt: string;
  /** 再利用の期間を過ぎている（画像を取り直して、ハッシュが同じなら再利用する） */
  stale: boolean;
}

/** 同じ候補・同じ画像URL・同じモードの最新の解析結果。**モード（mock/replay/real）が違う結果は返さない**（モックを実解析として再利用しない） */
export async function loadImageObservation(db: Db, householdId: string, candidateId: string, imageUrl: string, mode: ExperienceMode, now: Date = new Date()): Promise<LoadedImageObservation | null> {
  try {
    const r = (await t(db, "evidence_image_observations").select("status,readings,failure_reason,content_sha256,observed_at").eq("household_id", householdId).eq("candidate_id", candidateId).eq("url_key", canonUrl(imageUrl).key.slice(0, 300)).eq("mode", mode).order("observed_at", { ascending: false }).limit(1)) as { data: { status: LoadedImageObservation["status"]; readings: VisionReading[]; failure_reason: string | null; content_sha256: string | null; observed_at: string }[] | null };
    const x = r.data?.[0];
    if (!x) return null;
    const ageDays = (now.getTime() - new Date(x.observed_at).getTime()) / 86_400_000;
    const limit = x.status === "failed" ? IMAGE_FAILED_RETRY_DAYS : IMAGE_REUSE_DAYS;
    return { status: x.status, readings: x.readings ?? [], failureReason: x.failure_reason, sha256: x.content_sha256, observedAt: x.observed_at, stale: ageDays > limit };
  } catch {
    return null;
  }
}

export async function saveImageObservation(db: Db, householdId: string, candidateId: string, o: ImageObservation, a: { mode: ExperienceMode; modelId: string | null; at: string }): Promise<boolean> {
  const persistFailure = o.status === "failed" && !!o.failureReason && PERSISTENT_FAILURES.has(o.failureReason);
  if (o.status !== "analyzed" && o.status !== "unreadable" && !persistFailure) return false; // 一時的な失敗・上限超過は保存しない（再解析できる）
  if (o.meta?.reusedFromCache) return true; // 保存済みの結果を再利用しただけ（同じ内容の行が既にある）
  try {
    const m = o.meta;
    const r = (await t(db, "evidence_image_observations").insert({
      household_id: householdId,
      candidate_id: candidateId,
      image_url: o.url.slice(0, 500),
      url_key: canonUrl(o.url).key.slice(0, 300),
      image_index: Math.min(40, Math.max(1, o.imageIndex)),
      status: o.status,
      failure_reason: o.status === "failed" ? (o.failureReason ?? null) : null,
      content_sha256: m?.sha256 ?? null,
      width: m?.width ?? null,
      height: m?.height ?? null,
      tiles: m?.tiles ?? null,
      cost_jpy: m?.costJpy ?? null,
      input_tokens: m?.inputTokens ?? null,
      output_tokens: m?.outputTokens ?? null,
      readings: o.readings.map((x) => ({ field: x.field, text: x.text, ...(x.uncertainty ? { uncertainty: x.uncertainty } : {}), ...(x.region ? { region: x.region } : {}) })),
      mode: a.mode,
      model_id: a.modelId,
      observed_at: a.at,
    })) as { error: { code?: string } | null };
    return !r.error || r.error.code === "23505"; // 既にある（同じ画像・同じ内容・モード）は成功扱い
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ 収集時の画像の取得・検査（解析はしない。mode=intake）
export interface IntakeRow {
  status: "fetched" | "failed";
  failureReason: string | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  observedAt: string;
}
/** 収集時に取得・検査した画像の記録（画像URL→最新の行）。解析の結果（mock/replay/real）とは別のモード */
export async function loadIntakeObservations(db: Db, householdId: string, candidateId: string): Promise<Map<string, IntakeRow>> {
  const m = new Map<string, IntakeRow>();
  try {
    const r = (await t(db, "evidence_image_observations").select("image_url,status,failure_reason,content_sha256,width,height,observed_at").eq("household_id", householdId).eq("candidate_id", candidateId).eq("mode", "intake").order("observed_at", { ascending: true })) as { data: Record<string, unknown>[] | null };
    for (const x of r.data ?? []) m.set(String(x.image_url), { status: x.status as IntakeRow["status"], failureReason: (x.failure_reason as string | null) ?? null, sha256: (x.content_sha256 as string | null) ?? null, width: (x.width as number | null) ?? null, height: (x.height as number | null) ?? null, observedAt: String(x.observed_at) });
  } catch {
    /* 読めなければ空 */
  }
  return m;
}
export async function saveIntakeObservation(db: Db, householdId: string, candidateId: string, a: { url: string; index: number; status: "fetched" | "failed"; failureReason?: string; sha256?: string; width?: number; height?: number; at: string }): Promise<boolean> {
  try {
    const r = (await t(db, "evidence_image_observations").insert({ household_id: householdId, candidate_id: candidateId, image_url: a.url.slice(0, 500), url_key: canonUrl(a.url).key.slice(0, 300), image_index: Math.min(40, Math.max(1, a.index)), status: a.status, failure_reason: a.status === "failed" ? (a.failureReason ?? null) : null, content_sha256: a.sha256 ?? null, width: a.width ?? null, height: a.height ?? null, readings: [], mode: "intake", observed_at: a.at })) as { error: { code?: string } | null };
    return !r.error || r.error.code === "23505";
  } catch {
    return false;
  }
}
