/**
 * Phase 2（自律的な解消）: 耐久的な取得制御・未取得リンクの自動再調査・保持期間の掃除（ローカルのSupabase・外部アクセスなし・費用0）。
 *  ①DB共有のホスト制御: 複数の「インスタンス」が同時に走っても、ホスト別の同時接続・間隔・全体上限が守られる／429のバックオフと停止（期限つき）／落ちたリースの失効
 *  ②再調査キュー: 収集で未取得（時間切れ・予算）→ タスク登録 → 別の実行で取得 → 元の候補の証拠へ戻る → 登録案を再生成できる。重複実行の防止・リース失効での復帰・試行上限・期限・robots/403は回避しない
 *  ③保持期間の掃除: dry-run は何も消さない。最新版・human/gold・保留中の候補は残す
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { HostThrottle } from "@/lib/collector/fetch-control";
import { enqueueLinkRechecks, runLinkRechecks } from "@/lib/server/collector/link-recheck";
import { DbHostGate } from "@/lib/server/collector/db-host-gate";
import type { Db } from "@/lib/server/lottery-service";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { generateProposalsForCandidate, mockDeps } from "@/lib/server/proposals/generate";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = "https://p2dur.example.invalid";
const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const SHOPS = ["新宿本店", "渋谷店", "大阪店"];
const U = (i: number) => `https://shop-${"abc"[i]}.example.invalid/e/${i + 1}`;
const html = (shop: string) => `<html><title>${shop}</title><body><h1>【${shop}】拡張パック 抽選受付</h1><p>受付期間 11月30日まで。お一人様1回まで。${shop}の店頭受取のみ。</p><p>応募方法の詳細。本ページの内容をご確認ください。</p></body></html>`;
const okPage = (url: string): SafeFetchResult => ({ ok: true, finalUrl: url, status: 200, contentType: "text/html", body: html(SHOPS[Number(/e\/(\d)/.exec(url)?.[1] ?? 1) - 1]), truncated: false });
const sleepFast = async () => undefined;
const page0 = () => "【新宿本店】拡張パック 抽選受付。受付期間 11月30日まで。お一人様1回まで。新しい版のページ。";

describe.skipIf(!dbTestsEnabled)("Phase 2: 耐久的な取得制御・再調査・掃除", () => {
  const admin = adminClient();
  const db = () => admin as unknown as Db;
  const userIds: string[] = [];
  let hid: string;
  let n = 0;
  const hosts: string[] = [];
  const host = (tag: string) => {
    const h = `${tag}-${Date.now()}-${n++}.example.invalid`;
    hosts.push(h);
    return h;
  };
  beforeAll(async () => {
    const a = await signInTestUser(admin, "p2dur", 1);
    userIds.push(a.userId);
    hid = (await a.db.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${BASE}/%`);
    for (const h of hosts) await admin.from("fetch_host_gate").delete().eq("host", h);
    await cleanupTestUsers(admin, userIds);
  });

  it("①DB共有のホスト制御: 複数インスタンスが同時に走っても同時接続・間隔・全体上限を守る。429はバックオフし、続けば停止（期限つき）。落ちたリースは失効する", async () => {
    const h = host("gate");
    const gates = [0, 1, 2, 3].map(() => new DbHostGate(db(), { minIntervalMs: 120, maxPerHost: 1, globalMax: 50, leaseMs: 5000 }));
    let live = 0;
    let peak = 0;
    const starts: number[] = [];
    // 4つの「インスタンス」が同じホストへ各3回（合計12回）同時に取得する
    await Promise.all(
      gates.flatMap((g) =>
        [1, 2, 3].map(async () => {
          const r = await g.run(h, async () => {
            live++;
            peak = Math.max(peak, live);
            starts.push(Date.now());
            await new Promise((x) => setTimeout(x, 20));
            live--;
            return { value: 1, outcome: "ok" as const };
          });
          expect(r.ran).toBe(true);
        }),
      ),
    );
    expect(starts).toHaveLength(12);
    expect(peak).toBe(1); // ホスト別の同時接続は、インスタンスをまたいで1
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(100); // 開始間隔（120ms・時計の誤差を許容）
    // 429: バックオフ → 続けば停止（期限つき）。他のホストは影響を受けない
    const h2 = host("gate429");
    const g = new DbHostGate(db(), { minIntervalMs: 0, baseBackoffMs: 100, rateLimitLimit: 2, suspendMs: 60_000, sleep: sleepFast });
    const r1 = await g.run(h2, async () => ({ value: 1, outcome: "rate_limited" as const, retryAfterMs: 0 }));
    expect(r1.ran).toBe(true);
    await new Promise((x) => setTimeout(x, 250));
    const r2 = await g.run(h2, async () => ({ value: 1, outcome: "rate_limited" as const }));
    expect(r2.ran).toBe(true);
    const r3 = await g.run(h2, async () => ({ value: 1, outcome: "ok" as const }));
    expect(r3).toEqual({ ran: false, cause: "host_suspended" }); // 2回の429で停止
    const row = (await admin.from("fetch_host_gate").select("suspended_until").eq("host", h2).single()).data as any;
    expect(new Date(row.suspended_until).getTime()).toBeGreaterThan(Date.now()); // 期限がある（永久ではない）
    expect((await new DbHostGate(db(), { minIntervalMs: 0 }).run(host("other"), async () => ({ value: 1, outcome: "ok" as const }))).ran).toBe(true);
    // 落ちたインスタンスのリース: 期限が切れたら同時接続を占有し続けない
    const h3 = host("lease");
    const a1 = await admin.rpc("fetch_gate_acquire", { p_host: h3, p_min_interval_ms: 0, p_max_conc: 1, p_lease_ms: 1000, p_global_max: 50 });
    expect((a1.data as any)[0].granted).toBe(true); // 取得して、解放せずに「落ちた」
    const a2 = await admin.rpc("fetch_gate_acquire", { p_host: h3, p_min_interval_ms: 0, p_max_conc: 1, p_lease_ms: 1000, p_global_max: 50 });
    expect((a2.data as any)[0]).toMatchObject({ granted: false, reason: "wait" });
    await new Promise((x) => setTimeout(x, 1200));
    const a3 = await admin.rpc("fetch_gate_acquire", { p_host: h3, p_min_interval_ms: 0, p_max_conc: 1, p_lease_ms: 1000, p_global_max: 50 });
    expect((a3.data as any)[0].granted).toBe(true); // リースが失効して取得できる
    // 全体の上限
    const hg = host("glob");
    await admin.rpc("fetch_gate_acquire", { p_host: hg, p_min_interval_ms: 0, p_max_conc: 5, p_lease_ms: 5000, p_global_max: 50 });
    const gl = await admin.rpc("fetch_gate_acquire", { p_host: host("glob2"), p_min_interval_ms: 0, p_max_conc: 5, p_lease_ms: 5000, p_global_max: 1 });
    expect((gl.data as any)[0]).toMatchObject({ granted: false, reason: "wait" });
  }, 60_000);

  const mkCandidate = async (links: string[], text: string) => {
    n++;
    const url = `${BASE}/${n}`;
    const ledger = links.map((u, i) => ({ url: u, key: u.replace(/^https?:\/\//, ""), host: new URL(u).hostname, order: i, origins: ["link_map" as const], status: "skipped" as const, reason: i === 0 ? "deadline" : "budget_requests" }));
    const ev = buildEvidence({ url, kind: "x_post", post: { text, links: [], linkMap: links.map((u, i) => ({ short: `https://t.co/zz${i}`, url: u })) }, linkedPages: [], linkLedger: ledger } as never, new Date().toISOString());
    const { data, error } = await admin.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(980000000 + n), title: `dur-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: ev } as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return { row: data as any, ledger };
  };
  const POST = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/zz0 《渋谷店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/zz1 《大阪店（大阪）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/zz2";
  const tasksOf = async (cid: string) => ((await admin.from("link_recheck_tasks").select("*").eq("candidate_id", cid).order("order_no")).data ?? []) as any[];
  const gate = () => new HostThrottle({ minIntervalMs: 0, maxGlobal: 8 });

  it("②再調査: 収集で未取得 → タスク登録（二重登録なし）→ 別の実行で取得 → 候補の証拠へ戻る → 登録案を再生成できる。AIの入力に3店舗が揃う", async () => {
    const { row, ledger } = await mkCandidate([U(0), U(1), U(2)], POST);
    const q1 = await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger, now: new Date() });
    expect(q1).toEqual({ queued: 3, skipped: 0 });
    expect(await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger, now: new Date() })).toMatchObject({ queued: 3 }); // upsert（無視）
    expect(await tasksOf(row.id)).toHaveLength(3); // 二重登録なし
    // 取得できないと分かっているもの（robots・ログイン等）は登録しない
    const bad = await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger: [{ ...ledger[0], key: "x", reason: "robots", url: "https://x.example.invalid/" }], now: new Date() });
    expect(bad).toEqual({ queued: 0, skipped: 0 });
    // まだ実行時刻前（登録の1分後）: 取り出せない
    expect((await runLinkRechecks({ db: db(), householdId: hid, gate: gate(), timeLeft: () => 60_000, fetchPage: async (u) => okPage(u) })).claimed).toBe(0);
    await admin.from("link_recheck_tasks").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("candidate_id", row.id);
    let regenerated = 0;
    const s = await runLinkRechecks({ db: db(), householdId: hid, gate: gate(), limit: 5, timeLeft: () => 60_000, fetchPage: async (u) => okPage(u), onUpdated: async (cid) => { regenerated++; const r = await admin.from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("id", cid).single(); await generateProposalsForCandidate({ db: db(), householdId: hid, candidate: r.data as any, env: ENV, deps: mockDeps() }); } });
    expect(s).toMatchObject({ claimed: 3, done: 3, gaveUp: 0, regenerated: 1 });
    expect(regenerated).toBe(1);
    expect((await tasksOf(row.id)).every((t) => t.status === "done")).toBe(true);
    // 元の候補の証拠へ戻っている（リンク先3ページ・台帳は全て取得済み）
    const ev = ((await admin.from("collection_candidates").select("last_good").eq("id", row.id).single()).data as any).last_good.evidence;
    expect(ev.linkedPages).toHaveLength(3);
    expect(ev.linkLedger.every((e: any) => e.status === "fetched")).toBe(true);
    expect(ev.recheckSeq).toBe(3);
    // 全文も保存され、登録案は3店舗分が各自のページを根拠に作られる
    expect(((await admin.from("evidence_documents").select("id", { count: "exact", head: true }).eq("candidate_id", row.id)).count ?? 0)).toBe(3);
    const props = ((await admin.from("registration_proposals").select("source_urls,fields").eq("candidate_id", row.id).is("superseded_at", null).order("item_no")).data ?? []) as any[];
    expect(props).toHaveLength(3);
    props.forEach((p, i) => expect(p.source_urls).toEqual([U(i)]));
  });

  it("②重複実行の防止・リース失効での復帰・試行上限・期限・回避しない（robots/403）・一時的な失敗のバックオフ", async () => {
    const { row, ledger } = await mkCandidate([U(0), U(1), U(2)], POST);
    await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger, now: new Date() });
    await admin.from("link_recheck_tasks").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("candidate_id", row.id);
    // 2つのワーカーが同時に claim しても、同じタスクを取らない
    const [c1, c2] = await Promise.all([admin.rpc("link_recheck_claim", { p_limit: 2, p_lease_s: 2, p_now: new Date().toISOString() }), admin.rpc("link_recheck_claim", { p_limit: 2, p_lease_s: 2, p_now: new Date().toISOString() })]);
    const ids1 = ((c1.data ?? []) as any[]).filter((t) => t.candidate_id === row.id).map((t) => t.id);
    const ids2 = ((c2.data ?? []) as any[]).filter((t) => t.candidate_id === row.id).map((t) => t.id);
    expect(ids1.filter((x) => ids2.includes(x))).toEqual([]);
    expect(ids1.length + ids2.length).toBe(3); // 3件が重複なく割り当てられる（別のテストのタスクがあっても、この候補は3件）
    // ワーカーが落ちた（リースの期限切れ）→ 次の実行で再取得される
    await new Promise((x) => setTimeout(x, 2300));
    const s = await runLinkRechecks({ db: db(), householdId: hid, gate: gate(), limit: 10, timeLeft: () => 60_000, fetchPage: async (u) => (u === U(0) ? ({ ok: false, code: "robots", message: "x" } as SafeFetchResult) : u === U(1) ? ({ ok: false, code: "http_error", status: 403, message: "x" } as SafeFetchResult) : ({ ok: false, code: "timeout", message: "x" } as SafeFetchResult)), onUpdated: async () => undefined });
    expect(s.claimed).toBeGreaterThanOrEqual(3);
    const t = await tasksOf(row.id);
    expect(t[0]).toMatchObject({ status: "gave_up" }); // robots は回避しない
    expect(t[1]).toMatchObject({ status: "gave_up" }); // 403 は回避しない
    expect(t[2]).toMatchObject({ status: "pending", last_error: "timeout" }); // 一時的な失敗は再試行
    expect(new Date(t[2].next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000); // バックオフ（5分〜）
    // 試行上限・期限: 上限に達した／期限が切れたタスクは取り出されず gave_up になる
    await admin.from("link_recheck_tasks").update({ attempts: 5, next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", t[2].id);
    await admin.rpc("link_recheck_claim", { p_limit: 5, p_lease_s: 60, p_now: new Date().toISOString() });
    expect((await tasksOf(row.id))[2]).toMatchObject({ status: "gave_up" });
    const { row: row2, ledger: l2 } = await mkCandidate([U(0)], POST);
    await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row2.id, ledger: l2, now: new Date() });
    await admin.from("link_recheck_tasks").update({ expires_at: new Date(Date.now() - 1000).toISOString(), next_attempt_at: new Date(Date.now() - 2000).toISOString() }).eq("candidate_id", row2.id);
    const c3 = await admin.rpc("link_recheck_claim", { p_limit: 5, p_lease_s: 60, p_now: new Date().toISOString() });
    expect(((c3.data ?? []) as any[]).some((x) => x.candidate_id === row2.id)).toBe(false);
    expect((await tasksOf(row2.id))[0]).toMatchObject({ status: "gave_up" }); // 期限切れ（情報が古い）
    // 実行時間が足りない: 始めず、試行回数を消費せず次の実行へ
    const { row: row3, ledger: l3 } = await mkCandidate([U(1)], POST);
    await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row3.id, ledger: l3, now: new Date() });
    await admin.from("link_recheck_tasks").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("candidate_id", row3.id);
    const d = await runLinkRechecks({ db: db(), householdId: hid, gate: gate(), limit: 10, timeLeft: () => 3_000, fetchPage: async (u) => okPage(u), onUpdated: async () => undefined });
    expect(d.deferred).toBeGreaterThanOrEqual(1);
    expect((await tasksOf(row3.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
  }, 60_000);

  it("②書き戻しの競合: 同じ候補へ2つのタスクを同時に戻しても、先に戻したページが失われない（楽観的排他）", async () => {
    const { row, ledger } = await mkCandidate([U(0), U(1)], POST);
    await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger, now: new Date() });
    await admin.from("link_recheck_tasks").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("candidate_id", row.id);
    const run = () => runLinkRechecks({ db: db(), householdId: hid, gate: gate(), limit: 1, timeLeft: () => 60_000, fetchPage: async (u) => okPage(u), onUpdated: async () => undefined });
    await Promise.all([run(), run()]);
    await run(); // 競合して再試行になったタスクを回収
    await admin.from("link_recheck_tasks").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("candidate_id", row.id).eq("status", "pending");
    await run();
    const ev = ((await admin.from("collection_candidates").select("last_good").eq("id", row.id).single()).data as any).last_good.evidence;
    expect(ev.linkedPages.map((p: any) => p.url).sort()).toEqual([U(0), U(1)]); // 両方が残る
  }, 60_000);

  it("②監査で発見: 古い再取得結果で、より新しい証拠を上書きしない／完了・諦めたタスクが再収集でまた未取得になったら、1時間後に再び対象にする", async () => {
    const { row, ledger } = await mkCandidate([U(0)], POST);
    await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger, now: new Date() });
    await admin.from("link_recheck_tasks").update({ next_attempt_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }).eq("candidate_id", row.id);
    // 証拠には、このタスクの取得時刻（過去の時刻を注入）より新しいページが既にある
    const ev0 = (row.last_good as any).evidence;
    const newer = { url: U(0), text: page0(), fetchedAt: new Date(Date.now() + 3600_000).toISOString(), fullChars: 100, truncated: false };
    await admin.from("collection_candidates").update({ last_good: { evidence: { ...ev0, linkedPages: [newer] } } as never }).eq("id", row.id);
    const old = new Date(Date.now() - 86_400_000);
    const s = await runLinkRechecks({ db: db(), householdId: hid, gate: gate(), limit: 5, timeLeft: () => 60_000, now: () => old, fetchPage: async (u) => okPage(u), onUpdated: async () => undefined });
    expect(s.done).toBe(1);
    const after = ((await admin.from("collection_candidates").select("last_good").eq("id", row.id).single()).data as any).last_good.evidence;
    expect(after.linkedPages[0].fetchedAt).toBe(newer.fetchedAt); // 新しい証拠が残る（古い再取得結果で上書きしない）
    expect(after.recheckSeq).toBeUndefined();
    // 完了したタスク: 直後の再登録では再開しない（連続登録の暴走を防ぐ）。1時間以上たてば、台帳がまだ未取得なら再び対象になる
    await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger, now: new Date() });
    expect((await tasksOf(row.id))[0].status).toBe("done");
    await admin.from("link_recheck_tasks").update({ done_at: new Date(Date.now() - 2 * 3600_000).toISOString() }).eq("candidate_id", row.id);
    await enqueueLinkRechecks({ db: db(), householdId: hid, candidateId: row.id, ledger, now: new Date() });
    expect(await tasksOf(row.id)).toMatchObject([{ status: "pending", attempts: 0 }]);
  }, 60_000);

  it("③保持期間の掃除: dry-run は何も消さない。古い版・ai_unverified・失敗の画像観察だけが対象で、最新版・human・保留中の候補の全文は残る", async () => {
    const { row } = await mkCandidate([U(0)], POST);
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const doc = (url_key: string, at: string, hash: string) => ({ household_id: hid, candidate_id: row.id, url: `https://x.example.invalid/${url_key}`, url_key, origin: "collector", kind: "page", content_hash: hash, fetched_at: at, text: "本文のテキスト。", text_chars: 8, source_chars: 8, truncated: false });
    const ins = await admin.from("evidence_documents").insert([doc("k1", old, "a".repeat(64)), doc("k1", new Date().toISOString(), "b".repeat(64))] as never);
    expect(ins.error).toBeNull();
    await admin.from("investigation_experiences").insert([
      { household_id: hid, host: "ret-test", features: ["a"], doc_chars: 1, found_buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], verification: "ai_unverified", source: "proposal_run", mode: "mock", recorded_at: old },
      { household_id: hid, host: "ret-test", features: ["a"], doc_chars: 1, found_buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], verification: "human", source: "human_review", mode: "mock", recorded_at: old },
    ]);
    await admin.from("evidence_image_observations").insert({ household_id: hid, candidate_id: row.id, image_url: "https://i.example.invalid/1.png", url_key: "i/1", image_index: 1, status: "failed", failure_reason: "not_found", readings: [], mode: "mock", observed_at: old });
    const dry = (await admin.rpc("phase2_retention_purge", { p_now: new Date().toISOString(), p_dry_run: true })).data as any;
    expect(dry.dry_run).toBe(true);
    expect(dry.evidence_documents_superseded).toBeGreaterThanOrEqual(1);
    expect(dry.experiences_ai_unverified).toBeGreaterThanOrEqual(1);
    expect(dry.image_observations).toBeGreaterThanOrEqual(1);
    const count = async (t: string) => {
      const q = admin.from(t).select("id", { count: "exact", head: true });
      return ((t === "investigation_experiences" ? await q.eq("host", "ret-test") : t === "evidence_documents" || t === "evidence_image_observations" ? await q.eq("candidate_id", row.id) : await q.eq("household_id", hid)).count ?? 0);
    };
    const before = { d: await count("evidence_documents"), e: await count("investigation_experiences"), i: await count("evidence_image_observations") };
    expect(before).toMatchObject({ d: 2, e: 2, i: 1 }); // dry-run: 何も消えていない
    const real = (await admin.rpc("phase2_retention_purge", { p_now: new Date().toISOString(), p_dry_run: false })).data as any;
    expect(real.dry_run).toBe(false);
    const left = (await admin.from("evidence_documents").select("content_hash").eq("candidate_id", row.id)).data as any[];
    expect(left.map((x) => x.content_hash)).toEqual(["b".repeat(64)]); // 最新版だけ残る
    const exps = (await admin.from("investigation_experiences").select("verification").eq("host", "ret-test")).data as any[];
    expect(exps.map((x) => x.verification)).toEqual(["human"]); // human は残る
    expect(await count("evidence_image_observations")).toBe(0);
    // 権限: 利用者（authenticated）は掃除を実行できない
    const u = await signInTestUser(admin, "p2dur", 2);
    userIds.push(u.userId);
    expect((await u.db.rpc("phase2_retention_purge" as never, { p_now: new Date().toISOString(), p_dry_run: false } as never)).error).not.toBeNull();
    expect((await u.db.rpc("fetch_gate_acquire" as never, { p_host: "x.example.invalid", p_min_interval_ms: 0, p_max_conc: 1, p_lease_ms: 1000, p_global_max: 1 } as never)).error).not.toBeNull();
  });
});
