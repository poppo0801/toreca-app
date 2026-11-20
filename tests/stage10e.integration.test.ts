/**
 * Stage 10E の結合テスト（実Supabase・ローカルDB・架空データ。AI・外部通信なし＝台本のモデル）:
 * 判断履歴の保存→検索→次の入力への再利用、履歴保護の統合（lotteryProtection と共通の保護）、エンジンの追記。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetPools } from "@/lib/judgment/budget";
import { buildJudgmentInput } from "@/lib/judgment/build-input";
import { judgeCase } from "@/lib/judgment/engine";
import { mockAnswer } from "@/lib/judgment/eval/mock-answers";
import { loadCases, inputFor } from "@/lib/judgment/eval/replay";
import { ScriptedModel } from "@/lib/judgment/model";
import { createCase, recordJudgment, searchJudgments } from "@/lib/server/case-foundation";
import { historyFromDb, sinkToDb } from "@/lib/server/judgment-history";
import { lotteryProtection } from "@/lib/server/master-identity/reeval-service";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";
import { mkApplication } from "./helpers/application";

describe.skipIf(!dbTestsEnabled)("Stage 10E: 判断履歴の再利用・履歴保護の統合", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let chain: string;
  const NOW = "2099-01-20T00:00:00.000Z";

  const mkLottery = async (over: Record<string, unknown> = {}) =>
    (await u1.from("lotteries").insert({ household_id: hid, chain_id: chain, apply_deadline_precision: "date_only", apply_deadline_date: "2099-01-10", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "auto", registration_path: "auto", ...over } as never).select("id").single()).data!.id as string;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10e", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    chain = (await u1.from("chains").insert({ household_id: hid, name: "サンプル電機" }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("判断はエンジンから判断履歴へ追記され、次の入力へ戻る（保存だけで終わらない）。人の修正が先頭・訂正された判断は戻らない", async () => {
    const c = loadCases().cases.find((x) => x.id === "J07")!;
    const lot = await mkLottery();
    const cs = (await createCase(u1, { householdId: hid, title: "J07" })) as { ok: true; id: string };
    const input = { ...(await inputFor(c, NOW)), caseId: cs.id, related: [{ lotteryId: lot, chain: "サンプル電機", store: "渋谷店", products: [], applyDeadline: null, storeMode: "fixed" as const, protectedCodes: [] }] };
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J07", i), costJpy: 0.4 }));
    const r = await judgeCase({ model, budget: new BudgetPools({ judgment: 50, investigation: 50, discovery: 50 }), sink: sinkToDb(u1), householdId: hid }, input);
    expect(r.status).toBe("accepted");

    const saved = await searchJudgments(u1, { householdId: hid, caseId: cs.id });
    expect(saved.length).toBeGreaterThanOrEqual(3);
    const dl = saved.find((x) => x.subject === "O1.applyDeadline")!;
    expect(dl).toMatchObject({ claim_basis: "fact", model_id: "scripted-test-double", evidence_status: "fetched" });

    // 人が訂正する（元のAI判断を訂正）。次の入力では、人の修正が先頭で、訂正されたAI判断は戻らない
    await recordJudgment(u1, { householdId: hid, caseId: cs.id, kind: "correction", subject: "O1.applyDeadline", claimBasis: "fact", judgeKind: "human", correctionOf: dl.id as string, correctionSource: "human", value: "2099-03-12" });
    const next = await buildJudgmentInput({ caseId: cs.id, title: "J07", now: new Date(NOW), evidence: input.evidence.map((e) => ({ url: e.url, via: e.via, text: e.text, status: e.status, hash: e.hash })), related: input.related, masters: [], failures: [], regionPrefectures: [], history: historyFromDb(u1, hid) });
    expect(next.priorJudgments[0]).toMatchObject({ judgeKind: "human", value: "2099-03-12", subject: "O1.applyDeadline" });
    expect(next.priorJudgments.some((p) => p.id === dl.id)).toBe(false);
    // モデルがその入力を受け取って使える（再利用の経路）
    let seen = 0;
    const m2 = new ScriptedModel((i) => { seen = i.priorJudgments.length; return { raw: mockAnswer("J07", i), costJpy: 0.1 }; });
    await judgeCase({ model: m2, budget: new BudgetPools({ judgment: 50, investigation: 50, discovery: 50 }) }, next);
    expect(seen).toBeGreaterThan(0);
  });

  it("別の世帯・別の案件の判断は、入力に混ざらない（世帯の分離）", async () => {
    const other = (await createCase(u1, { householdId: hid, title: "別案件" })) as { ok: true; id: string };
    await recordJudgment(u1, { householdId: hid, caseId: other.id, kind: "field", subject: "x", claimBasis: "fact", judgeKind: "human", value: "別案件の値" });
    const inp = await buildJudgmentInput({ caseId: null, title: "t", now: new Date(NOW), evidence: [], related: [], masters: [], failures: [], regionPrefectures: [], history: historyFromDb(u1, hid) });
    expect(inp.priorJudgments).toEqual([]);
  });

  it("履歴保護の統合: lotteryProtection は従来の基準に加えて共通の保護（手動分類・除外・Xブックマーク）も見る。従来の保護は変わらない", async () => {
    const plain = await mkLottery();
    expect(await lotteryProtection(u1, plain)).toBeNull();
    const withApp = await mkLottery();
    await mkApplication(u1, hid, chain, withApp);
    expect(await lotteryProtection(u1, withApp)).toBe("応募・当落の記録あり");
    // 従来の基準では保護されない（自動登録・確認なし）が、手動で分類された抽選は、共通の保護で守られる
    const manualForm = await mkLottery({ lottery_form: "store_select", lottery_form_source: "manual" });
    expect(await lotteryProtection(u1, manualForm)).toBe("抽選形態を利用者が手動で分類済み");
    const a = await mkLottery();
    const b = await mkLottery();
    await u1.from("lottery_exclusions" as never).insert({ household_id: hid, lottery_id: a, reason: "duplicate", duplicate_of_lottery_id: b } as never);
    expect(await lotteryProtection(u1, a)).toBe("利用者が重複候補から除外した記録あり");
    expect(await lotteryProtection(u1, "00000000-0000-0000-0000-000000000000")).toBe("抽選が見つかりません");
  });

  it("エンジンの判断追記が保護された抽選に触れない: 検証で不合格の提案（保護された抽選の削除）は履歴に『不採用』として残り、抽選は変わらない", async () => {
    const lot = await mkLottery();
    await mkApplication(u1, hid, chain, lot);
    const c = loadCases().cases.find((x) => x.id === "J12")!;
    const cs = (await createCase(u1, { householdId: hid })) as { ok: true; id: string };
    const input = { ...(await inputFor(c, NOW)), caseId: cs.id, related: [{ lotteryId: lot, chain: "サンプル電機", store: "新宿店", products: [], applyDeadline: null, storeMode: "fixed" as const, protectedCodes: ["applications"] }] };
    const model = new ScriptedModel((i) => {
      const a = JSON.parse(JSON.stringify(mockAnswer("J12", i)));
      a.relations[0].lotteryId = lot;
      a.plannedChanges = [{ lotteryId: lot, op: "delete", reason: "原文の指示" }];
      return { raw: a, costJpy: 0.1 };
    });
    const r = await judgeCase({ model, budget: new BudgetPools({ judgment: 50, investigation: 50, discovery: 50 }), sink: sinkToDb(u1), householdId: hid, maxRetries: 0 }, input);
    expect(r.status).toBe("partial");
    const rows = await searchJudgments(u1, { householdId: hid, caseId: cs.id, kind: "reeval" });
    expect(rows.some((x) => String(x.value).includes("検証で不採用"))).toBe(true);
    expect(((await u1.from("lotteries").select("id").eq("id", lot)).data ?? []).length).toBe(1);
    expect(((await u1.from("applications").select("id").eq("lottery_id", lot)).data ?? []).length).toBe(1);
  });
});
