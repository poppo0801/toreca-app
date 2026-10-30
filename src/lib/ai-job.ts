import { z } from "zod";
import { MAX_TILES } from "@/lib/image-tiles";

/**
 * AI一括解析のジョブ（Stage 5G）の純粋な部分: 入力の検証・重複判定のキー・状態の表示。
 * ジョブはサーバー（DB）に保存され、ページを移動しても・再読み込みしても状態と結果が残る。
 * 解析結果はいきなり抽選として登録せず「確認待ち」として保持し、利用者が確認・修正してから保存する。
 * 将来の定期収集（Stage 4C）も、同じジョブ・項目の仕組みに「情報源の差分」を項目として積む形で再利用できる。
 */
export const MAX_JOB_ITEMS = 20;
/** 1件の抽選に使える画像の枚数（縦長画像の分割後の枚数を含む。値は image-tiles の MAX_TILES と同じ） */
export const MAX_ITEM_IMAGES = MAX_TILES;
export const MAX_ACTIVE_JOBS = 5;
export const MAX_TEXT_CHARS = 20_000;

export type ItemSource = "text" | "url" | "x_url" | "images";
export type JobStatus = "queued" | "running" | "review" | "partial" | "failed" | "cancelled" | "saved";
export type ItemStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "saved" | "skipped";

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "待機中",
  running: "解析中",
  review: "確認待ち",
  partial: "一部失敗",
  failed: "失敗",
  cancelled: "キャンセル",
  saved: "保存済み",
};
export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  queued: "待機中",
  running: "解析中",
  done: "確認待ち",
  failed: "失敗",
  cancelled: "キャンセル",
  saved: "保存済み",
  skipped: "除外",
};

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((v) => /^https?:\/\/\S+$/i.test(v), "URLは http(s):// で始まる形式で入力してください");

export const jobItemSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("text"), text: z.string().trim().min(10, "文章は10文字以上で入力してください").max(MAX_TEXT_CHARS) }),
  z.object({ source: z.literal("url"), url: httpUrl }),
  z.object({ source: z.literal("x_url"), url: httpUrl }),
  z.object({
    source: z.literal("images"),
    /** Storage job-inputs 内のパス（自世帯のフォルダ）と、画像ごとのSHA-256（重複判定用） */
    paths: z.array(z.string().regex(/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/)).min(1).max(MAX_ITEM_IMAGES),
    shas: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(MAX_ITEM_IMAGES),
  }),
]);
export type JobItemInput = z.input<typeof jobItemSchema>;

export const createJobSchema = z.object({
  label: z.string().trim().max(60).default(""),
  items: z.array(jobItemSchema).min(1, "解析する項目を追加してください").max(MAX_JOB_ITEMS, `1回に解析できるのは${MAX_JOB_ITEMS}件までです`),
});
export type CreateJobInput = z.input<typeof createJobSchema>;

/** URLの正規化（同じ告知の別表記を同じとみなす: ホストの大小・#以降・末尾の/・追跡パラメータ） */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|igshid$|s$|t$)/i.test(k)) u.searchParams.delete(k);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return raw.trim();
  }
}

/** X投稿のID（/status/数字） */
export const xPostId = (url: string): string | null => /\/status(?:es)?\/(\d{5,25})/.exec(url)?.[1] ?? null;

/** 入力欄に貼り付けた複数行のURLを項目にする（空行・重複は除き、Xの投稿URLは x_url にする） */
export function urlsToItems(text: string): { items: { source: "url" | "x_url"; url: string }[]; invalid: string[] } {
  const seen = new Set<string>();
  const items: { source: "url" | "x_url"; url: string }[] = [];
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const u = line.trim();
    if (!u) continue;
    if (!httpUrl.safeParse(u).success) {
      invalid.push(u.slice(0, 80));
      continue;
    }
    const key = normalizeUrl(u);
    if (seen.has(key)) continue;
    seen.add(key);
    let host = "";
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      /* 上で検証済み */
    }
    items.push({ source: /(^|\.)(x|twitter)\.com$/.test(host) ? "x_url" : "url", url: u });
  }
  return { items, invalid };
}

export interface JobSummary {
  id: string;
  label: string;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  saved: number;
  createdAt: string;
  completedAt: string | null;
  seenAt: string | null;
}

/** 完了通知の対象（解析が終わっていて、確認がまだのジョブ） */
export const needsAttention = (j: JobSummary) => (j.status === "review" || j.status === "partial" || j.status === "failed") && j.seenAt === null;
export const isActive = (s: JobStatus) => s === "queued" || s === "running";

/** 完了通知の文言（例: 「5件中4件の解析が完了しました」） */
export function completionMessage(j: JobSummary): string {
  const ok = j.done + j.saved;
  if (j.status === "failed") return "AI読み取りに失敗しました";
  if (j.failed > 0) return `${j.total}件中${ok}件の解析が完了しました（${j.failed}件は失敗）`;
  return j.total > 1 ? `AI読み取りが完了しました（${ok}件）` : "AI読み取りが完了しました";
}
