/**
 * 読み取り専用の実測（Stage 7O）。本番の世帯データに対する loadAppData（全ページ切替・保存のたびに実行される全件取得）の
 * 所要時間・クエリごとの時間とデータ量を測る。DBは変更しない（service_role の SELECT のみ）。
 *   PERF_MEASURE=1 npx vitest run tests/ops/perf-measure.ops.test.ts
 */
import { describe, it } from "vitest";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { adminClient, dbTestsEnabled } from "../helpers/db";

const enabled = process.env.PERF_MEASURE === "1" && dbTestsEnabled !== undefined;

describe.skipIf(!enabled)("Stage 7O: loadAppData の実測", () => {
  it("全件取得の所要時間・テーブルごとの時間とデータ量", async () => {
    const admin = adminClient();
    // 最も抽選の多い世帯（本番の利用世帯）
    const { data: ls } = await admin.from("lotteries").select("household_id").limit(5000);
    const counts = new Map<string, number>();
    for (const l of ls ?? []) counts.set(l.household_id, (counts.get(l.household_id) ?? 0) + 1);
    const hid = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const tables = ["profiles", "profile_target_rules", "chains", "stores", "products", "product_aliases", "family_groups", "identities", "service_accounts", "campaigns", "lotteries", "lottery_items", "lottery_management", "applications", "purchases", "purchase_items", "skip_rules", "skip_rule_exceptions", "application_rules", "limit_exemptions", "chain_requirements", "account_eligibilities", "application_item_results", "sales", "product_images", "product_set_items", "battle_records", "box_lots", "box_movements"];
    const rows: string[] = [];
    for (const t of tables) {
      const s = performance.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テーブル名ごとの型を問わない
      const { data, error } = await (admin as any).from(t).select("*").eq("household_id", hid).limit(50000);
      const ms = performance.now() - s;
      rows.push(`${t.padEnd(26)} ${error ? "ERR" : String((data ?? []).length).padStart(6)}件 ${(JSON.stringify(data ?? []).length / 1024).toFixed(0).padStart(6)}KB ${ms.toFixed(0).padStart(5)}ms`);
    }
    console.log(`\n世帯の抽選数: ${counts.get(hid)}\n${rows.join("\n")}`);
    const runs: number[] = [];
    let kb = 0;
    for (let i = 0; i < 4; i++) {
      const s = performance.now();
      const d = await loadAppData(admin as unknown as Db, hid);
      runs.push(performance.now() - s);
      if (i === 0) kb = JSON.stringify(d).length / 1024;
    }
    console.log(`loadAppData: ${runs.map((r) => r.toFixed(0)).join(" / ")} ms（AppData のJSON ${kb.toFixed(0)}KB）`);
  }, 300_000);
});
