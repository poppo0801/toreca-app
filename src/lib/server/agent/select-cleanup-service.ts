/**
 * 店舗選択式の二重登録の整理（Stage 8F-7・開発環境のみで使う）。
 *
 * 本来1件の店舗選択式の抽選が、店舗ごとの別カードとして登録されている疑いのある組を、利用者が安全に整理する。
 * 守ること:
 *  - 自動では何もしない。利用者の操作（整理する／別の抽選として残す／店舗選択式として扱う）でだけ動く。
 *  - 応募・当選・購入の記録があるカードは、整理（退避）の対象にしない（記録を守る）。
 *  - 退避は物理削除ではない（archived_at）。応募・購入履歴は残り、あとから元に戻せる。
 *  - 操作の対象は、いま再計算した整理候補に含まれるものだけ（画面から渡されたIDを鵜呑みにしない）。
 *  - 手動の分類（lottery_form_source=manual）は、利用者の操作でしか変えない。
 */
import type { SelectFormCleanup } from "@/lib/agent/lottery-grouping/form-cleanup";
import { auditSelectFormDuplicates } from "@/lib/server/agent/lottery-grouping-service";
import { archiveLottery, restoreLottery, setLotteryForm, type Db } from "@/lib/server/lottery-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列・結合は生成型に無い
const any = (db: unknown) => db as any;

export interface CleanupCard {
  id: string;
  storeName: string;
  products: string;
  deadline: string;
  isSelectCard: boolean;
  /** 応募・当選・購入の記録がある（自動で触らない） */
  protectedCard: boolean;
  form: string | null;
  formSource: string | null;
}
export interface CleanupView {
  key: string;
  chainName: string;
  reasons: string[];
  suggestion: string;
  selectCardId: string | null;
  cards: CleanupCard[];
}
export type CleanupDecision = "consolidate" | "keep_separate" | "mark_select";
export type CleanupResult = { ok: true; changed: string[]; skippedProtected: string[] } | { ok: false; error: string };

const keyOf = (c: SelectFormCleanup): string => [...c.perStoreIds].sort().join(",");

/** 整理候補の一覧（読み取りのみ）。カードごとの店舗・商品・締切・記録の有無つき */
export async function listSelectCleanup(db: Db, householdId: string): Promise<CleanupView[]> {
  const cands = await auditSelectFormDuplicates(db, householdId);
  if (cands.length === 0) return [];
  const ids = [...new Set(cands.flatMap((c) => [...c.perStoreIds, ...(c.selectCardId ? [c.selectCardId] : [])]))];
  const { data } = await any(db)
    .from("lotteries")
    .select("id,chain_id,store_mode,apply_deadline_date,lottery_form,lottery_form_source,stores(name),chains(name),lottery_items(products(official_name))")
    .eq("household_id", householdId)
    .in("id", ids);
  type Row = { id: string; chain_id: string; store_mode: string; apply_deadline_date: string | null; lottery_form: string | null; lottery_form_source: string | null; stores: { name: string } | null; chains: { name: string } | null; lottery_items: { products: { official_name: string } | null }[] };
  const byId = new Map(((data ?? []) as Row[]).map((r) => [r.id, r]));
  const card = (c: SelectFormCleanup, id: string): CleanupCard => {
    const r = byId.get(id);
    return {
      id,
      storeName: r?.store_mode === "select_on_apply" ? "応募時に店舗を選択" : (r?.stores?.name ?? "（店舗未設定）"),
      products: (r?.lottery_items ?? []).map((i) => i.products?.official_name).filter(Boolean).join("・") || "（商品未設定）",
      deadline: r?.apply_deadline_date ?? "",
      isSelectCard: id === c.selectCardId,
      protectedCard: c.protectedIds.includes(id),
      form: r?.lottery_form ?? null,
      formSource: r?.lottery_form_source ?? null,
    };
  };
  return cands.map((c) => ({
    key: keyOf(c),
    chainName: byId.get(c.perStoreIds[0])?.chains?.name ?? "",
    reasons: c.reasons,
    suggestion: c.suggestion,
    selectCardId: c.selectCardId,
    cards: [...(c.selectCardId ? [card(c, c.selectCardId)] : []), ...c.perStoreIds.map((id) => card(c, id))],
  }));
}

/** 整理の実行。対象は、いま再計算した整理候補（key が一致するもの）に限る */
export async function resolveSelectCleanup(db: Db, householdId: string, input: { key: string; decision: CleanupDecision }, actor: string | null): Promise<CleanupResult> {
  const cand = (await auditSelectFormDuplicates(db, householdId)).find((c) => keyOf(c) === input.key);
  if (!cand) return { ok: false, error: "この整理候補は、すでに変わっています。画面を更新してください" };
  const changed: string[] = [];
  if (input.decision === "consolidate") {
    if (!cand.selectCardId) return { ok: false, error: "店舗選択式のカードがまだありません。1つのカードを「応募時に店舗を選択」に変更してから整理してください" };
    const skipped = cand.perStoreIds.filter((id) => cand.protectedIds.includes(id));
    for (const id of cand.perStoreIds.filter((x) => !cand.protectedIds.includes(x))) {
      // 実行の直前に、応募の記録が無いことを再確認する（候補の計算後に記録が付いた場合に備える）
      const { data: apps } = await any(db).from("applications").select("id").eq("lottery_id", id).limit(1);
      if ((apps ?? []).length > 0) {
        skipped.push(id);
        continue;
      }
      const r = await archiveLottery(db, id, actor);
      if (!r.ok) return { ok: false, error: r.error };
      changed.push(id);
    }
    return { ok: true, changed, skippedProtected: skipped };
  }
  const form = input.decision === "keep_separate" ? "store_independent" : "store_select";
  if (input.decision === "mark_select" && cand.selectCardId) return { ok: false, error: "店舗選択式のカードがあるため、整理（退避）を選んでください" };
  for (const id of cand.perStoreIds) {
    const r = await setLotteryForm(db, id, form, actor);
    if (!r.ok) return { ok: false, error: r.error };
    changed.push(id);
  }
  return { ok: true, changed, skippedProtected: [] };
}

/** 最近退避した抽選（30日以内）。整理の取り消し（元に戻す）の対象 */
export async function listRecentlyArchived(db: Db, householdId: string): Promise<{ id: string; storeName: string; products: string; archivedAt: string }[]> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data } = await any(db)
    .from("lotteries")
    .select("id,archived_at,store_mode,stores(name),lottery_items(products(official_name))")
    .eq("household_id", householdId)
    .gte("archived_at", since)
    .order("archived_at", { ascending: false })
    .limit(30);
  type Row = { id: string; archived_at: string; store_mode: string; stores: { name: string } | null; lottery_items: { products: { official_name: string } | null }[] };
  return ((data ?? []) as Row[]).map((r) => ({ id: r.id, archivedAt: r.archived_at, storeName: r.store_mode === "select_on_apply" ? "応募時に店舗を選択" : (r.stores?.name ?? "（店舗未設定）"), products: r.lottery_items.map((i) => i.products?.official_name).filter(Boolean).join("・") || "（商品未設定）" }));
}

export async function restoreArchived(db: Db, householdId: string, id: string, actor: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data } = await any(db).from("lotteries").select("id").eq("id", id).eq("household_id", householdId).not("archived_at", "is", null).maybeSingle();
  if (!data) return { ok: false, error: "元に戻せる抽選が見つかりません" };
  const r = await restoreLottery(db, id, actor);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
