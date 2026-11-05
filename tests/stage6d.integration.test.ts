/**
 * Stage 6D: 複数情報源の項目単位の統合・補足投稿の紐付け・情報充実度・低情報量の扱い（実Supabase・RLS適用下。AI・外部サイトはモック）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { runHoldPass } from "@/lib/server/collector/hold";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const jst = (offsetDays: number, hour: number, minute = 0) => {
  const d = new Date(NOW.getTime() + offsetDays * 86400_000 + 9 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute };
};
const none = { year: null, month: null, day: null, hour: null, minute: null };

describe.skipIf(!dbTestsEnabled)("Stage 6D", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  type Plan = { chain?: string; store?: string; product?: string | null; deadline?: object; start?: object; result?: object; apply?: string; applyUrl?: string; conditions?: string; receive?: string; announce?: string };
  let plan: Plan = {};

  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r);
      const raw = JSON.parse(JSON.stringify(o.raw)) as Record<string, unknown>;
      raw.is_lottery_announcement = true;
      raw.chain_name = plan.chain ?? "統合系列6D";
      raw.store_name = plan.store ?? "";
      raw.products = plan.product === null ? [] : [{ name: plan.product ?? "6D商品", code: "", quantity: 1, unit: "box" }];
      raw.apply_start = plan.start ?? none;
      raw.apply_deadline = plan.deadline ?? none;
      raw.result_date = plan.result ?? none;
      raw.apply_method = plan.apply ?? "unknown";
      raw.apply_url = plan.applyUrl ?? "";
      raw.conditions_text = plan.conditions ?? "";
      raw.receive_method = plan.receive ?? "unknown";
      raw.announcement_method = plan.announce ?? "";
      raw.confidence = { ...(raw.confidence as object), apply_method: "high" };
      raw.notes = "";
      raw.warnings = [];
      return { ...o, raw };
    },
  };
  const deps = (): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: NOW, actor: null, canRegister: false, serviceRegister: true, extractor: extractor as never, xClient: null,
    fetchPage: async () => ({ ok: false, code: "robots", message: "robots" }), fetchOembed: async () => ({ ok: false, message: "x" }),
  });
  const run = async () => processQueue(deps(), { settings: { auto_register: true }, cond: { ...DEFAULT_CONDITIONS, prefectures: ["東京都"], statusMode: "open_or_before" }, data: await loadAppData(sys, hid), aiLeft: 5, timeLeft: () => 50_000, perBatch: 4 });
  const U = (n: string) => `https://q6d.example.invalid/${n}`;
  const addWeb = (n: string, card: string) =>
    sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: U(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: U(n), title: `【${n}】`, context: card, card, sourceName: "pokeso", attempts: 0 } } as never });
  const addX = (id: string, user: string, text: string, quotedId?: string) =>
    sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: `x:${id}`, source_url: `https://x.com/${user}/status/${id}`, x_post_id: id, title: text.slice(0, 40), status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "x_post", url: `https://x.com/${user}/status/${id}`, title: text.slice(0, 40), context: "", sourceName: user, attempts: 0, post: { id, text, images: [], links: [], createdAt: NOW.toISOString(), username: user, ...(quotedId ? { quoted: { id: quotedId, username: user, text: "", createdAt: NOW.toISOString(), images: [], links: [] } } : {}) } } } as never });
  const candBy = async (key: string) => (await sys.from("collection_candidates").select("id,status,job_state,triage,reasons,draft,lottery_id,hold_count,next_run_at").eq("household_id", hid).eq("dedupe_key", key).maybeSingle()).data!;
  type D = { assessment?: { rank: string; conflict: string | null; missing: string[]; reasons: string[] }; fields?: Record<string, { state: string; source: { url: string; kind: string }; value: string; alt?: unknown }>; mergeLog?: { kind: string; filled: string[] }[]; input?: { conditionsText: string; applyMethod: string; resultDate: { date: string }; applyDeadline: { date: string }; receiveMethod: string }; related?: string[]; mergedInto?: string; xpost?: { id: string } };
  const dr = (c: { draft: unknown }) => c.draft as D;
  const lots = async () => (await sys.from("lotteries").select("id,result_date,result_at,apply_method,receive_method,conditions_text").eq("household_id", hid).is("archived_at", null)).data ?? [];

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6d", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
    const chainId = (await u1.from("chains").insert({ household_id: hid, name: "統合系列6D" }).select("id").single()).data!.id;
    const storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "本店", prefecture: "東京都" }).select("id").single()).data!.id;
    await u1.from("products").insert({ household_id: hid, official_name: "6D商品", packs_per_box: 20 });
    // 店舗の公式Xアカウントの対応づけ（利用者が登録したものだけを公式として扱う）
    await u1.from("x_account_links").insert({ household_id: hid, username: "q6d_official", role: "official_store", store_id: storeId });
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q6d.example.invalid%");
    await sys.from("collection_candidates").delete().like("dedupe_key", "x:911%");
    await cleanupTestUsers(admin, userIds);
  });

  it("1) 複数情報源の項目補完: まとめサイトの候補に無い項目（応募締切・応募方法・応募URL）を、公式Xの候補から項目単位で補い、登録可能になる。項目ごとの出典が残る", async () => {
    // まとめサイト由来（取得制限のため一覧カードから解析＝二次情報）: 店舗・商品・当落発表日・受取方法・条件は分かるが、応募締切・応募方法が無い
    plan = { store: "本店", result: jst(9, 0), receive: "store", conditions: "会員登録が必要" };
    await addWeb("list1", "統合系列6D 本店 6D商品 抽選販売 当選発表あり 会員登録が必要 店頭受取");
    await run();
    const a = await candBy(U("list1"));
    expect(a.status).toBe("pending"); // 応募締切が無く、登録できない
    expect(dr(a).assessment?.rank).toBe("D"); // 系列・店舗・商品は分かるが、応募期間・応募先がどちらも不明
    expect(dr(a).fields?.resultDate?.source.kind).toBe("list_site");
    expect(dr(a).fields?.resultDate?.state).toBe("unverified");
    // 店舗公式Xの投稿（公式アカウント）: 応募締切・応募方法・応募URLがある
    plan = { store: "本店", deadline: jst(5, 23, 59), apply: "web", applyUrl: "https://shop6d.example.invalid/apply" };
    await addX("911000001", "q6d_official", "統合系列6D 本店で6D商品の抽選受付中。応募期間は11月末まで。応募はこちら https://shop6d.example.invalid/apply");
    await run();
    const b = await candBy("x:911000001");
    expect(b.status).toBe("auto_registered"); // 補完の結果、登録条件を満たした
    expect(dr(b).mergeLog?.[0]).toMatchObject({ kind: "same_lottery" });
    expect(dr(b).mergeLog?.[0].filled.sort()).toEqual(["conditions", "receiveMethod", "resultDate"].sort());
    expect(dr(b).fields?.applyDeadline).toMatchObject({ state: "confirmed" });
    expect(dr(b).fields?.applyDeadline?.source).toMatchObject({ kind: "official_x" });
    expect(dr(b).fields?.resultDate?.source).toMatchObject({ kind: "list_site", url: U("list1") }); // 補った項目の出典は元の情報源
    const old = await candBy(U("list1"));
    expect(old.status).toBe("duplicate"); // 統合済みの候補は、同じ抽選として整理（削除せず残す）
    expect(old.lottery_id).toBe(b.lottery_id);
    expect(old.reasons[0]).toContain("続報");
    const l = await lots();
    expect(l).toHaveLength(1);
    expect(l[0].apply_method).toBe("web");
    expect(l[0].result_date ?? l[0].result_at).toBeTruthy(); // 他の情報源から補った項目が抽選に入っている
    expect(l[0].conditions_text).toContain("会員登録");
  });

  it("2) 情報源間で食い違う項目（受取方法）は、どちらにも決めず矛盾として記録し、自動登録せず確認待ちに残す。情報充実度は下げない", async () => {
    plan = { chain: "統合系列6D", store: "本店", product: "6D商品2", deadline: jst(6, 23, 59), receive: "store" };
    await sys.from("products").insert({ household_id: hid, official_name: "6D商品2", packs_per_box: 20 });
    // 先の候補は応募方法が不明のため登録できない…ではなく、ここでは締切が無い候補で保留にする
    plan = { store: "本店", product: "6D商品2", receive: "store", conditions: "会員登録が必要" };
    await addWeb("conf1", "統合系列6D 本店 6D商品2 抽選 店頭受取 会員登録が必要");
    await run();
    plan = { store: "本店", product: "6D商品2", deadline: jst(6, 23, 59), apply: "web", receive: "shipping" };
    await addX("911000002", "q6d_official", "統合系列6D 本店で6D商品2の抽選受付中（配送でお届け）");
    await run();
    const b = await candBy("x:911000002");
    expect(b.status).toBe("pending");
    expect(dr(b).fields?.receiveMethod?.state).toBe("conflict");
    expect(dr(b).assessment?.conflict).toContain("受取方法");
    expect(["A", "B"]).toContain(dr(b).assessment?.rank); // 情報は揃っている（ランクは下げず、矛盾を別に示す）
    expect(b.reasons.join()).toContain("食い違う項目");
    expect((await lots()).length).toBe(1); // 登録されない（1件目のみ）
  });

  it("3) 補足投稿（応募条件だけを説明する投稿）は、引用元の投稿で対象が一意に特定できれば、商品・締切が無くても既存候補へ補完する", async () => {
    plan = { chain: "統合系列6D", store: "本店", product: "6D商品3", start: jst(0, 10), result: jst(9, 0) };
    await sys.from("products").insert({ household_id: hid, official_name: "6D商品3", packs_per_box: 20 });
    await addX("911000010", "q6d_official", "統合系列6D 本店で6D商品3の抽選を開始。当選発表は後日");
    await run();
    const target = await candBy("x:911000010");
    expect(target.status).toBe("pending");
    expect(dr(target).xpost?.id).toBe("911000010");
    // 補足投稿: 購入履歴の条件だけ。商品・締切・店舗は書かれていない。元の投稿を引用している
    plan = { chain: "", store: "", product: null, conditions: "過去に購入履歴のある方のみ応募可能です" };
    await addX("911000011", "q6d_official", "【補足】応募には購入履歴が必要です", "911000010");
    await run();
    const sup = await candBy("x:911000011");
    expect(sup.status).toBe("excluded");
    expect(sup.reasons[0]).toContain("補足投稿");
    expect(dr(sup).mergedInto).toBe(target.id);
    const after = await candBy("x:911000010");
    expect(dr(after).input?.conditionsText).toContain("購入履歴");
    expect(dr(after).mergeLog?.[0]).toMatchObject({ kind: "supplement" });
    expect(dr(after).fields?.conditions?.source.url).toContain("911000011");
  });

  it("4) 補足投稿の対象が複数あって一意に決まらない場合は、自動補完せず関連候補として記録する（同じアカウントというだけでは統合しない）", async () => {
    plan = { chain: "統合系列6D", store: "本店", product: "6D商品3", start: jst(1, 10), result: jst(9, 0) };
    await addX("911000020", "q6d_official", "統合系列6D 本店で6D商品3の抽選（別の回）");
    await run();
    plan = { chain: "統合系列6D", store: "", product: null, conditions: "メルマガ会員限定です" };
    await addX("911000021", "q6d_official", "【補足】メルマガ会員限定の抽選です");
    await run();
    const sup = await candBy("x:911000021");
    // 同じ公式アカウント・同じ系列の候補が複数あるため、一意に特定できない
    expect(sup.status).toBe("pending");
    expect((dr(sup).related ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("5) 情報充実度 D・E の候補は、要手動確認へ送らず、低優先度の自動追跡・再調査にとどめる", async () => {
    plan = { chain: "低情報系列6D", store: "", product: "6D商品" };
    await addWeb("low1", "低情報系列6D 6D商品 抽選を予定している模様（詳細不明の情報です。続報をお待ちください）");
    await run();
    const c = await candBy(U("low1"));
    expect(["D", "E"]).toContain(dr(c).assessment?.rank);
    // 保留回数が上限を超えても、要手動確認にはならない
    await sys.from("collection_candidates").update({ hold_count: 20, next_run_at: new Date(NOW.getTime() - 60_000).toISOString(), triage: "auto_retry" }).eq("id", c.id);
    await runHoldPass(deps(), { max: 10, timeLeft: () => 30_000 });
    const after = await candBy(U("low1"));
    expect(after.triage).toBe("auto_retry");
    expect(after.status).toBe("pending");
  });

  it("6) 別店舗の抽選は統合しない（同じ系列・商品・締切でも店舗が違う）", async () => {
    plan = { chain: "統合系列6D", store: "甲店6D", product: "6D商品2", deadline: jst(7, 23, 59), apply: "web", receive: "store" };
    await addWeb("shopA", "統合系列6D 甲店6D 6D商品2 抽選 応募期間あり 店頭受取（甲店の告知）");
    await run();
    plan = { chain: "統合系列6D", store: "乙店6D", product: "6D商品2", deadline: jst(7, 23, 59), apply: "web", receive: "store" };
    await addWeb("shopB", "統合系列6D 乙店6D 6D商品2 抽選 応募期間あり 店頭受取（乙店の告知）");
    await run();
    const a = await candBy(U("shopA"));
    const b = await candBy(U("shopB"));
    expect(a.status).not.toBe("excluded");
    expect(b.status).not.toBe("excluded");
    expect(dr(b).mergeLog).toBeUndefined();
  });
});
