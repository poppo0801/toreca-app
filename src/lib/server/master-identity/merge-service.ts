import "server-only";
import { normalizeAlias } from "@/lib/masters";
import type { MasterKind } from "@/lib/master-identity/names";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 重複マスターの整理（Stage 9H-3T）。仮登録の系列・商品を、同じものと確認できた既存の正式マスターへ寄せ、
 * 抽選などの参照を正しいマスターへ付け替える。**元に戻せる**ことを条件に、対象を絞る:
 *  - 統合元は仮登録（人が確定したマスターは動かさない）。統合先は非表示でない既存のマスター
 *  - 付け替える参照は、抽選・店舗（系列）／抽選の商品行（商品）・別名だけ。購入・応募アカウント・ルール・コレクション等の
 *    参照が1件でもあるものは、既存の統合機能（履歴つき）で人が実行する（ここでは何も変更しない）
 *  - 統合先に同名の店舗があるなど、付け替えが衝突するものは何も変更しない
 * 統合の前後の対応関係（移した行のID・統合元の名称・非表示にした印）は項目の before_state に記録し、revertMasterMerge で戻す。
 * 応募・当選・購入の履歴は、抽選（lottery）のIDで結びついたまま変わらない（付け替えるのは抽選が指すマスターだけ）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列・表は生成型に含まれない
const any = (db: Db) => db as any;

export interface MergeBefore {
  kind: MasterKind;
  fromId: string;
  fromName: string;
  intoId: string;
  intoName: string;
  /** 付け替えた行のID（戻すときに、統合先を指したままのものだけ戻す） */
  lotteryIds: string[];
  storeIds: string[];
  itemIds: string[];
  aliasIds: string[];
  /** 統合先に追加した別名（統合元の名称）のID */
  addedAliasId: string | null;
}

type Result = { ok: true; before: MergeBefore; after: Record<string, unknown> } | { ok: false; error: string };

/** 参照の件数のうち、ここで付け替えてよい項目（これ以外が1件でもあれば対象外） */
const MOVABLE: Record<MasterKind, string[]> = { chain: ["stores", "lotteries", "aliases"], product: ["lottery_items", "aliases"] };

export function unsupportedReferences(kind: MasterKind, counts: Record<string, number>): string[] {
  return Object.entries(counts).filter(([k, n]) => n > 0 && !MOVABLE[kind].includes(k)).map(([k]) => k);
}

const ids = (rows: { id: string }[] | null | undefined) => (rows ?? []).map((r) => r.id);

export async function mergeProvisionalMaster(db: Db, householdId: string, kind: MasterKind, fromId: string, intoId: string, actor: string | null): Promise<Result> {
  if (fromId === intoId) return { ok: false, error: "適用しませんでした（統合元と統合先が同じ）" };
  const table = kind === "chain" ? "chains" : "products";
  const nameCol = kind === "chain" ? "name" : "official_name";
  const refCol = kind === "chain" ? "chain_id" : "product_id";
  const aliasTable = kind === "chain" ? "chain_aliases" : "product_aliases";
  const { data: ms } = await any(db).from(table).select(`id,${nameCol},is_provisional,archived_at,household_id`).in("id", [fromId, intoId]);
  const from = (ms ?? []).find((m: { id: string }) => m.id === fromId);
  const into = (ms ?? []).find((m: { id: string }) => m.id === intoId);
  if (!from || !into || from.household_id !== householdId || into.household_id !== householdId) return { ok: false, error: "適用しませんでした（マスターが見つからない）" };
  if (!from.is_provisional) return { ok: false, error: "適用しませんでした（統合元は人が確定した正式なマスターのため、既存の統合機能で人が実行する）" };
  if (from.archived_at || into.archived_at) return { ok: false, error: "適用しませんでした（マスターの状態が計画時と変わっている）" };

  const { data: counts, error: ce } = await any(db).rpc(kind === "chain" ? "chain_reference_counts" : "product_reference_counts", { p_id: fromId });
  if (ce || !counts) return { ok: false, error: "適用しませんでした（参照の件数を確認できない）" };
  const unsupported = unsupportedReferences(kind, counts as Record<string, number>);
  if (unsupported.length) return { ok: false, error: `適用しませんでした（付け替えの対象外の参照がある: ${unsupported.join("・")}。既存の統合機能で人が実行する）` };

  const fromName = String(from[nameCol]);
  const intoName = String(into[nameCol]);
  const before: MergeBefore = { kind, fromId, fromName, intoId, intoName, lotteryIds: [], storeIds: [], itemIds: [], aliasIds: [], addedAliasId: null };

  const rollback = async () => {
    if (kind === "chain") {
      if (before.lotteryIds.length) await any(db).from("lotteries").update({ chain_id: fromId }).in("id", before.lotteryIds).eq("chain_id", intoId);
      if (before.storeIds.length) await any(db).from("stores").update({ chain_id: fromId }).in("id", before.storeIds).eq("chain_id", intoId);
    } else if (before.itemIds.length) await any(db).from("lottery_items").update({ product_id: fromId }).in("id", before.itemIds).eq("product_id", intoId);
    if (before.aliasIds.length) await any(db).from(aliasTable).update({ [refCol]: fromId }).in("id", before.aliasIds).eq(refCol, intoId);
    if (before.addedAliasId) await any(db).from(aliasTable).delete().eq("id", before.addedAliasId);
  };

  try {
    if (kind === "chain") {
      // 統合先に同名の店舗があると、店舗の統合（応募・購入の付け替え）が必要になる。ここでは扱わない
      const { data: fs } = await any(db).from("stores").select("id,name").eq("chain_id", fromId);
      const { data: ts } = await any(db).from("stores").select("name").eq("chain_id", intoId);
      const taken = new Set((ts ?? []).map((s: { name: string }) => normalizeAlias(s.name)));
      if ((fs ?? []).some((s: { name: string }) => taken.has(normalizeAlias(s.name)))) return { ok: false, error: "適用しませんでした（統合先に同名の店舗がある。既存の統合機能で人が実行する）" };
      const lots = await any(db).from("lotteries").update({ chain_id: intoId }).eq("chain_id", fromId).select("id");
      if (lots.error) throw new Error("lotteries");
      before.lotteryIds = ids(lots.data);
      const sts = await any(db).from("stores").update({ chain_id: intoId }).eq("chain_id", fromId).select("id");
      if (sts.error) throw new Error("stores");
      before.storeIds = ids(sts.data);
    } else {
      const its = await any(db).from("lottery_items").update({ product_id: intoId }).eq("product_id", fromId).select("id");
      if (its.error) throw new Error("lottery_items"); // 同じ抽選に両方の商品がある等の衝突は、ここで失敗して全体を戻す
      before.itemIds = ids(its.data);
    }
    // 別名: 統合先に同じ正規化名があれば移さず（衝突）、統合元に残す。移せたものだけ記録
    const { data: as } = await any(db).from(aliasTable).select("id,normalized_alias").eq(refCol, fromId);
    for (const a of (as ?? []) as { id: string; normalized_alias: string }[]) {
      const r = await any(db).from(aliasTable).update({ [refCol]: intoId }).eq("id", a.id).select("id");
      if (!r.error && r.data?.length) before.aliasIds.push(a.id);
    }
    // 統合元の名称を、統合先の別名として残す（以後その名称で入力しても統合先に解決される）。由来はAIの整理・状態は推定
    const norm = normalizeAlias(fromName);
    if (norm && normalizeAlias(intoName) !== norm) {
      const { data: ex } = await any(db).from(aliasTable).select("id").eq("household_id", householdId).eq("normalized_alias", norm).limit(1);
      if (!(ex ?? []).length) {
        const ins = await any(db).from(aliasTable).insert({ household_id: householdId, [refCol]: intoId, alias: fromName.slice(0, 80), normalized_alias: norm, source: "ai", status: "inferred", evidence: { reason: "仮登録の重複マスターを統合した（9H-3T）", mergedFrom: fromId }, updated_by_profile_id: actor }).select("id").maybeSingle();
        before.addedAliasId = ins.data?.id ?? null;
      }
    }
    const arch = await any(db).from(table).update({ archived_at: new Date().toISOString() }).eq("id", fromId).is("archived_at", null).select("id");
    if (arch.error || !arch.data?.length) throw new Error("archive");
  } catch {
    await rollback();
    return { ok: false, error: "統合できなかったため、変更を元に戻しました（何も変更していません）" };
  }
  return { ok: true, before, after: { intoId, moved: { lotteries: before.lotteryIds.length, stores: before.storeIds.length, items: before.itemIds.length, aliases: before.aliasIds.length }, aliasAdded: !!before.addedAliasId } };
}

/** 統合を元に戻す。付け替えた行は、今も統合先を指しているものだけ統合元へ戻す（その後に利用者が変えたものには触れない） */
export async function revertMasterMerge(db: Db, b: MergeBefore): Promise<boolean> {
  const table = b.kind === "chain" ? "chains" : "products";
  const refCol = b.kind === "chain" ? "chain_id" : "product_id";
  const aliasTable = b.kind === "chain" ? "chain_aliases" : "product_aliases";
  let ok = true;
  const upd = async (t: string, col: string, rowIds: string[]) => {
    if (!rowIds.length) return;
    const r = await any(db).from(t).update({ [col]: b.fromId }).in("id", rowIds).eq(col, b.intoId);
    if (r.error) ok = false;
  };
  const un = await any(db).from(table).update({ archived_at: null }).eq("id", b.fromId);
  if (un.error) ok = false;
  if (b.kind === "chain") {
    await upd("lotteries", "chain_id", b.lotteryIds);
    await upd("stores", "chain_id", b.storeIds);
  } else await upd("lottery_items", "product_id", b.itemIds);
  await upd(aliasTable, refCol, b.aliasIds);
  if (b.addedAliasId) await any(db).from(aliasTable).delete().eq("id", b.addedAliasId);
  return ok;
}
