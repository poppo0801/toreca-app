/* eslint-disable @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に含まれない */
/**
 * Stage 9H-3S-2 の結合テスト（実Supabase・RLS適用下。AI・外部サイトは台本で差し替え。費用0円）:
 * 固定ロジックの暫定判定は、AIが実際の情報源を調べて確認するまで適用しない／取得できなかった調査は「調査済み」にしない／
 * 情報元から確認できた空欄の日付だけを補完する／締切が延長されていれば期限切れとしない／店舗の実所在地は確認済みのときだけ蓄積し、地域内なら除外しない。 npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { ResearchOutcome } from "@/lib/agent/store-location/run";
import { EMPTY_CLASSIFY_CTX } from "@/lib/agent/case-investigator/source-class";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";
import { runAiReevaluation } from "@/lib/server/agent/reeval-ai-run";
import type { AiDeps } from "@/lib/server/agent/reeval-ai-service";
import { applyReevalBatch, createReevalPlan, revertReevalBatch } from "@/lib/server/master-identity/reeval-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const flex = (offset: number) => ({ precision: "date_only" as const, date: day(offset), time: "" });

const field = (f: string, adopted: string | null, state = "confirmed") => ({ field: f, label: f, adopted, state, independentOrigins: 1, hasPrimary: true, sources: adopted ? [{ url: "https://official.example.test/a", kind: "organizer_official", tier: "primary", quote: `${f}は${adopted}`, at: "2026-11-18T00:00:00Z" }] : [], alternatives: [] as { value: string; sources: string[] }[] });
const result = (id: string, o: { fetched: boolean; fields?: ReturnType<typeof field>[]; extra?: ReturnType<typeof field>[] }): CaseInvestigationResult =>
  ({ caseId: id, status: o.fetched ? "completed" : "failed", stopReason: "sufficient", stopLabel: "", aiFinish: null, fields: o.fields ?? [], extraFields: o.extra ?? [], extras: [], sources: o.fetched ? [{ url: "https://official.example.test/a", kind: "organizer_official", tier: "primary", status: "fetched", fetchedAt: "", origin: "official.example.test", derivedFrom: null, contributed: [], quotes: {} }] : [{ url: "https://x.example.test", kind: "other", tier: "secondary", status: "failed", failKind: "http_error", failReason: "404", fetchedAt: "", origin: "x", derivedFrom: null, contributed: [], quotes: {} }], steps: [], queries: ["q"], fetched: [], unreported: [], notMerged: [], usage: {}, injectionFlags: 0, followUps: 0, policyChanges: [] }) as unknown as CaseInvestigationResult;

describe.skipIf(!dbTestsEnabled)("Stage 9H-3S-2: 自律型AIによる再調査・再判定（台本のAI）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainA: string;
  let prodA: string;
  let storeOsaka: string;
  let storeTokyoMis: string; // 登録上は東京都だが、実際は大阪府（AIが公式情報で確認 → 地域内）
  let storeTokyoReal: string; // 登録も実際も東京都
  const L: Record<string, string> = {};
  let spent = 0;
  const calls: string[] = [];
  let batchId: string;

  const input = (storeId: string, deadline: number, extra: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId: chainA, storeId, campaignId: null, newCampaign: null, items: [{ productId: prodA, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX, applyDeadline: flex(deadline), resultDate: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: ["https://official.example.test/a"], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "", isManaged: false, ...extra,
  });
  const mk = async (name: string, storeId: string, deadline: number, extra: Partial<LegacyInput> = {}) => {
    const r = await saveLottery(u1, hid, null, input(storeId, deadline, extra), profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    const id = (r as { value: { id: string } }).value.id;
    await admin.from("lotteries").update({ source_kind: "auto", registration_path: "auto" }).eq("id", id);
    L[name] = id;
  };

  const deps: AiDeps = {
    model: "test",
    classify: EMPTY_CLASSIFY_CTX,
    capJpy: 100,
    spentJpy: () => spent,
    stopped: () => null,
    investigate: async (t) => {
      calls.push(`investigate:${t.id}`);
      spent += 8;
      if (t.id === L.failed) return result(t.id, { fetched: false });
      if (t.id === L.extended) return result(t.id, { fetched: true, fields: [field("applyDeadline", day(10))] });
      if (t.id === L.expired) return result(t.id, { fetched: true, fields: [field("applyDeadline", day(-20)), field("applyStart", day(-30)), field("resultDate", day(-15))], extra: [field("chain", "あおぞら書店")] });
      if (t.id === L.missing) return result(t.id, { fetched: true, fields: [field("applyDeadline", day(10)), field("applyStart", day(-1)), field("resultDate", day(15))] });
      return result(t.id, { fetched: true, fields: [] });
    },
    research: async (s) => {
      calls.push(`research:${s.name}`);
      spent += 5;
      const pref = s.name === "実は大阪店" ? "大阪府" : "東京都";
      return { result: { status: "confirmed", prefecture: pref, city: null, address: `${pref}テスト区1-2-3`, lat: null, lng: null, confidence: 90, sources: [{ url: "https://official.example.test/stores", quote: `${pref}テスト区1-2-3`, official: true, domain: "official.example.test" }], reasons: [], candidates: [], officialSites: [] } } as unknown as ResearchOutcome;
    },
    judge: async () => ({ judgments: [], raw: [], usage: { inputTokens: 0, outputTokens: 0 } }),
  };

  beforeAll(async () => {
    const x = await signInTestUser(admin, "s9h3s2", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainA = (await u1.from("chains").insert({ household_id: hid, name: "あおぞら書店" }).select("id").single()).data!.id;
    prodA = (await u1.from("products").insert({ household_id: hid, official_name: "テストパック", packs_per_box: 30 }).select("id").single()).data!.id;
    const st = async (name: string, pref: string) => (await u1.from("stores").insert({ household_id: hid, chain_id: chainA, name, prefecture: pref }).select("id").single()).data!.id;
    storeOsaka = await st("大阪本店", "大阪府");
    storeTokyoMis = await st("実は大阪店", "東京都");
    storeTokyoReal = await st("東京店", "東京都");
    await admin.from("collection_settings").delete().eq("household_id", hid);
    await admin.from("collection_settings").insert({ household_id: hid, prefectures: ["大阪府"], include_online: true });
    await mk("expired", storeOsaka, -20); // 期限切れ → AIが確認（passed）
    await mk("extended", storeOsaka, -21); // 期限切れに見えるが、情報元では締切が延長されている → 除外しない
    await mk("failed", storeOsaka, -22); // 情報源を取得できない → 調査済みにしない
    await mk("missing", storeOsaka, 10); // 日付が空欄（応募開始・当選発表）→ 情報元から補完
    await mk("regionMis", storeTokyoMis, 10); // 登録上は地域外 → 実際は大阪府
    await mk("regionReal", storeTokyoReal, 10); // 地域外 → 確認済み
    await mk("starred", storeOsaka, -23, { isManaged: true }); // ★（保護）
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  const st = async (id: string) => (await u1.from("lotteries").select("archived_at,apply_start_date,apply_start_precision,result_date").eq("id", id).single()).data as { archived_at: string | null; apply_start_date: string | null; apply_start_precision: string; result_date: string | null };
  const item = async (target: string, action: string) => (await (u1 as any).from("master_reeval_items").select("id,status,ai_state,ai_result,ai_cost_jpy").eq("batch_id", batchId).eq("target_id", target).eq("action", action).maybeSingle()).data;

  it("計画: 固定ロジックの暫定判定。この時点では、AIの確認が無いので適用できない（0件）", async () => {
    const r = await createReevalPlan(u1, hid, profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    batchId = (r as { batchId: string }).batchId;
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["archive_expired", "archive_region"], limit: 50 });
    expect(a.ok).toBe(true);
    expect((a as { applied: number }).applied).toBe(0);
    expect((await st(L.expired)).archived_at).toBeNull();
    expect((await item(L.expired, "archive_expired")).ai_state).toBe("not_investigated");
    expect(await item(L.starred, "archive_expired")).toBeNull(); // ★は計画にも出ない
  });

  it("AI再調査: 実際に情報源を取得できたものだけが調査済み。取得できなかったものは failed。費用が項目に記録される", async () => {
    const rep = await runAiReevaluation(u1, hid, profile, batchId, deps, { limit: 20 });
    expect(rep.units).toBeGreaterThanOrEqual(5);
    expect(rep.stopped).toBeNull();
    expect((await item(L.expired, "archive_expired")).ai_state).toBe("investigated");
    expect((await item(L.expired, "archive_expired")).ai_result.verdict).toBe("confirm");
    expect((await item(L.failed, "archive_expired")).ai_state).toBe("failed"); // 未調査を調査済みとして扱わない
    expect((await item(L.failed, "archive_expired")).ai_result.verdict).toBe("inconclusive");
    expect(Number((await item(L.expired, "archive_expired")).ai_cost_jpy)).toBeGreaterThan(0);
    const b = (await (u1 as any).from("master_reeval_batches").select("params").eq("id", batchId).single()).data;
    expect(b.params.costJpy).toBe(spent); // 一括再評価の費用が、バッチに別枠で記録される
    // 再実行しても、調査済みのものは再調査しない（重複処理の防止・再開）
    const before = calls.length;
    await runAiReevaluation(u1, hid, profile, batchId, deps, { limit: 20 });
    expect(calls.length).toBe(before);
  });

  it("期限切れ: AIが情報元で確認できたものだけ適用。締切が延長されていたもの・調査できなかったものは適用しない", async () => {
    expect((await item(L.extended, "archive_expired")).ai_result.verdict).toBe("refute");
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["archive_expired"], limit: 50 });
    expect((a as { applied: number }).applied).toBe(1);
    expect((await st(L.expired)).archived_at).not.toBeNull();
    expect((await st(L.extended)).archived_at).toBeNull();
    expect((await st(L.failed)).archived_at).toBeNull();
    expect((await st(L.starred)).archived_at).toBeNull();
  });

  it("日付の補完: 情報元で確認できた空欄の日付だけを、根拠つきで補完する（既存の値は変えない）。元に戻せる", async () => {
    const fill = await item(L.missing, "fill_fields");
    expect(fill).not.toBeNull();
    expect(fill.ai_state).toBe("investigated");
    const prop = (await (u1 as any).from("master_reeval_items").select("proposal").eq("id", fill.id).single()).data.proposal;
    expect(prop.changes.map((c: { field: string }) => c.field).sort()).toEqual(["applyStart", "resultDate"]); // 締切は既に入っているため補完しない
    expect(prop.evidence[0].evidence[0].quote).toMatch(/は/); // 根拠（原文）つき
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["fill_fields"], limit: 50 });
    expect((a as { applied: number }).applied).toBeGreaterThanOrEqual(1);
    const s = await st(L.missing);
    expect(s.apply_start_date).toBe(day(-1));
    expect(s.result_date).toBe(day(15));
    const r = await revertReevalBatch(u1, profile, batchId, { itemIds: [fill.id] });
    expect((r as { reverted: number }).reverted).toBe(1);
    const s2 = await st(L.missing);
    expect(s2.apply_start_date).toBeNull();
    expect(s2.apply_start_precision).toBe("unknown");
  });

  it("地域: 店舗の実所在地を公式情報で確認。登録上は地域外でも実際は地域内なら除外しない。確認済みの所在地と根拠は店舗マスターに蓄積される", async () => {
    expect((await item(L.regionMis, "archive_region")).ai_result.verdict).toBe("refute"); // 実際は大阪府
    expect((await item(L.regionReal, "archive_region")).ai_result.verdict).toBe("confirm"); // 確認済みで地域外
    const stores = (await (u1 as any).from("stores").select("id,prefecture,address_optional,location_evidence,location_verified_at").in("id", [storeTokyoMis, storeTokyoReal])).data as { id: string; prefecture: string; address_optional: string; location_evidence: { sources: { official: boolean }[] }; location_verified_at: string }[];
    const mis = stores.find((s) => s.id === storeTokyoMis)!;
    expect(mis.prefecture).toBe("大阪府"); // 公式情報で確認した所在地に更新
    expect(mis.location_evidence.sources[0].official).toBe(true);
    expect(mis.location_verified_at).toBeTruthy();
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["archive_region"], limit: 50 });
    expect((a as { applied: number }).applied).toBe(1);
    expect((await st(L.regionReal)).archived_at).not.toBeNull();
    expect((await st(L.regionMis)).archived_at).toBeNull();
  });

  it("所在地が確認できない（公式の根拠なし）ときは、地域外と推測して除外しない・店舗マスターも更新しない", async () => {
    const r = await (await import("@/lib/server/agent/reeval-ai-service")).researchRegion({ ...deps, research: async () => ({ result: { status: "candidate", prefecture: "東京都", address: "東京都x", sources: [], confidence: 40, reasons: [], candidates: [], officialSites: [], city: null, lat: null, lng: null } }) as unknown as ResearchOutcome }, { chain: "あおぞら書店", name: "X店", prefecture: "", knownDomains: [], siblingNames: [] }, null, ["大阪府"]);
    expect(r.verdict).toBe("inconclusive");
    expect(r.aiState).toBe("insufficient");
    const acc = await (await import("@/lib/server/agent/reeval-ai-service")).accumulateStoreLocation(u1, storeOsaka, { result: { status: "candidate", prefecture: "東京都", address: "東京都x", sources: [], lat: null, lng: null, confidence: 40, reasons: [] } } as unknown as ResearchOutcome);
    expect(acc.updated).toBe(false);
    expect((await (u1 as any).from("stores").select("prefecture").eq("id", storeOsaka).single()).data.prefecture).toBe("大阪府");
  });

  it("別名の学習: 調査で見つけた表記が、根拠（公式情報）つきで名寄せ機構へ渡る。既に登録済みの表記は追加しない", async () => {
    const rows = (await (u1 as any).from("chain_aliases").select("alias").eq("chain_id", chainA)).data as { alias: string }[];
    expect(rows.map((x) => x.alias)).not.toContain("あおぞら書店"); // 正式名と同じ表記は別名にしない
  });
});
