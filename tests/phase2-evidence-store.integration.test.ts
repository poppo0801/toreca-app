/**
 * Phase 2 証拠の保存・計測・人の修正の項目追従（ローカルのSupabase・擬似クライアント・費用0）。
 *  ①同じ見出し内で項目が入れ替わっても、人の修正は同じ本文の項目に付いて移る（項目番号では当てない）。項目が変わって合わない修正は未確認事項に残る
 *  ②evidence_documents / evidence_coverage_stats の権限: 構成員は読める・他世帯は読めない・利用者は書けない・更新できない（追記専用）・原文を含まない計測
 *  ③長文ページ（12,000字超）で、AIが read で読んだ範囲が判断AIに届き、計測に残る。ホスト別の傾向の要約は、サンプルが少ないうちは出さない
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { planXPost } from "@/lib/judgment/xsource/x-origin";
import { scriptedAnthropic, type ScriptedOptions } from "@/lib/judgment/xsource/scripted-client";
import type { FetchOutcome } from "@/lib/judgment/xsource/research-loop";
import type { Db } from "@/lib/server/lottery-service";
import { loadCoverageSummary } from "@/lib/server/proposals/evidence-store";
import { recordReview } from "@/lib/server/proposals/review";
import { runRealProposals } from "@/lib/server/proposals/real-run";
import type { CandidateRow } from "@/lib/server/proposals/generate";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const gate = () => checkJudgmentRealRun({ env: { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: "scripted-key-not-real" }, confirm: true, approvedTotalJpy: 25, approvedPerCaseJpy: 5 });
const URL_BASE = "https://evstore.example.invalid";
const PACK = "https://shop-a.example.invalid/e/pack";
const BOX = "https://shop-a.example.invalid/e/box";
const MAP = [{ short: "https://t.co/aaa111", url: PACK }, { short: "https://t.co/bbb222", url: BOX }];
const SAME_HEAD = "《新宿本店（東京）- 2件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 ・拡張BOX 抽選 11/30(月)23:59 https://t.co/bbb222 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/ccc333";
const SWAPPED = "《新宿本店（東京）- 2件》 ・拡張BOX 抽選 11/30(月)23:59 https://t.co/bbb222 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/ccc333";
const pages = [{ url: PACK, text: "【新宿本店】拡張パック 抽選受付 受付期間 11月30日まで" }, { url: BOX, text: "【新宿本店】拡張BOX 抽選受付 受付期間 11月30日まで" }];

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!dbTestsEnabled)("Phase 2 証拠の保存・計測・人の修正の項目追従", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;
  let hid2: string;
  let u1: Db;
  let u2: Db;
  let n = 0;
  const dir = mkdtempSync(join(tmpdir(), "evstore-"));
  const mk = (text: string, pgs: { url: string; text: string }[]) => buildEvidence({ url: `${URL_BASE}/${n}`, kind: "x_post", post: { text, links: [], linkMap: MAP }, linkedPages: pgs }, new Date().toISOString());
  const add = async (text: string, pgs = pages): Promise<CandidateRow> => {
    n++;
    const url = `${URL_BASE}/${n}`;
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(950000000 + n), title: `es-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: mk(text, pgs) } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const rows = async (id: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", id).is("superseded_at", null).order("item_no")).data ?? []) as Record<string, unknown>[];
  const run = (c: CandidateRow, opts: ScriptedOptions = {}, liveFetch: (u: string) => Promise<FetchOutcome> = async () => ({ ok: false, reason: "not_public" })) => {
    const { client, calls } = scriptedAnthropic(opts);
    const sent: { tools: string[]; text: string }[] = [];
    const orig = client.messages.create;
    client.messages.create = async (req, o) => {
      sent.push({ tools: (req.tools ?? []).map((t) => t.name), text: String((req.messages?.[0] as { content?: unknown } | undefined)?.content ?? "") });
      return orig(req, o);
    };
    return runRealProposals({ db: admin as unknown as Db, householdId: hid, candidates: [c], client: client as never, gate: gate(), env: ENV, liveFetch }).then((s) => ({ s, calls, sent }));
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "evst", 1);
    const b = await signInTestUser(admin, "evst", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${URL_BASE}/%`);
    await cleanupTestUsers(admin, userIds);
    rmSync(dir, { recursive: true, force: true });
  });

  it("①同じ見出し内の入れ替え: 項目の分割を確認し、人の修正は同じ本文の項目（BOX）に付いて移る。パックには移らない", async () => {
    expect(planXPost({ postId: "x", text: SAME_HEAD, links: [], linkMap: MAP, recordedAt: null }).items.map((i) => i.groupLabel)).toHaveLength(3);
    const c = await add(SAME_HEAD);
    await run(c);
    const box = (await rows(c.id)).find((r) => (r.fields as Record<string, { value: string }>).product.value.includes("BOX"))!;
    expect(box.item_no).toBe(2);
    expect(box.item_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(await recordReview({ db: u1, householdId: hid, proposalId: box.id as string, decision: "approve_with_edits", edits: { product: "拡張BOX（特別版）" }, note: "確認", env: ENV })).toEqual({ ok: true });
    // 入れ替え（BOXが1番・パックが2番）
    const { error } = await u1.from("collection_candidates").update({ last_good: { evidence: mk(SWAPPED, pages) } as never }).eq("id", c.id);
    expect(error).toBeNull();
    const c2 = (await u1.from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("id", c.id).single()).data as CandidateRow;
    await run(c2);
    const after = await rows(c.id);
    const f = (no: number) => after.find((r) => r.item_no === no)!.fields as Record<string, { value: string }>;
    expect(f(1).product.value).toBe("拡張BOX（特別版）"); // 修正は項目に付いて移った
    expect(f(2).product.value).not.toContain("特別版"); // 同じ見出しの別項目（パック）には移らない
  });

  it("②権限: 構成員は読める・他世帯は読めない・利用者は書けず更新もできない。計測行に原文・URLが無い。傾向の要約はサンプルが少ないと出さない", async () => {
    const c = await add(SAME_HEAD);
    await run(c);
    const docs = (await admin.from("evidence_documents").select("id,text,url").eq("candidate_id", c.id)).data ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(((await (u1 as unknown as { from: (t: string) => any }).from("evidence_documents").select("id").eq("candidate_id", c.id)).data ?? []).length).toBe(docs.length); // 構成員は読める
    expect(((await (u2 as unknown as { from: (t: string) => any }).from("evidence_documents").select("id").eq("candidate_id", c.id)).data ?? []).length).toBe(0); // 他世帯は読めない
    expect(((await (u2 as unknown as { from: (t: string) => any }).from("evidence_coverage_stats").select("id").eq("household_id", hid)).data ?? []).length).toBe(0);
    const ins = await (u1 as unknown as { from: (t: string) => any }).from("evidence_documents").insert({ household_id: hid, candidate_id: c.id, url: "https://x.example.invalid/", url_key: "x", content_hash: "a".repeat(32), fetched_at: new Date().toISOString(), text_chars: 1, text: "x" } as never);
    expect(ins.error).not.toBeNull(); // 利用者は書けない
    expect((await (u1 as unknown as { from: (t: string) => any }).from("evidence_coverage_stats").insert({ household_id: hid, host: "x", source_chars: 1, view_mode: "full", shown_chars: 1, fetch_outcome: "ok", mode: "mock" } as never)).error).not.toBeNull();
    // 更新はサービス権限でもできない（履歴・計測の改ざん防止）
    expect((await admin.from("evidence_documents").update({ text: "改ざん" }).eq("id", docs[0].id as string)).error).not.toBeNull();
    const st = (await admin.from("evidence_coverage_stats").select("id").eq("household_id", hid).limit(1)).data ?? [];
    expect(st.length).toBe(1);
    expect((await admin.from("evidence_coverage_stats").update({ host: "x" }).eq("id", st[0].id as string)).error).not.toBeNull();
    const all = JSON.stringify((await admin.from("evidence_coverage_stats").select("*").eq("household_id", hid)).data);
    expect(all).not.toContain("拡張パック"); // 原文なし
    expect(all).not.toContain("/e/pack"); // URLなし
    expect(await loadCoverageSummary(admin as unknown as Db, hid, 1000)).toEqual([]); // サンプル不足は出さない
    expect((await loadCoverageSummary(admin as unknown as Db, hid, 1)).length).toBeGreaterThan(0);
    expect(hid2).not.toBe(hid);
  });

  it("③長文: 保存した全文（12,000字超）のうち、AIが read で読んだ範囲が判断AIに届き、計測に参照の位置・字数が残る", async () => {
    const hidden = "当日は本人確認書類の提示が必要です。代理人の来店はご遠慮ください。";
    const filler = "◆開催概要と注意事項。".repeat(1500);
    const long = `【新宿本店】拡張パック 抽選受付\n${filler.slice(0, 7000)}\n${hidden}\n${filler.slice(7000)}`;
    const at = long.indexOf(hidden);
    const item = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111";
    const c = await add(item, [{ url: PACK, text: long }]);
    const full = (u: string): Promise<FetchOutcome> => Promise.resolve({ ok: true, finalUrl: u, html: `<html><body><p>${long.replace(/\n/g, "</p><p>")}</p></body></html>`, text: long });
    const { sent } = await run(c, { agentPlan: (excerpt, history) => (history === 0 ? { kind: "fetch", url: PACK } : { kind: "stop" }) }, full);
    const judge = sent.find((x) => x.tools[0] === "submit_registration_judgment")!;
    expect(judge.text).toContain("提示範囲:");
    expect(judge.text).toContain("目次（位置: 冒頭）");
    expect(judge.text).not.toContain("代理人の来店"); // 目印の語に無い文は、読まない限り届かない（未確認として明示される）
    expect(judge.text).toContain("未確認");
    // 保存された登録案には、未確認範囲が未確認事項として残る（記載が無いと誤読されない）
    const p = (await rows(c.id))[0];
    expect((p.unknowns as { what: string; why: string }[]).some((u) => u.what === "ページの未確認範囲")).toBe(true);
    expect(at).toBeGreaterThan(7000);
    // AIが目次を手掛かりに read で読む: 判断AIにその原文が届き、計測に位置・字数が残る
    const c3 = await add(item, [{ url: PACK, text: long }]);
    const reads = await run(c3, { agentPlan: (_e, history) => (history === 0 ? { kind: "fetch", url: PACK } : history === 1 ? { kind: "read", evidenceId: "p1", from: at - 100, chars: 400 } : { kind: "stop" }) }, full);
    const j3 = reads.sent.find((x) => x.tools[0] === "submit_registration_judgment")!;
    expect(j3.text).toContain("代理人の来店はご遠慮ください");
    expect(j3.text).toMatch(/参照した原文（\d+〜\d+字目）/);
    const st = ((await admin.from("evidence_coverage_stats").select("reads,read_chars,first_read_at,view_mode").eq("household_id", hid).gt("reads", 0)).data ?? []) as { reads: number; read_chars: number; first_read_at: number }[];
    expect(st.some((x) => x.reads === 1 && x.read_chars === 400 && x.first_read_at === at - 100)).toBe(true);
  });

  it("④収集時の文脈: 本文の切り詰め・画像の読み取りは、AIの入力に『観察』として届き（引用の根拠にはならない）、登録案の未確認事項に残る。画像の内容が無いときも未確認と明示される", async () => {
    const longPost = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・拡張BOX 抽選 11/30(月)23:59 https://t.co/ccc333 " + "お知らせ。".repeat(3000);
    n++;
    const url = `${URL_BASE}/${n}`;
    const ev = buildEvidence({ url, kind: "x_post", post: { text: longPost, links: [], linkMap: MAP, images: ["https://pbs.example.invalid/1.jpg", "https://pbs.example.invalid/2.jpg"] }, linkedPages: pages, imageReadings: [{ field: "applyDeadline", text: "締切 11/30 23:59", source: "画像1枚目", imageIndex: 1, kind: "ai_reading", verified: null, uncertainty: "high" } as never] }, new Date().toISOString());
    expect(ev?.truncated).toBe(true);
    const { data } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(950000000 + n), title: `es-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: ev } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single();
    const c = data as CandidateRow;
    const { sent } = await run(c);
    const judge = sent.find((x) => x.tools[0] === "submit_registration_judgment")!;
    expect(judge.text).toContain("【収集時の注記】この投稿の本文は収集時の保存で上限に切り詰められており");
    expect(judge.text).toContain("画像から読み取った情報");
    expect(judge.text).toContain("applyDeadline=締切 11/30 23:59");
    const r = (await rows(c.id))[0];
    expect((r.unknowns as { what: string }[]).some((u) => u.what === "投稿の欠落")).toBe(true);
    // 画像があるのに読み取りが無い: 画像の内容は未確認
    n++;
    const url2 = `${URL_BASE}/${n}`;
    const ev2 = buildEvidence({ url: url2, kind: "x_post", post: { text: SAME_HEAD, links: [], linkMap: MAP, images: ["https://pbs.example.invalid/1.jpg"] }, linkedPages: pages }, new Date().toISOString());
    const d2 = (await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url2, source_url: url2, x_post_id: String(950000000 + n), title: `es-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: ev2 } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single()).data as CandidateRow;
    await run(d2);
    expect(((await rows(d2.id))[0].unknowns as { what: string }[]).some((u) => u.what === "画像の内容")).toBe(true);
  });
});
