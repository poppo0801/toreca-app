/**
 * 同一性の照合の相手を読む（JUDGMENT_IDENTITY_EFFICIENCY §2）。読み取りだけ（抽選・応募・履歴には一切書かない）。
 *  - 登録済みの抽選（非表示を含む。非表示は archived の印つき）と、他の候補の現行の登録案（新AIの判断）。
 *  - **将来の情報を混ぜない**: 評価の基準時刻（収集時刻）より後に作られた抽選・候補は比べない（この候補から旧方式が作った抽選＝自分自身も、作成が後なので入らない）。
 *  - 人が確定した抽選（手動・取り込み・応募の記録あり）は humanConfirmed（AIの判断で自動に変更しない）。
 */
import type { Db } from "@/lib/server/lottery-service";
import type { ExistingOpportunity, IdentityResult } from "@/lib/judgment/xsource/opportunity-identity";
import { IDENTITY_LABELS } from "@/lib/judgment/xsource/opportunity-identity";
import type { ProposalRecord } from "@/lib/judgment/xsource/proposal";

type Loose = { from: (n: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const jst = (at: string | null, d: string | null): string | null => (at ? new Date(new Date(at).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : d);

export async function loadExistingOpportunities(db: Db, householdId: string, a: { basisAt: string; candidateId: string; mode: string }): Promise<ExistingOpportunity[]> {
  const t = (n: string) => (db as unknown as Loose).from(n);
  const out: ExistingOpportunity[] = [];
  try {
    const since = new Date(new Date(a.basisAt).getTime() - 120 * 86_400_000).toISOString();
    const L = ((await t("lotteries").select("id,chain_id,store_id,store_mode,selectable_stores,apply_start_date,apply_start_at,apply_deadline_date,apply_deadline_at,result_date,result_at,source_urls,source_kind,created_at,archived_at").eq("household_id", householdId).lte("created_at", a.basisAt).gte("created_at", since).limit(2000)).data ?? []) as { id: string; chain_id: string; store_id: string; store_mode: string | null; selectable_stores: unknown; apply_start_date: string | null; apply_start_at: string | null; apply_deadline_date: string | null; apply_deadline_at: string | null; result_date: string | null; result_at: string | null; source_urls: string[] | null; source_kind: string; created_at: string; archived_at: string | null }[];
    if (L.length) {
      const ids = L.map((l) => l.id);
      const [IT, CH, ST, AP]: [{ lottery_id: string; product_id: string }[], { id: string; name: string }[], { id: string; name: string }[], { lottery_id: string }[]] = await Promise.all([
        t("lottery_items").select("lottery_id,product_id").in("lottery_id", ids).then((r: { data: unknown }) => (r.data ?? []) as { lottery_id: string; product_id: string }[]),
        t("chains").select("id,name").eq("household_id", householdId).then((r: { data: unknown }) => (r.data ?? []) as { id: string; name: string }[]),
        t("stores").select("id,name").eq("household_id", householdId).then((r: { data: unknown }) => (r.data ?? []) as { id: string; name: string }[]),
        t("applications").select("lottery_id").in("lottery_id", ids).then((r: { data: unknown }) => (r.data ?? []) as { lottery_id: string }[]),
      ]);
      const pids = [...new Set(IT.map((x) => x.product_id))];
      const PR = pids.length ? (((await t("products").select("id,official_name").in("id", pids)).data ?? []) as { id: string; official_name: string }[]) : [];
      const chain = new Map(CH.map((c) => [c.id, c.name]));
      const store = new Map(ST.map((s) => [s.id, s.name]));
      const prod = new Map(PR.map((p) => [p.id, p.official_name]));
      const items = new Map<string, string[]>();
      for (const x of IT) items.set(x.lottery_id, [...(items.get(x.lottery_id) ?? []), prod.get(x.product_id) ?? ""]);
      const applied = new Set(AP.map((x) => x.lottery_id));
      for (const l of L)
        out.push({
          id: l.id,
          kind: "lottery",
          chain: chain.get(l.chain_id) ?? "",
          store: store.get(l.store_id) ?? "",
          storeMode: l.store_mode ?? "fixed",
          selectableStores: Array.isArray(l.selectable_stores) ? (l.selectable_stores as unknown[]).map((s) => (typeof s === "string" ? s : String((s as { name?: string })?.name ?? ""))).filter(Boolean).slice(0, 40) : [],
          products: items.get(l.id) ?? [],
          applyStart: jst(l.apply_start_at, l.apply_start_date),
          applyDeadline: jst(l.apply_deadline_at, l.apply_deadline_date),
          result: jst(l.result_at, l.result_date),
          sourceUrls: l.source_urls ?? [],
          createdAt: l.created_at,
          humanConfirmed: l.source_kind !== "auto" || applied.has(l.id),
          ...(l.archived_at && l.archived_at <= a.basisAt ? { archived: true } : {}),
        });
    }
    // 他の候補の現行の登録案（基準時刻より前に作られた候補だけ。新AIの判断どうしの重複を見つける）
    const C = ((await t("collection_candidates").select("id").eq("household_id", householdId).lt("created_at", a.basisAt).gte("created_at", since).neq("id", a.candidateId).limit(3000)).data ?? []) as { id: string }[];
    const cids = new Set(C.map((c) => c.id));
    if (cids.size) {
      const P = ((await t("registration_proposals").select("proposal_key,candidate_id,decision,fields,source_urls,created_at").eq("household_id", householdId).eq("mode", a.mode).is("superseded_at", null).in("decision", ["register", "tentative"]).limit(2000)).data ?? []) as { proposal_key: string; candidate_id: string; decision: string; fields: Record<string, { value?: string | null }> | null; source_urls: string[] | null; created_at: string }[];
      for (const p of P) {
        if (!cids.has(p.candidate_id)) continue;
        const f = p.fields ?? {};
        out.push({ id: `p:${p.proposal_key}`, kind: "proposal", chain: "", store: String(f.store?.value ?? ""), storeMode: String(f.apply_unit?.value ?? "unknown"), selectableStores: [], products: f.product?.value ? [String(f.product.value)] : [], applyStart: f.apply_start?.value ?? null, applyDeadline: f.deadline?.value ?? null, result: f.result_at?.value ?? null, sourceUrls: [...(p.source_urls ?? []), ...(String(f.apply_url?.value ?? "").startsWith("http") ? [String(f.apply_url!.value)] : [])], createdAt: p.created_at, humanConfirmed: false, decision: p.decision });
      }
    }
  } catch {
    /* 読めなければ照合の相手なし（判断は unknown にはしない: 検索の失敗は identity.retrieved=0 と issues で分かる） */
  }
  return out;
}

/** 同一性の結果を登録案の項目（fields._identity）に書く。fields の大きさの上限に収まるよう短くする */
export function attachIdentity(r: ProposalRecord, id: IdentityResult): void {
  const compact = { relation: id.relation, targetId: id.targetId, action: id.action, why: id.why.slice(0, 300), verified: id.verified, needsHuman: id.needsHuman, issues: id.issues.slice(0, 6), retrieved: id.retrieved, candidates: id.candidates.slice(0, 8).map((c) => ({ id: c.id, kind: c.kind, signals: c.signals, score: c.score })), judgments: id.judgments.slice(0, 5).map((j) => ({ targetId: j.targetId, relation: j.relation, why: j.why.slice(0, 200), diffs: j.diffs.slice(0, 4).map((d) => d.slice(0, 120)), cites: j.cites.slice(0, 4) })), costJpy: id.costJpy, model: id.model };
  (r.fields as Record<string, unknown>)._identity = { value: `${IDENTITY_LABELS[id.relation]}${id.targetId ? `（${id.targetId.startsWith("p:") ? "別の候補の登録案" : "登録済みの抽選"}）` : ""}`, basis: "inferred", quote: null, evidence: null, support: "no_value", identity: compact };
}
