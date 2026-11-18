/**
 * Stage 9D: 実在の公開サイトへの取得の動作確認（無料・少数・robots.txt尊重・間隔1.5秒）。通常のテストには含めない。
 *   LIVE_FETCH=1 RUN_DB_TESTS=1 npx vitest run tests/live9d.integration.test.ts
 * 取得は dry-run のみ（登録・監視追加なし）。実AI・有料APIは使わない。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { runInvestigation } from "@/lib/server/agent/investigation-run";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled || process.env.LIVE_FETCH !== "1")("Stage 9D live", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u: Db;
  let hid: string;
  beforeAll(async () => {
    const a = await signInTestUser(admin, "l9d", 1);
    ids.push(a.userId);
    u = a.db;
    hid = (await u.rpc("bootstrap_household")).data as string;
    const mk = async (name: string, url: string) => {
      const c = (await u.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
      await u.from("stores").insert({ household_id: hid, chain_id: c, name: `${name}本店`, prefecture: "東京都", store_url: url } as never);
    };
    await mk("キデイランド", "https://www.kiddyland.co.jp/");
    await mk("ポケモンカードゲーム公式", "https://www.pokemon-card.com/");
  });
  afterAll(async () => cleanupTestUsers(admin, ids));
  it("実サイトを取得し、調査の記録と情報源の評価が出る", async () => {
    const r = await runInvestigation({ db: admin as unknown as Db, householdId: hid, now: new Date(), mode: "dry_run", live: true, actor: null });
    if (!r.ok) throw new Error(r.error);
    console.log(JSON.stringify({ status: r.record.status, steps: r.record.steps.map((s) => ({ tool: s.tool, ok: s.ok, ms: s.ms, target: s.target, result: s.resultSummary, next: s.nextInfo })), previews: r.record.previews.map((p) => ({ url: p.url, recognized: p.recognized, disposition: p.disposition.kind, missing: p.missing })), monitor: r.record.monitorEvals.map((e) => ({ url: e.url, official: e.official, relevance: e.relevance, recommend: e.recommend })), stops: r.record.stops, metrics: r.record.evaluation.metrics }, null, 1));
    expect(r.record.steps.some((s) => s.tool === "check_official_site")).toBe(true);
  });
});
