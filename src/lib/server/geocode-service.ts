import { z } from "zod";
import { buildQuery, isCompleteAddress, MAX_GEO_ATTEMPTS, pickCandidate, type GeoHit } from "@/lib/geocode";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 店舗の住所 → 緯度経度（国土地理院の住所検索API。無料・APIキー不要）。
 * 住所の保存とは分け、取得待ち（geo_status='pending'）の店舗を小分けで処理する。1件ずつ間隔をあけて送る（大量の同時リクエストはしない）。
 * 住所・座標はログに出さない。住所が処理中に変わっていたら結果は捨てる（更新は「保存時の住所と同じ」ときだけ）。
 */
const GSI_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch";
const gsiSchema = z.array(z.object({ geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }), properties: z.object({ title: z.string() }) }));
const GAP_MS = 1100;

type Fetched = { ok: true; hits: GeoHit[] } | { ok: false; transient: boolean };

export async function fetchCandidates(query: string, fetcher: typeof fetch = fetch): Promise<Fetched> {
  try {
    const res = await fetcher(`${GSI_URL}?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000), cache: "no-store", headers: { accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) return { ok: false, transient: true };
    if (!res.ok) return { ok: false, transient: false };
    const parsed = gsiSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, transient: false };
    const hits = parsed.data
      .map((c) => ({ title: c.properties.title, lng: c.geometry.coordinates[0], lat: c.geometry.coordinates[1] }))
      .filter((c) => Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180);
    return { ok: true, hits };
  } catch {
    return { ok: false, transient: true };
  }
}

export interface GeocodeBatchResult {
  processed: number;
  ok: number;
  failed: number;
  incomplete: number;
  retry: number;
  skipped: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 取得待ちの店舗を最大 limit 件処理する。fetcher/sleep はテスト用に差し替え可能 */
export async function processGeocodeBatch(db: Db, opts: { limit?: number; fetcher?: typeof fetch; gapMs?: number } = {}): Promise<GeocodeBatchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const gap = opts.gapMs ?? GAP_MS;
  const out: GeocodeBatchResult = { processed: 0, ok: 0, failed: 0, incomplete: 0, retry: 0, skipped: 0 };
  const { data: rows } = await db
    .from("stores")
    .select("id,prefecture,address_optional,geo_attempts")
    .eq("geo_status", "pending")
    .is("archived_at", null)
    .order("geo_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  let first = true;
  for (const s of rows ?? []) {
    const address = s.address_optional ?? "";
    const update = async (patch: Record<string, unknown>) => {
      // 取得中に住所が変わっていたら（トリガーが取得待ちに戻している）、この結果では上書きしない
      await db
        .from("stores")
        .update({ ...patch, geo_checked_at: new Date().toISOString() })
        .eq("id", s.id)
        .eq("address_optional", address)
        .eq("geo_status", "pending");
    };
    const query = buildQuery(address, s.prefecture);
    if (!isCompleteAddress(query)) {
      await update({ geo_status: "incomplete", geo_error: "address_incomplete" });
      out.incomplete++;
      out.processed++;
      continue;
    }
    if (!first) await wait(gap);
    first = false;
    const r = await fetchCandidates(query, opts.fetcher);
    out.processed++;
    if (!r.ok) {
      const attempts = (s.geo_attempts ?? 0) + 1;
      if (r.transient && attempts < MAX_GEO_ATTEMPTS) {
        await update({ geo_attempts: attempts, geo_error: "temporary" });
        out.retry++;
      } else {
        await update({ geo_status: "failed", geo_attempts: attempts, geo_error: r.transient ? "temporary_limit" : "service_error" });
        out.failed++;
      }
      continue;
    }
    const pick = pickCandidate(query, r.hits);
    if (pick.kind !== "ok") {
      await update({ geo_status: "failed", geo_error: pick.kind === "ambiguous" ? "ambiguous" : "no_match" });
      out.failed++;
      continue;
    }
    await update({ latitude: Number(pick.hit.lat.toFixed(6)), longitude: Number(pick.hit.lng.toFixed(6)), geo_status: "ok", geo_address: address, geo_attempts: 0, geo_error: null });
    out.ok++;
  }
  return out;
}

/** 取得失敗の店舗だけを取得待ちに戻す（住所不完全は対象外。住所を補完すると自動で取得待ちになる） */
export async function requeueFailedGeocoding(db: Db): Promise<number> {
  const { data } = await db.from("stores").update({ geo_status: "pending", geo_attempts: 0, geo_error: null, geo_checked_at: null }).eq("geo_status", "failed").select("id");
  return data?.length ?? 0;
}
