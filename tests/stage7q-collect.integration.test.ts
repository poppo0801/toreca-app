/**
 * Stage 7Q: 除外系列（信頼性なし）の再収集と、同一抽選を異なるURLから収集したときの統合（実Supabase・RLS適用下・架空データのみ。AI・外部サイトの呼び出しなし）。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { runReevaluation, type ReevalReport } from "@/lib/server/collector/reevaluate";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import type { CollectDeps } from "@/lib/server/collector/run";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const ymd = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);

describe.skipIf(!dbTestsEnabled)("Stage 7Q: 除外系列の再収集・同一抽選の統合", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainOk: string;
  let chainEx: string;
  let ruleId: string;

  const deps = (): CollectDeps => ({ db: u1, householdId: hid, trigger: "manual", now: NOW, actor: profile, canRegister: true, extractor: null, xClient: null });
  const storedInput = (over: Record<string, unknown> = {}) => ({
    chain: { id: null, name: "7Qサンプル電機" },
    store: { id: null, name: "三宮店", prefecture: "兵庫県" },
    campaignId: null, newCampaign: null,
    items: [{ product: { id: null, name: "7Q拡張パック「ひかりの森」" }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: ymd(20), time: "" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web", requirementTags: [],
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [],
    ...over,
  });
  const draft = (input: Record<string, unknown>) => ({ input, flags: {}, summary: { chain: "none", store: "none", items: [{ name: "x", kind: "none", matchedName: null }] }, warnings: [], modePending: false, verdict: "review", ready: false, notices: [] });
  const url = (n: string) => `https://s7qc.example.invalid/${n}`;
  const addCand = async (n: string, d: unknown) => {
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url(n), source_url: url(n), title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], draft: d as never } as never);
    expect(error).toBeNull();
  };
  const cand = async (n: string) => (await u1.from("collection_candidates").select("id,status,job_state,reasons,draft,lottery_id").eq("dedupe_key", url(n)).single()).data!;
  const active = async () => (await loadAppData(u1, hid)).lotteries;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7qc", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainOk = (await u1.from("chains").insert({ household_id: hid, name: "7Qサンプル電機" }).select("id").single()).data!.id;
    chainEx = (await u1.from("chains").insert({ household_id: hid, name: "7Q除外屋" }).select("id").single()).data!.id;
    await u1.from("chain_aliases").insert({ household_id: hid, chain_id: chainEx, alias: "ななきゅー除外別名", normalized_alias: "ななきゅー除外別名" } as never);
    for (const c of [chainOk, chainEx]) await u1.from("stores").insert({ household_id: hid, chain_id: c, name: "三宮店", prefecture: "兵庫県" });
    await u1.from("products").insert({ household_id: hid, official_name: "7Q拡張パック「ひかりの森」", packs_per_box: 30 });
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
    ruleId = (await u1.from("collection_exclusions").insert({ household_id: hid, scope: "chain", key: chainEx, chain_id: chainEx, label: "7Q除外屋", reason_code: "untrusted_shop", reason_note: "テスト" } as never).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://s7qc.example.invalid/%");
    await cleanupTestUsers(admin, userIds);
  });

  it("除外系列の再収集: 系列ID・別名・表記ゆれ・別店舗のどれでも登録されない（候補は残る）。除外していない系列は登録される。既存の抽選カードは変わらない", async () => {
    await addCand("ok", draft(storedInput()));
    await addCand("ex-id", draft(storedInput({ chain: { id: chainEx, name: "7Q除外屋" } })));
    await addCand("ex-alias", draft(storedInput({ chain: { id: null, name: "ななきゅー除外別名" } })));
    await addCand("ex-spelling", draft(storedInput({ chain: { id: null, name: "７Ｑ除外屋 通販" }, store: { id: null, name: "梅田店", prefecture: "大阪府" } })));
    const r = (await runReevaluation(deps(), { execute: true, aiMax: 0 })) as ReevalReport;
    expect(r.ok).toBe(true);
    expect((await cand("ok")).status).toBe("auto_registered");
    for (const n of ["ex-id", "ex-alias", "ex-spelling"]) {
      const c = await cand(n);
      expect(c, n).toMatchObject({ status: "excluded", job_state: "skipped", lottery_id: null });
      expect(c.reasons.join(""), n).toContain("信頼性なし");
    }
    const ls = await active();
    expect(ls.filter((l) => l.chainId === chainEx)).toHaveLength(0);
    expect(ls.filter((l) => l.chainId === chainOk)).toHaveLength(1);
    // ルール自体は変わらない（理由・日時が残っている）
    const rule = (await u1.from("collection_exclusions").select("active,reason_code,created_at").eq("id", ruleId).single()).data!;
    expect(rule).toMatchObject({ active: true, reason_code: "untrusted_shop" });
    expect(rule.created_at).toBeTruthy();
  });

  it("手動登録は禁止しない（除外は自動収集のみ）", async () => {
    const { saveLegacy } = await import("./helpers/legacy");
    const prod = (await u1.from("products").select("id").eq("household_id", hid).limit(1).single()).data!.id;
    const store = (await u1.from("stores").select("id").eq("chain_id", chainEx).limit(1).single()).data!.id;
    const l = await saveLegacy(u1, hid, null, {
      chainId: chainEx, storeId: store, campaignId: null, newCampaign: null, items: [{ productId: prod, quantity: 1, unit: "box" }], multiMode: "single",
      applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: ymd(30), time: "" }, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
      receiveMethod: "store", applyMethod: "web", conditionsText: "手動", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [url("manual")],
      eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "",
    }, profile);
    expect(l.ok).toBe(true);
  });

  it("除外を解除すると、同じ系列も再び自動登録の対象になる", async () => {
    await u1.from("collection_exclusions").update({ active: false, released_at: NOW.toISOString() } as never).eq("id", ruleId);
    await u1.from("products").insert({ household_id: hid, official_name: "7Q解除パック", packs_per_box: 20 });
    await addCand("ex-after", draft(storedInput({ chain: { id: chainEx, name: "7Q除外屋" }, items: [{ product: { id: null, name: "7Q解除パック" }, quantity: 1, unit: "box" }], applyDeadline: { precision: "date_only", date: ymd(40), time: "" } })));
    await runReevaluation(deps(), { execute: true, aiMax: 0 });
    expect((await cand("ex-after")).status).toBe("auto_registered");
    await u1.from("collection_exclusions").update({ active: true, released_at: null } as never).eq("id", ruleId);
  });

  it("同じ抽選を異なるURL・異なる締切日で続けて収集しても、1件に統合され、2件目の情報元が記録される", async () => {
    // 別の商品・別の店舗で、他のテストと重ならないようにする
    await u1.from("products").insert({ household_id: hid, official_name: "7Q統合パック", packs_per_box: 20 });
    const items = [{ product: { id: null, name: "7Q統合パック" }, quantity: 1, unit: "box" }];
    await addCand("m1", draft(storedInput({ items, applyDeadline: { precision: "date_only", date: ymd(21), time: "" } })));
    await addCand("m2", draft(storedInput({ items, applyDeadline: { precision: "date_only", date: ymd(26), time: "" } })));
    await addCand("m3", draft(storedInput({ items, applyDeadline: { precision: "date_only", date: ymd(21), time: "" } })));
    await runReevaluation(deps(), { execute: true, aiMax: 0 });
    const regs = await Promise.all(["m1", "m2", "m3"].map(cand));
    expect(regs.filter((c) => c.status === "auto_registered")).toHaveLength(1);
    expect(regs.filter((c) => c.status === "duplicate")).toHaveLength(2);
    const survivor = regs.find((c) => c.status === "auto_registered")!.lottery_id!;
    expect(regs.filter((c) => c.status === "duplicate").every((c) => c.lottery_id === survivor)).toBe(true);
    const ls = (await active()).filter((l) => l.items.some((i) => i.productId && regs.length > 0) && l.chainId === chainOk && l.sourceUrls.some((u) => u.includes("/m")));
    expect(ls).toHaveLength(1);
    // 統合元の記録（URL・収集時の系列名）
    const ms = ((await u1.from("lotteries").select("merged_sources").eq("id", survivor).single()).data as unknown as { merged_sources: { url: string; chainName: string }[] }).merged_sources;
    expect(ms.length).toBeGreaterThanOrEqual(2);
    expect(ms.every((m) => m.chainName === "7Qサンプル電機")).toBe(true);
    expect(new Set(ms.map((m) => m.url)).size).toBe(ms.length);
  });
});
