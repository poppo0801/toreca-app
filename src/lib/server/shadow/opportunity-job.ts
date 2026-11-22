/**
 * 応募機会の判断プレビュー（Stage 10P・サーバー。ワーカーへの接続の準備）。**読み取り＋ shadow_opportunities への書き込みだけ**（既存の登録・応募・当選・購入・通知・候補には書かない）。
 *  - 入力: shadow_list_items（10Mで判断済みの一覧項目）・保存原文（見出し・範囲）・既存の登録（読み取りのみ）・商品/店舗マスター・収集設定（読み取りのみ）。
 *  - 出力: クラスタリング→対象条件→判断（自動登録プレビュー／欠落つき候補／確認待ち／除外／更新提案）を shadow_opportunities に保存（冪等）。**AIは呼ばない**（費用 0）。
 *  - 本番では cron 経由で呼ばない（未接続）。呼び出しは、ローカルの検証・将来の承認後のワーカーのみ。停止スイッチ: 呼び出し側（ワーカー）が shadow_settings.enabled を確認する。
 */
import type { StoredEvidence } from "@/lib/collector/evidence";
import { clusterFacts, pairRelations } from "@/lib/judgment/xsource/cluster";
import { resolveConditions } from "@/lib/judgment/xsource/conditions";
import { decideOpportunity, type DecisionResult } from "@/lib/judgment/xsource/decision";
import { factFromListItem, factFromRegistration, type RegistrationLike } from "@/lib/judgment/xsource/facts";
import { chainsMatch, storesMatch } from "@/lib/judgment/xsource/normalize";
import { buildProductMatcher } from "@/lib/judgment/xsource/product-master";
import type { SourceFact } from "@/lib/judgment/xsource/types";
import { linkResolver, parseListItems } from "@/lib/judgment/list-items";
import type { Db } from "@/lib/server/lottery-service";
import { saveOpportunities } from "./opportunity-store";
import { DbItemStore } from "./list-store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (db: Db, t: string): any => (db as unknown as { from: (t: string) => unknown }).from(t);
const jst = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : null);

export interface OpportunityPreviewResult {
  facts: number;
  registrations: number;
  clusters: number;
  saved: number;
  byDecision: Record<string, number>;
  /** 読み取りに失敗した表（保護の確認ができなかった場合は、全ての登録を保護ありとして扱った） */
  readErrors: string[];
}

export async function loadRegistrations(db: Db, householdId: string): Promise<{ regs: RegistrationLike[]; errors: string[] }> {
  const errors: string[] = [];
  const read = async (t: string, sel: string): Promise<Record<string, unknown>[]> => {
    const { data, error } = await table(db, t).select(sel).eq("household_id", householdId);
    if (error) errors.push(t);
    return (data ?? []) as Record<string, unknown>[];
  };
  const [lots, chains, stores, products, items, apps, mgmt] = await Promise.all([
    read("lotteries", "id,chain_id,store_id,source_kind,archived_at,apply_start_at,apply_start_date,apply_deadline_at,apply_deadline_date,result_date,source_urls,updated_at"),
    read("chains", "id,name"),
    read("stores", "id,name,prefecture"),
    read("products", "id,official_name"),
    (async () => {
      const { data, error } = await table(db, "lottery_items").select("lottery_id,product_id");
      if (error) errors.push("lottery_items");
      return (data ?? []) as Record<string, unknown>[];
    })(),
    read("applications", "lottery_id"),
    (async () => {
      const { data, error } = await table(db, "lottery_management").select("lottery_id,is_managed");
      if (error) errors.push("lottery_management");
      return (data ?? []) as Record<string, unknown>[];
    })(),
  ]);
  const chain = new Map(chains.map((c) => [c.id as string, c.name as string]));
  const store = new Map(stores.map((s) => [s.id as string, s]));
  const prod = new Map(products.map((p) => [p.id as string, p.official_name as string]));
  const itemsBy = new Map<string, string[]>();
  for (const it of items) itemsBy.set(it.lottery_id as string, [...(itemsBy.get(it.lottery_id as string) ?? []), prod.get(it.product_id as string) ?? ""].filter(Boolean));
  const applied = new Set(apps.map((a) => a.lottery_id as string));
  const starred = new Set(mgmt.filter((m) => m.is_managed === true).map((m) => m.lottery_id as string));
  const unknownProtection = errors.includes("applications") || errors.includes("lottery_management");
  const regs: RegistrationLike[] = lots
    .filter((l) => !l.archived_at)
    .map((l) => {
      const st = l.store_id ? store.get(l.store_id as string) : undefined;
      const codes = [...(applied.has(l.id as string) ? ["applications"] : []), ...(starred.has(l.id as string) ? ["starred"] : []), ...(l.source_kind === "manual" ? ["manual_edit"] : [])];
      return {
        id: l.id as string,
        chain: chain.get(l.chain_id as string) ?? null,
        store: (st?.name as string | undefined) ?? null,
        prefecture: (st?.prefecture as string | undefined) ?? null,
        products: itemsBy.get(l.id as string) ?? [],
        applyStart: jst((l.apply_start_at as string) ?? null) ?? ((l.apply_start_date as string) ?? null),
        applyDeadline: jst((l.apply_deadline_at as string) ?? null) ?? ((l.apply_deadline_date as string) ?? null),
        resultDate: (l.result_date as string) ?? null,
        applyUrl: ((l.source_urls as string[] | null) ?? [])[0] ?? null,
        protectedCodes: codes,
        protectionUnknown: unknownProtection,
        updatedAt: (l.updated_at as string) ?? null,
      };
    });
  return { regs, errors };
}

export async function runOpportunityPreview(a: { db: Db; householdId: string; now: Date }): Promise<OpportunityPreviewResult> {
  const { db, householdId, now } = a;
  const { regs, errors } = await loadRegistrations(db, householdId);
  const regFacts = regs.map(factFromRegistration);
  for (const f of regFacts) f.urls = f.fields.applyUrl ? [f.fields.applyUrl as string] : undefined;

  // 一覧の項目（10Mで判断済み）→ 観測。見出し・範囲は保存原文から復元（原文はここでも複製・保存しない）
  const { data: parents } = await table(db, "shadow_list_items").select("candidate_id,parent_key").eq("household_id", householdId).eq("status", "done");
  const keys = new Map<string, Set<string>>();
  for (const p of (parents ?? []) as { candidate_id: string; parent_key: string }[]) keys.set(p.candidate_id, (keys.get(p.candidate_id) ?? new Set()).add(p.parent_key));
  const itemFacts: SourceFact[] = [];
  for (const [candId, pks] of keys) {
    const { data: cand } = await table(db, "collection_candidates").select("last_good").eq("id", candId).eq("household_id", householdId).maybeSingle();
    const ev = (cand?.last_good as { evidence?: StoredEvidence } | null)?.evidence;
    if (!ev?.text) continue;
    const parsed = parseListItems(ev.text);
    if (!pks.has(parsed.parentKey)) continue;
    const resolver = linkResolver(ev.linkMap);
    const results = await new DbItemStore(db, { householdId, candidateId: candId, items: parsed.items, promptVersion: "" }).load(parsed.parentKey);
    for (const it of parsed.items) {
      const r = results.get(it.no);
      if (!r) continue;
      const f = factFromListItem({ candidateId: candId, parentKey: parsed.parentKey, item: r, fetchedAt: ev.fetchedAt ?? null, range: { start: it.start, end: it.end }, groupLabel: it.groupLabel, contextTexts: [ev.text.slice(0, 120), it.text], destinationDistinct: !!ev.linkMap?.length && !!resolver.host(it) && !parsed.items.some((o) => o.no !== it.no && resolver.sameDestination(it, o)) });
      // 発信者（公式か）は判断に使わない。種類は一覧の項目のまま
      if (f) itemFacts.push(f);
    }
  }

  // 収集設定・マスター（読み取りのみ）
  const { data: cs } = await table(db, "collection_settings").select("prefectures,include_online,product_mode").eq("household_id", householdId).maybeSingle();
  const cond = { prefectures: ((cs?.prefectures as string[] | undefined) ?? []) as string[], includeOnline: (cs?.include_online as boolean | undefined) ?? true, productMode: ((cs?.product_mode as string | undefined) ?? "all") as "all" };
  const { data: sm } = await table(db, "stores").select("name,prefecture,chain_id").eq("household_id", householdId);
  const { data: cm } = await table(db, "chains").select("id,name").eq("household_id", householdId);
  const chainName = new Map(((cm ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const { data: pm } = await table(db, "products").select("id,official_name").eq("household_id", householdId);
  const matcher = buildProductMatcher(((pm ?? []) as { id: string; official_name: string }[]).map((p) => ({ id: p.id, officialName: p.official_name })));
  const storeMaster = (chain: string | null, store: string | null): { prefecture: string | null } | null => {
    const hit = ((sm ?? []) as { name: string; prefecture: string | null; chain_id: string }[]).filter((s) => chainsMatch(chainName.get(s.chain_id) ?? null, chain) === "same" && ["same", "partial"].includes(storesMatch(s.name, store)));
    const prefs = new Set(hit.map((s) => s.prefecture).filter((p): p is string => !!p));
    return prefs.size === 1 ? { prefecture: [...prefs][0] } : null;
  };

  const all = [...regFacts, ...itemFacts];
  const byId = new Map(all.map((f) => [f.sourceId, f]));
  const clusters = clusterFacts(all);
  const rel = pairRelations(all);
  const unresolved = new Map<string, number>();
  for (const p of rel) if (p.relation.kind === "unknown" && p.relation.evidence.includes("chain_same") && !p.relation.evidence.includes("store_different") && !p.relation.evidence.includes("product_disjoint") && p.relation.score >= 0.3) for (const id of [p.a, p.b]) unresolved.set(id, (unresolved.get(id) ?? 0) + 1);
  const gv = (c: (typeof clusters)[number], n: string): unknown => c.fields.find((f) => f.field === n)?.adopted ?? c.fields.find((f) => f.field === n)?.candidates[0]?.value ?? null;
  const items: { cluster: (typeof clusters)[number]; eligibility: ReturnType<typeof resolveConditions>; decision: DecisionResult }[] = [];
  const byDecision: Record<string, number> = {};
  for (const c of clusters) {
    const facts = c.members.map((m) => byId.get(m) as SourceFact);
    const eligibility = resolveConditions({ chain: gv(c, "chain") as string | null, store: gv(c, "store") as string | null, prefecture: gv(c, "prefecture") as string | null, products: (gv(c, "products") as string[] | null) ?? [], texts: facts.flatMap((f) => f.texts ?? []) }, cond, [], { storeMaster, productMaster: (n) => !!matcher.match(n) });
    const decision = decideOpportunity({ cluster: c, facts, eligibility, now, unresolvedDuplicatePairs: c.members.reduce((n, m) => n + (unresolved.get(m) ?? 0), 0), isLottery: true });
    byDecision[decision.decision] = (byDecision[decision.decision] ?? 0) + 1;
    // 提案のない単独の既存登録は保存しない（行を増やさない）。それ以外（新規の判断・複数情報源・提案あり）は保存
    if (c.registrations.length > 0 && c.members.length === 1) continue;
    items.push({ cluster: c, eligibility, decision });
  }
  const saved = await saveOpportunities(db, householdId, items);
  return { facts: all.length, registrations: regs.length, clusters: clusters.length, saved, byDecision, readErrors: errors };
}
