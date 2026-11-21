/**
 * 画像根拠の検証（Stage 10L）。**純関数のみ。DB・ネットワーク・AIには接続しない**（画像の取得と書き起こしは呼び出し側が注入する）。
 * 方針: 収集時の解析（旧方式のAI）が「画像にこう書いてある」と申告した根拠（imageReadings）は、**それだけでは事実（fact）の根拠にしない**。
 *   元画像を**独立に**読み直した結果（盲検の書き起こし: 申告を見せずに、画像に見える文字をすべて書き起こす）と照合し、
 *   申告の抜粋が書き起こしの「はっきり読めた行」に実在するときだけ「照合済み」とする（2つの独立した読みの一致＋画像のハッシュ・取得日時・画像番号の記録）。
 *   照合できないもの（画像が取得できない・抜粋が書き起こしに無い・読みづらい・画像が更新された）は、従来どおり inference/保留（AIの自己申告だけでは確定させない）。
 * 画像そのものは保存しない（ハッシュ・書き起こし・照合結果だけ。書き起こしは保持期限で掃除）。
 */
import type { ImageReading } from "@/lib/collector/evidence";
import type { EvidenceSeed } from "./build-input";

export interface TranscriptLine {
  text: string;
  /** clear=はっきり読めた／unclear=判読しづらい（照合に使わない） */
  certainty: "clear" | "unclear";
}
export interface ImageTranscript {
  /** 何枚目の画像か（1始まり） */
  imageIndex: number;
  /** 取得した画像のバイト列の SHA-256（16進）。画像が更新されたかの判定に使う */
  imageHash: string;
  fetchedAt: string;
  lines: TranscriptLine[];
  /** 書き起こしの方式・モデル・指示文の版 */
  method: "blind_transcription";
  model: string;
  promptVersion: string;
  /** 書き起こしの費用（円）。不明は null */
  costJpy: number | null;
}

export type ClaimStatus = "verified" | "not_found" | "illegible" | "no_image";
export interface ClaimCheck {
  field: string;
  imageIndex: number | null;
  status: ClaimStatus;
  /** 照合できた画像のハッシュ（verified のとき） */
  imageHash?: string;
  /** 一致した書き起こしの行（verified のとき。照合済みの根拠として判断に渡す本文） */
  line?: string;
}

const flat = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const MIN_QUOTE = 8; // 短い抜粋（「お一人様1回まで」未満の短文・「応募」だけ等）は、別の画像にも現れうる汎用の語句で、照合の根拠にならない（実測: 4〜7文字の抜粋が別画像で一致した）

/** 申告の抜粋が、書き起こしの行に実在するか（空白・全半角・大文字小文字の差だけを吸収。言い換えは許さない） */
export function lineContainsQuote(line: string, quote: string): boolean {
  const q = flat(quote);
  return q.length >= MIN_QUOTE && flat(line).includes(q);
}

/**
 * 申告（imageReadings）を、元画像の書き起こしと照合する。
 *  - 該当する画像（画像番号）の書き起こしが無い → no_image
 *  - 書き起こしの「clear」な行に抜粋が実在 → verified（その行と画像ハッシュを記録）
 *  - 「unclear」な行にだけ実在 → illegible（確定させない）
 *  - どの行にも無い → not_found（申告が画像で確認できない。確定させない）
 * 画像番号が不明な申告は、全ての画像の書き起こしを対象にする。
 */
export function checkClaims(readings: ImageReading[], transcripts: ImageTranscript[]): ClaimCheck[] {
  return readings.map((r) => {
    const pool = r.imageIndex == null ? transcripts : transcripts.filter((t) => t.imageIndex === r.imageIndex);
    if (!pool.length) return { field: r.field, imageIndex: r.imageIndex, status: "no_image" as const };
    for (const t of pool) {
      const hit = t.lines.find((l) => l.certainty === "clear" && lineContainsQuote(l.text, r.text));
      if (hit) return { field: r.field, imageIndex: t.imageIndex, status: "verified" as const, imageHash: t.imageHash, line: hit.text };
    }
    const soft = pool.some((t) => t.lines.some((l) => l.certainty === "unclear" && lineContainsQuote(l.text, r.text)));
    return { field: r.field, imageIndex: r.imageIndex, status: soft ? ("illegible" as const) : ("not_found" as const) };
  });
}

/**
 * 判断の入力に渡す画像の根拠の並び。
 *  - 照合済みの行（元画像の書き起こしと申告が一致）: kind=image_verified。事実（fact）の根拠にできる（引用は、この本文から行う）
 *  - 照合できなかった申告: kind=image_reading（これまでどおり。これだけを根拠に fact にはできない）
 */
export function imageEvidenceSeeds(readings: ImageReading[], checks: ClaimCheck[], url: string, fetchedAt: string): EvidenceSeed[] {
  const out: EvidenceSeed[] = [];
  const ok = checks.filter((c) => c.status === "verified" && c.line);
  if (ok.length) {
    const lines = [...new Set(ok.map((c) => `[画像${c.imageIndex ?? "?"}枚目・${c.field}] ${c.line}`))];
    out.push({ url, fetchedAt, via: "image_verified", origin: "secondary", text: `【画像の照合済みの記載（元画像を独立に書き起こした結果と、収集時の読み取りが一致した行。画像のハッシュ・取得日時を記録済み）】 ${lines.join(" ")}`, hash: null, status: "fetched", reused: true, kind: "image_verified" });
  }
  const rest = readings.filter((r, i) => checks[i]?.status !== "verified");
  if (rest.length) {
    const why: Record<string, string> = { not_found: "元画像で確認できず", illegible: "元画像の文字が不鮮明", no_image: "元画像を取得できず" };
    const lines = rest.map((r) => {
      const c = checks[readings.indexOf(r)];
      return `[${r.imageIndex ? `画像${r.imageIndex}枚目` : r.source || "画像"}・${r.field}${r.uncertainty ? `・確度${r.uncertainty}` : ""}・${why[c?.status ?? "no_image"] ?? "未照合"}] ${r.text}`;
    });
    out.push({ url, fetchedAt, via: "image_reading", origin: "secondary", text: `【画像からのAI読み取り（元画像と照合できていない・事実の根拠にできない）】 ${lines.join(" ")}`, hash: null, status: "fetched", reused: true, kind: "image_reading" });
  }
  return out;
}

/** 照合の要約（件数のみ。記録・報告用） */
export function summarizeChecks(checks: ClaimCheck[]): Record<ClaimStatus, number> {
  const m: Record<ClaimStatus, number> = { verified: 0, not_found: 0, illegible: 0, no_image: 0 };
  for (const c of checks) m[c.status]++;
  return m;
}
