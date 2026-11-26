/**
 * Phase 2（UI改修後）: 収集→全文保存→AI調査→登録案→人のレビュー→次回調査への反映 の全経路（ローカルのSupabase・モック・費用0。実AI・Web・X APIは呼ばない）。
 *  ①複数店舗の投稿: 3店舗のリンク先本文が欠けず保存され、各登録案は自分の店舗のページだけを根拠にする（混ざらない）。切り詰められた抜粋の後半は全文で補われる
 *  ②画像: 収集時の読み取りの無い画像だけをビジョン（モック）で解析し、結果は仮説として観察に渡る。本文と矛盾したら矛盾として残る。同じ画像は再解析しない
 *  ③調査経験: AIの観察だけでは提案に使われず、人の確認（レビュー）の経験が積み上がると「最初に見せる位置」が次の調査に反映される。全文の参照可能性は変わらない
 *  ④権限: 経験・画像解析・全文は構成員だけが読める。AI由来の経験は利用者が書けない。更新できない
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import { mockVision } from "@/lib/judgment/xsource/image-evidence";
import type { Db } from "@/lib/server/lottery-service";
import { documentsFromCollected } from "@/lib/server/proposals/collected-store";
import { persistCollectedDocuments } from "@/lib/server/proposals/collected-store";
import { rememberFullPages } from "@/lib/server/collector/collected-docs";
import { loadBestDocument } from "@/lib/server/proposals/evidence-store";
import { loadExperiences } from "@/lib/server/proposals/experience-store";
import { generateProposalsForCandidate, mockDeps, type CandidateRow } from "@/lib/server/proposals/generate";
import { recordReview, recordTruth } from "@/lib/server/proposals/review";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const BASE = "https://p2post.example.invalid";
const S = ["https://shop-a.example.invalid/e/1", "https://shop-b.example.invalid/e/2", "https://shop-c.example.invalid/e/3"];
const MAP = [{ short: "https://t.co/aaa111", url: S[0] }, { short: "https://t.co/bbb222", url: S[1] }, { short: "https://t.co/ccc333", url: S[2] }];
const POST = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222 《大阪店（大阪）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/ccc333";
const pageText = (shop: string, filler = 0) => `【${shop}】拡張パック 抽選受付\n受付期間 11月30日まで\n${"案内文です。".repeat(filler)}お一人様1回まで。${shop}の店頭受取のみ。`;

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!dbTestsEnabled)("Phase 2（UI改修後）: 全経路", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;
  let hid2: string;
  let u1: Db;
  let u2: Db;
  let n = 0;
  const add = async (text: string, linkedPages: { url: string; text: string; fullChars?: number; truncated?: boolean }[], extra: Record<string, unknown> = {}): Promise<CandidateRow> => {
    n++;
    const url = `${BASE}/${n}`;
    const ev = buildEvidence({ url, kind: "x_post", post: { text, links: [], linkMap: MAP }, linkedPages, ...extra } as never, new Date().toISOString());
    const { data, error } = await admin.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(960000000 + n), title: `p2-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: ev } as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const proposals = async (id: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", id).is("superseded_at", null).order("item_no")).data ?? []) as Record<string, any>[];

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p2post", 1);
    const b = await signInTestUser(admin, "p2post", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${BASE}/%`);
    await admin.from("investigation_experiences").delete().eq("household_id", hid);
    await cleanupTestUsers(admin, userIds);
  });

  it("①複数店舗: 3店舗のリンク先が欠けず保存され、各登録案は自分の店舗のページだけを根拠にする。切り詰められた抜粋の後半は、収集時に保存した全文で補える", async () => {
    // 3店舗のうち1店舗のページは長い（収集時の抜粋では後半の「お一人様1回まで」が切れる）
    const longText = pageText("新宿本店", 1500);
    const c = await add(POST, [
      { url: S[0], text: longText },
      { url: S[1], text: pageText("渋谷店") },
      { url: S[2], text: pageText("大阪店") },
    ]);
    const ev = (c.last_good as any).evidence;
    expect(ev.linkedPages).toHaveLength(3); // 以前は先頭2件まで
    expect(ev.linkedPages[0].truncated).toBe(true);
    expect(ev.linkedPages[0].text.length).toBeLessThan(longText.length);
    expect(ev.linkedPages[0].fullChars).toBe(longText.length);
    // 収集時の全文保存（run.ts が呼ぶ接続口と同じ処理）
    const q = {};
    rememberFullPages(q, [
      { url: S[0], finalUrl: S[0], title: "a", text: longText, truncated: false, fetchedAt: new Date().toISOString(), depth: 0, origins: ["link_map"] },
      { url: S[1], finalUrl: S[1], title: "b", text: pageText("渋谷店"), truncated: false, fetchedAt: new Date().toISOString(), depth: 0, origins: ["link_map"] },
      { url: S[2], finalUrl: S[2], title: "c", text: pageText("大阪店"), truncated: false, fetchedAt: new Date().toISOString(), depth: 0, origins: ["link_map"] },
    ]);
    const saved = await persistCollectedDocuments(admin as unknown as Db, hid, c.id, q, { postUrl: c.source_url!, postText: POST, nowIso: new Date().toISOString() });
    expect(saved).toEqual({ saved: 4, existing: 0, failed: 0 }); // 投稿本文＋3ページ
    expect(await persistCollectedDocuments(admin as unknown as Db, hid, c.id, q, { postUrl: c.source_url!, postText: POST, nowIso: new Date().toISOString() })).toMatchObject({ saved: 0, existing: 4 }); // 冪等
    const full = await loadBestDocument(admin as unknown as Db, hid, c.id, S[0]);
    expect(full?.text).toContain("お一人様1回まで"); // 抜粋の外にある後半も、全文にある
    expect(full?.text.length).toBe(longText.length);
    expect(full?.truncated).toBe(false);

    const r = await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c, env: ENV, deps: mockDeps() });
    expect(r.ok).toBe(true);
    const rows = await proposals(c.id);
    expect(rows).toHaveLength(3);
    // 各項目は自分のリンクのページだけを根拠にし、他店のページ・本文は混ざらない
    rows.forEach((row, i) => {
      expect(row.source_urls).toEqual([S[i]]);
      const quote = String(row.fields.product?.quote ?? "");
      const shop = ["新宿本店", "渋谷店", "大阪店"][i];
      expect(quote).toContain("拡張パック");
      expect(JSON.stringify(row.fields)).not.toMatch(new RegExp(["新宿本店", "渋谷店", "大阪店"].filter((x) => x !== shop).join("|")));
    });
  });

  it("②画像: 読み取りの無い画像だけをビジョンで解析し、仮説として観察に渡す。本文と矛盾したら矛盾として残る。同じ画像は再解析しない（重複課金なし）", async () => {
    const IMG1 = "https://pbs.example.invalid/m/p2-1.jpg";
    const IMG2 = "https://pbs.example.invalid/m/p2-2.jpg";
    const c = await add(POST.replace("11/30(月)23:59", "詳細は画像"), [{ url: S[0], text: pageText("新宿本店") }, { url: S[1], text: pageText("渋谷店") }, { url: S[2], text: pageText("大阪店") }], {
      imageRefs: [IMG1, IMG2],
      imageReadings: [{ field: "対象店舗", text: "新宿本店", source: "画像1枚目", imageIndex: 1, kind: "ai_reading", verified: null, uncertainty: "medium", readAt: new Date().toISOString() }],
    });
    const calls: { imageIndex: number }[] = [];
    const seen: string[] = [];
    const agent: typeof mockResearchAgent = async (i) => {
      seen.push(JSON.stringify(i.evidence.map((e) => e.observations)));
      return mockResearchAgent(i);
    };
    const vision = mockVision({ [IMG2]: [{ field: "応募期間", text: "12/20 23:59まで", uncertainty: "low" }] }, calls as never);
    const r = await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c, env: ENV, deps: mockDeps({ agent, vision }) });
    expect(r.ok && r.storage.images).toMatchObject({ images: 2, reused: 1, analyzed: 1 });
    expect(calls.map((x) => x.imageIndex)).toEqual([2]); // 収集時に読み取り済みの画像1は再解析しない
    const all = seen.join("\n");
    expect(all).toMatch(/画像2枚目\(IMG2-[0-9a-f]{6,8}\)・応募期間/);
    expect(all).toContain("矛盾・未確定"); // リンク先の本文の日付（11月30日）と画像の12/20が食い違う
    expect(all).toContain("どちらも確認済みとしない");
    const obs = (await admin.from("evidence_image_observations").select("*").eq("candidate_id", c.id)).data ?? [];
    expect(obs).toHaveLength(1); // 解析した画像2だけ
    // 2回目: 保存済みの解析結果を再利用（ビジョンを呼ばない）
    calls.length = 0;
    await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c, env: ENV, deps: mockDeps({ agent, vision }) });
    expect(calls).toHaveLength(0);
    // 本文と矛盾する日付: 矛盾として残り、どちらも確認済みにならない
    const c2 = await add(POST, [{ url: S[0], text: pageText("新宿本店") }], { imageRefs: [IMG1], imageReadings: [] });
    seen.length = 0;
    await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c2, env: ENV, deps: mockDeps({ agent, vision: mockVision({ [IMG1]: [{ field: "applyDeadline", text: "12/25 23:59" }] }) }) });
    expect(seen.join("\n")).toContain("矛盾・未確定");
  });

  it("③調査経験: AIの観察だけでは提案に使わず、人の確認の経験が積み上がると『最初に見せる位置』が次の調査に反映される（全文の参照は変わらない）", async () => {
    const hints: string[] = [];
    const agent: typeof mockResearchAgent = async (i) => {
      for (const e of i.evidence) if (e.hintWindows?.length) hints.push(...e.hintWindows);
      return mockResearchAgent(i);
    };
    // 長いページ（抜粋の外＝約13,000字目）に重要条件がある店
    const longPage = (shop: string) => `${pageText(shop)}\n${"ナビゲーション ".repeat(1800)}\n【重要】${shop}では会員証の提示が必要です。1人1回の応募。`;
    // 収集時に全文を保存する（抜粋は先頭6,000字。全文は12,000字超＝長文表示になり、ヒントの対象になる）
    const mkc = async (shop: string) => {
      const c = await add(POST, [{ url: S[0], text: longPage(shop) }, { url: S[1], text: pageText("渋谷店") }, { url: S[2], text: pageText("大阪店") }]);
      const q = {};
      rememberFullPages(q, [{ url: S[0], finalUrl: S[0], title: "", text: longPage(shop), truncated: false, fetchedAt: new Date().toISOString(), depth: 0, origins: ["link_map"] }]);
      await persistCollectedDocuments(admin as unknown as Db, hid, c.id, q, { postUrl: c.source_url!, postText: null, nowIso: new Date().toISOString() });
      return c;
    };
    const c0 = await mkc("新宿本店");
    const docs = documentsFromCollected({ pages: [{ url: S[0], finalUrl: S[0], title: "", text: longPage("新宿本店"), truncated: false, fetchedAt: new Date().toISOString(), depth: 0, origins: ["link_map"] }], postUrl: c0.source_url!, postText: null, postFetchedAt: new Date().toISOString() });
    expect(docs[0].textChars).toBeGreaterThan(12_000); // 12,000字超の長文
    // 経験が無い: ヒントは出ない
    await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c0, env: ENV, deps: mockDeps({ agent }) });
    expect(hints).toHaveLength(0);
    // 1回目の調査はAIの観察だけの経験（ai_unverified）を残す。内容は原文・URLを含まない
    const exp1 = (await admin.from("investigation_experiences").select("*").eq("household_id", hid)).data ?? [];
    const ai = exp1.filter((x) => x.verification === "ai_unverified");
    expect(JSON.stringify(exp1)).not.toContain("会員証");
    expect(JSON.stringify(exp1)).not.toContain("/e/1");
    // AIの観察だけを大量に積んでも、検証済みが無ければ提案しない（自己強化の防止）
    for (let i = 0; i < 6; i++) await admin.from("investigation_experiences").insert({ household_id: hid, host: "shop-a.example.invalid", features: ai[0]?.features ?? ["host:shop-a.example.invalid"], doc_chars: 14000, found_buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], verification: "ai_unverified", source: "proposal_run", mode: "mock", recorded_at: new Date().toISOString() });
    await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c0, env: ENV, deps: mockDeps({ agent }) });
    expect(hints).toHaveLength(0);
    // 人の確認の経験（検証済み）が積み上がる: 利用者のセッションで、正解の記録（正しい＝全項目を確認）をしたときだけ（ADAPTIVE_REVIEW: 修正して承認は未編集の項目を確認したとは限らないため経験にしない）
    const rows = await proposals(c0.id);
    for (const row of rows) await recordReview({ db: u1, householdId: hid, proposalId: row.id, decision: "approve_with_edits", edits: {}, note: "確認", env: ENV });
    expect(((await admin.from("investigation_experiences").select("id").eq("household_id", hid).eq("verification", "human")).data ?? []).length).toBe(0);
    for (const row of rows) expect(await recordTruth({ db: u1, householdId: hid, proposalId: row.id, verdict: "correct", env: ENV })).toMatchObject({ ok: true });
    const human = (await admin.from("investigation_experiences").select("*").eq("household_id", hid).eq("verification", "human")).data ?? [];
    expect(human.length).toBeGreaterThanOrEqual(1);
    expect(human[0].source).toBe("human_review");
    // 同じ構造のページの経験を検証済みとして補い（独立した確認の積み上げの代わり）、次の調査への反映を確かめる
    for (let i = 0; i < 6; i++) await admin.from("investigation_experiences").insert({ household_id: hid, host: "shop-a.example.invalid", features: human[0].features, doc_chars: 14000, found_buckets: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0], verification: i % 2 ? "human" : "gold", source: i % 2 ? "human_review" : "gold_eval", mode: "mock", recorded_at: new Date().toISOString() });
    expect((await loadExperiences(admin as unknown as Db, hid)).length).toBeGreaterThan(10);
    const c1 = await mkc("新宿本店");
    await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c1, env: ENV, deps: mockDeps({ agent }) });
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.join("")).toContain("仮説");
    // 対照群（学習なし）: ヒントは出ず、経験も追記しない
    const before = (await admin.from("investigation_experiences").select("id").eq("household_id", hid)).data?.length ?? 0;
    hints.length = 0;
    await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: await mkc("新宿本店"), env: ENV, deps: mockDeps({ agent, learn: false }) });
    expect(hints).toHaveLength(0);
    expect((await admin.from("investigation_experiences").select("id").eq("household_id", hid)).data?.length).toBe(before);
  });

  it("④権限: 構成員は読める・他世帯は読めない・AI由来の経験は利用者が書けない（人の確認の経験だけ可）・更新できない", async () => {
    const from = (db: Db, t: string) => (db as unknown as { from: (t: string) => any }).from(t);
    expect(((await from(u1, "investigation_experiences").select("id").eq("household_id", hid)).data ?? []).length).toBeGreaterThan(0);
    expect(((await from(u2, "investigation_experiences").select("id").eq("household_id", hid)).data ?? []).length).toBe(0); // 他世帯は読めない
    const base = { host: "x", features: ["host:x"], doc_chars: 100, found_buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], mode: "mock", recorded_at: new Date().toISOString() };
    expect((await from(u1, "investigation_experiences").insert({ ...base, household_id: hid, verification: "ai_unverified", source: "proposal_run" })).error).not.toBeNull(); // AI由来は書けない
    expect((await from(u1, "investigation_experiences").insert({ ...base, household_id: hid, verification: "gold", source: "human_review" })).error).not.toBeNull(); // gold は書けない
    expect((await from(u2, "investigation_experiences").insert({ ...base, household_id: hid, verification: "human", source: "human_review" })).error).not.toBeNull(); // 他世帯へは書けない
    expect((await from(u1, "investigation_experiences").insert({ ...base, household_id: hid, verification: "human", source: "human_review" })).error).toBeNull(); // 人の確認は書ける
    const one = (await admin.from("investigation_experiences").select("id").eq("household_id", hid).limit(1)).data![0];
    expect((await admin.from("investigation_experiences").update({ host: "y" }).eq("id", one.id)).error).not.toBeNull(); // 更新不可（サービス権限でも）
    expect((await admin.from("evidence_image_observations").update({ mode: "real" }).eq("household_id", hid)).error).not.toBeNull();
    expect(((await from(u2, "evidence_image_observations").select("id").eq("household_id", hid)).data ?? []).length).toBe(0);
    expect(hid2).not.toBe(hid);
  });
});
