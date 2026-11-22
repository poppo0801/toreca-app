/**
 * Stage 10Z: 通常収集の候補 → 新AI（費用ゼロのモック・注入）→ 登録案の保存 → 人のレビュー の統合テスト（ローカルのSupabase・RLS適用下）。実AI・実Web・X API は使わない。
 *   npm run test:db
 * 確認すること: ①収集が保存した構造（本文・linkMap・linkedPages）が新AIの入力へ正しく渡り、項目ごとに登録案ができる ②冪等（同じ入力で増えない）・入力が変わったときだけ新しい版
 * ③人のレビューは再評価で上書きされない（古い版へのレビューは不可） ④RLS・追記専用・サービス権限以外は書けない ⑤既定OFF（フラグ・本番では動かない）
 * ⑥lotteries・applications・購入・通知・候補の既存の内容を変えない ⑦未取得・根拠不足・URLなしの項目も候補に保持 ⑧同じ機会の可能性は示すが統合しない。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import type { AgentTurnOutput, JudgeOutput, RegistrationJudge, ResearchAgent } from "@/lib/judgment/xsource/research-loop";
import type { Db } from "@/lib/server/lottery-service";
import { generateProposalsForCandidate, mockDeps } from "@/lib/server/proposals/generate";
import { recordReview } from "@/lib/server/proposals/review";
import { loadProposals } from "@/lib/server/proposals/store";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { from: (t: string) => any };
const L = (db: unknown): Loose => db as Loose;
const ON = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const URL_BASE = "https://proposal10z.example.invalid";
const LIST = "【抽選まとめ】応募はお早めに 《新宿本店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222";
const page = (store: string, extra = "") => `【${store}】拡張パック 抽選受付\n受付期間 11月30日まで ${extra}`;

describe.skipIf(!dbTestsEnabled)("Stage 10Z: 収集候補 → 新AI → 登録案 → 人のレビュー（既存の記録・通知に触れない）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hidA: string;
  let hidB: string;
  let n = 0;

  const addCandidate = async (text: string, opts: { links?: string[]; linkMap?: { short: string; url: string }[]; pages?: { url: string; text: string }[]; postId?: string } = {}) => {
    n++;
    const url = `${URL_BASE}/${n}`;
    const stored = buildEvidence({ url, kind: "x_post", post: { text, links: opts.links ?? [], ...(opts.linkMap ? { linkMap: opts.linkMap } : {}) }, ...(opts.pages ? { linkedPages: opts.pages } : {}) }, new Date().toISOString());
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hidA, dedupe_key: url, source_url: url, x_post_id: opts.postId ?? String(900000000 + n), title: `t${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: { input: { store: { name: "元の店舗" } } } as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as { id: string; x_post_id: string; source_url: string; last_good: unknown };
  };
  const setEvidence = async (id: string, text: string, opts: Parameters<typeof addCandidate>[1]) => {
    const stored = buildEvidence({ url: `${URL_BASE}/x${id.slice(0, 4)}`, kind: "x_post", post: { text, links: opts?.links ?? [], ...(opts?.linkMap ? { linkMap: opts.linkMap } : {}) }, ...(opts?.pages ? { linkedPages: opts.pages } : {}) }, new Date().toISOString());
    await u1.from("collection_candidates").update({ last_good: { evidence: stored } as never }).eq("id", id);
    return (await u1.from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("id", id).single()).data as { id: string; x_post_id: string; source_url: string; last_good: unknown };
  };
  const counts = async () => {
    const c = async (t: string) => ((await admin.from(t).select("*", { count: "exact", head: true }).eq("household_id", hidA)).count ?? 0) as number;
    return { lotteries: await c("lotteries"), applications: await c("applications"), purchases: await c("purchases"), notifications: await c("notification_deliveries") };
  };
  const gen = (cand: Awaited<ReturnType<typeof addCandidate>>, deps = mockDeps(), env: Record<string, string | undefined> = ON) => generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hidA, candidate: cand, deps, env });
  const rowsOf = async (candId: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", candId).order("item_no").order("version")).data ?? []) as Record<string, unknown>[];

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10z", 1);
    const b = await signInTestUser(admin, "s10z", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hidA = (await u1.rpc("bootstrap_household")).data as string;
    hidB = (await u2.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${URL_BASE}/%`);
    await cleanupTestUsers(admin, userIds);
  });

  it("①収集の構造（本文・収集時の linkMap・linkedPages）が渡り、複数店舗の項目ごとに登録案ができる。項目自身のリンク由来と明示され、親の共通リンクは流用されない。既存の記録・候補は不変", async () => {
    const cand = await addCandidate(LIST, { links: ["https://shared.example.invalid/all"], linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }, { short: "https://t.co/bbb222", url: "https://shop-b.example.invalid/e/2" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }, { url: "https://shop-b.example.invalid/e/2", text: page("渋谷西口店") }] });
    const before = await counts();
    const candBefore = (await admin.from("collection_candidates").select("status,job_state,draft,lottery_id").eq("id", cand.id).single()).data;
    const r = await gen(cand);
    expect(r.ok).toBe(true);
    const rows = await rowsOf(cand.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => [x.item_no, x.url_status, x.mode, x.version])).toEqual([[1, "url_from_item", "mock", 1], [2, "url_from_item", "mock", 1]]);
    expect((rows[0].fields as Record<string, { value: string; basis: string }>).store).toMatchObject({ value: "新宿本店", basis: "observed" });
    expect((rows[1].fields as Record<string, { value: string }>).store.value).toBe("渋谷西口店"); // 別店舗のページを取り違えない
    expect(rows[0].source_urls).toEqual(["https://shop-a.example.invalid/e/1"]); // 項目自身のリンクだけ（共通リンクは保存しない）
    expect(rows[0].link_hosts).toEqual([{ host: "shop-a.example.invalid", origin: "item_entity" }, { host: "shared.example.invalid", origin: "parent_card" }]); // 親の共通リンクは「対応未確認」の出所つきのホスト名だけ。取得にも根拠にも使われない
    expect((rows[0].pages as { host: string }[]).map((p) => p.host)).toEqual(["shop-a.example.invalid"]);
    expect(rows.every((x) => x.decision !== "register")).toBe(true); // モックは本登録案を返さない
    expect(await counts()).toEqual(before);
    expect((await admin.from("collection_candidates").select("status,job_state,draft,lottery_id").eq("id", cand.id).single()).data).toEqual(candBefore);
  });

  it("②冪等: 同じ入力で再生成しても増えない。入力（取得したページ）が変わったときだけ新しい版が追加され、古い版は superseded になる（現行は項目ごとに1つ）", async () => {
    const cand = await addCandidate(LIST, { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }, { short: "https://t.co/bbb222", url: "https://shop-b.example.invalid/e/2" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }, { url: "https://shop-b.example.invalid/e/2", text: page("渋谷西口店") }] });
    await gen(cand);
    const again = await gen(cand);
    expect(again.ok && again.save).toMatchObject({ inserted: 0, unchanged: 2, superseded: 0 });
    expect(await rowsOf(cand.id)).toHaveLength(2);
    const changed = await setEvidence(cand.id, LIST, { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }, { short: "https://t.co/bbb222", url: "https://shop-b.example.invalid/e/2" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店", "応募条件が更新されました") }, { url: "https://shop-b.example.invalid/e/2", text: page("渋谷西口店") }] });
    const r = await gen(changed);
    expect(r.ok && r.save).toMatchObject({ inserted: 1, unchanged: 1, superseded: 1 });
    const rows = await rowsOf(cand.id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((x) => x.superseded_at === null)).toHaveLength(2); // 現行は項目ごとに1つ
    expect(rows.find((x) => x.item_no === 1 && x.version === 2)).toBeTruthy();
    // 古い版の内容は書き換えられない（トリガ）
    const old = rows.find((x) => x.item_no === 1 && x.version === 1)!;
    const upd = await admin.from("registration_proposals").update({ decision: "register" }).eq("id", old.id as string);
    expect(upd.error).not.toBeNull();
    // 現行の版は、収集の候補ごとに1つしか作れない（大量重複の防止）
    const dup = await admin.from("registration_proposals").insert({ ...(rows.find((x) => x.item_no === 2)!), id: undefined, version: 9, created_at: undefined });
    expect(dup.error).not.toBeNull();
  });

  it("③人のレビュー: 修正して承認の記録は残り、再評価（新しい版）で上書きされない。古い版へのレビューは拒否。承認しても抽選・応募・購入・通知は作られない", async () => {
    const pagesA = [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }];
    const cand = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111", { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }], pages: pagesA });
    await gen(cand);
    const v1 = (await rowsOf(cand.id))[0];
    const before = await counts();
    const rv = await recordReview({ db: u1, householdId: hidA, proposalId: v1.id as string, decision: "approve_with_edits", edits: { store: "新宿本店（東館）" }, note: "確認済み", env: ON });
    expect(rv).toEqual({ ok: true });
    expect(await counts()).toEqual(before); // 承認は新方式の登録案へのレビュー記録。登録・通知は作らない
    // 再評価（入力が変わる）→ 新しい版。人のレビューは残り、AIの値で上書きされない
    const changed = await setEvidence(cand.id, "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111", { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店", "条件変更") }] });
    await gen(changed);
    const view = (await loadProposals(u1, [cand.id]))[cand.id];
    expect(view).toHaveLength(1);
    expect(view[0].version).toBe(2);
    expect(view[0].review).toMatchObject({ decision: "approve_with_edits", edits: { store: "新宿本店（東館）" }, note: "確認済み" });
    expect(view[0].reviewOutdated).toBe(true); // 版が変わったので再確認が必要（レビューは消えない）
    expect(view[0].fields.store.value).toBe("新宿本店"); // AIの値は人の修正とは別に保持
    expect(await recordReview({ db: u1, householdId: hidA, proposalId: v1.id as string, decision: "hold", env: ON })).toEqual({ ok: false, reason: "not_current" });
    expect(await recordReview({ db: u1, householdId: hidA, proposalId: view[0].id, decision: "reject", note: "別の応募", env: ON })).toEqual({ ok: true });
    expect((await loadProposals(u1, [cand.id]))[cand.id][0].review?.decision).toBe("reject"); // 最新のレビュー
    expect(await recordReview({ db: u1, householdId: hidA, proposalId: view[0].id, decision: "approve", env: ON })).toEqual({ ok: false, reason: "invalid" });
    expect(await counts()).toEqual(before);
  });

  it("④RLS・権限: 別世帯・匿名は読めない。利用者は登録案を直接書けない・レビューを更新/削除できない・他人名義で追記できない", async () => {
    const cand = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 https://t.co/aaa111", { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }] });
    await gen(cand);
    const p = (await rowsOf(cand.id))[0];
    await recordReview({ db: u1, householdId: hidA, proposalId: p.id as string, decision: "hold", env: ON });
    expect((await L(u1).from("registration_proposals").select("id").eq("candidate_id", cand.id)).data).toHaveLength(1);
    expect((await L(u2).from("registration_proposals").select("id").eq("candidate_id", cand.id)).data).toHaveLength(0); // 別世帯
    expect((await L(u2).from("registration_proposal_reviews").select("id")).data).toHaveLength(0);
    expect((await L(anonClient()).from("registration_proposals").select("id")).data ?? []).toHaveLength(0);
    expect((await L(u1).from("registration_proposals").insert({ ...p, id: undefined, version: 5 })).error).not.toBeNull(); // 利用者は登録案を作れない
    expect((await L(u1).from("registration_proposals").update({ decision: "register" }).eq("id", p.id)).error ?? { x: 1 }).toBeTruthy();
    const review = (await admin.from("registration_proposal_reviews").select("id,decision").eq("proposal_id", p.id as string)).data![0];
    await L(u1).from("registration_proposal_reviews").update({ decision: "reject" }).eq("id", review.id);
    await L(u1).from("registration_proposal_reviews").delete().eq("id", review.id);
    expect((await admin.from("registration_proposal_reviews").select("decision").eq("id", review.id)).data![0].decision).toBe("hold"); // 更新・削除は効かない
    expect((await admin.from("registration_proposal_reviews").update({ decision: "reject" }).eq("id", review.id)).error).not.toBeNull(); // トリガ（サービス権限でも不可）
    const other = (await admin.auth.admin.listUsers({ perPage: 200 })).data.users.find((u) => u.id !== userIds[0])!.id;
    const spoof = await L(u1).from("registration_proposal_reviews").insert({ household_id: hidA, proposal_key: p.proposal_key, proposal_id: p.id, decision: "hold", reviewed_by: other });
    expect(spoof.error).not.toBeNull(); // 他人名義では追記できない
    const cross = await L(u2).from("registration_proposal_reviews").insert({ household_id: hidA, proposal_key: p.proposal_key, proposal_id: p.id, decision: "hold" });
    expect(cross.error).not.toBeNull(); // 別世帯の登録案へはレビューできない
    void hidB;
  });

  it("⑤既定OFF: フラグが無い・本番/Vercel の環境では何も生成・保存・レビューしない", async () => {
    const cand = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック https://t.co/aaa111", { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }] });
    for (const env of [{}, { TOREMANE_ENV: "local" }, { PROPOSAL_PREVIEW: "on" }, { ...ON, VERCEL: "1" }, { ...ON, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij.supabase.co" }, { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on" }]) {
      expect(await gen(cand, mockDeps(), env)).toEqual({ ok: false, reason: "disabled" });
    }
    expect(await rowsOf(cand.id)).toHaveLength(0);
    expect(await recordReview({ db: u1, householdId: hidA, proposalId: "00000000-0000-0000-0000-000000000000", decision: "hold", env: {} })).toEqual({ ok: false, reason: "disabled" });
    expect(await gen(cand, { ...mockDeps(), mode: "real" })).toEqual({ ok: false, reason: "disabled" }); // 実AIはこの入口では生成しない
  });

  it("⑥URLなし・短縮URL未展開・親の共通リンクだけ・取得不能・調査AIの例外でも、項目は候補に保持され、未確認事項が残る（応募単位は unknown）", async () => {
    const noUrl = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59", { links: [] });
    await gen(noUrl);
    const a = await rowsOf(noUrl.id);
    expect(a.map((x) => x.url_status)).toEqual(["url_missing", "url_missing"]);
    expect(a.every((x) => x.apply_unit === "unknown" && (x.unknowns as { what: string }[]).some((u) => u.what === "応募先URL"))).toBe(true);
    const shared = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選", { links: ["https://shared.example.invalid/all"], pages: [{ url: "https://shared.example.invalid/all", text: page("渋谷西口店") }] });
    await gen(shared);
    const s = await rowsOf(shared.id);
    expect(s.map((x) => x.url_status)).toEqual(["shared_only_unverified", "shared_only_unverified"]);
    expect(s.every((x) => (x.source_urls as string[]).length === 0)).toBe(true); // 共通リンクは項目へ流用しない
    const unexpanded = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 https://t.co/bbb222", { links: [] });
    await gen(unexpanded);
    expect((await rowsOf(unexpanded.id)).map((x) => x.url_status)).toEqual(["short_unexpanded", "short_unexpanded"]);
    // 取得不能（保存ページも無く、実取得も無い）＋調査AIが例外 → 判断が得られなくても行が残る
    const dead = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 https://t.co/aaa111", { linkMap: [{ short: "https://t.co/aaa111", url: "https://gone.example.invalid/e/9" }] });
    const boom: ResearchAgent = async () => { throw new Error("agent down"); };
    const r = await gen(dead, { ...mockDeps(), agent: boom });
    expect(r.ok).toBe(true);
    const d = await rowsOf(dead.id);
    expect(d).toHaveLength(1);
    expect(d[0].url_status).toBe("url_from_item");
    expect((d[0].unknowns as { what: string }[]).length).toBeGreaterThan(0);
    expect(d[0].pages).toEqual([]); // 取得できなかった（ページ無し）
    expect((d[0].fields as Record<string, { basis: string }>).store?.basis ?? "unknown").toBe("unknown"); // 根拠が無い項目を観察とは書かない
  });

  it("⑦応募単位はAIの出力をそのまま運ぶ（列挙に一致するときだけ採用）。店舗選択式／店舗別独立／同じ店舗・商品の別項目は『同じ機会の可能性』として示すだけで統合しない", async () => {
    const cand = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 https://t.co/aaa111 《新宿本店（東京）- 1件》 ・拡張パック 抽選 https://t.co/bbb222 《渋谷西口店（東京）- 1件》 ・別の商品 抽選 https://t.co/ccc333", { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }, { short: "https://t.co/bbb222", url: "https://shop-a.example.invalid/e/2" }, { short: "https://t.co/ccc333", url: "https://shop-b.example.invalid/e/3" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }, { url: "https://shop-a.example.invalid/e/2", text: page("新宿本店") }] });
    // 収集が保存する linkedPages は最大2件（既存の仕様）。3件目は開発限定の実取得（注入）で補う
    const body = "【渋谷西口店】別の商品 抽選受付 受付期間 11月30日まで";
    const live = async (u: string) => (u.endsWith("/e/3") ? ({ ok: true as const, finalUrl: u, html: "<html><body>" + body + "</body></html>", text: body }) : ({ ok: false as const, reason: "not_public" as const }));
    const agent: ResearchAgent = async (i): Promise<AgentTurnOutput> => {
      const own = /この項目自身のリンク: (https:\/\/\S+)/.exec(i.evidence[0]?.excerpt ?? "");
      return { observed: [], inferred: [], unknown: [], counterHypotheses: [], costJpy: 0, next: !i.history.length && own ? { kind: "fetch", url: own[1], why: "" } : { kind: "stop", reason: "sufficient", why: "" } };
    };
    const judge: RegistrationJudge = async (i): Promise<JudgeOutput> => {
      const pg = i.evidence.find((e) => e.kind === "page");
      const line = pg?.excerpt.split("\n")[0] ?? "";
      const unit = pg?.excerpt.includes("別の商品") ? "store_select" : "per_store";
      return { decision: "tentative", fields: { store: { value: /【(.+?)】/.exec(line)?.[1] ?? null, basis: "observed", evidenceId: pg?.id, quote: /【.+?】/.exec(line)?.[0] }, product: { value: line.replace(/^【[^】]*】/, "").trim(), basis: "observed", evidenceId: pg?.id, quote: line }, apply_unit: { value: unit, basis: "inferred" }, 応募単位メモ: { value: "不明な値", basis: "inferred" } }, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0 };
    };
    await gen(cand, { ...mockDeps(), agent, judge, mode: "replay", liveFetch: live });
    const rows = await rowsOf(cand.id);
    console.log("DBG3", JSON.stringify(rows[2].fields), JSON.stringify(rows[2].pages), rows[2].end_reason);
    expect(rows.map((x) => [x.item_no, x.apply_unit, x.apply_unit_basis, x.mode])).toEqual([[1, "per_store", "inferred", "replay"], [2, "per_store", "inferred", "replay"], [3, "store_select", "inferred", "replay"]]);
    expect(rows[0].possibly_same).toEqual([rows[1].proposal_key]); // 同じ店舗・商品の別項目は「可能性」
    expect(rows[1].possibly_same).toEqual([rows[0].proposal_key]);
    expect(rows[2].possibly_same).toEqual([]);
    expect(rows[0].proposal_key).not.toBe(rows[1].proposal_key); // 統合しない（別々の応募機会候補として残る）
    expect((rows[0].fields as Record<string, { support: string }>).product.support).toBe("literal_in_quote");
  });
});
