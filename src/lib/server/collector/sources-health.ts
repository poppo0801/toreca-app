import "server-only";
import { hardSourceKeys, type ExclusionRule } from "@/lib/collector/triage";
import type { FailKind } from "@/lib/collector/queue";
import type { Db } from "@/lib/server/lottery-service";

/** 有効な収集元の除外ルール（世帯共通。利用者が指定したものだけ） */
export async function activeExclusions(db: Db, householdId: string): Promise<ExclusionRule[]> {
  const { data } = await db.from("collection_exclusions").select("id,scope,key,active,reason_code,label").eq("household_id", householdId).eq("active", true).limit(500);
  return (data ?? []) as unknown as ExclusionRule[];
}

export interface HardSourceEvent {
  url: string | null;
  chainId?: string | null;
  storeId?: string | null;
  chainName?: string;
  storeName?: string;
  failKind: FailKind;
  /** 代替の取得方法を試した結果（試していなければ undefined） */
  alt?: { source: string; ok: boolean };
}

/**
 * 取得困難な系列・店舗・応募サービスの記録。失敗の原因・回数・最終確認日・代替取得の成否を残し、成功した代替方法を次回以降に優先する。
 * 応募サービス単位だけでなく「店舗×サービス」でも記録し、共通サービスの失敗を理由に利用店舗全体を一律に取得不可としない。
 * 記録の失敗で本処理を止めない。
 */
export async function recordHardSource(db: Db, householdId: string, now: Date, ev: HardSourceEvent): Promise<void> {
  try {
    const keys = hardSourceKeys({ url: ev.url, chainId: ev.chainId, storeId: ev.storeId, chainName: ev.chainName, storeName: ev.storeName });
    const nowIso = now.toISOString();
    for (const k of keys) {
      const cur = (await db.from("collection_hard_sources").select("id,fail_count,alt_source,alt_success,alt_fail,needs_manual").eq("household_id", householdId).eq("scope", k.scope).eq("key", k.key).maybeSingle()).data;
      const altSuccess = (cur?.alt_success ?? 0) + (ev.alt?.ok ? 1 : 0);
      const altFail = (cur?.alt_fail ?? 0) + (ev.alt && !ev.alt.ok ? 1 : 0);
      const row = {
        household_id: householdId,
        scope: k.scope,
        key: k.key,
        label: k.label.slice(0, 120),
        chain_id: ev.chainId ?? null,
        store_id: ev.storeId ?? null,
        origin_url: ev.url?.slice(0, 500) ?? null,
        service_host: k.scope === "service" ? k.key : null,
        fail_kind: ev.failKind,
        fail_count: (cur?.fail_count ?? 0) + 1,
        last_failed_at: nowIso,
        last_checked_at: nowIso,
        alt_source: ev.alt?.ok ? ev.alt.source : (cur?.alt_source ?? ev.alt?.source ?? null),
        alt_success: altSuccess,
        alt_fail: altFail,
        // 代替取得が成功している間は手動確認を要求しない
        needs_manual: ev.alt?.ok ? false : (cur?.needs_manual ?? false) || !ev.alt,
      };
      await db.from("collection_hard_sources").upsert(row as never, { onConflict: "household_id,scope,key" });
    }
  } catch {
    /* 記録の失敗は無視 */
  }
}

/** 代替取得に成功したことだけを記録する（失敗の回数は増やさない） */
export async function recordAltSuccess(db: Db, householdId: string, now: Date, ev: Omit<HardSourceEvent, "failKind"> & { source: string }): Promise<void> {
  try {
    for (const k of hardSourceKeys({ url: ev.url, chainId: ev.chainId, storeId: ev.storeId, chainName: ev.chainName, storeName: ev.storeName })) {
      const cur = (await db.from("collection_hard_sources").select("id,alt_success").eq("household_id", householdId).eq("scope", k.scope).eq("key", k.key).maybeSingle()).data;
      if (!cur) continue;
      await db.from("collection_hard_sources").update({ alt_source: ev.source, alt_success: (cur.alt_success ?? 0) + 1, needs_manual: false, last_checked_at: now.toISOString() }).eq("id", cur.id);
    }
  } catch {
    /* 無視 */
  }
}

/** 過去に代替取得が成功している方法（次回優先） */
export async function preferredAltFor(db: Db, householdId: string, url: string | null): Promise<string | null> {
  try {
    const keys = hardSourceKeys({ url });
    for (const k of keys) {
      const rec = (await db.from("collection_hard_sources").select("alt_source,alt_success,alt_fail").eq("household_id", householdId).eq("scope", k.scope).eq("key", k.key).maybeSingle()).data;
      if (rec?.alt_source && rec.alt_success > rec.alt_fail) return rec.alt_source;
    }
  } catch {
    /* 無視 */
  }
  return null;
}

/** 取得制限が確定している応募先へ、同じURLの取得を繰り返さないための判定（Stage 6B）。この日数を過ぎたら取得を試し直す（制限が解除された場合に気づくため） */
export const ALT_RECHECK_DAYS = 7;
export const ALT_MIN_SUCCESS = 2;

/**
 * 取得困難の記録から、ページの取得を省いて最初から代替（一覧の文章）で読み取ってよいかを判断する。
 * 条件: 応募サービス／ドメイン全体が robots で拒否されている記録があり、一覧文章による代替の成功が失敗を上回り（2回以上）、直近の失敗が新しい。
 * 個別のページ単位の失敗（ページ削除など）や、短縮URLは対象にしない。
 */
export async function altPlanFor(db: Db, householdId: string, url: string | null, now: Date): Promise<{ skipFetch: boolean; failKind: FailKind }> {
  const none = { skipFetch: false, failKind: "robots" as FailKind };
  for (const k of hardSourceKeys({ url }).filter((x) => x.scope === "service" || x.scope === "domain")) {
    const rec = (await db.from("collection_hard_sources").select("fail_kind,alt_source,alt_success,alt_fail,last_failed_at").eq("household_id", householdId).eq("scope", k.scope).eq("key", k.key).maybeSingle()).data;
    if (!rec || rec.fail_kind !== "robots" || rec.alt_source !== "list_text") continue;
    if ((rec.alt_success ?? 0) < ALT_MIN_SUCCESS || (rec.alt_success ?? 0) <= (rec.alt_fail ?? 0)) continue;
    const age = rec.last_failed_at ? (now.getTime() - new Date(rec.last_failed_at).getTime()) / 86_400_000 : Infinity;
    if (age > ALT_RECHECK_DAYS) continue;
    return { skipFetch: true, failKind: "robots" };
  }
  return none;
}
