/**
 * 既存の抽選・抽選候補の一括再評価の計画（Stage 9H-3S・純関数）。何も変更せず、「何を・なぜ・どの根拠で」整理するかの提案（計画）だけを作る。
 *
 * 保護（変更対象にしない。DB上の実態で判断し、タブの位置だけでは決めない）:
 *   要チェック（★）／応募・当落の記録／人が登録・確認・修正した抽選（手動登録・確認済み・AI補助の手動登録）／通知・ルール・メモなどの参照がある抽選
 * 整理の対象（保護に当たらない自動収集の未処理情報）:
 *   archive_duplicate  同じ企画の重複（同じ系列・店舗・商品・締切日。系列の重複マスターは統合先へ寄せて比較する）→ 非表示（復元可）
 *   archive_expired    応募締切を過ぎている（猶予日数後）→ 非表示（復元可）
 *   archive_region     対象地域外の店舗（地域設定との不一致が店舗の都道府県から確認できるもの）→ 非表示（復元可）
 *   dismiss_candidate  抽選候補（確認待ち）のうち、期限切れ・対象地域外・登録済みの抽選と重複するもの → 除外（候補は残す。除外一覧から戻せる）
 *   merge_master       重複した系列・商品マスター → 既存の統合機能（参照の付け替え・履歴・復元つき）で、利用者が実行
 *   review             情報不足など、無理に整理せず人・追加調査に回すもの（変更なし）
 * 根拠が不十分なものは整理しない（review にも変更を伴わない）。1つの抽選に提案する処理は1つ（重複 > 地域外 > 期限切れ）。
 */
import { findDuplicateCandidates, findDuplicateMasters, type DupCluster } from "./duplicates";
import { resolveName } from "./resolve";
import { chainMasters, productMasters, type Snapshot } from "./snapshot";

export type ReevalAction = "archive_duplicate" | "archive_expired" | "archive_region" | "dismiss_candidate" | "merge_master" | "review";
export interface PlanItem {
  targetType: "lottery" | "candidate" | "chain" | "product";
  targetId: string;
  action: ReevalAction;
  risk: "low" | "medium" | "high";
  proposal: { reason: string; subKind?: string; relatedId?: string; evidence?: Record<string, unknown> };
}
export interface PlanOptions {
  now: Date;
  /** 対象の都道府県（収集設定）。空なら地域の判定をしない */
  prefectures: string[];
  /** 通販・オンライン店舗を対象にするか */
  includeOnline: boolean;
  /** 締切を過ぎてから非表示にするまでの日数 */
  graceDays?: number;
}
export interface Plan {
  items: PlanItem[];
  summary: {
    lotteries: { total: number; active: number; protected: number; unprotected: number };
    byAction: Record<ReevalAction, number>;
    protectedReasons: Record<string, number>;
    candidates: { pending: number; proposed: number };
    masters: { chainClusters: number; productClusters: number; chainCandidates: number; productCandidates: number };
    /** 確認待ち候補の、マスターに未解決だった系列名・商品名のうち、新しい名寄せで一意に解決できる／候補止まり／関係なしの件数 */
    nameResolution: { chainNames: { matched: number; candidate: number; none: number }; productNames: { matched: number; candidate: number; none: number }; matchedChainExamples: string[] };
  };
  clusters: { chain: DupCluster[]; product: DupCluster[] };
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ms = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
/** 締切（日時または日付のみ）の終わり。日付のみは、その日の終わり（日本時間 23:59:59）まで有効とみなす */
export function deadlineEndMs(l: Row): number | null {
  const at = ms(l.apply_deadline_at);
  if (at !== null) return at;
  const d = str(l.apply_deadline_date);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T23:59:59+09:00`) : null;
}
const deadlineDay = (l: Row): string => {
  const d = str(l.apply_deadline_date);
  if (d) return d;
  const at = ms(l.apply_deadline_at);
  return at === null ? "" : new Date(at + 9 * 3600_000).toISOString().slice(0, 10);
};

export function planReevaluation(snap: Snapshot, opts: PlanOptions): Plan {
  const grace = (opts.graceDays ?? 3) * 86_400_000;
  const nowMs = opts.now.getTime();
  const refsOf = (id: string) => Object.values(snap.lottery_refs ?? {}).reduce((n, m) => n + (m[id] ?? 0), 0);
  const managed = new Set(snap.lottery_management.filter((m) => m.is_managed).map((m) => str(m.lottery_id)));
  const hasApp = new Set(snap.applications.map((a) => str(a.lottery_id)));
  const storeOf = new Map(snap.stores.map((s) => [str(s.id), s]));
  const itemsOf = new Map<string, string[]>();
  for (const i of snap.lottery_items) itemsOf.set(str(i.lottery_id), [...(itemsOf.get(str(i.lottery_id)) ?? []), str(i.product_id)]);

  // 重複マスター（系列は統合先へ寄せて、抽選の重複を比較する）
  const chainClusters = findDuplicateMasters("chain", chainMasters(snap));
  const productClusters = findDuplicateMasters("product", productMasters(snap));
  const chainCands = findDuplicateCandidates("chain", chainMasters(snap), chainClusters);
  const productCands = findDuplicateCandidates("product", productMasters(snap), productClusters);
  const chainKeep = new Map<string, string>();
  for (const c of chainClusters) for (const o of c.others) chainKeep.set(o.master.id, c.keep.id);
  const prodKeep = new Map<string, string>();
  for (const c of productClusters) for (const o of c.others) prodKeep.set(o.master.id, c.keep.id);

  const items: PlanItem[] = [];
  const byAction: Plan["summary"]["byAction"] = { archive_duplicate: 0, archive_expired: 0, archive_region: 0, dismiss_candidate: 0, merge_master: 0, review: 0 };
  const push = (it: PlanItem) => {
    items.push(it);
    byAction[it.action]++;
  };

  // ---------------- 抽選
  const lotteries = snap.lotteries;
  const active = lotteries.filter((l) => !l.archived_at);
  const protectedReasons: Record<string, number> = {};
  const protection = (l: Row): string | null => {
    const id = str(l.id);
    if (managed.has(id)) return "要チェック（★）";
    if (hasApp.has(id)) return "応募・当落の記録あり";
    if (refsOf(id) > 0) return "通知・ルール・メモなどの参照あり";
    if (l.confirmed_at) return "確認済み";
    if (str(l.source_kind) !== "auto" || str(l.registration_path) !== "auto") return "人が登録・確認した抽選";
    return null;
  };
  const prot = new Map<string, string | null>();
  for (const l of active) {
    const p = protection(l);
    prot.set(str(l.id), p);
    if (p) protectedReasons[p] = (protectedReasons[p] ?? 0) + 1;
  }
  // 重複グループ（同じ系列・店舗・商品・締切日）
  const dupKey = (l: Row) => `${chainKeep.get(str(l.chain_id)) ?? str(l.chain_id)}|${str(l.store_id) || "-"}|${(itemsOf.get(str(l.id)) ?? []).map((p) => prodKeep.get(p) ?? p).sort().join("+")}|${deadlineDay(l)}|${str(l.store_mode)}`;
  const groups = new Map<string, Row[]>();
  for (const l of active) {
    if (!deadlineDay(l) || (itemsOf.get(str(l.id)) ?? []).length === 0) continue; // 締切・商品が不明なものは重複と断定しない
    groups.set(dupKey(l), [...(groups.get(dupKey(l)) ?? []), l]);
  }
  const dupLoser = new Map<string, Row>(); // 非表示にする抽選 → 残す抽選
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // 残す抽選: 保護されているもの → 情報源の多いもの → 古いもの
    const sorted = [...g].sort((a, b) => Number(!!prot.get(str(b.id))) - Number(!!prot.get(str(a.id))) || ((b.source_urls as unknown[] | null)?.length ?? 0) - ((a.source_urls as unknown[] | null)?.length ?? 0) || str(a.created_at).localeCompare(str(b.created_at)));
    const keep = sorted[0];
    for (const l of sorted.slice(1)) if (!prot.get(str(l.id))) dupLoser.set(str(l.id), keep);
  }
  const prefs = new Set(opts.prefectures);
  for (const l of active) {
    const id = str(l.id);
    if (prot.get(id)) continue;
    const keep = dupLoser.get(id);
    if (keep) {
      push({ targetType: "lottery", targetId: id, action: "archive_duplicate", risk: "low", proposal: { reason: "同じ企画の重複（同じ系列・店舗・商品・締切日）。情報の多い方を残します", subKind: "duplicate", relatedId: str(keep.id), evidence: { dedupeKey: dupKey(l) } } });
      continue;
    }
    const st = storeOf.get(str(l.store_id));
    const pref = str(st?.prefecture);
    const online = str(st?.sales_kind) === "online" || str(l.store_mode) === "none";
    if (prefs.size > 0 && pref && !prefs.has(pref) && !(online && opts.includeOnline) && str(l.store_mode) !== "select_on_apply") {
      push({ targetType: "lottery", targetId: id, action: "archive_region", risk: "low", proposal: { reason: `対象地域外の店舗（${pref}。対象: ${[...prefs].join("・")}）`, subKind: "region", evidence: { prefecture: pref } } });
      continue;
    }
    const end = deadlineEndMs(l);
    if (end !== null && end + grace < nowMs) {
      push({ targetType: "lottery", targetId: id, action: "archive_expired", risk: "low", proposal: { reason: `応募締切（${deadlineDay(l)}）を過ぎています`, subKind: "expired", evidence: { deadline: deadlineDay(l) } } });
      continue;
    }
    if (end === null) push({ targetType: "lottery", targetId: id, action: "review", risk: "low", proposal: { reason: "応募締切が不明（無理に整理せず、続報・追加調査で補います）", subKind: "no_deadline" } });
  }

  // ---------------- 抽選候補（確認待ち）
  const pending = snap.collection_candidates.filter((c) => c.status === "pending");
  const keys = new Set(active.map((l) => dupKey(l)));
  let cProposed = 0;
  for (const c of pending) {
    const id = str(c.id);
    const input = ((c.draft as Row | null)?.input ?? null) as Row | null;
    const dueMs = ms(c.due_at);
    const dl = input ? ((input.applyDeadline as Row | undefined) ?? {}) : {};
    const dlMs = str(dl.date) ? Date.parse(`${str(dl.date)}T${str(dl.time) || "23:59"}:00+09:00`) : null;
    const end = dueMs ?? dlMs;
    const store = (input?.store ?? {}) as Row;
    const chainId = str((input?.chain as Row | undefined)?.id);
    const pref = str(store.prefecture);
    const prods = ((input?.items ?? []) as Row[]).map((i) => str((i.product as Row | undefined)?.id)).filter(Boolean);
    let hit: PlanItem | null = null;
    const base = { targetType: "candidate" as const, targetId: id, action: "dismiss_candidate" as const };
    if (c.lottery_id && active.some((l) => str(l.id) === str(c.lottery_id))) hit = { ...base, risk: "low", proposal: { reason: "登録済みの抽選と紐づいている（重複）", subKind: "duplicate", relatedId: str(c.lottery_id) } };
    else if (chainId && str(store.id) && prods.length === (input?.items as unknown[] | undefined)?.length && keys.has(`${chainKeep.get(chainId) ?? chainId}|${str(store.id)}|${prods.map((p) => prodKeep.get(p) ?? p).sort().join("+")}|${str(dl.date)}|${str(input?.storeMode)}`)) hit = { ...base, risk: "low", proposal: { reason: "登録済みの抽選と同じ企画（系列・店舗・商品・締切日が一致）", subKind: "duplicate" } };
    else if (prefs.size > 0 && pref && !prefs.has(pref) && !(/オンライン|通販/.test(str(store.name)) && opts.includeOnline) && str(input?.storeMode) !== "select_on_apply") hit = { ...base, risk: "low", proposal: { reason: `対象地域外（${pref}）`, subKind: "region" } };
    else if (end !== null && end + grace < nowMs) hit = { ...base, risk: str(c.manual_state) === "open" ? "medium" : "low", proposal: { reason: "応募締切を過ぎています", subKind: "expired" } };
    if (hit) {
      push(hit);
      cProposed++;
    }
  }

  // ---------------- 候補の系列名の解決（新しい名寄せで、これまで特定できなかった系列名がどれだけ解決できるか。変更はせず、登録時に自動で効く）
  const chainEntries = chainMasters(snap);
  const prodEntries = productMasters(snap);
  const nameResolution = { chainNames: { matched: 0, candidate: 0, none: 0 }, productNames: { matched: 0, candidate: 0, none: 0 }, matchedChainExamples: [] as string[] };
  const seenChain = new Set<string>();
  const seenProd = new Set<string>();
  for (const c of pending) {
    const input = ((c.draft as Row | null)?.input ?? null) as Row | null;
    const ch = (input?.chain ?? {}) as Row;
    const cn = str(ch.name).trim();
    if (!str(ch.id) && cn && !seenChain.has(cn)) {
      seenChain.add(cn);
      const r = resolveName("chain", cn, chainEntries);
      nameResolution.chainNames[r.status === "matched" ? "matched" : r.status === "candidate" || r.status === "ambiguous" ? "candidate" : "none"]++;
      if (r.status === "matched" && nameResolution.matchedChainExamples.length < 8) nameResolution.matchedChainExamples.push(`${cn} → ${r.match.masterName}`);
    }
    for (const it of (input?.items ?? []) as Row[]) {
      const p = (it.product ?? {}) as Row;
      const pn = str(p.name).trim();
      if (!str(p.id) && pn && !seenProd.has(pn)) {
        seenProd.add(pn);
        const r = resolveName("product", pn, prodEntries);
        nameResolution.productNames[r.status === "matched" ? "matched" : r.status === "candidate" || r.status === "ambiguous" ? "candidate" : "none"]++;
      }
    }
  }

  // ---------------- マスターの重複（統合は既存の統合機能で、利用者が実行）
  for (const [kind, clusters] of [["chain", chainClusters], ["product", productClusters]] as const) {
    for (const c of clusters) {
      for (const o of c.others) {
        push({ targetType: kind, targetId: o.master.id, action: "merge_master", risk: c.risk, proposal: { reason: `「${c.keep.name}」と同じ${kind === "chain" ? "系列" : "商品"}（${o.reason}）`, relatedId: c.keep.id, evidence: { keep: c.keep.name, from: o.master.name, refsFrom: o.master.refs, refsInto: c.keep.refs, confidence: o.confidence } } });
      }
    }
  }
  for (const c of [...chainCands, ...productCands]) {
    push({ targetType: c.kind, targetId: c.a.provisional ? c.a.id : c.b.id, action: "review", risk: "medium", proposal: { reason: `重複の候補（${c.reason}）。追加調査で同一か確認します`, subKind: "master_candidate", relatedId: c.a.provisional ? c.b.id : c.a.id, evidence: { a: c.a.name, b: c.b.name } } });
  }

  return {
    items,
    summary: {
      lotteries: { total: lotteries.length, active: active.length, protected: [...prot.values()].filter(Boolean).length, unprotected: [...prot.values()].filter((v) => !v).length },
      byAction,
      protectedReasons,
      candidates: { pending: pending.length, proposed: cProposed },
      masters: { chainClusters: chainClusters.length, productClusters: productClusters.length, chainCandidates: chainCands.length, productCandidates: productCands.length },
      nameResolution,
    },
    clusters: { chain: chainClusters, product: productClusters },
  };
}
