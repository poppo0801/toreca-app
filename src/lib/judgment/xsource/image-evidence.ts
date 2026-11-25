/**
 * 画像を一次情報として扱う（Phase 2・純関数＋注入されたビジョンクライアント）。
 *
 * 位置づけ:
 *  - X投稿・応募ページの画像に、応募期間・店・商品・応募単位が書かれていることがある（本文には無い／本文と矛盾する）。
 *  - 収集時に既に画像を解析した結果（ImageReading。AIの読み取りで原本と未照合）があれば**再利用**し、同じ画像を重ねて課金解析しない。
 *    読み取りの無い画像だけを、注入された VisionClient で解析する（実装は既定でモック。**有料のビジョン実行は別途の明示承認が必要**で、ここでは呼ばない）。
 *  - 画像から読んだ内容は**仮説**であり、原文の確認済み事実へ昇格させない（引用の根拠にしない・観察としてAIに渡す）。
 *    本文と一致すれば「本文でも確認」、本文と矛盾すれば**矛盾として残して未確定**にし（無言でどちらかを採用しない）、画像だけにある情報は「画像のみ・原本未照合」とする。
 *  - 読めなかった・解析できなかった・上限で解析しなかった画像も、状態として残す（画像の内容を「無い」と扱わない＝重要条件を無言で除外しない）。
 */
import type { ImageReading } from "@/lib/collector/evidence";

export interface VisionReading {
  field: string;
  text: string;
  /** 画像内の位置の記述（例: 「右下の注意書き」）。原本照合の手がかり。無ければ空 */
  region?: string;
  uncertainty?: "high" | "medium" | "low";
}
export interface VisionRequest {
  imageUrl: string;
  /** 1始まりの画像番号（収集時の画像参照の並び） */
  imageIndex: number;
  /** 読み取ってほしい項目（応募期間・店・商品・応募単位・購入条件 など） */
  wantFields: string[];
  /** 期間を過ぎた保存済みの解析結果（画像を取り直して内容のハッシュが同じなら、有料の解析を重ねずこの結果を再利用する） */
  known?: { sha256: string; readings: VisionReading[] };
}
/** 画像の取得・解析に関する付随情報（再利用の鮮度判定・費用の記録・出所の追跡に使う。原本の画像は含まない） */
export interface VisionMeta {
  /** 取得した原本のバイトの SHA-256 先頭16桁（同一性・差し替えの検出） */
  sha256?: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** 縦長の分割後の枚数（1なら分割なし） */
  tiles?: number;
  fetchedAt?: string;
  costJpy?: number;
  inputTokens?: number;
  outputTokens?: number;
  modelId?: string;
  /** 保存済みの解析結果を再利用した（有料の解析を重ねていない） */
  reusedFromCache?: boolean;
}
/** 取得・解析に失敗した結果。reason は分類コード（robots・not_found・too_large_pixels・budget など）。retryable=true は保存せず、次回再試行できる */
export interface VisionFailure {
  failed: string;
  message?: string;
  retryable?: boolean;
  meta?: VisionMeta;
}
export type VisionOutcome = { readings: VisionReading[]; meta?: VisionMeta } | VisionFailure | null;
/** 注入されるビジョンクライアント。失敗・読み取れないときは失敗の結果か null（例外を投げない）。実AI版は vision-real.ts（承認と許可証が無いと作れない） */
export type VisionClient = (req: VisionRequest) => Promise<VisionOutcome>;

export type ImageStatusKind = "reused" | "analyzed" | "unreadable" | "failed" | "skipped_limit" | "not_analyzed";
export interface ImageObservation {
  imageIndex: number;
  /** 画像の識別子（番号＋内容のハッシュまたはURLのハッシュ）。AIへの注記・登録案の根拠表示・保存で同じ画像を指すために使う */
  imageId: string;
  url: string;
  status: ImageStatusKind;
  /** 失敗・未解析の理由（分類コード）。画像の内容が「無い」のではなく「確認できていない」理由 */
  failureReason?: string;
  meta?: VisionMeta;
  /** この画像由来の読み取り（再利用・新規）。仮説であり、原文の事実ではない */
  readings: { field: string; text: string; uncertainty: "high" | "medium" | "low" | null; origin: "collector_reading" | "vision"; region?: string }[];
}

export type Reconcile = "confirmed_by_text" | "conflict" | "image_only" | "text_only_unverifiable";
export interface ReconciledReading {
  imageIndex: number;
  field: string;
  imageText: string;
  status: Reconcile;
  /** 矛盾したときの本文側の値（比較に使った日付・数値の表記） */
  textValues?: string[];
  uncertainty: "high" | "medium" | "low" | null;
}

export interface ImageAnalysisResult {
  observations: ImageObservation[];
  reconciled: ReconciledReading[];
  /** AIへ渡す注記（観察。引用の根拠にしない） */
  notes: string[];
  counts: { images: number; reused: number; analyzed: number; failed: number; skipped: number; conflicts: number };
}

export const DEFAULT_WANT_FIELDS = ["応募期間", "応募開始", "応募締切", "当選発表", "対象店舗", "対象商品", "応募単位（店舗選択・商品ごと）", "購入条件・会員条件", "受取方法"];
export const MAX_VISION_ANALYSES = 4;

const nfkc = (s: string): string => s.normalize("NFKC");

const hash6 = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
};
export const imageIdOf = (index: number, url: string, sha256?: string): string => `IMG${index}-${sha256 ? sha256.slice(0, 8) : hash6(url)}`;

/** 失敗の分類コードの表示用の説明（画像の内容が無いのではなく、確認できていない理由） */
export const FAILURE_LABEL: Record<string, string> = {
  pending_approval: "取得・検査は済んでいるが、画像の解析（有料）は承認が必要で未実施",
  invalid_url: "URLが不正",
  private_url: "個人用・期限つきのURLのため取得しない",
  blocked: "取得できないアドレス",
  robots: "サイトが取得を許可していない（robots）",
  auth_required: "ログインや権限が必要",
  not_found: "画像が見つからない（期限切れの可能性）",
  rate_limited: "アクセス制限（429）",
  http_error: "取得エラー",
  timeout: "取得がタイムアウト",
  network: "接続できない",
  unsupported_type: "画像以外の種類",
  spoofed_type: "申告と中身の形式が一致しない（不正な可能性）",
  too_large_bytes: "ファイルが大きすぎる",
  too_large_pixels: "画像のピクセル数が大きすぎる",
  corrupt: "画像が壊れている",
  not_attempted: "取得の上限・停止のため未取得",
  budget: "解析の費用・回数の上限のため未解析",
  vision_error: "画像解析の呼び出しに失敗",
  analysis_unavailable: "画像解析が許可されていない（未実施）",
};
const DATE_FIELD = /(deadline|start|end|date|period|result|announce|期間|締切|開始|終了|発表|日)/i;

/** 文字列から日付（月/日）を集める。「11/30」「11月30日」「2026-11-30」など。年は無視して月日で比較（年またぎの誤判定を避けるため月日だけ） */
export function dateTokens(text: string): string[] {
  const t = nfkc(text);
  const out = new Set<string>();
  for (const m of t.matchAll(/(?:\d{4}[/.\-年])?\s*(?<!\d)(\d{1,2})\s*[/月.\-]\s*(\d{1,2})(?!\d)\s*日?/g)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.add(`${mo}/${d}`);
  }
  return [...out];
}

const compact = (s: string): string => nfkc(s).replace(/[\s　・、,。.\-ー_()（）「」『』【】]/g, "").toLowerCase();

/**
 * 画像の読み取りを、本文と突き合わせる。日付項目は月日の集合で比較（共通があれば一致、両方に日付があるのに共通が無ければ矛盾）。
 * その他の項目は、片方がもう片方を含めば本文でも確認、そうでなければ「画像のみ」（矛盾とは断定しない。表記の違いの可能性）。
 */
export function reconcileReading(field: string, imageText: string, postText: string): { status: Reconcile; textValues?: string[] } {
  if (DATE_FIELD.test(field) || dateTokens(imageText).length > 0) {
    const img = dateTokens(imageText);
    const txt = dateTokens(postText);
    if (img.length > 0 && txt.length > 0) {
      if (img.some((d) => txt.includes(d))) return { status: "confirmed_by_text" };
      return { status: "conflict", textValues: txt.slice(0, 6) };
    }
    return { status: img.length > 0 ? "image_only" : "text_only_unverifiable" };
  }
  const a = compact(imageText);
  const b = compact(postText);
  if (a.length >= 2 && b.includes(a)) return { status: "confirmed_by_text" };
  return { status: "image_only" };
}

export async function analyzeImages(a: {
  /** 画像の公開URL（投稿・引用元の添付。収集時の imageRefs） */
  imageRefs: readonly string[];
  /** 収集時の画像解析の読み取り（再利用する。画像番号が分かるものは、その画像の解析済みとして扱う） */
  existing: readonly ImageReading[];
  /** 比較に使う投稿・ページ本文 */
  postText: string;
  vision?: VisionClient;
  /** 収集時の画像の取得・検査の結果（URL→理由コード・付随情報）。ビジョンが無いとき、未解析の理由を「承認待ち」や取得失敗の分類として明示する */
  intake?: Record<string, { reason: string; meta?: VisionMeta }>;
  wantFields?: string[];
  maxAnalyses?: number;
}): Promise<ImageAnalysisResult> {
  const want = a.wantFields ?? DEFAULT_WANT_FIELDS;
  const max = a.maxAnalyses ?? MAX_VISION_ANALYSES;
  const refs = a.imageRefs.filter((u) => /^https:\/\//.test(u));
  const total = refs.length;
  // 画像番号が分からない読み取りは、画像が1枚だけのときだけ「その画像の読み取り」として扱う（複数枚のとき、どの画像か分からないものを全画像の解析済みにしない）
  const byIndex = (i: number): ImageReading[] => a.existing.filter((r) => r.imageIndex === i || (r.imageIndex === null && total === 1));
  const obs: ImageObservation[] = [];
  let analyzed = 0;
  for (let i = 1; i <= total; i++) {
    const url = refs[i - 1];
    const have = byIndex(i);
    if (have.length > 0) {
      obs.push({ imageIndex: i, imageId: imageIdOf(i, url), url, status: "reused", readings: have.map((r) => ({ field: r.field, text: r.text, uncertainty: r.uncertainty, origin: "collector_reading" as const })) });
      continue;
    }
    if (!a.vision) {
      const k = a.intake?.[url];
      obs.push({ imageIndex: i, imageId: imageIdOf(i, url, k?.meta?.sha256), url, status: "not_analyzed", failureReason: k?.reason ?? "analysis_unavailable", ...(k?.meta ? { meta: k.meta } : {}), readings: [] });
      continue;
    }
    if (analyzed >= max) {
      obs.push({ imageIndex: i, imageId: imageIdOf(i, url), url, status: "skipped_limit", failureReason: "budget", readings: [] });
      continue;
    }
    // 同じURLの画像が複数回ある（投稿と引用元の重複など）ときは、1回だけ解析して結果を共有する（重複課金の回避）
    const dup = obs.find((o) => o.url === url && (o.status === "analyzed" || o.status === "unreadable" || o.status === "failed"));
    if (dup) {
      obs.push({ ...dup, imageIndex: i, imageId: imageIdOf(i, url, dup.meta?.sha256), meta: dup.meta ? { ...dup.meta, reusedFromCache: true } : dup.meta, readings: dup.readings.map((x) => ({ ...x })) });
      continue;
    }
    analyzed++;
    const r: VisionOutcome = await a.vision({ imageUrl: url, imageIndex: i, wantFields: want }).catch(() => null);
    const id = imageIdOf(i, url, r && "meta" in r ? r.meta?.sha256 : undefined);
    if (!r) obs.push({ imageIndex: i, imageId: id, url, status: "failed", failureReason: "vision_error", readings: [] });
    else if ("failed" in r) obs.push({ imageIndex: i, imageId: id, url, status: r.failed === "budget" ? "skipped_limit" : "failed", failureReason: r.failed, ...(r.meta ? { meta: r.meta } : {}), readings: [] });
    else if (r.readings.length === 0) obs.push({ imageIndex: i, imageId: id, url, status: "unreadable", failureReason: "unreadable", ...(r.meta ? { meta: r.meta } : {}), readings: [] });
    else obs.push({ imageIndex: i, imageId: id, url, status: "analyzed", ...(r.meta ? { meta: r.meta } : {}), readings: r.readings.slice(0, 20).map((x) => ({ field: x.field.slice(0, 40), text: x.text.slice(0, 300), uncertainty: x.uncertainty ?? null, origin: "vision" as const, ...(x.region ? { region: x.region.slice(0, 80) } : {}) })) });
  }
  const idOf = new Map(obs.map((o) => [o.imageIndex, o.imageId]));
  const imgLabel = (n: number): string => `画像${n}枚目(${idOf.get(n) ?? "?"})`;
  const reconciled: ReconciledReading[] = obs.flatMap((o) =>
    o.readings.map((r) => {
      const c = reconcileReading(r.field, r.text, a.postText);
      return { imageIndex: o.imageIndex, field: r.field, imageText: r.text, status: c.status, ...(c.textValues ? { textValues: c.textValues } : {}), uncertainty: r.uncertainty };
    }),
  );
  const notes: string[] = [];
  for (const r of reconciled) {
    const head = `${imgLabel(r.imageIndex)}・${r.field}`;
    const unc = r.uncertainty ? `・確度${r.uncertainty}` : "";
    if (r.status === "conflict") notes.push(`【矛盾・未確定】${head}「${r.imageText.slice(0, 60)}」は本文の日付（${(r.textValues ?? []).join("・")}）と食い違う（どちらも確認済みとしない。人または別の一次情報で確認が必要${unc}）`);
    else if (r.status === "image_only") notes.push(`${head}「${r.imageText.slice(0, 80)}」は画像のみの情報（AIの読み取り・原本と未照合・事実として確定しない${unc}）`);
    else if (r.status === "confirmed_by_text") notes.push(`${head}「${r.imageText.slice(0, 60)}」は本文でも確認できる`);
  }
  const bad = obs.filter((o) => o.status === "failed" || o.status === "unreadable" || o.status === "skipped_limit" || o.status === "not_analyzed");
  if (bad.length) {
    const why = (o: ImageObservation): string => (o.status === "unreadable" ? "文字を読み取れない" : FAILURE_LABEL[o.failureReason ?? ""] ?? ({ failed: "解析に失敗", skipped_limit: "解析の上限で未実施", not_analyzed: "未解析" } as Record<string, string>)[o.status] ?? "確認できない");
    notes.push(`画像の内容を確認できていない: ${bad.map((o) => `${imgLabel(o.imageIndex)}（${why(o)}）`).join("／")}。画像の内容は「無い」ではなく未確認（画像に重要な条件が書かれている可能性がある）`);
  }
  // 画像から読み取れなかった項目（読み取れた画像があるときだけ。画像に書かれていない、とは断定しない）
  const readable = obs.filter((o) => o.readings.length > 0);
  if (readable.length > 0 && !a.wantFields) {
    const got = readable.flatMap((o) => o.readings.map((r) => nfkc(r.field)));
    const missing = DEFAULT_WANT_FIELDS.filter((w) => !got.some((g) => g.includes(nfkc(w).slice(0, 2)) || nfkc(w).includes(g.slice(0, 2))));
    if (missing.length > 0 && missing.length < DEFAULT_WANT_FIELDS.length) notes.push(`画像から読み取れなかった項目: ${missing.slice(0, 6).join("・")}（画像に書かれていない、とは断定しない。本文・リンク先で確認する）`);
  }
  return {
    observations: obs,
    reconciled,
    notes,
    counts: { images: total, reused: obs.filter((o) => o.status === "reused").length, analyzed: obs.filter((o) => o.status === "analyzed").length, failed: obs.filter((o) => o.status === "failed" || o.status === "unreadable").length, skipped: obs.filter((o) => o.status === "skipped_limit" || o.status === "not_analyzed").length, conflicts: reconciled.filter((r) => r.status === "conflict").length },
  };
}

/** テスト・開発用のモック（費用0）。画像URL→読み取りの固定表を返す。表に無い画像は読み取れない（unreadable）。実AIではない */
export function mockVision(table: Record<string, VisionReading[] | null>, calls?: VisionRequest[]): VisionClient {
  return async (req) => {
    calls?.push(req);
    const r = table[req.imageUrl];
    return r === undefined ? { readings: [] } : r === null ? null : { readings: r };
  };
}
