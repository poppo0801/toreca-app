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
    await u1.from("products").insert({ household_id: hid, official_name: "6C商品", packs_per_box: 20 });
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q6c.example.invalid%");
    await cleanupTestUsers(admin, userIds);
  });

  // ------------------------------------------------------------ 予告の追跡 → 続報 → 正式登録
  it("1) 抽選予告（受付開始・締切が未発表）は、除外も要手動確認もせず、追跡候補として保持する（登録しない）", async () => {
    plan = {};
    await add("t1", "テスト玩具6Cで6C商品の抽選を近日実施予定です");
    await run();
    const c = await cand("t1");
    expect(c.status).toBe("pending");
    expect(c.job_state).toBe("review");
    expect(c.triage).toBe("auto_retry"); // 手動確認ではない
    expect(dr(c).stage).toBe("teaser");
    expect(dr(c).tracking?.since).toBeTruthy();
    expect(c.reasons[0]).toContain("抽選予告");
    expect((await lots()).length).toBe(0);
  });

  it("2) 続報（受付開始日・締切・応募URL・条件・店舗が判明）は、同じ抽選として予告の候補を更新する。別抽選として登録しない。更新履歴に情報源と日時が残る", async () => {
    plan = { store: "本店", start: jst(2, 10), deadline: jst(5, 23, 59), applyUrl: "https://shop.example.invalid/apply", conditions: "会員登録が必要" };
    await add("t2", "テスト玩具6C本店で6C商品の抽選受付を開始します。応募方法は公式アプリ https://shop.example.invalid/apply");
    await run(); // 現在応募可能のみ＋追跡ON: 受付前なので登録せず追跡を続ける
    const old = await cand("t1");
    const c = await cand("t2");
    expect(old.status).toBe("excluded"); // 続報の候補へ統合（削除しない）
    expect(old.reasons[0]).toContain("統合");
    expect(c.triage).toBe("auto_retry");
    expect(dr(c).stage).toBe("upcoming");
    expect(dr(c).tracking?.startDate).toBe(ymd(jst(2, 10)));
    const kinds = dr(c).tracking!.history.map((h) => h.kind).sort();
    expect(kinds).toEqual(["apply_url_known", "conditions_known", "deadline_known", "start_known", "store_added"]);
    expect(dr(c).tracking!.history.every((h) => h.source === U("t2") && !!h.at)).toBe(true);
    expect(dr(c).tracking!.since).toBe(dr(await cand("t1")).tracking!.since); // 追跡の開始は最初の発見
    expect(dr(c).tracking!.sources.map((s) => s.url)).toEqual([U("t1"), U("t2")]);
    expect((await lots()).length).toBe(0); // 応募可能として登録・表示されない
  });

  it("3) 追跡中は保留回数・締切の近さを理由に要手動確認へ移さず、受付前のまま除外もされない（保留の再調査）", async () => {
    const c = await cand("t2");
    await sys.from("collection_candidates").update({ hold_count: 30, next_run_at: new Date(NOW.getTime() - 60_000).toISOString() }).eq("id", c.id);
    await runHoldPass(deps(), { max: 10, timeLeft: () => 30_000 });
    const after = await cand("t2");
    expect(after.status).toBe("pending");
    expect(after.triage).toBe("auto_retry");
    expect(new Date(after.next_run_at!).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("4) 受付が始まり、詳細が確定すると、通常の登録判定で正式登録に移行する。予告の候補は同じ抽選として整理され、履歴は引き継がれる", async () => {
    plan = { store: "本店", start: jst(-1, 10), deadline: jst(4, 23, 59), applyUrl: "https://shop.example.invalid/apply", conditions: "会員登録が必要" };
    await add("t3", "テスト玩具6C本店で6C商品の抽選受付中です。応募はこちら");
    await run();
    const c = await cand("t3");
    expect(c.status, JSON.stringify({ r: c.reasons, f: Object.entries((c.draft as any).fields ?? {}).filter(([, v]: any) => v.state === "conflict").map(([k, v]: any) => [k, v.value, v.alt?.value]) })).toBe("auto_registered");
    const lotsNow = await lots();
    expect(lotsNow).toHaveLength(1);
    expect(c.lottery_id).toBe(lotsNow[0].id);
    const prev = await cand("t2");
    expect(prev.status).toBe("duplicate"); // 予告の候補は同じ抽選として整理
    expect(prev.lottery_id).toBe(lotsNow[0].id);
    expect(dr(c).tracking?.promotedLotteryId).toBe(lotsNow[0].id);
    expect(dr(c).tracking?.history.length).toBeGreaterThanOrEqual(5); // 予告からの更新履歴を引き継ぐ
    expect(dr(c).tracking?.sources.map((s) => s.url)).toEqual([U("t1"), U("t2"), U("t3")]);
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
  it("8) 同じ系列・商品の予告が複数あって決められない続報は、統合せず関連候補として保持する", async () => {
    plan = { chain: "別の系列6C", product: "6C商品", store: "甲店" };
    await add("a1", "別の系列6Cの店頭および通販で、6C商品の抽選販売を近日中に実施する予定です");
    await run();
    plan = { chain: "別の系列6C", product: "6C商品", store: "乙店" };
    await add("a2", "別の系列6Cの店頭および通販で、6C商品の抽選販売を近日中に実施する予定です（別の告知）");
    await run();
    const a1 = await cand("a1");
    expect(dr(a1).tracking, JSON.stringify({ s: a1.status, j: a1.job_state, r: a1.reasons, t: a1.triage })).toBeTruthy();
    expect(dr(await cand("a2")).tracking).toBeTruthy();
    plan = { chain: "別の系列6C", product: "6C商品", store: "", start: jst(3, 10), deadline: jst(6, 23, 59) };
    await add("a3", "別の系列6Cの店頭および通販で、6C商品の抽選受付を開始します。詳細は公式アプリ");
    await run();
    const c = await cand("a3");
    expect(dr(c).tracking?.related?.length, JSON.stringify({ s: c.status, j: c.job_state, r: c.reasons, t: c.triage, tr: dr(c).tracking })).toBe(2); // 一意に決まらないので統合しない
    expect((await cand("a1")).status).toBe("pending");
    expect((await cand("a2")).status).toBe("pending");
  });

  it("8b) 別の情報源が同じ抽選を告知し、読み取れた項目が違っても（片方に受付開始日が無くても）、同じ抽選として追跡を引き継ぐ（本番のホビーゾーンの事例）", async () => {
    plan = { chain: "ホビー系列6C", product: "6C商品", store: "", start: jst(8, 0), deadline: jst(10, 21) };
    await add("h1", "ホビー系列6Cの店頭で6C商品の抽選を実施します。応募期間は店頭POPで掲示（抽選応募）");
    await run();
    expect(dr(await cand("h1")).tracking?.startDate).toBe(ymd(jst(8, 0)));
    plan = { chain: "ホビー系列6C", product: "6C商品", store: "", deadline: jst(10, 21) }; // 受付開始日を読み取れなかった別の投稿
    await add("h2", "ホビー系列6Cより6C商品の抽選が発表。応募期間は店頭POPで掲示（抽選応募）");
    await run();
    const second = await cand("h2");
    expect(second.triage).toBe("auto_retry");
    expect(dr(second).tracking?.startDate).toBe(ymd(jst(8, 0))); // 受付開始予定を引き継ぐ
    expect(dr(second).tracking?.sources.map((s) => s.url)).toEqual([U("h1"), U("h2")]);
    expect((await cand("h1")).status).toBe("excluded"); // 同じ抽選として統合（二重に追跡しない）
    expect((await lots()).length).toBe(1); // 応募可能な抽選としては登録されない（既存の1件のみ）
  });

  // ------------------------------------------------------------ 設定との整合
  it("9) 追跡OFF＋現在応募可能のみ: 受付前は従来どおり除外。『受付前も含む』: 詳細確定の受付前抽選は通常条件で登録される", async () => {
    plan = { chain: "テスト玩具6C", product: "6C商品", store: "本店", start: jst(3, 10), deadline: jst(7, 23, 59) };
    await add("off", "テスト玩具6C本店 6C商品 抽選（追跡OFF）");
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

  it("11) 情報に矛盾（画像同士の食い違い）がある告知は、自動登録せず利用者の判断にする", async () => {
    plan = { chain: "テスト玩具6C", product: "6C商品", store: "本店", start: jst(-1, 10), deadline: jst(9, 23, 59) };
    const base = extractor.extract;
    extractor.extract = async (r: never) => {
      const o = await base(r);
      return { ...o, raw: { ...(o.raw as object), warnings: ["画像1と画像3で応募期間に矛盾があります"] } };
    };
    await add("conf", "テスト玩具6C本店 6C商品 抽選受付中（画像の内容が食い違う告知）");
    await run();
    extractor.extract = base;
    const c = await cand("conf");
    expect(c.status).not.toBe("auto_registered");
    expect(c.triage).toBe("manual");
    expect(c.reasons.join()).toContain("矛盾");
  });
});
