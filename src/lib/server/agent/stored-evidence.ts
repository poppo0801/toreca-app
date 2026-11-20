import "server-only";
import { createHash } from "node:crypto";
import { evidenceFromLastGood, MAX_EVIDENCE_CHARS, normalizeEvidenceUrl, EVIDENCE_VERSION, type StoredEvidence } from "@/lib/collector/evidence";
import type { Db } from "@/lib/server/lottery-service";

/**
 * Stage 9Z: 保存済みの原文・取得制限の記録を読み込む（読み取りのみ。何も書き換えない）。
 *  - 抽選ごとの保存済みの原文: ① 初回収集の候補（collection_candidates.last_good.evidence。抽選IDで紐づく）② 取得した情報源の保存（lottery_source_snapshots）。
 *    どちらも無い抽選は「保存なし」（空配列）。保存されていない過去の情報を、取得済みとして扱わない。
 *  - 取得制限の記録: collection_hard_sources（通常収集が記録している取得困難の情報源）。ドメイン／応募サービス単位でロボット制限が繰り返し記録され、
 *    直近に再確認していないものだけを「再取得しない」とする（一定期間後は再確認する＝制限が解除された場合に気づける）。制限の回避はしない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
const any = (db: Db) => db as any;

export const BLOCK_MIN_FAILS = 2;
export const BLOCK_RECHECK_DAYS = 7;

export async function loadStoredEvidence(db: Db, lotteryIds: string[]): Promise<Map<string, StoredEvidence[]>> {
  const out = new Map<string, StoredEvidence[]>();
  const add = (id: string, e: StoredEvidence) => {
    const cur = out.get(id) ?? [];
    if (!cur.some((x) => normalizeEvidenceUrl(x.url) === normalizeEvidenceUrl(e.url) && x.hash === e.hash)) out.set(id, [...cur, e].slice(0, 6));
  };
  for (let i = 0; i < lotteryIds.length; i += 100) {
    const ids = lotteryIds.slice(i, i + 100);
    const c = await any(db).from("collection_candidates").select("lottery_id,last_good").in("lottery_id", ids);
    for (const r of (c.data ?? []) as { lottery_id: string | null; last_good: unknown }[]) {
      const e = evidenceFromLastGood(r.last_good);
      if (r.lottery_id && e) add(r.lottery_id, e);
    }
    const s = await any(db).from("lottery_source_snapshots").select("lottery_id,url,source_kind,body,fetched_at").in("lottery_id", ids).gt("expires_at", new Date().toISOString()).order("fetched_at", { ascending: false });
    if (!s.error) {
      for (const r of (s.data ?? []) as { lottery_id: string; url: string; source_kind: string; body: string; fetched_at: string }[]) {
        const text = r.body.slice(0, MAX_EVIDENCE_CHARS);
        add(r.lottery_id, { v: EVIDENCE_VERSION, url: r.url, fetchedAt: r.fetched_at, via: r.source_kind === "x_post" ? "x_api" : "web_fetch", origin: "unknown", text, truncated: r.body.length > text.length, links: [], imageCount: 0, imageStatus: "none", hash: createHash("sha256").update(text).digest("hex").slice(0, 32) });
      }
    }
  }
  return out;
}

/** 通常収集が記録した「取得制限が繰り返されているホスト」の一覧（読み取りのみ）。直近に再確認が要るものは含めない */
export async function loadBlockedHosts(db: Db, householdId: string, now: Date): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await any(db).from("collection_hard_sources").select("scope,key,fail_kind,fail_count,last_failed_at").eq("household_id", householdId).in("scope", ["domain", "service"]).eq("fail_kind", "robots");
  if (error) return out;
  for (const r of (data ?? []) as { key: string; fail_count: number; last_failed_at: string | null }[]) {
    const age = r.last_failed_at ? (now.getTime() - new Date(r.last_failed_at).getTime()) / 86_400_000 : Infinity;
    if ((r.fail_count ?? 0) >= BLOCK_MIN_FAILS && age <= BLOCK_RECHECK_DAYS) out.add(r.key.replace(/^www\./, "").toLowerCase());
  }
  return out;
}
