/**
 * Stage 9C: 実運用で確認された9項目の回帰（実Supabase・RLS適用下。AI・外部サイトはモック。有料APIなし）
 *   ①系列の表記揺れ ③店舗選択式が「店舗不明」にならない・判断の追跡 ④店舗選択式と個別店舗の二重登録の防止
 *   ⑥一部の情報は既存の抽選の補完 ⑦商品名の認識 ⑧キデイランド（応募制限による店舗選択式）⑨楽天ブックス（同一企画の複数商品）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS, type CollectionConditions } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { mkApplication } from "./helpers/application";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const jst = (offsetDays: number, hour: number, minute = 0) => {
  const d = new Date(NOW.getTime() + offsetDays * 86400_000 + 9 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute };
};
const none = { year: null, month: null, day: null, hour: null, minute: null };

describe.skipIf(!dbTestsEnabled)("Stage 9C", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  type Plan = { chain?: string; store?: string; products?: string[]; unit?: string; selectable?: string[]; conditions?: string; deadline?: object; start?: object; receive?: string };
  let plan: Plan = {};
  const U = (n: string) => `https://q9c.example.invalid/${n}`;
  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r);
      const raw = JSON.parse(JSON.stringify(o.raw)) as Record<string, unknown>;
      raw.is_lottery_announcement = true;
      raw.chain_name = plan.chain ?? "";
      raw.store_name = plan.store ?? "";
      raw.products = (plan.products ?? []).map((name) => ({ name, code: "", quantity: 1, unit: "box" }));
      raw.apply_start = plan.start ?? jst(-1, 10);
      raw.apply_deadline = plan.deadline ?? jst(5, 23, 59);
      raw.result_date = none;
      raw.apply_url = "";
      raw.conditions_text = plan.conditions ?? "会員登録が必要";
      raw.receive_method = plan.receive ?? "store";
      raw.apply_unit = plan.unit ?? "unknown";
      raw.selectable_stores = plan.selectable ?? [];
      raw.notes = "";
      return { ...o, raw };
    },
  };
  const cond = (o: Partial<CollectionConditions> = {}): CollectionConditions => ({ ...DEFAULT_CONDITIONS, prefectures: ["東京都"], ...o });
  const deps = (): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: NOW, actor: null, canRegister: false, serviceRegister: true, extractor: extractor as never, xClient: null,
    fetchPage: async () => ({ ok: false, code: "robots", message: "robots" }), fetchOembed: async () => ({ ok: false, message: "x" }),
  });
  const run = async () => processQueue(deps(), { settings: { auto_register: true }, cond: cond(), data: await loadAppData(sys, hid), aiLeft: 8, timeLeft: () => 50_000, perBatch: 4 });
  const add = (n: string, card: string) =>
    sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: U(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: U(n), title: `【${n}】`, context: card, card, sourceName: "pokecachan", attempts: 0 } } as never });
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,job_state,triage,reasons,lottery_id,draft").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const lots = async () => (await sys.from("lotteries").select("id,chain_id,store_id,store_mode,cautions").eq("household_id", hid).is("archived_at", null)).data ?? [];
  const items = async (id: string) => (await sys.from("lottery_items").select("product_id").eq("lottery_id", id)).data ?? [];
  let chainsBefore = 0;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9c", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
    const mkChain = async (name: string) => (await u1.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
    const bo = await mkChain("BOOKOFF");
    await u1.from("stores").insert({ household_id: hid, chain_id: bo, name: "渋谷店", prefecture: "東京都" });
    const kd = await mkChain("キデイランド");
    await u1.from("stores").insert([{ household_id: hid, chain_id: kd, name: "応募時に店舗選択", prefecture: "" }, { household_id: hid, chain_id: kd, name: "原宿店", prefecture: "東京都" }, { household_id: hid, chain_id: kd, name: "新宿店", prefecture: "東京都" }]);
    const rk = await mkChain("楽天ブックス");
    await u1.from("stores").insert({ household_id: hid, chain_id: rk, name: "オンライン", prefecture: "東京都", sales_kind: "online_only" } as never);
    const tc = await mkChain("トレカ9C");
    await u1.from("stores").insert({ household_id: hid, chain_id: tc, name: "本店", prefecture: "東京都" });
    await u1.from("products").insert(["ハドウシーカー", "ニンジャスピナー", "9C商品A", "9C商品B"].map((n) => ({ household_id: hid, official_name: n, packs_per_box: 20 })));
    chainsBefore = (await sys.from("chains").select("id").eq("household_id", hid)).data!.length;
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q9c.example.invalid%");
    await cleanupTestUsers(admin, userIds);
  });

  it("① 系列名の表記揺れ（BOOK・OFF）は、新しい系列を作らず既存の BOOKOFF に登録される", async () => {
    plan = { chain: "BOOK・OFF", store: "渋谷店", products: ["9C商品A"] };
    await add("a1", "BOOK・OFF 渋谷店で9C商品Aの抽選を実施します");
    await run();
    const c = await cand("a1");
    expect(c.status, JSON.stringify(c.reasons)).toBe("auto_registered");
    expect((await sys.from("chains").select("id").eq("household_id", hid)).data).toHaveLength(chainsBefore);
    const l = (await lots()).find((x) => x.id === c.lottery_id)!;
    const chainName = (await sys.from("chains").select("name").eq("id", l.chain_id).single()).data!.name;
    expect(chainName).toBe("BOOKOFF");
  });

  it("⑦ 商品名の修飾語（MEGA 拡張パック・シュリンクなし）で未登録判定にならず、商品マスターの「ハドウシーカー」に紐づく", async () => {
    plan = { chain: "トレカ9C", store: "本店", products: ["MEGA 拡張パック ハドウシーカー（シュリンクなし）"] };
    await add("p1", "トレカ9C本店でハドウシーカー（シュリンクなし）の抽選を実施します。応募方法はWebで案内します");
    await run();
    const c = await cand("p1");
    expect(c.status, JSON.stringify(c.reasons)).toBe("auto_registered");
    const pid = (await sys.from("products").select("id").eq("household_id", hid).eq("official_name", "ハドウシーカー").single()).data!.id;
    expect((await items(c.lottery_id!)).map((i) => i.product_id)).toEqual([pid]);
  });

  it("③ AIが店舗選択式と読み取った抽選は、「店舗不明」の注意に戻されず、店舗選択式で登録される。判断の追跡が残る", async () => {
    plan = { chain: "トレカ9C", store: "", unit: "store_select", selectable: ["本店"], products: ["9C商品B"] };
    await add("s1", "トレカ9Cの抽選。応募時に受取店舗をお選びいただけます");
    await run();
    const c = await cand("s1");
    expect(c.status, JSON.stringify(c.reasons)).toBe("auto_registered");
    const l = (await lots()).find((x) => x.id === c.lottery_id)!;
    expect(l.store_mode).toBe("select_on_apply");
    expect((l.cautions as { code: string }[]).map((x) => x.code)).not.toContain("store_unconfirmed");
    const u = (c.draft as { understanding?: { applyUnit: string; decidedBy: { applyUnit: string }; trace: { stage: string; by: string }[] } }).understanding;
    expect(u?.applyUnit).toBe("store_select");
    expect(u?.decidedBy.applyUnit).toBe("ai");
    expect(u?.trace.some((t) => t.stage === "ai")).toBe(true);
    expect(u?.trace.some((t) => t.stage === "fixed")).toBe(true);
  });

  it("④ 店舗選択式のカードがある同じ企画の個別店舗の告知（選べる店舗に含まれる）は、別カードにせず重複として扱う。応募の記録は変わらない", async () => {
    const sel = (await cand("s1")).lottery_id!;
    await sys.from("lotteries").update({ selectable_stores: [{ name: "本店", prefecture: "東京都" }] } as never).eq("id", sel);
    const chainId = (await sys.from("lotteries").select("chain_id").eq("id", sel).single()).data!.chain_id as string;
    await mkApplication(sys, hid, chainId, sel);
    const appsBefore = (await sys.from("applications").select("id,state,result_status").eq("lottery_id", sel).order("id")).data;
    const before = (await lots()).length;
    plan = { chain: "トレカ9C", store: "本店", products: ["9C商品B"] };
    await add("s2", "トレカ9C本店で9C商品Bの抽選のお知らせ");
    await run();
    const c = await cand("s2");
    expect(c.status, JSON.stringify(c.reasons)).toBe("duplicate");
    expect(c.lottery_id).toBe(sel);
    expect(await lots()).toHaveLength(before);
    expect((await sys.from("applications").select("id,state,result_status").eq("lottery_id", sel).order("id")).data).toEqual(appsBefore);
  });

  it("⑥ 登録済み抽選の一部の情報（商品が読み取れない同じ情報源の告知）は、新規にせず既存の抽選の補完・重複として扱う", async () => {
    plan = { chain: "トレカ9C", store: "", unit: "store_select", products: [] };
    const sel = (await cand("s1")).lottery_id!;
    const url = (await sys.from("lotteries").select("source_urls").eq("id", sel).single()).data!.source_urls as string[];
    const before = (await lots()).length;
    await sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U("f1"), source_url: url[0] ?? U("s1"), title: "f1", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: url[0] ?? U("s1"), title: "【f1】", context: "トレカ9Cの抽選の続報です。応募の締切が近づいています。応募方法はWebで案内しています", card: "トレカ9Cの抽選の続報です。応募の締切が近づいています。応募方法はWebで案内しています", sourceName: "pokecachan", attempts: 0 } } as never });
    await run();
    const f1 = await cand("f1");
    expect(f1.status, JSON.stringify(f1.reasons)).toBe("duplicate");
    expect(f1.lottery_id).toBe(sel);
    expect((await lots()).length).toBe(before);
  });

  it("⑧ キデイランド: 店舗別の応募ページでも、応募できる店舗が1つに制限されるなら店舗選択式として登録される（URLが店舗別というだけでは独立抽選にしない）", async () => {
    plan = { chain: "キデイランド", store: "原宿店", products: ["ニンジャスピナー"], conditions: "※応募できる店舗はいずれか1店舗のみです。複数店舗への応募は無効となります。" };
    await add("k1", "キデイランド原宿店 ニンジャスピナー 抽選のお知らせ");
    await run();
    const c = await cand("k1");
    expect(c.status, JSON.stringify(c.reasons)).toBe("auto_registered");
    const l = (await lots()).find((x) => x.id === c.lottery_id)!;
    expect(l.store_mode).toBe("select_on_apply");
    const u = (c.draft as { understanding?: { trace: { note?: string }[] } }).understanding;
    expect(JSON.stringify(u?.trace)).toContain("店舗は応募者が応募時に選ぶ");
  });

  it("⑨ 楽天ブックス: 同じ期間・同じ条件の別商品の告知は、新規カードを作らず既存の1枚に商品を追加する。応募の記録がある抽選には足さない", async () => {
    plan = { chain: "楽天ブックス", store: "オンライン", receive: "shipping", products: ["9C商品A"], conditions: "楽天会員のみ" };
    await add("r1", "楽天ブックス 9C商品A 抽選販売のお知らせ");
    await run();
    const c1 = await cand("r1");
    expect(c1.status, JSON.stringify(c1.reasons)).toBe("auto_registered");
    const target = c1.lottery_id!;
    const before = (await lots()).length;
    plan = { chain: "楽天ブックス", store: "オンライン", receive: "shipping", products: ["ニンジャスピナー"], conditions: "楽天会員のみ" };
    await add("r2", "楽天ブックス ニンジャスピナー 抽選販売のお知らせ");
    await run();
    const c2 = await cand("r2");
    expect(c2.status, JSON.stringify(c2.reasons)).toBe("duplicate");
    expect(c2.lottery_id).toBe(target);
    expect(await lots()).toHaveLength(before);
    expect(await items(target)).toHaveLength(2);
    const caution = ((await sys.from("lotteries").select("cautions").eq("id", target).single()).data!.cautions as { code: string }[]).map((x) => x.code);
    expect(caution).toContain("mode_unconfirmed");
    // 応募の記録がある抽選には商品を足さない（別商品は通常の流れで扱う）
    const chainId = (await sys.from("lotteries").select("chain_id").eq("id", target).single()).data!.chain_id as string;
    await mkApplication(sys, hid, chainId, target);
    plan = { chain: "楽天ブックス", store: "オンライン", receive: "shipping", products: ["ハドウシーカー"], conditions: "楽天会員のみ" };
    await add("r3", "楽天ブックス ハドウシーカー 抽選販売のお知らせ");
    await run();
    expect(await items(target)).toHaveLength(2);
  });
});
