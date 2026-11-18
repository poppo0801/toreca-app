/**
 * Stage 8F-5 の結合テスト（実Supabase・RLS適用下・架空データのみ。有料APIなし・外部ネットワークなし）:
 *  新しいグループ化の定義（同一系列・同一商品・同一応募期間・同一応募条件・同一抽選方式の別店舗の抽選。イベントID・応募URLは問わない）の、DBを通した動作と、
 *  店舗別の抽選・応募の保全、手動解除の尊重、旧定義の記録の再評価、既存グループ・候補の読み取り専用の再評価。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockGroupingBrain } from "@/lib/agent/lottery-grouping/mock";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { groupLotteries, saveLottery, ungroupLottery, type Db } from "@/lib/server/lottery-service";
import { auditGroupingState, runLotteryGrouping } from "@/lib/server/agent/lottery-grouping-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 8F-5", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let h1: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・関数は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8f5", 1);
    ids.push(a.userId);
    u1 = a.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    for (let i = 0; i < 10 && !actor; i++) {
      actor = (await u1.from("profiles").select("id").order("sort_order")).data?.[0]?.id as string;
      if (!actor) await new Promise((r) => setTimeout(r, 300));
    }
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  const mkChain = async (name: string) => (await u1.from("chains").insert({ household_id: h1, name } as never).select("id").single()).data!.id as string;
  const mkStore = async (chainId: string, name: string) => (await u1.from("stores").insert({ household_id: h1, chain_id: chainId, name, prefecture: "兵庫県" } as never).select("id").single()).data!.id as string;
  const mkProduct = async (name: string) => (await u1.from("products").insert({ household_id: h1, official_name: name, packs_per_box: 20 } as never).select("id").single()).data!.id as string;
  const input = (chain: string, product: string, store: { id: string | null; name: string }, over: Record<string, unknown> = {}) =>
    lotteryInputSchema.parse({
      chain: { id: chain, name: "" }, store: { id: store.id, name: store.name, prefecture: "" }, campaignId: null, newCampaign: null,
      items: [{ product: { id: product, name: "" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "date_only", date: "2099-01-01", time: "" }, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: { precision: "date_only", date: "2099-01-15", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", conditionsText: "会員登録が必要です。1人1口まで。", verificationText: "", announcementMethod: "", announcementUrl: "",
      sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", ...over,
    });
  const mkLottery = async (chain: string, product: string, store: string | null, name: string, over: Record<string, unknown> = {}) => {
    const r = await saveLottery(u1, h1, null, input(chain, product, { id: store, name }, over), actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.ok ? r.value.id : "";
  };
  /** 同じ内容で、応募URL・イベントIDが店舗ごとに別（独立した店舗別の抽選）の抽選を n 店舗ぶん作る */
  const mkSet = async (label: string, n: number, over: (i: number) => Record<string, unknown> = () => ({})) => {
    const chain = await mkChain(`8F5${label}チェーン`);
    const product = await mkProduct(`8F5${label}商品`);
    const lots: string[] = [];
    for (let i = 0; i < n; i++) lots.push(await mkLottery(chain, product, await mkStore(chain, `8F5${label}店${i + 1}`), `8F5${label}店${i + 1}`, { sourceUrls: [`https://example.invalid/8f5/${label}/shop-${i + 1}?event_id=${1000000 + i}`], ...over(i) }));
    return { chain, product, lots };
  };
  const groupOf = async (id: string) => (await x(u1).from("lotteries").select("bulk_group_id").eq("id", id).single()).data?.bulk_group_id as string | null;
  const run = (id: string, over: Record<string, unknown> = {}) => runLotteryGrouping(u1, h1, id, { llm: new MockGroupingBrain("careful"), allowAuto: true, asService: false, actor, followUps: 0, ...over });

  it("店舗ごとにイベントID・応募URLが別でも、同一商品・期間・条件・方式なら自動でグループ化。各店舗の抽選・応募の記録は変わらない", async () => {
    const { lots } = await mkSet("独立", 3);
    const before = (await u1.from("lotteries").select("id,apply_deadline_date,apply_start_date,conditions_text,source_urls,event_state,store_id").in("id", lots).order("id")).data;
    const r = await run(lots[2]);
    expect(r.status, r.message).toBe("applied");
    expect(r.tier).toBe("auto");
    const g = await groupOf(lots[2]);
    expect(g).toBeTruthy();
    expect(await groupOf(lots[0])).toBe(g);
    expect(await groupOf(lots[1])).toBe(g);
    // 店舗別の抽選（期限・条件・応募URL・店舗）はそのまま
    expect((await u1.from("lotteries").select("id,apply_deadline_date,apply_start_date,conditions_text,source_urls,event_state,store_id").in("id", lots).order("id")).data).toEqual(before);
    // 提案の根拠に、補足の裏づけが無いこと（必須でない）が残る
    const p = ((await x(u1).from("lottery_group_proposals").select("*").eq("subject_lottery_id", lots[2])).data ?? []) as { evidence: { basis: string[]; strongSignals: string[] } }[];
    expect(p[0].evidence.strongSignals).toEqual([]);
    expect(p[0].evidence.basis.join("\n")).toMatch(/自動確定[\s\S]*必須条件ではない/);
  });

  it("グループ化しても応募の記録は影響を受けない。グループ内に応募済み・未応募が混在していても、店舗別に管理される", async () => {
    const { lots } = await mkSet("応募", 2);
    const accountId = (await x(u1).from("accounts").select("id").eq("household_id", h1).limit(1)).data?.[0]?.id as string | undefined;
    if (accountId) {
      const ins = await x(u1).from("applications").insert({ household_id: h1, lottery_id: lots[0], account_id: accountId, state: "applied", applied_at: new Date().toISOString() });
      expect(ins.error, JSON.stringify(ins.error)).toBeNull();
    }
    const appsBefore = (await x(u1).from("applications").select("id,lottery_id,state,result").in("lottery_id", lots).order("id")).data;
    const r = await run(lots[1]);
    expect(r.status, r.message).toBe("applied");
    expect(await groupOf(lots[0])).toBe(await groupOf(lots[1]));
    expect((await x(u1).from("applications").select("id,lottery_id,state,result").in("lottery_id", lots).order("id")).data).toEqual(appsBefore);
    // 解除しても店舗の抽選と応募は残る
    const rm = await ungroupLottery(u1, lots[1], actor, { code: "other" });
    expect(rm.ok).toBe(true);
    expect((await u1.from("lotteries").select("id").in("id", lots)).data).toHaveLength(2);
    expect((await x(u1).from("applications").select("id,lottery_id,state,result").in("lottery_id", lots).order("id")).data).toEqual(appsBefore);
  });

  it("対象外: 応募期間が異なる・応募条件が異なる・店舗選択式・同一店舗の重複は、グループ化しない", async () => {
    const period = await mkSet("期間", 2, (i) => (i === 1 ? { applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" } } : {}));
    expect((await run(period.lots[1])).status).not.toBe("applied");
    expect(await groupOf(period.lots[1])).toBeNull();
    const cond = await mkSet("条件", 2, (i) => (i === 1 ? { conditionsText: "過去の購入履歴が必要です。" } : {}));
    expect((await run(cond.lots[1])).status).not.toBe("applied");
    expect(await groupOf(cond.lots[1])).toBeNull();
    // 店舗選択式（店舗未指定・応募時に選ぶ）
    const chain = await mkChain("8F5選択チェーン");
    const product = await mkProduct("8F5選択商品");
    const a = await mkLottery(chain, product, await mkStore(chain, "8F5選択店A"), "8F5選択店A");
    const sel = await mkLottery(chain, product, null, "", { storeMode: "select_on_apply", selectableStores: [{ name: "8F5選択店A", prefecture: "" }, { name: "8F5選択店B", prefecture: "" }] });
    expect((await run(sel)).status).not.toBe("applied");
    expect(await groupOf(sel)).toBeNull();
    expect(await groupOf(a)).toBeNull();
    // 同一店舗の重複登録
    const chain2 = await mkChain("8F5重複チェーン");
    const product2 = await mkProduct("8F5重複商品");
    const store = await mkStore(chain2, "8F5重複店");
    const d1 = await mkLottery(chain2, product2, store, "8F5重複店");
    const d2 = await mkLottery(chain2, product2, store, "8F5重複店");
    expect((await run(d2)).status).not.toBe("applied");
    expect(await groupOf(d1)).toBeNull();
    expect(await groupOf(d2)).toBeNull();
  });

  it("手動で外したグループは、同じ内容でも再びまとめない（新定義でも尊重）。旧定義の単独の記録は、新定義で再評価される", async () => {
    const { lots } = await mkSet("手動", 2);
    expect((await run(lots[1])).status).toBe("applied");
    const rm = await ungroupLottery(u1, lots[1], actor, { code: "different_campaign" });
    expect(rm.ok, JSON.stringify(rm)).toBe(true);
    expect(await groupOf(lots[1])).toBeNull();
    const again = await run(lots[1], { llm: new MockGroupingBrain("eager") });
    expect(again.status).not.toBe("applied");
    expect(await groupOf(lots[1])).toBeNull();
    expect(await groupOf(lots[0])).toBeNull();
    // 旧定義の「単独」の記録（古い署名のキー）: 新定義の判定をスキップさせない
    const { lots: l2 } = await mkSet("旧記録", 2);
    await x(u1).from("lottery_group_proposals").insert({ household_id: h1, proposal_key: `single:${l2[1]}:0000deadbeef00`, kind: "single", status: "dismissed", tier: "single", subject_lottery_id: l2[1], lottery_ids: [l2[1]], confidence: 0, rationale: "旧定義で単独と判断", common: [], mismatches: [], missing: [], evidence: {}, agent_claim: {}, engine: "old", usage: {} });
    const r = await run(l2[1]);
    expect(r.ranAgent).toBe(true);
    expect(r.status).toBe("applied");
  });

  it("既存グループ・候補の再評価（読み取りのみ）: 新定義に合わない所属を指摘するが、グループ・抽選・候補は変更しない", async () => {
    const { lots } = await mkSet("監査", 3, (i) => (i === 2 ? { applyDeadline: { precision: "date_only", date: "2099-01-25", time: "" } } : {}));
    // 旧定義で作られたグループ（期間が異なる所属が混在）を、グループ化の関数で直接作る
    const made = await groupLotteries(u1, lots, { title: "旧定義のグループ" }, actor);
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const g = await groupOf(lots[0]);
    expect(g).toBeTruthy();
    const snapshot = JSON.stringify((await x(u1).from("lotteries").select("id,bulk_group_id,apply_deadline_date").in("id", lots).order("id")).data);
    const audit = await auditGroupingState(u1, h1);
    const mine = audit.groups.find((a) => a.groupId === g);
    expect(mine?.status).toBe("inconsistent");
    expect(mine?.advice).toContain("利用者の意思なので変更しません"); // 手動グループは変更しない
    expect(mine?.issues.some((i) => i.field === "applyDeadline")).toBe(true);
    // 何も変更していない
    expect(JSON.stringify((await x(u1).from("lotteries").select("id,bulk_group_id,apply_deadline_date").in("id", lots).order("id")).data)).toBe(snapshot);
  });
});
