/**
 * 一覧の項目ごとの状態の保存先（Stage 10M・サーバー）。`shadow_list_items` への読み書きだけ（旧方式の表には書かない）。
 * 再開: done/hold の項目は読み戻され、再び判断されない（重複課金の防止）。failed は次回の再処理の対象。
 */
import type { ItemStore, ListItemResult } from "@/lib/judgment/list-discovery";
import type { ListItem } from "@/lib/judgment/list-items";
import type { Db } from "@/lib/server/lottery-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (db: Db, t: string): any => (db as unknown as { from: (t: string) => unknown }).from(t);

export interface ListStoreMeta {
  householdId: string;
  candidateId: string;
  items: ListItem[];
  promptVersion: string;
  /** 項目の応募先のホスト名（展開済みリンクの対応表がある場合）。表示用 */
  hostOf?: (item: ListItem) => string | null;
}

const cleanText = (s: string): string => s.replace(/https?:\/\/\S+/g, "").slice(0, 300);

export class DbItemStore implements ItemStore {
  constructor(private readonly db: Db, private readonly meta: ListStoreMeta) {}

  async load(parentKey: string): Promise<Map<number, ListItemResult>> {
    const { data } = await table(this.db, "shadow_list_items").select("*").eq("household_id", this.meta.householdId).eq("candidate_id", this.meta.candidateId).eq("parent_key", parentKey);
    const m = new Map<number, ListItemResult>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      m.set(r.item_no as number, {
        no: r.item_no as number,
        groupNo: r.group_no as number,
        status: r.status as ListItemResult["status"],
        verdict: (r.verdict as ListItemResult["verdict"]) ?? null,
        mergedInto: (r.merged_into as number | null) ?? null,
        unit: (r.apply_unit as ListItemResult["unit"]) ?? null,
        chain: (r.chain as string | null) ?? null,
        store: (r.store as string | null) ?? null,
        products: (r.products as string[]) ?? [],
        applyDeadline: (r.apply_deadline as string | null) ?? null,
        applyStart: (r.apply_start as string | null) ?? null,
        method: (r.method as string | null) ?? null,
        rationale: (r.rationale as string) ?? "",
        quote: "", // 抜粋は保存しない
        quoteVerified: r.quote_verified === true,
        unresolved: (r.unresolved as ListItemResult["unresolved"]) ?? [],
        issues: (r.issues as string[]) ?? [],
      });
    }
    return m;
  }

  async save(parentKey: string, results: ListItemResult[]): Promise<void> {
    const byNo = new Map(this.meta.items.map((i) => [i.no, i]));
    const rows = results
      .filter((r) => r.status === "done" || r.status === "hold" || r.status === "failed")
      .map((r) => {
        const it = byNo.get(r.no) as ListItem;
        return {
          household_id: this.meta.householdId,
          candidate_id: this.meta.candidateId,
          parent_key: parentKey,
          item_no: r.no,
          group_no: r.groupNo,
          range_start: it.start,
          range_end: it.end,
          status: r.status,
          verdict: r.verdict,
          merged_into: r.mergedInto,
          apply_unit: r.unit,
          chain: r.chain,
          store: r.store,
          products: r.products.map((p) => cleanText(p).slice(0, 120)),
          apply_deadline: r.applyDeadline,
          apply_start: r.applyStart,
          method: r.method,
          rationale: cleanText(r.rationale),
          quote_verified: r.quoteVerified,
          unresolved: r.unresolved.map((u) => ({ question: cleanText(u.question).slice(0, 200), importance: u.importance })),
          issues: r.issues.slice(0, 8),
          link_host: this.meta.hostOf?.(it) ?? null,
          prompt_version: this.meta.promptVersion,
          updated_at: new Date().toISOString(),
        };
      });
    if (!rows.length) return;
    await table(this.db, "shadow_list_items").upsert(rows, { onConflict: "household_id,candidate_id,parent_key,item_no" });
  }
}
