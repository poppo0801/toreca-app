/**
 * Phase 2 P2 原因究明の統合テスト（ローカルのSupabase・擬似クライアント・費用0）。実AI・実Web・有料検索は使わない。
 * ①**検索が実際の通し経路（real-run → generate → runXPostReplay → 調査ループ）で届く**（P2 では cachedTools が検索ツールを落としていた）②検索の提示/実行の記録
 * ③本登録案なのに応募単位が未確定・根拠のない除外 は、保存された登録案で「要確認（検証の指摘）」になる（結論は書き換えない）④判断の出力の省略は成功と数えない。
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
import { runRealProposals } from "@/lib/server/proposals/real-run";
import type { CandidateRow } from "@/lib/server/proposals/generate";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const gate = () => checkJudgmentRealRun({ env: { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: "scripted-key-not-real" }, confirm: true, approvedTotalJpy: 25, approvedPerCaseJpy: 5 });
const URL_BASE = "https://p2rc.example.invalid";
const NOURL = "《新宿本店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111";
const page = (store: string) => `<html><body><h1 class="heading01">【${store}】拡張パック 抽選受付</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${store} 拡張パック</h4><p class="event-detail-ticket-card__text">受付</p></section>受付期間 11月30日まで お1人様1回のみ</body></html>`;

describe.skipIf(!dbTestsEnabled)("Phase 2 P2 原因: 検索の配線・未確定の本登録案・根拠なし除外・出力の省略", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;
  let u1: Db;
  let n = 0;
  const dir = mkdtempSync(join(tmpdir(), "p2rc-"));
  const addCandidate = async (text: string): Promise<CandidateRow> => {
    n++;
    const url = `${URL_BASE}/${n}`;
    const stored = buildEvidence({ url, kind: "x_post", post: { text, links: [] } }, new Date().toISOString());
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(930000000 + n), title: `rc-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const rows = async (id: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", id).order("item_no")).data ?? []) as Record<string, unknown>[];
  const found: string[] = [];
  const provider = (cost = 1.5) => ({ search: async (q: string) => (found.push(q), { hits: [{ title: "新宿本店 抽選", url: "https://shop-a.example.invalid/e/1", snippet: "拡張パック 抽選受付" }], costJpy: cost }) });
  const live = async (u: string): Promise<FetchOutcome> => (u.includes("shop-a") ? { ok: true, finalUrl: u, html: page("新宿本店"), text: "【新宿本店】拡張パック 抽選受付 新宿本店 拡張パック 受付 受付期間 11月30日まで お1人様1回のみ" } : { ok: false, reason: "not_public" });
  /** 検索→検索結果のURLを取得→止まる、という調査をする台本 */
  const searchPlan: ScriptedOptions["agentPlan"] = (excerpt, history) => {
    const url = /\[[^\]]*\] [^\n]*? (https:\/\/\S+)/.exec(excerpt)?.[1];
    if (history === 0 && url) return { kind: "fetch", url };
    if (history === 0) return { kind: "search", query: "新宿本店 拡張パック 抽選" };
    return { kind: "stop" };
  };
  const run = (c: CandidateRow, opts: ScriptedOptions, withSearch: boolean) => {
    const { client, calls } = scriptedAnthropic(opts);
    return runRealProposals({ db: admin as unknown as Db, householdId: hid, candidates: [c], client: client as never, gate: gate(), env: ENV, ...(withSearch ? { search: { provider: provider(), worstJpy: 2 } } : {}), liveFetch: live }).then((s) => ({ s, calls }));
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p2rc", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${URL_BASE}/%`);
    await cleanupTestUsers(admin, userIds);
    rmSync(dir, { recursive: true, force: true });
  });

  it("①URLなしの候補で、検索が実際に提示・実行され、検索結果のページへ進み、登録案に『検索経由』と費用（検索を含む）が残る。検索なしでは『検索が提示されなかった』が残る", async () => {
    const c = await addCandidate(NOURL);
    found.length = 0;
    const { s } = await run(c, { agentPlan: searchPlan }, true);
    expect(s.stopReason).toBe("completed");
    expect(found).toEqual(["新宿本店 拡張パック 抽選"]); // 検索が実際に実行された（P2 では 0 回）
    expect(s.search).toEqual({ notOffered: 0, offeredNotUsed: 0, used: 1 });
    const r = (await rows(c.id))[0];
    expect(r.stop_reason).toContain("searched:1");
    expect((r.pages as { host: string; viaSearch: boolean }[])[0]).toMatchObject({ host: "shop-a.example.invalid", viaSearch: true }); // 検索で見つけた候補を取得した
    expect((r.fields as Record<string, { value: string }>).store.value).toBe("新宿本店");
    expect(Number(r.cost_jpy)).toBeGreaterThan(1.5); // 検索の費用（1.5）が計上されている
    // 検索ツールなし: 提示されない（事実として記録）
    const c2 = await addCandidate(NOURL);
    const { s: s2 } = await run(c2, { agentPlan: searchPlan }, false);
    expect(s2.search).toEqual({ notOffered: 1, offeredNotUsed: 0, used: 0 });
    expect((await rows(c2.id))[0].stop_reason).toContain("search_not_offered");
    // 検索は提示されたが、AIが使わなかった（P2 の「AIが選ばなかった」はこの区別で観測する）
    const c3 = await addCandidate(NOURL);
    const { s: s3 } = await run(c3, {}, true);
    expect(s3.search).toEqual({ notOffered: 0, offeredNotUsed: 1, used: 0 });
  });

  it("②本登録案（register）なのに応募単位が未確定・根拠のない除外は、再評価の後も直らなければ『要確認（検証の指摘）』として保存される（結論は書き換えない）。応募単位を推定した本登録案は指摘されない", async () => {
    const withUrl = async () => {
      n++;
      const url = `${URL_BASE}/${n}`;
      const stored = buildEvidence({ url, kind: "x_post", post: { text: NOURL, links: [], linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }] }, linkedPages: [{ url: "https://shop-a.example.invalid/e/1", text: "【新宿本店】拡張パック 抽選受付 受付期間 11月30日まで お1人様1回のみ" }] }, new Date().toISOString());
      const { data } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(930000000 + n), title: `rc-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single();
      return data as CandidateRow;
    };
    // AUTONOMY_RESTORATION（V22）: 応募単位の形式を本登録の必須条件にしない。register・応募単位なしは、そのまま登録案（応募単位の未確定は確認事項として人が確かめる）
    const a = await withUrl();
    const ra = await run(a, { judgeDecisions: ["register", "register"] }, false);
    expect(ra.calls.filter((x) => x.kind === "submit_registration_judgment")).toHaveLength(1); // 止める指摘が無いので再評価しない
    const pa = (await rows(a.id))[0];
    expect(pa).toMatchObject({ decision: "register", verified: true });
    expect(pa.held_reasons ?? []).not.toContain("register_unit_unresolved");
    // 応募単位の未確定では再評価を求めないため、最初の判断（register）がそのまま採用される（以前は「再評価で暫定に直す」の経路だった）
    const b = await withUrl();
    await run(b, { judgeDecisions: ["register", "tentative"] }, false);
    expect(await rows(b.id)).toMatchObject([{ decision: "register", verified: true }]);
    // register・応募単位を推定（inferred）→ 指摘なし（再評価も不要）
    const c = await withUrl();
    const rc = await run(c, { judgeDecisions: ["register"], judgeUnit: "one_form_one" }, false);
    expect(rc.calls.filter((x) => x.kind === "submit_registration_judgment")).toHaveLength(1);
    expect(await rows(c.id)).toMatchObject([{ decision: "register", verified: true, apply_unit: "one_form_one", apply_unit_basis: "inferred" }]);
    // 取得できないまま exclude（根拠なし）→ 指摘（P2 の r10:2）
    const d = await addCandidate(NOURL);
    await run(d, { judgeDecisions: ["exclude", "exclude"] }, false);
    const pd = (await rows(d.id))[0];
    expect(pd).toMatchObject({ decision: "tentative", verified: false }); // 根拠のない除外も、最終の扱いは暫定（応募の機会を失わせない）
    expect(pd.held_reasons).toContain("exclude_without_evidence");
  });

  it("③判断の出力で fields が省略された項目は、判断の成功と数えない（内訳 defaulted・未確認事項に記録）。判断の理由が保存される", async () => {
    const c = await addCandidate(NOURL);
    const { s } = await run(c, { omitFields: true }, false);
    expect(s.judgments).toEqual({ ok: 0, defaulted: 1, failed: 0 });
    expect(Object.keys(s.diagnostics)).toContain("judge:fields_defaulted");
    const r = (await rows(c.id))[0];
    expect((r.unknowns as { what: string; why: string }[]).some((u) => u.what === "AIの判断" && u.why.includes("省略"))).toBe(true);
    expect((r.fields as Record<string, { value: string }>)._rationale.value).toContain("台本");
    // 通常の判断は ok、判断の不備は failed
    const c2 = await addCandidate(NOURL);
    expect((await run(c2, {}, false)).s.judgments).toEqual({ ok: 1, defaulted: 0, failed: 0 });
    const c3 = await addCandidate(NOURL);
    expect((await run(c3, { badJudge: true }, false)).s.judgments).toEqual({ ok: 0, defaulted: 0, failed: 1 });
  });
});
