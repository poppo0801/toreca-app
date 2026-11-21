/**
 * 画像根拠の検証の実行（Stage 10L・サーバー）。収集時の画像の読み取り（imageReadings）と元画像への参照（imageRefs）から、
 *   公開画像の取得（注入: 既存の `fetchXImage` = pbs.twimg.com のみ・https・リダイレクト禁止・3MB上限・形式判定）→ 画像ハッシュ → キャッシュ確認 → 盲検の書き起こし（注入）→ 照合（`image-verify.ts`）
 * を行い、判断の入力に渡す画像の根拠を作る。**画像を毎回再解析しない**（同じ世帯・候補・画像ハッシュの書き起こしは `shadow_image_verifications` から再利用）。
 *  - 書き込み先は shadow_image_verifications のみ（追記専用）。旧方式の表には書かない。
 *  - 取得できない（期限切れ・非公開・サイズ超過）・書き起こしの失敗・予算不足は、その画像は「照合できない」として扱い、申告は fact にならない（推測で確定しない）。
 *  - 認証・制限の回避はしない（取得は注入された既存の部品だけ。X/t.co等は取得しない）。
 */
import { createHash } from "node:crypto";
import type { ImageReading } from "@/lib/collector/evidence";
import { checkClaims, type ClaimCheck, type ImageTranscript, type TranscriptLine } from "@/lib/judgment/image-verify";
import type { ImageInputB64, Transcriber } from "@/lib/judgment/image-transcriber";
import type { Db } from "@/lib/server/lottery-service";

export interface ImageVerifierDeps {
  db: Db;
  /** 公開画像の取得（既存の取得部品）。取得できなければ null */
  fetchImage: (url: string) => Promise<(ImageInputB64 & { bytes: number }) | null>;
  transcribe: Transcriber;
  now?: () => Date;
  /** 1候補で検証する画像の最大枚数 */
  maxImages?: number;
  /** 画像1枚の書き起こしの費用の見込み（円）。予算の事前予約に使う */
  perImageReserveJpy?: number;
}

export interface ImageVerification {
  checks: ClaimCheck[];
  transcripts: ImageTranscript[];
  costJpy: number;
  fetched: number;
  failed: number;
  cached: number;
  /** 予算不足で書き起こせなかった画像の枚数 */
  skippedBudget: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (db: Db, t: string): any => (db as unknown as { from: (t: string) => unknown }).from(t);

const indexOfSource = (readings: ImageReading[]): number[] => {
  const s = new Set<number>();
  for (const r of readings) if (r.imageIndex != null) s.add(r.imageIndex);
  return [...s].sort((a, b) => a - b);
};

export async function verifyImageReadings(deps: ImageVerifierDeps, a: { householdId: string; candidateId: string; readings: ImageReading[]; refs: string[]; budgetJpy: number }): Promise<ImageVerification> {
  const now = deps.now ?? ((): Date => new Date());
  const max = deps.maxImages ?? 3;
  const reserve = deps.perImageReserveJpy ?? 0.8;
  const res: ImageVerification = { checks: [], transcripts: [], costJpy: 0, fetched: 0, failed: 0, cached: 0, skippedBudget: 0 };
  // 検証する画像: 申告に画像番号があればその画像。番号が無い申告があれば、参照のある画像すべて（最大 max 枚）
  const wanted = a.readings.some((r) => r.imageIndex == null) ? a.refs.map((_, i) => i + 1) : indexOfSource(a.readings);
  for (const idx of wanted.slice(0, max)) {
    const ref = a.refs[idx - 1];
    if (!ref) {
      res.failed++;
      continue;
    }
    const img = await deps.fetchImage(ref).catch(() => null);
    if (!img) {
      res.failed++;
      continue;
    }
    res.fetched++;
    const imageHash = createHash("sha256").update(Buffer.from(img.base64, "base64")).digest("hex");
    const fetchedAt = now().toISOString();
    let lines: TranscriptLine[] | null = null;
    let model = "cached";
    let promptVersion = "cached";
    let cost: number | null = 0;
    const hit = await table(deps.db, "shadow_image_verifications").select("transcript,model_id,prompt_version").eq("household_id", a.householdId).eq("candidate_id", a.candidateId).eq("image_hash", imageHash).maybeSingle();
    if (hit?.data) {
      lines = hit.data.transcript as TranscriptLine[];
      model = hit.data.model_id as string;
      promptVersion = hit.data.prompt_version as string;
      res.cached++;
    } else {
      if (a.budgetJpy - res.costJpy < reserve) {
        res.skippedBudget++;
        continue;
      }
      const t = await deps.transcribe({ mediaType: img.mediaType, base64: img.base64 }).catch(() => null);
      if (!t) {
        res.failed++;
        continue;
      }
      lines = t.lines;
      model = t.model;
      promptVersion = t.promptVersion;
      cost = t.costJpy;
      res.costJpy += t.costJpy ?? reserve; // 費用が不明な呼び出しは、予約額で計上する（0円にしない）
      const ins = await table(deps.db, "shadow_image_verifications").insert({ household_id: a.householdId, candidate_id: a.candidateId, image_index: idx, image_hash: imageHash, fetched_at: fetchedAt, transcript: lines, model_id: model, prompt_version: promptVersion, cost_jpy: t.costJpy });
      if (ins.error) res.failed++; // 保存に失敗しても、この実行では照合に使える（次回は再度書き起こす）
    }
    res.transcripts.push({ imageIndex: idx, imageHash, fetchedAt, lines: lines ?? [], method: "blind_transcription", model, promptVersion, costJpy: cost });
  }
  res.checks = checkClaims(a.readings, res.transcripts);
  return res;
}
