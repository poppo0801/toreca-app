/**
 * Phase 2 E2E 整合性の監査（ローカルのSupabase・擬似クライアント・費用0）。実AI・実Web・有料検索・X API は使わない。
 * 入口 runRealProposals → generateProposalsForCandidate → runXPostReplay → cachedTools → runResearch を通し、**各段階の入出力が一致するか**を確認する。
 *  ①複数店舗の項目: 項目Aの証拠（ページ・店舗名）が項目Bの調査・判断の入力に流れない（AIへ実際に送られた内容で確認）。AIに渡るツールは許可された2つだけ
 *  ②人の修正は、レビューした項目と同じ項目にだけ適用される（再収集で項目の並びが変わっても別の店舗へ移らない）
 *  ③同じ候補の同時実行・再実行で、現行の登録案が重複しない／長文ページの後半の応募条件が判断の入力まで届く
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { scriptedAnthropic, type ScriptedOptions } from "@/lib/judgment/xsource/scripted-client";
import type { FetchOutcome } from "@/lib/judgment/xsource/research-loop";
import type { Db } from "@/lib/server/lottery-service";
import { recordReview } from "@/lib/server/proposals/review";
import { runRealProposals } from "@/lib/server/proposals/real-run";
import type { CandidateRow } from "@/lib/server/proposals/generate";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const gate = () => checkJudgmentRealRun({ env: { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: "scripted-key-not-real" }, confirm: true, approvedTotalJpy: 25, approvedPerCaseJpy: 5 });
const URL_BASE = "https://e2eaudit.example.invalid";
const A_URL = "https://shop-a.example.invalid/e/1";
const B_URL = "https://shop-b.example.invalid/e/2";
const pageA = (extra = "") => `【新宿本店】拡張パック 抽選受付 MARKER-A-7731 受付期間 11月30日まで ${extra}`;
const pageB = (extra = "") => `【渋谷西口店】拡張パック 抽選受付 MARKER-B-9914 受付期間 11月30日まで ${extra}`;
const AB = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222";
const BA = "《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222 《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111";
const MAP = [{ short: "https://t.co/aaa111", url: A_URL }, { short: "https://t.co/bbb222", url: B_URL }];

describe.skipIf(!dbTestsEnabled)("Phase 2 E2E監査: 項目の対応・人の修正の対応・ツール・長文・同時実行", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;
  let u1: Db;
  let n = 0;
  const dir = mkdtempSync(join(tmpdir(), "e2eaudit-"));
  const mk = (text: string, pages: { url: string; text: string }[], linkMap = MAP) => buildEvidence({ url: `${URL_BASE}/${n}`, kind: "x_post", post: { text, links: [], linkMap }, linkedPages: pages }, new Date().toISOString());
  const addCandidate = async (text: string, pages: { url: string; text: string }[]): Promise<CandidateRow> => {
    n++;
    const url = `${URL_BASE}/${n}`;
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(940000000 + n), title: `ea-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: mk(text, pages) } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const reevidence = async (c: CandidateRow, text: string, pages: { url: string; text: string }[]): Promise<CandidateRow> => {
    await u1.from("collection_candidates").update({ last_good: { evidence: mk(text, pages) } as never }).eq("id", c.id);
    return (await u1.from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("id", c.id).single()).data as CandidateRow;
  };
  const rows = async (id: string, onlyCurrent = false) => {
    let q = admin.from("registration_proposals").select("*").eq("candidate_id", id).order("item_no").order("version");
    if (onlyCurrent) q = q.is("superseded_at", null);
    return ((await q).data ?? []) as Record<string, unknown>[];
  };
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
    const a = await signInTestUser(admin, "e2ea", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${URL_BASE}/%`);
    await cleanupTestUsers(admin, userIds);
    rmSync(dir, { recursive: true, force: true });
  });

  it("①複数店舗: 各項目の調査・判断の入力に、他の項目のページ・店舗は入らない。AIに渡るツールは調査/判断の提出用だけ", async () => {
    const c = await addCandidate(AB, [{ url: A_URL, text: pageA() }, { url: B_URL, text: pageB() }]);
    const { s, sent } = await run(c);
    expect(s.stopReason).toBe("completed");
    // 送信内容を、項目（案件ID #1=新宿 / #2=渋谷）ごとに分ける
    const of = (no: number) => sent.filter((x) => x.text.startsWith(`案件ID: ${c.x_post_id}#${no}\n`));
    expect(of(1).length).toBeGreaterThanOrEqual(2); // 調査＋判断
    expect(of(2).length).toBeGreaterThanOrEqual(2);
    for (const x of of(1)) {
      expect(x.text).not.toContain("MARKER-B-9914");
      expect(x.text).not.toContain("shop-b.example");
    }
    for (const x of of(2)) {
      expect(x.text).not.toContain("MARKER-A-7731");
      expect(x.text).not.toContain("shop-a.example");
    }
    expect(of(1).some((x) => x.text.includes("MARKER-A-7731"))).toBe(true); // 自分のページは届いている
    expect(of(2).some((x) => x.text.includes("MARKER-B-9914"))).toBe(true);
    // ツール: 許可された提出用の1つだけ（書き込み・実行・投稿のツールが混ざらない）。同一性の照合（JUDGMENT_IDENTITY_EFFICIENCY）も提出用のツールだけ
    for (const x of sent) expect(["submit_research_turn", "submit_registration_judgment", "submit_identity_judgment"]).toContain(x.tools.join(","));
    // 保存された登録案も項目どおり
    const r = await rows(c.id, true);
    expect(r.map((x) => (x.fields as Record<string, { value: string }>).store.value)).toEqual(["新宿本店", "渋谷西口店"]);
    expect(r.map((x) => (x.source_urls as string[])[0])).toEqual([A_URL, B_URL]);
  });

  it("②人の修正は、レビューした項目にだけ適用される。再収集で項目の並びが入れ替わっても修正は同じ項目に付いて移り、別の店舗へは移らない（同じ並びなら従来どおり適用）", async () => {
    const c = await addCandidate(AB, [{ url: A_URL, text: pageA() }, { url: B_URL, text: pageB() }]);
    await run(c);
    const v1 = (await rows(c.id, true)).find((x) => x.item_no === 2)!;
    expect((v1.fields as Record<string, { value: string }>).store.value).toBe("渋谷西口店");
    expect(await recordReview({ db: u1, householdId: hid, proposalId: v1.id as string, decision: "approve_with_edits", edits: { store: "渋谷西口店（東館）" }, note: "確認", env: ENV })).toEqual({ ok: true });
    // 同じ並びで再評価（入力のページが変わる）→ 人の値が渋谷の項目に使われる
    const same = await reevidence(c, AB, [{ url: A_URL, text: pageA() }, { url: B_URL, text: pageB("条件変更") }]);
    await run(same);
    const cur = await rows(c.id, true);
    expect((cur.find((x) => x.item_no === 2)!.fields as Record<string, { value: string }>).store.value).toBe("渋谷西口店（東館）");
    expect((cur.find((x) => x.item_no === 1)!.fields as Record<string, { value: string }>).store.value).toBe("新宿本店");
    // 並びが入れ替わる（渋谷が1番・新宿が2番）。項目2＝新宿に、渋谷への修正が移ってはならない
    const swapped = await reevidence(c, BA, [{ url: A_URL, text: pageA() }, { url: B_URL, text: pageB("条件変更") }]);
    await run(swapped);
    const after = await rows(c.id, true);
    // 人の修正は項目に付いて移る（項目の識別子で照合）。渋谷の項目は番号が1に変わっても渋谷への修正を持ち、新宿の項目には移らない
    expect(after.find((x) => x.item_no === 1)!.fields).toMatchObject({ store: { value: "渋谷西口店（東館）" } });
    expect(after.find((x) => x.item_no === 2)!.fields).toMatchObject({ store: { value: "新宿本店" } });
  });

  it("③長文ページ: 抜粋より後ろ（約4,000字目）にある応募条件の文が、調査・判断の入力に位置つきで届く。同じ候補の同時実行でも現行の登録案は重複しない", async () => {
    const filler = "◆開催概要と注意事項。".repeat(1800); // 約3,600字
    const long = `【新宿本店】拡張パック 抽選受付 受付期間 11月30日まで ${filler} 抽選を希望する店舗を選んで応募してください。お1人様1回までです。`;
    const item = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111";
    const full = (u: string): Promise<FetchOutcome> => Promise.resolve({ ok: true, finalUrl: u, html: `<html><body><p>${long}</p></body></html>`, text: long });
    // (a) 取得が許されている: 収集時の保存本文は抜粋（6,000字）で切り詰められているので、最新の全文が優先され、後半の条件が届く
    const c = await addCandidate(item, [{ url: A_URL, text: long }]);
    const stored = (c.last_good as { evidence: { linkedPages: { text: string }[] } }).evidence.linkedPages[0].text;
    expect(stored.length).toBe(6000); // 収集の保存境界（抜粋の上限）での切り詰めを確認（lp/4 の約3,981字目はこの時点で失われる）
    expect(stored).not.toContain("抽選を希望する店舗を選んで");
    const { sent } = await run(c, {}, full);
    const judge = sent.find((x) => x.tools[0] === "submit_registration_judgment")!;
    expect(judge.text).toContain("抜粋より後ろの応募条件の記載");
    expect(judge.text).toContain("抽選を希望する店舗を選んで");
    expect(judge.text).toMatch(/（\d{4,6}字目〜）/);
    // 取得した全文は保存される（収集時の3,000字ではなく全文）。取得を許さない再処理でも、保存した全文から同じ条件が届く
    const docs = ((await admin.from("evidence_documents").select("text_chars,truncated,url_key").eq("candidate_id", c.id)).data ?? []) as { text_chars: number; truncated: boolean }[];
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs.some((d) => d.text_chars > 19_000 && !d.truncated)).toBe(true);
    const again = await run(c);
    const j2 = again.sent.find((x) => x.tools[0] === "submit_registration_judgment")!;
    expect(j2.text).toContain("抽選を希望する店舗を選んで");
    expect(j2.text).not.toContain("切り詰められており");
    const stats = ((await admin.from("evidence_coverage_stats").select("host,view_mode,source_chars,truncated").eq("household_id", hid).eq("view_mode", "indexed")).data ?? []) as { host: string; source_chars: number }[];
    expect(stats.some((x) => x.host === "shop-a.example.invalid" && x.source_chars > 19_000)).toBe(true); // 原文・URLを含まない計測
    // (b) 取得できない: 切り詰められた保存本文を使い、「後半は確認できない」と明示する（無いのではなく確認できない）
    const c1 = await addCandidate(item, [{ url: A_URL, text: long }]);
    const { sent: sent1 } = await run(c1);
    const j1 = sent1.find((x) => x.tools[0] === "submit_registration_judgment")!;
    expect(j1.text).not.toContain("抽選を希望する店舗を選んで");
    expect(j1.text).toContain("先頭6000字（全文");
    expect(j1.text).toContain("に切り詰められており、後半は確認できない（無いのではなく未確認）");
    // 同時実行: ロックまたは冪等で、現行の登録案は項目ごとに1件
    const c2 = await addCandidate(AB, [{ url: A_URL, text: pageA() }, { url: B_URL, text: pageB() }]);
    await Promise.allSettled([run(c2), run(c2)]);
    const cur = await rows(c2.id, true);
    expect(cur.map((x) => x.item_no).sort()).toEqual([1, 2]);
    const all = await rows(c2.id);
    expect(new Set(all.map((x) => `${x.proposal_key}:${x.version}`)).size).toBe(all.length);
  });
});
