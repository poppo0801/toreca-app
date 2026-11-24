/**
 * Phase 2: 同条件比較試験の基盤（ローカルDB・モック・費用0）。**結果は精度ではなく、試験の仕組みの確認**（claim=pipeline_check_only）。架空の案件・架空のgoldのみ。
 *  ①links: 旧方式（先頭の1リンク）と新方式（全リンク）が、同じ案件から作られ、旧方式では2件目以降の機会が見つからず、新方式では見つかる。goldはAIへの入力に混ざらない
 *  ②text_depth: 旧方式は抜粋だけ（全文を保存しない）・新方式は全文を保存する／image: 画像の有無だけが違う／hints: 学習の有無だけが違う（対照群は経験を書かない）
 *  ③モックの結果は精度として主張されない。goldが足りなければ inconclusive
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import { armsOf, splitCalibration, validateGold, type CompareCase, type GoldCase } from "@/lib/judgment/xsource/compare-eval";
import type { Db } from "@/lib/server/lottery-service";
import { CMP_HOST, prepareArmCandidates, runExperimentMock, seedGoldExperiences } from "@/lib/server/proposals/compare-run";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const S = ["https://shop-a.example.invalid/e/1", "https://shop-b.example.invalid/e/2", "https://shop-c.example.invalid/e/3"];
const SHOPS = ["新宿本店", "渋谷店", "大阪店"];
const POST = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222 《大阪店（大阪）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/ccc333";
const page = (shop: string, filler = 0) => `【${shop}】拡張パック 抽選受付\n受付期間 11月30日まで\n${"案内文です。".repeat(filler)}お一人様1回まで。${shop}の店頭受取のみ。`;

const mkCase = (n: number, o: Partial<CompareCase> = {}): CompareCase => ({
  caseId: `cmpc${n}`,
  postText: POST,
  links: [],
  linkMap: [{ short: "https://t.co/aaa111", url: S[0] }, { short: "https://t.co/bbb222", url: S[1] }, { short: "https://t.co/ccc333", url: S[2] }],
  pages: SHOPS.map((s, i) => ({ url: S[i], text: page(s, 700) })), // 約4,200字（旧方式の3,000字抜粋では「お一人様1回まで」が切れる）
  imageRefs: [],
  imageReadings: [],
  ...o,
});
const mkGold = (n: number): GoldCase => ({
  caseId: `cmpc${n}`,
  canary: `CANARY-CMP-GOLD-${n}-QQ`,
  verified: { by: "human", at: "2026-11-24", basis: "公式ページを人が目視で確認（架空のテスト用）" },
  opportunities: SHOPS.map((s, i) => ({ oppId: `o${i}`, store: s, product: "拡張パック", applyEnd: "2026-11-30", region: null, url: S[i], applyUnit: null, decision: "register" as const, evidenceIn: ["page" as const], pageIndex: i, evidence: [{ where: `page:${i}`, quote: "受付期間 11月30日まで" }] })),
});

describe.skipIf(!dbTestsEnabled)("Phase 2: 同条件比較試験の基盤（モック・仕組みの確認）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;
  beforeAll(async () => {
    const a = await signInTestUser(admin, "p2cmp", 1);
    userIds.push(a.userId);
    hid = (await a.db.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${CMP_HOST}/%`);
    await admin.from("investigation_experiences").delete().eq("household_id", hid);
    await cleanupTestUsers(admin, userIds);
  });
  const db = () => admin as unknown as Db;

  it("①links: 旧方式は先頭の1リンクだけ・新方式は全リンク。旧方式は2件目以降の機会を見つけられない。モックの結果は精度として主張せず、gold が少なければ inconclusive。gold は入力に混ざらない", async () => {
    const cases = [mkCase(1), mkCase(2)];
    const gold = [mkGold(1), mkGold(2)];
    expect(validateGold(gold).ok).toBe(true);
    const r = await runExperimentMock({ db: db(), householdId: hid, experiment: "links", cases, gold, env: ENV });
    // 同じ案件から、アームごとに候補が作られる（比較対象以外は同じ入力）
    expect(r.prepared).toHaveLength(4);
    const ev = (arm: string) => (r.prepared.find((p) => p.caseId === "cmpc1" && p.arm.id === arm)!.candidate.last_good as { evidence: { linkedPages: unknown[]; text: string } }).evidence;
    expect(ev("links.first_only").linkedPages).toHaveLength(1);
    expect(ev("links.all").linkedPages).toHaveLength(3);
    expect(ev("links.first_only").text).toBe(ev("links.all").text);
    // 取りこぼし: 旧方式は1件目の機会だけ・新方式は3件
    const found = (role: "baseline" | "treatment") => r.scores[role].map((s) => s.oppFound);
    expect(found("baseline")).toEqual([1, 1]);
    expect(found("treatment")).toEqual([3, 3]);
    expect(r.comparison.deltas.find((d) => d.metric === "oppRecall")!.improvement).toBeGreaterThan(0.5);
    expect(r.comparison.deltas.filter((d) => d.critical).every((d) => !d.regressed)).toBe(true);
    // 各登録案は自分の店舗のページだけを根拠にする（混入なし）
    expect(r.scores.treatment.every((s) => s.crossContamination === 0 && s.invalidQuotes === 0)).toBe(true);
    // 読み飛ばしの切り分け: 旧方式は2件目以降のページを収集していない／新方式は全て収集・保存・AI入力に届き、短いページは全文が提示範囲に入る
    expect(r.readAudit.baseline.byStage.not_collected).toBe(4); // 2案件×（2件目・3件目）
    expect(r.readAudit.treatment.byStage.not_collected).toBe(0);
    expect(r.readAudit.treatment.byStage.seen_ok + r.readAudit.treatment.byStage.seen_wrong).toBe(6);
    expect(r.claim).toBe("pipeline_check_only"); // モックの結果は精度ではない
    expect(r.comparison.verdict).toBe("inconclusive"); // gold が2件しかない
    expect(r.goldLeak).toEqual({ ok: true, leaks: [] });
    // 上限・切り詰めの監査が毎回記録される（記録の無い欠落が無い）
    expect(r.limitAudit.level).not.toBe("fail");
    expect(r.limitAudit.report.silentLoss).toEqual([]);
    expect(r.limitAudit.report.candidates).toBe(4);
  });

  it("②text_depth: 旧方式は抜粋だけで全文を保存しない／新方式は全文を保存する。画像・ヒントは比較対象以外同じ", async () => {
    const cases = [mkCase(3)];
    const prepared = await prepareArmCandidates({ db: db(), householdId: hid, experiment: "text_depth", cases, now: new Date().toISOString() });
    const [b, t] = prepared;
    const docs = async (id: string) => (await admin.from("evidence_documents").select("id", { count: "exact", head: true }).eq("candidate_id", id)).count ?? 0;
    expect(await docs(b.candidate.id)).toBe(0);
    expect(await docs(t.candidate.id)).toBe(4); // 投稿本文＋3ページ
    expect(b.pages[0].text.length).toBe(3000);
    expect(t.pages[0].text.length).toBeGreaterThan(4000);
    // image: 画像の有無だけ
    const withImg = mkCase(4, { imageRefs: ["https://img.example.invalid/1.png"], imageReadings: [{ field: "応募期間", text: "11/30まで", imageIndex: 1, uncertainty: "low" }] });
    const im = await prepareArmCandidates({ db: db(), householdId: hid, experiment: "image", cases: [withImg], now: new Date().toISOString() });
    const evi = (p: (typeof im)[number]) => (p.candidate.last_good as { evidence: { imageRefs?: string[]; linkedPages: unknown[] } }).evidence;
    expect(evi(im[0]).imageRefs ?? []).toEqual([]);
    expect(evi(im[1]).imageRefs).toEqual(["https://img.example.invalid/1.png"]);
    expect(evi(im[0]).linkedPages).toHaveLength(evi(im[1]).linkedPages.length);
    expect(armsOf("image").map((a) => a.vision)).toEqual([false, true]);
  });

  it("③hints: 対照群（学習なし）は経験を書かず、学習ありは書く。入力は同じ", async () => {
    const before = (await admin.from("investigation_experiences").select("id", { count: "exact", head: true }).eq("household_id", hid)).count ?? 0;
    const r = await runExperimentMock({ db: db(), householdId: hid, experiment: "hints", cases: [mkCase(5)], gold: [mkGold(5)], env: ENV });
    const after = (await admin.from("investigation_experiences").select("id", { count: "exact", head: true }).eq("household_id", hid)).count ?? 0;
    expect(after).toBeGreaterThan(before); // 学習ありのアームだけが経験を書く
    const exp = (await admin.from("investigation_experiences").select("candidate_id").eq("household_id", hid)).data ?? [];
    const ctrl = r.prepared.find((p) => p.arm.id === "hints.off")!.candidate.id;
    const trt = r.prepared.find((p) => p.arm.id === "hints.on")!.candidate.id;
    expect(exp.some((e) => e.candidate_id === ctrl)).toBe(false);
    expect(exp.some((e) => e.candidate_id === trt)).toBe(true);
    expect(r.claim).toBe("pipeline_check_only");
  });

  it("④hints の公平性: ヒントの元の経験は校正用の案件の gold（人の確認）から作り、評価用の案件には使わない。ヒントは学習ありのアームにだけ出る", async () => {
    const longPage = (shop: string) => `${page(shop)}
${"ナビゲーション ".repeat(1800)}
【重要】${shop}では会員証の提示が必要です。1人1回の応募。`;
    const mk = (n: number): CompareCase => mkCase(n, { pages: [{ url: S[0], text: longPage("新宿本店") }, { url: S[1], text: page("渋谷店") }, { url: S[2], text: page("大阪店") }] });
    const goldWithQuote = (n: number): GoldCase => ({ ...mkGold(n), opportunities: mkGold(n).opportunities.map((o, i) => (i === 0 ? { ...o, evidence: [{ where: "page:0", quote: "【重要】新宿本店では会員証の提示が必要です。" }] } : o)) });
    const all = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(mk);
    const { calibration, evaluation } = splitCalibration(all, 0.5);
    expect(calibration.length).toBeGreaterThan(0);
    expect(evaluation.length).toBeGreaterThan(0);
    expect(calibration.map((c) => c.caseId).filter((id) => evaluation.some((e) => e.caseId === id))).toEqual([]); // 重複しない
    // 校正用（gold付き）から検証済みの経験を作る（評価用には使わない）
    const calGold = calibration.map((c) => goldWithQuote(Number(c.caseId.replace("cmpc", ""))));
    const seeded = await seedGoldExperiences({ db: db(), householdId: hid, cases: calibration, gold: calGold, at: new Date().toISOString() });
    expect(seeded).toBeGreaterThanOrEqual(1);
    const exps = (await admin.from("investigation_experiences").select("verification,source,features,host").eq("household_id", hid).eq("source", "gold_eval")).data ?? [];
    expect(exps.length).toBe(seeded);
    expect(JSON.stringify(exps)).not.toContain("会員証"); // 原文を含まない
    // 評価用の案件で比較: ヒントは学習ありのアームにだけ出る（verified が足りるまで経験を足す）
    for (let i = 0; i < 4; i++) await seedGoldExperiences({ db: db(), householdId: hid, cases: calibration, gold: calGold, at: new Date().toISOString() });
    const hintsBy: Record<string, number> = {};
    const r = await runExperimentMock({
      db: db(),
      householdId: hid,
      experiment: "hints",
      cases: evaluation.slice(0, 1),
      gold: evaluation.slice(0, 1).map((c) => goldWithQuote(Number(c.caseId.replace("cmpc", "")))),
      env: ENV,
      extraDeps: (arm) => ({
        agent: async (i) => {
          for (const e of i.evidence) hintsBy[arm.id] = (hintsBy[arm.id] ?? 0) + (e.hintWindows?.length ?? 0);
          return mockResearchAgent(i);
        },
      }),
    });
    expect(hintsBy["hints.off"] ?? 0).toBe(0);
    expect(hintsBy["hints.on"] ?? 0).toBeGreaterThan(0);
    expect(r.claim).toBe("pipeline_check_only");
  });
});
