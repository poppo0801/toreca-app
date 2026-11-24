import "server-only";
import type { HostGate, RunFetchBudget } from "@/lib/collector/fetch-control";
import { fetchPublicImage, type ImageFetchResult } from "@/lib/server/images/image-fetch";
import type { Db } from "@/lib/server/lottery-service";
import { loadIntakeObservations, PERSISTENT_FAILURES, saveIntakeObservation } from "@/lib/server/proposals/experience-store";
import { proposalPreviewEnabled } from "@/lib/server/proposals/flag";

/**
 * 収集時の公開画像の取得・検査（Phase 2・開発限定・**AIの解析はしない＝費用0**）。通常の収集の経路で、画像を次の順に処理する:
 *   発見（投稿・引用元の画像参照）→ 安全な取得（SSRF・robots・実バイト形式・ピクセル・サイズ・ホスト別制御）→ 記録（ハッシュ・寸法・失敗の分類。画像の原本は保存しない）→ 新AIの調査へ受け渡し
 * 受け渡し: 新AIの調査（generate）は、この記録を読み、**解析が未実施の画像を「取得・検査は済んでいるが、有料の解析は承認が必要で未実施」と明示**する（画像の内容を『無い』にしない）。
 * 有料の画像解析は、通常の収集（cron・API）からは起動しない。承認済みの関門を通った評価入口だけが、同じ取得の経路で解析する（vision-real）。
 * 既定OFF（IMAGE_INTAKE=on かつ新AI機能が有効な開発環境のときだけ）。本番では常に何もしない。
 */
export const imageIntakeEnabled = (env: Record<string, string | undefined> = process.env): boolean => proposalPreviewEnabled(env) && env.IMAGE_INTAKE === "on";
export const MAX_INTAKE_PER_CANDIDATE = 8;

export async function intakeCollectedImages(a: {
  db: Db;
  householdId: string;
  candidateId: string;
  imageRefs: readonly string[];
  gate?: HostGate;
  budget?: RunFetchBudget;
  shouldCancel?: () => boolean;
  now?: () => Date;
  /** 取得の実体の差し替え（テスト） */
  fetchImage?: (url: string) => Promise<ImageFetchResult>;
  env?: Record<string, string | undefined>;
}): Promise<{ fetched: number; failed: number; skipped: number; existing: number } | null> {
  if (!imageIntakeEnabled(a.env ?? process.env)) return null;
  const out = { fetched: 0, failed: 0, skipped: 0, existing: 0 };
  try {
    const known = await loadIntakeObservations(a.db, a.householdId, a.candidateId);
    const refs = [...new Set(a.imageRefs.filter((u) => /^https:\/\//.test(u)))].slice(0, MAX_INTAKE_PER_CANDIDATE);
    for (const [i, url] of refs.entries()) {
      if (known.has(url)) {
        out.existing++;
        continue;
      }
      const doFetch = a.fetchImage ?? ((u: string) => fetchPublicImage(u, { ...(a.gate ? { throttle: a.gate } : {}), ...(a.budget ? { budget: a.budget } : {}), ...(a.shouldCancel ? { shouldCancel: a.shouldCancel } : {}) }));
      const r = await doFetch(url);
      const at = (a.now ?? (() => new Date()))().toISOString();
      if (r.ok) {
        await saveIntakeObservation(a.db, a.householdId, a.candidateId, { url, index: i + 1, status: "fetched", sha256: r.image.sha256, width: r.image.width, height: r.image.height, at });
        out.fetched++;
      } else if (PERSISTENT_FAILURES.has(r.failure)) {
        await saveIntakeObservation(a.db, a.householdId, a.candidateId, { url, index: i + 1, status: "failed", failureReason: r.failure, at });
        out.failed++;
      } else out.skipped++; // 一時的な失敗・上限・停止は保存しない（次の収集で再び取得する）
    }
    return out;
  } catch {
    console.warn("[image-intake] failed");
    return null;
  }
}
