/**
 * Phase 2（自律的な解消）: 実AIの通し経路（runRealProposals）の耐性の追加監査（ローカルのSupabase・擬似クライアント・費用0）。既存の監査（停止条件・出力不備・同時実行・長文・項目の対応）に加えて:
 *  ①秘密情報: APIキー・投稿の原文・URLが、監査イベント・集計・console に出ない（失敗時も）
 *  ②異常な入力: 30ページ・6万字のページ・多数リンクの候補でも、例外にならず、各登録案は自分のリンクだけを根拠にする（他候補・他ページの混同なし）
 *  ③途中の失敗: 調査の途中でAPIが5xxを返しても、その候補だけが失敗し、次の候補は処理される。呼び出しは無制限に再試行されない（maxRetries=0・回数に上限）
 *  ④再試行の冪等性: 同じ候補を失敗後に再実行しても、現行の登録案が重複しない
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { scriptedAnthropic, type ScriptedOptions } from "@/lib/judgment/xsource/scripted-client";
import { rememberFullPages } from "@/lib/server/collector/collected-docs";
import type { Db } from "@/lib/server/lottery-service";
import { persistCollectedDocuments } from "@/lib/server/proposals/collected-store";
import type { CandidateRow } from "@/lib/server/proposals/generate";
import { runRealProposals, type RunEvent } from "@/lib/server/proposals/real-run";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const SECRET = "sk-ant-test-SECRET-DO-NOT-LOG-1234567890";
const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const gate = () => checkJudgmentRealRun({ env: { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_EVAL_API_KEY: SECRET }, confirm: true, approvedTotalJpy: 30, approvedPerCaseJpy: 5 });
const BASE = "https://p2res.example.invalid";
const SHOPS = ["新宿本店", "渋谷店", "大阪店"];
const U = (i: number) => `https://shop-${"abc"[i]}.example.invalid/e/${i + 1}`;
const POST = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222 《大阪店（大阪）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/ccc333";
const MAP = [0, 1, 2].map((i) => ({ short: ["https://t.co/aaa111", "https://t.co/bbb222", "https://t.co/ccc333"][i], url: U(i) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!dbTestsEnabled)("Phase 2: 実AI経路の耐性（秘密・異常入力・途中失敗・冪等性）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;
  let n = 0;
  const dir = mkdtempSync(join(tmpdir(), "p2res-"));
  const add = async (pages: { url: string; text: string }[]): Promise<CandidateRow> => {
    n++;
    const url = `${BASE}/${n}`;
    const ev = buildEvidence({ url, kind: "x_post", post: { text: POST, links: [], linkMap: MAP }, linkedPages: pages } as never, new Date().toISOString());
    const { data, error } = await admin.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(990000000 + n), title: `res-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: ev } as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const page = (i: number, extra = "") => ({ url: U(i), text: `【${SHOPS[i]}】拡張パック 抽選受付\n受付期間 11月30日まで\nお一人様1回まで。${extra}` });
  const current = async (id: string) => ((await admin.from("registration_proposals").select("item_no,source_urls,fields,version").eq("candidate_id", id).is("superseded_at", null).order("item_no")).data ?? []) as any[];
  const run = (cands: CandidateRow[], opts: ScriptedOptions = {}, events: RunEvent[] = []) => {
    const { client, calls } = scriptedAnthropic(opts);
    return runRealProposals({ db: admin as unknown as Db, householdId: hid, candidates: cands, client: client as never, gate: gate(), env: ENV, lockPath: join(dir, `l${n}.lock`), onEvent: (e) => events.push(e) }).then((s) => ({ s, calls, events }));
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p2res", 1);
    userIds.push(a.userId);
    hid = (await a.db.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${BASE}/%`);
    await cleanupTestUsers(admin, userIds);
  });

  it("①秘密情報: APIキー・投稿の原文・URLが、監査イベント・集計・console に出ない（成功・失敗の両方）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c1 = await add(SHOPS.map((_, i) => page(i)));
    const c2 = await add(SHOPS.map((_, i) => page(i)));
    const ok = await run([c1]);
    const ng = await run([c2], { failAll: 500 });
    const blob = JSON.stringify({ ok, ng, out: [...warn.mock.calls, ...log.mock.calls, ...err.mock.calls] });
    warn.mockRestore();
    log.mockRestore();
    err.mockRestore();
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("sk-ant");
    expect(blob).not.toContain("example.invalid");
    expect(blob).not.toContain("拡張パック");
    expect(blob).not.toContain("お一人様");
  });

  it("②異常な入力: 30ページ・6万字のページ・多数リンクの候補でも例外にならず、各登録案は自分のリンクだけを根拠にする", async () => {
    const extra = Array.from({ length: 27 }, (_, i) => ({ url: `https://noise-${i}.example.invalid/e/${i}`, text: `【ノイズ店${i}】別のイベントのページです。${"関係の無い案内。".repeat(30)}` }));
    const long = { url: U(0), text: `${page(0).text}\n${"ナビゲーション項目 ".repeat(6000)}\n【重要】新宿本店では会員証の提示が必要です。` }; // 約6万字
    expect(long.text.length).toBeGreaterThan(55_000);
    const c = await add([long, page(1), page(2), ...extra]);
    // 収集時の全文保存（長いページは抜粋が全文より短い。全文を保管して、AIが読めるようにする）
    const q = {};
    rememberFullPages(q, [long, page(1), page(2), ...extra].map((p) => ({ url: p.url, finalUrl: p.url, title: "", text: p.text, truncated: false, fetchedAt: new Date().toISOString(), depth: 0 as const, origins: ["link_map" as const] })));
    await persistCollectedDocuments(admin as unknown as Db, hid, c.id, q, { postUrl: c.source_url!, postText: POST, nowIso: new Date().toISOString() });
    const { s } = await run([c]);
    expect(s.processed).toBe(1);
    expect(s.stopReason).toBe("completed");
    const rows = await current(c.id);
    expect(rows).toHaveLength(3);
    rows.forEach((r, i) => {
      expect(r.source_urls).toEqual([U(i)]); // 自分のリンクだけ
      expect(JSON.stringify(r.fields)).not.toMatch(new RegExp(["新宿本店", "渋谷店", "大阪店"].filter((_, j) => j !== i).join("|")));
      expect(JSON.stringify(r.fields)).not.toContain("ノイズ店");
    });
  });

  it("③途中の失敗: 調査の途中で5xxが出ても、その候補だけが失敗し次の候補は処理される。呼び出し回数は有限（再試行の暴走なし）", async () => {
    const a = await add(SHOPS.map((_, i) => page(i)));
    const b = await add(SHOPS.map((_, i) => page(i)));
    const { s, calls } = await run([a, b], { failAt: { 2: 500, 3: 500 } }); // 最初の候補の途中で2回続けて失敗
    expect(s.processed).toBe(2);
    expect(s.rows.map((r) => r.status)).toEqual(expect.arrayContaining(["done"]));
    expect(calls.length).toBeLessThan(60); // 無制限に再試行しない
    expect((await current(b.id)).length).toBeGreaterThan(0); // 次の候補は処理された
  });

  it("④再試行の冪等性: 失敗した候補を再実行しても、現行の登録案は重複せず、項目の数は同じ", async () => {
    const c = await add(SHOPS.map((_, i) => page(i)));
    await run([c], { failAll: 500 });
    const first = await current(c.id);
    const r2 = await run([c]);
    expect(r2.s.processed).toBe(1);
    const second = await current(c.id);
    expect(second).toHaveLength(3);
    expect(new Set(second.map((r) => r.item_no)).size).toBe(3); // 項目ごとに現行は1件
    await run([c]); // もう一度（成功の再実行）
    const third = await current(c.id);
    expect(third).toHaveLength(3);
    expect(third.map((r) => r.version).every((v, i) => v >= second[i].version)).toBe(true);
    expect(first.length).toBeLessThanOrEqual(3);
  });
});
