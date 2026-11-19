import "server-only";
import type { RealRunGuard } from "@/lib/agent/collection-planner/real-guard";
import { chainsRelated, sameStore } from "@/lib/agent/discovery/verify";
import type { DiscoveryWorld, ExistingLottery, KnownStore } from "@/lib/agent/discovery/types";
import type { PageFetcher, SearchProvider } from "@/lib/agent/store-location/tools";
import { sameChainName } from "@/lib/chain-normalize";
import { resolveName } from "@/lib/master-identity/resolve";
import { loadMasterEntries } from "@/lib/server/master-identity/alias-service";
import { createCaseWorld, type WorldLogEntry } from "@/lib/server/agent/case-world";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 自律探索の「世界」（Stage 9H-3Q）。実際のWeb取得・検索と、既存データの読み取りを、読み取り専用で提供する。DBには何も書かない。
 *   取得 : 既存の安全な取得（SSRF対策・内部アドレス拒否・リダイレクト先の再検査・robots.txt の尊重・サイズ/時間の上限・ログイン非回避）。実Web接続でも、この経路を迂回しない
 *   検索 : 呼び出し側が渡した検索部品（実検索は費用の関門・台帳つき。渡さなければ検索ツール自体が登録されない）
 *   既存 : 登録済みの抽選（出どころ＝従来の収集／手動登録／過去の自律探索、人間が確認・修正したか）、店舗マスター、系列の公式サイト
 * 取得したページは世界の中に保持し、登録経路が同じURLを再解析するときに再取得しない（アクセスを増やさない・AIが見た内容と同じ内容を解析する）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い（開発DBのみのマイグレーション104）
const anyDb = (db: Db) => db as any;
const MANUAL_EDIT_TOLERANCE_MS = 120_000;

export interface RealDiscoveryWorld {
  world: DiscoveryWorld;
  /** 取得済みのページ（URL→本文）。登録経路の再解析が使う */
  pageOf(url: string): { title: string; text: string; links: { url: string; text: string }[] } | undefined;
  log: WorldLogEntry[];
}

export function createRealDiscoveryWorld(o: { db: Db; householdId: string; fetcher?: PageFetcher; search?: SearchProvider; guard?: RealRunGuard; now?: () => Date; /** テスト用: 取得・検索の完全な差し替え */ override?: Pick<DiscoveryWorld, "fetchPage" | "search" | "lastSearchCostJpy"> }): RealDiscoveryWorld {
  const base = o.override ? null : createCaseWorld({ fetcher: o.fetcher, search: o.search, guard: o.guard, now: o.now });
  const pages = new Map<string, { title: string; text: string; links: { url: string; text: string }[] }>();
  const inner = o.override ?? base!.world;
  let cache: { lotteries: ExistingLottery[]; stores: (KnownStore & { chain: string; url: string | null })[] } | null = null;

  const load = async () => {
    if (cache) return cache;
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    const [lots, chains, stores, products, origins] = await Promise.all([
      o.db.from("lotteries").select("id,chain_id,store_id,source_urls,source_kind,created_at,updated_at,cautions_updated_at,apply_start_date,apply_deadline_date").eq("household_id", o.householdId).is("archived_at", null).or(`apply_deadline_date.gte.${since},apply_deadline_date.is.null`).limit(2000),
      o.db.from("chains").select("id,name").eq("household_id", o.householdId),
      o.db.from("stores").select("id,chain_id,name,prefecture,address_optional,store_url").eq("household_id", o.householdId).is("archived_at", null),
      o.db.from("products").select("id,official_name").eq("household_id", o.householdId),
      anyDb(o.db).from("lottery_discovery_origins").select("lottery_id").eq("household_id", o.householdId).limit(5000),
    ]);
    const ids = (lots.data ?? []).map((l) => l.id);
    const items = ids.length ? await o.db.from("lottery_items").select("lottery_id,product_id").in("lottery_id", ids.slice(0, 1000)) : { data: [] as { lottery_id: string; product_id: string }[] };
    const chainName = new Map((chains.data ?? []).map((c) => [c.id, c.name]));
    const storeName = new Map((stores.data ?? []).map((s) => [s.id, s.name]));
    const productName = new Map((products.data ?? []).map((p) => [p.id, p.official_name]));
    const byLottery = new Map<string, string[]>();
    for (const it of items.data ?? []) byLottery.set(it.lottery_id, [...(byLottery.get(it.lottery_id) ?? []), productName.get(it.product_id) ?? ""].filter(Boolean));
    const aiOwned = new Set(((origins.data ?? []) as { lottery_id: string }[]).map((r) => r.lottery_id));
    const lotteries: ExistingLottery[] = (lots.data ?? []).map((l) => {
      const row = l as unknown as { source_kind: string; created_at: string; updated_at: string; cautions_updated_at: string | null; apply_start_date: string | null; apply_deadline_date: string | null; source_urls: string[] | null };
      const base0 = new Date(row.cautions_updated_at ?? row.created_at).getTime();
      // 人間が確認・修正した: 手動登録、または自動登録のあとに利用者が保存し直した（既存の自動補完と同じ判定）
      const humanConfirmed = row.source_kind !== "auto" || new Date(row.updated_at).getTime() - base0 > MANUAL_EDIT_TOLERANCE_MS;
      return { lotteryId: l.id, chain: chainName.get(l.chain_id) ?? "", store: l.store_id ? (storeName.get(l.store_id) ?? "") : "", products: byLottery.get(l.id) ?? [], sourceUrls: row.source_urls ?? [], origin: aiOwned.has(l.id) ? "ai_discovery" : row.source_kind === "auto" ? "legacy_collection" : row.source_kind === "manual" ? "manual" : "unknown", humanConfirmed, applyStart: row.apply_start_date, applyDeadline: row.apply_deadline_date };
    });
    cache = { lotteries, stores: (stores.data ?? []).map((s) => ({ name: s.name, prefecture: (s as { prefecture?: string | null }).prefecture || null, address: (s as { address_optional?: string | null }).address_optional || null, chain: chainName.get(s.chain_id) ?? "", url: (s as { store_url?: string | null }).store_url ?? null })) };
    return cache;
  };

  const world: DiscoveryWorld = {
    async fetchPage(url) {
      const r = await inner.fetchPage(url);
      if (r.ok) pages.set(url.trim().replace(/#.*$/, "").replace(/\/+$/, ""), { title: r.title ?? "", text: r.text ?? "", links: r.links ?? [] });
      return r;
    },
    ...(inner.search ? { search: inner.search.bind(inner), lastSearchCostJpy: () => inner.lastSearchCostJpy?.() ?? 0 } : {}),
    async existing(q) {
      const { lotteries } = await load();
      return lotteries
        .filter((l) => (!!q.url && l.sourceUrls.includes(q.url)) || ((!q.chain || chainsRelated(l.chain, q.chain)) && (!q.store || sameStore(l.store, l.chain, q.store, q.chain)) && (!q.product || l.products.some((p) => p.includes(q.product ?? "") || (q.product ?? "").includes(p)))))
        .slice(0, 20);
    },
    async knownStores(chain) {
      const { stores } = await load();
      return stores.filter((s) => sameChainName(s.chain, chain)).map(({ name, prefecture, address }) => ({ name, prefecture, address }));
    },
    async resolveName(kind, name) {
      // 登録・収集・再調査と同じ名寄せ（正式名・確認済み/推定の別名・複合名称・表記揺れ）。読み取りのみ
      const r = resolveName(kind, name, await loadMasterEntries(o.db, o.householdId, kind));
      if (r.status === "matched") return { status: "matched", masterName: r.match.masterName, note: `既存のマスター「${r.match.masterName}」と同じ名称として扱われる（${r.match.via}）` };
      if (r.status === "candidate" || r.status === "ambiguous") {
        const c = r.status === "candidate" ? r.candidates[0] : null;
        return { status: "candidate", masterName: c?.masterName, note: c ? `「${c.masterName}」と近いが、同一とは確認できていない（${c.reason}）` : "複数の既存マスターに当たり、1つに決まらない" };
      }
      return { status: "none", note: "既存のマスターに該当なし（未知の名称の可能性）" };
    },
    async chainOfficialUrl(chain) {
      // 店舗に登録されたURLのうち、最も多いサイトの入口（利用者が登録した情報）
      const { stores } = await load();
      const votes = new Map<string, number>();
      for (const s of stores.filter((x) => sameChainName(x.chain, chain))) {
        if (!s.url || !/^https:\/\//.test(s.url)) continue;
        try {
          const origin = new URL(s.url).origin;
          votes.set(origin, (votes.get(origin) ?? 0) + 1);
        } catch {
          /* 不正なURLは無視 */
        }
      }
      const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return top ? `${top}/` : null;
    },
  };
  return { world, pageOf: (u) => pages.get(u.trim().replace(/#.*$/, "").replace(/\/+$/, "")), log: base?.log ?? [] };
}
