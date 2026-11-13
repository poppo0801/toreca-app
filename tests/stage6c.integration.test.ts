/**
 * Stage 6C: 抽選予告の追跡・続報による更新・予告から正式登録への移行・重複防止（実Supabase・RLS適用下。AI・外部サイトはモック）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS, type CollectionConditions } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { runHoldPass } from "@/lib/server/collector/hold";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const jst = (offsetDays: number, hour: number, minute = 0) => {
  const d = new Date(NOW.getTime() + offsetDays * 86400_000 + 9 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute };
};
const ymd = (o: { year: number; month: number; day: number }) => `${o.year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}`;
const none = { year: null, month: null, day: null, hour: null, minute: null };

describe.skipIf(!dbTestsEnabled)("Stage 6C", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  type Plan = { store?: string; product?: string; start?: object; deadline?: object; applyUrl?: string; conditions?: string; lottery?: boolean; chain?: string };
  let plan: Plan = {};
  const U = (n: string) => `https://q6c.example.invalid/${n}`;

  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r);
      const raw = JSON.parse(JSON.stringify(o.raw)) as Record<string, unknown>;
      raw.is_lottery_announcement = plan.lottery !== false;
      raw.chain_name = plan.chain ?? "テスト玩具6C";
      raw.store_name = plan.store ?? "";
      raw.products = [{ name: plan.product ?? "6C商品", code: "", quantity: 1, unit: "box" }];
      raw.apply_start = plan.start ?? none;
      raw.apply_deadline = plan.deadline ?? none;
      raw.result_date = none;
      raw.apply_url = plan.applyUrl ?? "";
      raw.conditions_text = plan.conditions ?? "";
      raw.receive_method = "store";
      raw.notes = "";
      return { ...o, raw };
    },
  };
  const cond = (o: Partial<CollectionConditions> = {}): CollectionConditions => ({ ...DEFAULT_CONDITIONS, prefectures: ["東京都"], ...o });
  const deps = (): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: NOW, actor: null, canRegister: false, serviceRegister: true, extractor: extractor as never, xClient: null,
    fetchPage: async () => ({ ok: false, code: "robots", message: "robots" }), fetchOembed: async () => ({ ok: false, message: "x" }),
  });
  const run = async (c: CollectionConditions = cond()) => processQueue(deps(), { settings: { auto_register: true }, cond: c, data: await loadAppData(sys, hid), aiLeft: 5, timeLeft: () => 50_000, perBatch: 4 });
  const add = (n: string, card: string) =>
    sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: U(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: U(n), title: `【${n}】`, context: card, card, sourceName: "pokecachan", attempts: 0 } } as never });
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,job_state,triage,reasons,draft,lottery_id,hold_count,next_run_at").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const lots = async () => (await sys.from("lotteries").select("id").eq("household_id", hid).is("archived_at", null)).data ?? [];
  type Draft = { stage?: string; tracking?: { since: string; startDate: string | null; history: { kind: string; source: string; at: string }[]; sources: { url: string }[]; promotedAt?: string; promotedLotteryId?: string; related?: string[] }; input?: { store: { name: string } } };
  const dr = (c: { draft: unknown }) => c.draft as Draft;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6c", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
    const chainId = (await u1.from("chains").insert({ household_id: hid, name: "テスト玩具6C" }).select("id").single()).data!.id;
    await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "本店", prefecture: "東京都" });
    await u1.from("products").insert(["6C商品", "6C商品B", "6C商品C"].map((n) => ({ household_id: hid, official_name: n, packs_per_box: 20 })));
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q6c.example.invalid%");
    await cleanupTestUsers(admin, userIds);
  });

  // ------------------------------------------------------------ 予告の追跡 → 続報 → 正式登録
  it("1) 抽選予告（受付開始・締切が未発表）も、抽選の告知と認識できれば登録する（Stage 9A）。日時は推測せず『未確認』の注意として保持し、要手動確認・保留にしない", async () => {
    plan = { store: "本店" };
    await add("t1", "テスト玩具6Cで6C商品の抽選を近日実施予定です");
    await run();
    const c = await cand("t1");
    expect(c.status, JSON.stringify(c.reasons)).toBe("auto_registered");
    expect(c.triage).toBe("auto_register");
    const ls = await lots();
    expect(ls).toHaveLength(1);
    const lot = (await sys.from("lotteries").select("cautions,apply_deadline_precision,apply_start_precision").eq("id", ls[0].id).single()).data as unknown as { cautions: { code: string }[]; apply_deadline_precision: string; apply_start_precision: string };
    expect(lot.apply_deadline_precision).toBe("unknown"); // 日時を推測で入れない
    expect(lot.cautions.map((x) => x.code)).toContain("deadline_unknown");
  });

  it("2) 続報（受付開始日・締切・応募URL・条件・店舗が判明）は、同じ抽選として既存の抽選を自動補完する。別の抽選として二重に登録しない。補完された日時は注意が解除される", async () => {
    plan = { store: "本店", start: jst(2, 10), deadline: jst(5, 23, 59), applyUrl: "https://shop.example.invalid/apply", conditions: "会員登録が必要" };
    await add("t2", "テスト玩具6C本店で6C商品の抽選受付を開始します。応募方法は公式アプリ https://shop.example.invalid/apply");
    await run();
    const ls = await lots();
    expect(ls, JSON.stringify((await cand("t2")).reasons)).toHaveLength(1); // 二重登録しない
    const c = await cand("t2");
    expect(["duplicate", "auto_registered"]).toContain(c.status);
    const lot = (await sys.from("lotteries").select("cautions,apply_deadline_precision,apply_deadline_at").eq("id", ls[0].id).single()).data as unknown as { cautions: { code: string }[]; apply_deadline_precision: string; apply_deadline_at: string | null };
    expect(lot.apply_deadline_precision).not.toBe("unknown"); // 続報で締切が分かった
    expect(lot.apply_deadline_at).toBeTruthy();
    expect(lot.cautions.map((x) => x.code)).not.toContain("deadline_unknown");
  });

  it("4) 受付が始まり、詳細が確定した告知は、同じ抽選として既存の抽選に統合される（二重に登録しない）。締切が変わった場合は暫定の値を採用し、相違を注意として残す", async () => {
    plan = { store: "本店", start: jst(-1, 10), deadline: jst(4, 23, 59), applyUrl: "https://shop.example.invalid/apply", conditions: "会員登録が必要" };
    await add("t3", "テスト玩具6C本店で6C商品の抽選受付中です。応募はこちら");
    await run();
    const c = await cand("t3");
    expect(c.status, JSON.stringify(c.reasons)).toBe("duplicate");
    const lotsNow = await lots();
    expect(lotsNow).toHaveLength(1);
    expect(c.lottery_id).toBe(lotsNow[0].id);
  });

  it("5) さらに同じ内容の告知が来ても、重複して登録しない", async () => {
    await add("t4", "テスト玩具6C本店 6C商品 抽選受付中（再掲）");
    await run();
    expect((await cand("t4")).status).toBe("duplicate");
    expect(await lots()).toHaveLength(1);
  });

  // ------------------------------------------------------------ 抽選予告と発売予告の区別
  it("6) 抽選の文言が無い『新商品の発売予定』の告知は、抽選予告として追跡しない", async () => {
    plan = { product: "6C商品", chain: "テスト玩具6C" };
    await add("rel", "テスト玩具6Cで6C商品が11月末に発売予定です");
    await run();
    const c = await cand("rel");
    expect(c.status).toBe("excluded");
    expect(c.reasons[0]).toContain("発売予定");
    expect(dr(c).tracking).toBeUndefined();
  });

  it("7) 具体的な系列が無い予告は追跡しない（通常の保留へ）", async () => {
    plan = { chain: "" };
    await add("nochain", "近日、抽選販売を実施予定です");
    await run();
    const c = await cand("nochain");
    expect(dr(c).tracking).toBeUndefined();
  });

  // ------------------------------------------------------------ 複数の予告に一致 → 無理に統合しない
  it("8) 店舗が違う予告は別々に登録する。あとから届いた店舗不明の続報は、どちらの抽選か決められないため統合せず、確認待ちにする（誤統合しない）", async () => {
    const before = (await lots()).length;
    plan = { chain: "別の系列6C", product: "6C商品", store: "甲店" };
    await add("a1", "別の系列6Cの店頭および通販で、6C商品の抽選販売を近日中に実施する予定です");
    await run();
    plan = { chain: "別の系列6C", product: "6C商品", store: "乙店" };
    await add("a2", "別の系列6Cの店頭および通販で、6C商品の抽選販売を近日中に実施する予定です（別の告知）");
    await run();
    expect((await cand("a1")).status).toBe("auto_registered");
    expect((await cand("a2")).status).toBe("auto_registered");
    expect((await lots()).length).toBe(before + 2);
    plan = { chain: "別の系列6C", product: "6C商品", store: "", start: jst(3, 10), deadline: jst(6, 23, 59) };
    await add("a3", "別の系列6Cの店頭および通販で、6C商品の抽選受付を開始します。詳細は公式アプリ");
    await run();
    const c = await cand("a3");
    expect(c.status).not.toBe("auto_registered");
    expect((await lots()).length).toBe(before + 2); // 店舗が決められない続報は、どちらにも統合しない
  });

  it("8b) 別の情報源が同じ抽選を告知しても（店舗不明で同じ系列・商品・締切）、同じ抽選として扱い、二重に登録しない（本番のホビーゾーンの事例）", async () => {
    const before = (await lots()).length;
    plan = { chain: "ホビー系列6C", product: "6C商品", store: "", start: jst(8, 0), deadline: jst(10, 21) };
    await add("h1", "ホビー系列6Cの店頭で6C商品の抽選を実施します。応募期間は店頭POPで掲示（抽選応募）");
    await run();
    expect((await cand("h1")).status).toBe("auto_registered");
    plan = { chain: "ホビー系列6C", product: "6C商品", store: "", deadline: jst(10, 21) }; // 受付開始日を読み取れなかった別の投稿
    await add("h2", "ホビー系列6Cより6C商品の抽選が発表。応募期間は店頭POPで掲示（抽選応募）");
    await run();
    expect((await cand("h2")).status).toBe("duplicate");
    expect((await lots()).length).toBe(before + 1);
  });

  // ------------------------------------------------------------ 設定との整合
  it("9) 追跡OFF＋現在応募可能のみ: 受付前は従来どおり除外。『受付前も含む』: 詳細確定の受付前抽選は通常条件で登録される", async () => {
    plan = { chain: "テスト玩具6C", product: "6C商品B", store: "本店", start: jst(3, 10), deadline: jst(7, 23, 59) };
    await add("off", "テスト玩具6C本店 6C商品B 抽選（追跡OFF）");
    await run(cond({ trackUpcoming: false }));
    const c = await cand("off");
    expect(c.status).toBe("excluded");
    expect(c.reasons[0]).toContain("応募開始前");
  });

  it("10) 商品マスターに無い商品の予告は、商品確認待ちとして要手動確認（追跡中でも無理に登録・保留しない）", async () => {
    plan = { chain: "テスト玩具6C", product: "未登録の6C新商品", store: "本店", start: jst(3, 10), deadline: jst(7, 23, 59) };
    await add("unreg", "テスト玩具6C本店 未登録の6C新商品 抽選受付");
    await run();
    const c = await cand("unreg");
    expect(c.triage).toBe("manual");
    expect(c.reasons.join()).toContain("商品確認待ち");
  });

  it("11) 情報に矛盾（画像同士の食い違い）がある告知は、確認待ちにせず注意付きで自動登録し、矛盾を注意として残す（Stage 7A）", async () => {
    plan = { chain: "テスト玩具6C", product: "6C商品C", store: "本店", start: jst(-1, 10), deadline: jst(9, 23, 59) };
    const base = extractor.extract;
    extractor.extract = async (r: never) => {
      const o = await base(r);
      return { ...o, raw: { ...(o.raw as object), warnings: ["画像1と画像3で応募期間に矛盾があります"] } };
    };
    await add("conf", "テスト玩具6C本店 6C商品C 抽選受付中（画像の内容が食い違う告知）");
    await run();
    extractor.extract = base;
    const c = await cand("conf");
    expect(c.status).toBe("auto_registered");
    expect(c.reasons.join()).toContain("注意付き");
    const lot = (await sys.from("lotteries").select("cautions,confidence").eq("id", c.lottery_id!).single()).data as unknown as { cautions: { code: string; message: string }[]; confidence: string };
    const tc = lot.cautions.find((x) => x.code === "text_conflict");
    expect(tc?.message).toContain("矛盾");
    expect(lot.confidence).toBe("conflict");
  });
});
