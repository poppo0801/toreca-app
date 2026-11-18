import "server-only";
import type { FetchedSource } from "@/lib/agent/lottery-grouping/identifiers";
import { MAX_STORED_TEXT } from "@/lib/agent/lottery-grouping/identifiers";
import { redact } from "@/lib/agent/lottery-grouping/recorder";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 情報源の保存・読み込み（Stage 8F-4）。表 lottery_source_snapshots（マイグレーション100）。
 *  - 保存するのは、元のURL・取得した本文の要点（最大4000文字）・取得日時・情報源の種類・同じイベントを示す識別子だけ。
 *    個人情報・認証情報・ページ全文は保存しない（キーらしき文字列は伏せる）。保持期間は既定180日（purge で削除）。
 *  - 同じ抽選・同じURL・同じ本文は1件（一意制約）。再取得・同時実行でも二重に保存しない。
 *  - 表が無い環境（本番など、マイグレーション未適用）では、保存は何もせず・読み込みは空を返す（既存の動作に影響しない）。
 *  - 応募・当選・購入・通知・期限・店舗マスターは更新しない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
const any = (db: Db) => db as any;

export type SourceKind = "x_post" | "web_page" | "candidate_text" | "manual_note";
export type SnapshotOrigin = "collector" | "manual" | "grouping_fetch";

/** 評価・判定の入力に使う、1件の保存済みの情報源の文章（取得したページと同じ「題 本文」の形） */
export const evidenceText = (title: string, body: string): string => `${title} ${body}`;

export function kindOfUrl(url: string): SourceKind {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)(x\.com|twitter\.com|t\.co)$/i.test(h) ? "x_post" : "web_page";
  } catch {
    return "web_page";
  }
}

export interface SnapshotInput {
  lotteryId: string;
  url: string;
  finalUrl?: string | null;
  kind: SourceKind;
  origin: SnapshotOrigin;
  title?: string;
  body: string;
  identifiers?: { kind: string; value: string }[];
  fetchedAt?: string;
}

/** 保存する。戻り値は新しく保存した件数（重複・表が無い・失敗は0）。例外を投げない */
export async function saveSourceSnapshots(db: Db, householdId: string, items: SnapshotInput[]): Promise<{ saved: number; tableMissing: boolean }> {
  const rows = items
    .map((s) => ({
      household_id: householdId, lottery_id: s.lotteryId, url: s.url.slice(0, 2000), final_url: s.finalUrl?.slice(0, 2000) ?? null, source_kind: s.kind, origin: s.origin,
      title: redact(s.title ?? "").slice(0, 200), body: redact(s.body.replace(/\s+/g, " ").trim()).slice(0, MAX_STORED_TEXT),
      body_hash: "", identifiers: (s.identifiers ?? []).slice(0, 10), fetched_at: s.fetchedAt ?? new Date().toISOString(),
    }))
    .filter((r) => /^https?:\/\//.test(r.url) && r.body.length > 0);
  if (rows.length === 0) return { saved: 0, tableMissing: false };
  const { hash53 } = await import("@/lib/agent/lottery-grouping/verify");
  for (const r of rows) r.body_hash = hash53(r.body);
  const { data, error } = await any(db).from("lottery_source_snapshots").upsert(rows, { onConflict: "lottery_id,url,body_hash", ignoreDuplicates: true }).select("id");
  if (error) return { saved: 0, tableMissing: /does not exist|schema cache|42P01|PGRST205/i.test(`${error.code ?? ""} ${error.message ?? ""}`) };
  return { saved: (data ?? []).length, tableMissing: false };
}

/** 取得したページの台帳（実行中に作られる）を保存する形にする */
export const snapshotsOfFetched = (fetched: FetchedSource[]): SnapshotInput[] =>
  fetched.map((f) => ({ lotteryId: f.lotteryId, url: f.url, finalUrl: f.finalUrl, kind: kindOfUrl(f.url), origin: "grouping_fetch" as const, title: f.title, body: f.text, identifiers: f.identifiers.map((i) => ({ kind: i.kind, value: i.value })), fetchedAt: f.fetchedAt }));

/** 抽選ごとの保存済みの情報源の文章（期限内のもの。新しい順に最大6件）。表が無ければ空 */
export async function loadSourceSnapshotTexts(db: Db, lotteryIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < lotteryIds.length; i += 100) {
    const { data, error } = await any(db).from("lottery_source_snapshots").select("lottery_id,title,body,fetched_at").in("lottery_id", lotteryIds.slice(i, i + 100)).gt("expires_at", new Date().toISOString()).order("fetched_at", { ascending: false }).limit(1000);
    if (error) return out;
    for (const r of (data ?? []) as { lottery_id: string; title: string; body: string }[]) {
      const cur = out.get(r.lottery_id) ?? [];
      if (cur.length < 6) out.set(r.lottery_id, [...cur, evidenceText(r.title, r.body)]);
    }
  }
  return out;
}

/** 保持期間を過ぎた情報源を削除する（サービス側の定期処理用）。戻り値は削除件数 */
export async function purgeExpiredSourceSnapshots(db: Db, limit = 1000): Promise<number> {
  const { data, error } = await any(db).rpc("purge_expired_source_snapshots", { p_limit: limit });
  return error ? 0 : (data as number) ?? 0;
}
