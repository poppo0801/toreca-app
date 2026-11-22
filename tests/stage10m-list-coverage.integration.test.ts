/**
 * Stage 10M: 一覧・まとめ投稿の全項目の処理（ワーカー経路・項目ごとの状態の保存・再開・ハード上限・RLS・旧方式の非干渉）の統合テスト
 * （ローカルのSupabase・RLS適用下。判断のAIはすべて台本のモック。架空データのみ。実AI・課金なし）
 *   npm run test:db
 * 必須回帰: 8項目・複数系列・複数店舗・複数商品の一覧（ユーザーが確認した#1と同じ構造を架空データで再現）が、8項目すべて追跡され、応募機会数は判定から数えられる。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { CallBudget } from "@/lib/judgment/call-budget";
import { ScriptedListModel } from "@/lib/judgment/list-model";
import { parseListItems } from "@/lib/judgment/list-items";
import type { Db } from "@/lib/server/lottery-service";
import { runShadowWorker } from "@/lib/server/shadow/worker";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { rpc: (n: string, a?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>; from: (t: string) => any };
const L = (db: unknown): Loose => db as Loose;
const ENV_ON = { SHADOW_WORKER: "on" };
const NOW = new Date();
const HEAD = "🏯架空地方 | 3府県8件 (1/1)";
const LIST8 = `${HEAD} 《サンプル書店A（架空県）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選販売受付 https://t.co/a1 - 11/23(月)23:59〆 《サンプル書店B（架空県）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選予約販売 https://t.co/a2 - 11/22(日)23:59〆 《チェーンC 東店（架空県）- 1件》 ・別TCG 抽選販売（デッキセット） https://t.co/a3 - 11/20(金)20:00〆 《チェーンD 西店（架空県）- 1件》 ・【再入荷】別TCG ブースター 抽選販売受付 https://t.co/a4 - 11/22(日)23:59〆 《チェーンD 南店（架空県）- 1件》 ・【再入荷】別TCG ブースター 抽選販売受付 https://t.co/a5 - 11/22(日)23:59〆 《チェーンE 北店（架空県）- 2件》 ・架空TCG 商品X https://t.co/a6 - 11/20(金)22:00〆 ・架空TCG 商品Y https://t.co/a7 - 11/22(日)22:00〆 《ショップF（架空県）- 1件》 ・架空TCG「テスト弾」抽選販売受付 https://t.co/a8 - 11/22(日)22:00〆`;

const indep = (no: number, text: string, over: Record<string, unknown> = {}) => ({ itemNo: no, verdict: "independent_lottery", quote: text.replace(/^[・✅ ]+/, "").slice(0, 8), rationale: "テスト", applyUnit: "one_form_one", ...over });
const allIndependent = (req: { items: { no: number; text: string }[] }) => ({ items: req.items.map((i) => indep(i.no, i.text)) });

describe.skipIf(!dbTestsEnabled)("Stage 10M: 一覧の全項目の処理（シャドーのワーカー経路）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hidA: string;
  const mk = (n: string) => `https://shadow10m.example.invalid/${n}`;

  const setSettings = async (over: Record<string, unknown> = {}) => {
    const { error } = await admin.from("shadow_settings").upsert({ household_id: hidA, enabled: true, enqueue_enabled: true, daily_budget_jpy: 20, monthly_budget_jpy: 200, per_case_cap_jpy: 3, max_jobs_per_run: 3, retention_days: 30, ...over });
    expect(error).toBeNull();
  };
  /** 親投稿（一覧）の候補。旧方式の登録（draft）は、1店舗・1商品だけ（旧方式は1候補＝1抽選） */
  const addList = async (n: string, text = LIST8) => {
    const stored = buildEvidence({ url: mk(n), kind: "x_post", post: { text, links: [], linkMap: [{ short: "https://t.co/a4", url: "https://shop-d.example.com/lottery/1" }, { short: "https://t.co/a5", url: "https://shop-d.example.com/lottery/1" }] } }, NOW.toISOString())!;
    const draft = { input: { chain: { name: "サンプル書店" }, store: { name: "サンプル書店A" }, items: [{ product: { name: "拡張パック" } }], storeMode: "fixed" } };
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hidA, dedupe_key: mk(n), source_url: mk(n), title: n, status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: draft as never }).select("id").single();
    expect(error).toBeNull();
    return { id: data!.id as string, hash: stored.hash.slice(0, 32), text: stored.text };
  };
  const enqueue = async (c: { id: string; hash: string }) => (await L(u1).rpc("shadow_enqueue", { p_household: hidA, p_candidate: c.id, p_hash: c.hash })).data as boolean;
  const run = (listModel: ScriptedListModel | undefined, over: Record<string, unknown> = {}) => runShadowWorker({ db: admin as unknown as Db, model: null as never, listModel, env: ENV_ON, workerId: "w", limit: 3, ...over });
  const items = async (cid: string) => ((await admin.from("shadow_list_items").select("*").eq("candidate_id", cid).order("item_no")).data ?? []) as Record<string, unknown>[];
  const clean = async () => {
    for (const t of ["shadow_judgments", "shadow_list_items", "shadow_jobs"]) await admin.from(t).delete().eq("household_id", hidA);
    await admin.from("collection_candidates").delete().like("dedupe_key", "https://shadow10m.example.invalid/%");
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10m", 1);
    const b = await signInTestUser(admin, "s10m", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hidA = (await u1.rpc("bootstrap_household")).data as string;
    await (b.db as unknown as { rpc: (n: string) => Promise<unknown> }).rpc("bootstrap_household");
  });
  afterAll(async () => {
    await clean();
    await cleanupTestUsers(admin, userIds);
  });

  // run() は model=null: 判断モデルが無くても、一覧は listModel で処理される（一覧でない告知は model が要る＝ここでは扱わない）
  it("①必須回帰: 8項目の一覧は、8項目すべてが保存され（範囲は親投稿の原文と一致）、応募機会は判定から数える。旧方式の登録は1項目分だけ（取りこぼしを比較で示す）", async () => {
    await setSettings();
    const c = await addList("a1");
    expect(await enqueue(c)).toBe(true);
    const m = new ScriptedListModel((req) => allIndependent(req));
    // model が null だと worker は not_allowed ではなく no_model で止まるため、一覧のためのダミーの判断モデルを渡す
    const r = await runShadowWorker({ db: admin as unknown as Db, model: { id: "x", promptVersion: "x", maxCostJpy: () => 0.1, judge: async () => ({ raw: {}, costJpy: 0 }), planAction: async () => ({ raw: {}, costJpy: 0 }) }, listModel: m, env: ENV_ON, workerId: "w" });
    expect(r).toMatchObject({ leased: 1, done: 1 });
    expect(m.calls).toBe(2);
    const rows = await items(c.id);
    expect(rows.map((x) => x.item_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.every((x) => x.status === "done" && x.verdict === "independent_lottery" && x.quote_verified === true)).toBe(true);
    for (const x of rows) expect(c.text.slice(x.range_start as number, x.range_end as number)).toBe(parseListItems(c.text).items[(x.item_no as number) - 1].text);
    expect(rows.find((x) => x.item_no === 4)!.link_host).toBe("shop-d.example.com");
    expect(rows.find((x) => x.item_no === 5)!.link_host).toBe("shop-d.example.com"); // 展開後の応募先が同じ（項目4と5）
    const j = (await admin.from("shadow_judgments").select("status,opportunity_count,structure_new,record").eq("candidate_id", c.id)).data![0];
    expect(j).toMatchObject({ status: "accepted", opportunity_count: 8, structure_new: "list_discovery" });
    const rec = j.record as { list: { total: number; done: number; complete: boolean }; legacy: { matchedItems: number; itemCount: number } };
    expect(rec.list).toMatchObject({ total: 8, done: 8, complete: true });
    expect(rec.legacy.itemCount).toBe(1); // 旧方式の登録は1商品
    expect(rec.legacy.matchedItems).toBe(1); // 8項目のうち、旧方式の登録（1店舗）が覆うのは1項目だけ
    const cov = (await L(u1).rpc("shadow_list_coverage", { p_household: hidA, p_candidate: c.id, p_parent: parseListItems(c.text).parentKey })).data as Record<string, number>;
    expect(cov).toMatchObject({ done: 8, hold: 0, failed: 0, opportunities_confirmed: 8 });
    // 記録に原文・抜粋・URLを保存していない
    const blob = JSON.stringify(rows) + JSON.stringify(j);
    for (const bad of ["https://t.co", "抽選販売受付", "架空TCG 拡張パック"]) expect(blob, bad).not.toContain(bad);
    await clean();
  });

  it("②8項目が必ず8応募機会になるとは限らない: 同じ店舗の見出しの下の2項目を同一応募と判断すれば、8項目→7応募機会。別の見出しの統合（リンク先が不明）は保留", async () => {
    await setSettings();
    const c = await addList("m1");
    await enqueue(c);
    const m = new ScriptedListModel((req) => ({
      items: req.items.map((i) => {
        if (i.no === 7) return indep(7, i.text, { verdict: "part_of_other_item", mergedInto: 6 });
        if (i.no === 2) return indep(2, i.text, { verdict: "part_of_other_item", mergedInto: 1 }); // 別の見出し・リンク先不明 → 保留
        return indep(i.no, i.text);
      }),
    }));
    await runShadowWorker({ db: admin as unknown as Db, model: { id: "x", promptVersion: "x", maxCostJpy: () => 0.1, judge: async () => ({ raw: {}, costJpy: 0 }), planAction: async () => ({ raw: {}, costJpy: 0 }) }, listModel: m, env: ENV_ON, workerId: "w" });
    const rows = await items(c.id);
    expect(rows.find((x) => x.item_no === 7)).toMatchObject({ status: "done", verdict: "part_of_other_item", merged_into: 6 });
    expect(rows.find((x) => x.item_no === 2)).toMatchObject({ status: "hold", verdict: "part_of_other_item" });
    expect((rows.find((x) => x.item_no === 2)!.issues as string[])).toContain("cross_group_merge");
    const j = (await admin.from("shadow_judgments").select("opportunity_count,record").eq("candidate_id", c.id)).data![0];
    expect(j.opportunity_count).toBe(6); // 8項目 − 統合済み1 − 保留1（確認済みの機会は6。保留の1項目は『候補』として別に数える）
    expect((j.record as { list: { candidatesOnHold: number } }).list.candidatesOnHold).toBe(0); // 保留の項目の判断は part_of_other_item（独立した抽選ではない）
    await clean();
  });

  it("③ハードな呼び出し上限と再開: 実行全体の上限（1回）で止まり、続きから再開できる。処理済みの6項目は再び呼び出されない（合計2回）。再実行しても行は重複しない", async () => {
    await setSettings();
    const c = await addList("r1");
    await enqueue(c);
    const dummy = { id: "x", promptVersion: "x", maxCostJpy: () => 0.1, judge: async () => ({ raw: {}, costJpy: 0 }), planAction: async () => ({ raw: {}, costJpy: 0 }) };
    const m = new ScriptedListModel((req) => allIndependent(req));
    const b1 = new CallBudget({ maxCalls: 1, maxCostJpy: 20 });
    const r1 = await runShadowWorker({ db: admin as unknown as Db, model: dummy, listModel: m, callBudget: b1, env: ENV_ON, workerId: "w" });
    expect(b1.calls).toBe(1);
    expect(r1.byReason.list_incomplete).toBe(1);
    expect((await items(c.id)).map((x) => x.item_no)).toEqual([1, 2, 3, 4, 5, 6]); // 7・8は未処理（行なし）
    const job = (await admin.from("shadow_jobs").select("status,attempts,last_error").eq("candidate_id", c.id)).data![0];
    expect(job).toMatchObject({ status: "queued", last_error: "list_stopped_calls" });
    expect(job.attempts).toBe(0); // 進んだ（6項目を処理した）ので罰なしで戻る
    await admin.from("shadow_jobs").update({ next_run_at: new Date(Date.now() - 1000).toISOString() }).eq("candidate_id", c.id);
    const b2 = new CallBudget({ maxCalls: 5, maxCostJpy: 20 });
    const r2 = await runShadowWorker({ db: admin as unknown as Db, model: dummy, listModel: m, callBudget: b2, env: ENV_ON, workerId: "w" });
    expect(r2.done).toBe(1);
    expect(m.calls).toBe(2); // 1回目の6項目を再び呼び出していない
    expect(m.seen[1].items.map((i) => i.no)).toEqual([7, 8]);
    expect(b2.calls).toBe(1);
    expect(await items(c.id)).toHaveLength(8);
    const recs = (await admin.from("shadow_judgments").select("status,opportunity_count").eq("candidate_id", c.id).order("created_at")).data!;
    expect(recs.map((x) => x.status)).toEqual(["partial", "accepted"]); // 1回目は部分（未処理あり）、2回目で完了
    await clean();
  });

  it("④実行全体の呼び出し上限に既に達していれば、一覧のジョブは1回も呼び出さずに戻る。予算（日次）が足りないときも呼ばない", async () => {
    await setSettings();
    const c = await addList("l1");
    await enqueue(c);
    const dummy = { id: "x", promptVersion: "x", maxCostJpy: () => 0.1, judge: async () => ({ raw: {}, costJpy: 0 }), planAction: async () => ({ raw: {}, costJpy: 0 }) };
    const m = new ScriptedListModel((req) => allIndependent(req));
    const spent = new CallBudget({ maxCalls: 2, maxCostJpy: 20 });
    spent.start("judge", 0);
    spent.start("judge", 0); // すでに2回
    const r = await runShadowWorker({ db: admin as unknown as Db, model: dummy, listModel: m, callBudget: spent, env: ENV_ON, workerId: "w" });
    expect(r.byReason.run_call_limit).toBe(1);
    expect(m.calls).toBe(0);
    await admin.from("shadow_jobs").update({ next_run_at: new Date(Date.now() - 1000).toISOString() }).eq("candidate_id", c.id);
    await setSettings({ daily_budget_jpy: 0.3 });
    const r2 = await runShadowWorker({ db: admin as unknown as Db, model: dummy, listModel: m, env: ENV_ON, workerId: "w" });
    expect(r2.byReason.budget).toBe(1);
    expect(m.calls).toBe(0);
    await clean();
  });

  it("⑤緊急停止: 一覧の処理中にDBの enabled を切ると、次のジョブは呼び出されず戻る。取りこぼしの項目（モデルが返さなかった項目）は failed で、完了とは数えない", async () => {
    await setSettings();
    const a = await addList("k1");
    const b = await addList("k2", LIST8.replace("架空地方", "架空地方2"));
    await enqueue(a);
    await enqueue(b);
    const dummy = { id: "x", promptVersion: "x", maxCostJpy: () => 0.1, judge: async () => ({ raw: {}, costJpy: 0 }), planAction: async () => ({ raw: {}, costJpy: 0 }) };
    let n = 0;
    const m = new ScriptedListModel(async (req) => {
      if (n++ === 0) await admin.from("shadow_settings").update({ enabled: false }).eq("household_id", hidA);
      return { items: req.items.filter((i) => i.no !== 4).map((i) => indep(i.no, i.text)) }; // 項目4は常に返さない
    });
    const r = await runShadowWorker({ db: admin as unknown as Db, model: dummy, listModel: m, env: ENV_ON, workerId: "w", limit: 2 });
    expect(r.byReason.killed).toBe(1); // 2件目のジョブは呼び出されない
    const first = (await admin.from("shadow_judgments").select("status,record").eq("household_id", hidA)).data!;
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("partial"); // 項目4が failed のため、完了とは数えない（accepted にならない）
    expect((first[0].record as { list: { failed: number; complete: boolean } }).list).toMatchObject({ failed: 1, complete: false });
    expect((await admin.from("shadow_list_items").select("status").eq("household_id", hidA).eq("item_no", 4)).data![0].status).toBe("failed");
    await clean();
  });

  it("⑥RLS・旧方式の非干渉・保持期限: 世帯の構成員だけが項目を読める。利用者は書けない。旧方式の表は変わらない。期限を過ぎた項目だけ掃除される", async () => {
    await setSettings({ retention_days: 7 });
    const tables = ["lotteries", "applications", "collection_candidates", "case_judgments", "notification_deliveries"];
    const snap = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, JSON.stringify((await admin.from(t as never).select("*").eq("household_id" as never, hidA as never)).data ?? [])])));
    const c = await addList("p1");
    await enqueue(c);
    const before = await snap();
    const m = new ScriptedListModel((req) => allIndependent(req));
    await runShadowWorker({ db: admin as unknown as Db, model: { id: "x", promptVersion: "x", maxCostJpy: () => 0.1, judge: async () => ({ raw: {}, costJpy: 0 }), planAction: async () => ({ raw: {}, costJpy: 0 }) }, listModel: m, env: ENV_ON, workerId: "w" });
    expect(await snap()).toEqual(before);
    expect((await L(u1).from("shadow_list_items").select("id")).data).toHaveLength(8);
    expect((await L(u2).from("shadow_list_items").select("id")).data ?? []).toEqual([]);
    expect((await L(anonClient()).from("shadow_list_items").select("id")).data ?? []).toEqual([]);
    expect((await L(u1).from("shadow_list_items").update({ status: "failed" }).eq("household_id", hidA)).error).not.toBeNull();
    expect((await L(u1).from("shadow_list_items").insert({ household_id: hidA, candidate_id: c.id, parent_key: "0".repeat(16), item_no: 1, group_no: 1, range_start: 0, range_end: 1, status: "done" })).error).not.toBeNull();
    await admin.from("shadow_list_items").update({ updated_at: new Date(Date.now() - 30 * 86_400_000).toISOString() }).eq("candidate_id", c.id).eq("item_no", 1);
    expect((await L(u1).rpc("shadow_purge")).error).not.toBeNull();
    expect((await admin.rpc("shadow_purge")).error).toBeNull();
    expect((await admin.from("shadow_list_items").select("item_no").eq("candidate_id", c.id)).data!.map((x) => x.item_no)).not.toContain(1);
    expect((await admin.from("shadow_list_items").select("id").eq("candidate_id", c.id)).data).toHaveLength(7);
    await clean();
  });
});
