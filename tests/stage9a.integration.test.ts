/**
 * Stage 9A: 情報不足でも登録する収集（実Supabase・RLS適用下。AI・外部サイトはモック。有料APIなし）
 *   - 締切・受付開始が不明でも、抽選と認識できれば注意付きで登録（日時は推測しない）
 *   - 憶測・未確定の表現の告知、抽選の文言が無い告知は登録しない
 *   - 続報（同じ店舗・同じ商品）で、不明だった日時を自動補完し、注意を解除する。二重に登録しない
 *   - 手動で編集された抽選は、自動補完が上書きしない。応募・当選の記録・通知設定は変わらない
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

describe.skipIf(!dbTestsEnabled)("Stage 9A", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  type Plan = { store?: string; product?: string; start?: object; deadline?: object; conditions?: string; chain?: string; lottery?: boolean };
  let plan: Plan = {};
  const U = (n: string) => `https://q9a.example.invalid/${n}`;
  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r);
      const raw = JSON.parse(JSON.stringify(o.raw)) as Record<string, unknown>;
      raw.is_lottery_announcement = plan.lottery !== false;
      raw.chain_name = plan.chain ?? "テスト玩具9A";
      raw.store_name = plan.store ?? "本店";
      raw.products = [{ name: plan.product ?? "9A商品", code: "", quantity: 1, unit: "box" }];
      raw.apply_start = plan.start ?? none;
      raw.apply_deadline = plan.deadline ?? none;
      raw.result_date = none;
      raw.apply_url = "";
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
  const run = async () => processQueue(deps(), { settings: { auto_register: true }, cond: cond(), data: await loadAppData(sys, hid), aiLeft: 5, timeLeft: () => 50_000, perBatch: 4 });
  const add = (n: string, card: string) =>
    sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: U(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: U(n), title: `【${n}】`, context: card, card, sourceName: "pokecachan", attempts: 0 } } as never });
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,job_state,triage,reasons,lottery_id").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const lots = async () => (await sys.from("lotteries").select("id").eq("household_id", hid).is("archived_at", null)).data ?? [];
  const lotRow = async (id: string) => (await sys.from("lotteries").select("cautions,apply_deadline_precision,apply_deadline_at,conditions_text,updated_at,cautions_updated_at").eq("id", id).single()).data as unknown as { cautions: { code: string }[]; apply_deadline_precision: string; apply_deadline_at: string | null; conditions_text: string | null; updated_at: string; cautions_updated_at: string | null };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9a", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
    const chainId = (await u1.from("chains").insert({ household_id: hid, name: "テスト玩具9A" }).select("id").single()).data!.id;
    await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "本店", prefecture: "東京都" });
    await u1.from("products").insert(["9A商品", "9A商品B"].map((n) => ({ household_id: hid, official_name: n, packs_per_box: 20 })));
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q9a.example.invalid%");
    await cleanupTestUsers(admin, userIds);
  });

  it("1) 締切も受付開始も不明な抽選告知を、確認待ちにせず注意付きで登録する。日時は推測で入れず、『未確認』の注意として保持する", async () => {
    plan = {};
    await add("u1", "テスト玩具9A本店で9A商品の抽選を実施予定です。応募方法は店頭で案内します");
    await run();
    const c = await cand("u1");
    expect(c.status, JSON.stringify(c.reasons)).toBe("auto_registered");
    expect(c.triage).toBe("auto_register");
    const l = await lotRow(c.lottery_id!);
    expect(l.apply_deadline_precision).toBe("unknown");
    expect(l.apply_deadline_at).toBeNull();
    expect(l.cautions.map((x) => x.code)).toContain("deadline_unknown");
  });

  it("2) 続報（同じ店舗・同じ商品）で締切が分かると、同じ抽選を自動補完する。二重に登録せず、『未確認』の注意が解除される。応募・当選の記録は変わらない", async () => {
    const target = (await cand("u1")).lottery_id!;
    // 応募の記録を先に作っておき、補完後も変わらないことを確認する
    await mkApplication(sys, hid, (await sys.from("lotteries").select("chain_id").eq("id", target).single()).data!.chain_id as string, target);
    const appsBefore = (await sys.from("applications").select("id,state,result").eq("lottery_id", target).order("id")).data;
    plan = { start: jst(-1, 10), deadline: jst(5, 23, 59), conditions: "会員登録が必要" };
    await add("u2", "テスト玩具9A本店で9A商品の抽選受付中です。応募期限あり");
    await run();
    const c2 = await cand("u2");
    expect(c2.status, JSON.stringify(c2.reasons)).toBe("duplicate");
    expect(c2.lottery_id).toBe(target);
    expect(await lots()).toHaveLength(1);
    const l = await lotRow(target);
    expect(l.apply_deadline_precision).not.toBe("unknown");
    expect(l.cautions.map((x) => x.code)).not.toContain("deadline_unknown");
    expect((await sys.from("applications").select("id,state,result").eq("lottery_id", target).order("id")).data).toEqual(appsBefore);
  });

  it("3) 手動で編集された抽選は、自動補完が上書きしない（手動で入れた締切・条件は保護される）", async () => {
    plan = { product: "9A商品B" };
    await add("m1", "テスト玩具9A本店で9A商品Bの抽選を実施予定です");
    await run();
    const c = await cand("m1");
    expect(c.status).toBe("auto_registered");
    const id = c.lottery_id!;
    // 利用者が手動で編集した状態（最終更新が、自動処理の更新（cautions_updated_at）より十分後）にする。updated_at は更新時にDBが現在時刻にするため、自動処理の時刻の側を過去にする
    await sys.from("lotteries").update({ cautions_updated_at: new Date(Date.now() - 10 * 60_000).toISOString() } as never).eq("id", id);
    await sys.from("lotteries").update({ conditions_text: "手動で入力した条件" } as never).eq("id", id);
    const pre = await lotRow(id);
    plan = { product: "9A商品B", start: jst(-1, 10), deadline: jst(6, 23, 59), conditions: "自動収集の条件" };
    await add("m2", "テスト玩具9A本店で9A商品Bの抽選受付中です");
    await run();
    const l = await lotRow(id);
    const m2 = await cand("m2");
    expect(l.apply_deadline_precision, JSON.stringify({ pre: [pre.updated_at, pre.cautions_updated_at], st: m2.status, r: m2.reasons, lot: m2.lottery_id, id })).toBe("unknown");
    expect(l.conditions_text).toBe("手動で入力した条件");
    expect(l.apply_deadline_precision).toBe("unknown"); // 手動編集された抽選は補完しない（利用者が決める）
  });

  it("4) 憶測・未確定の表現（模様・噂など）で日時も不明な告知は、確定した抽選と判断できないため登録しない（追跡・再調査）。抽選の文言が無い告知は登録しない", async () => {
    const before = (await lots()).length;
    plan = { product: "9A商品", chain: "憶測系列9A", store: "" };
    await add("s1", "憶測系列9Aで9A商品の抽選があるらしい（詳細不明の模様）");
    await run();
    const c = await cand("s1");
    expect(c.status).not.toBe("auto_registered");
    expect(c.triage).not.toBe("manual"); // 人の確認ではなく、自動の再調査
    plan = { product: "9A商品", chain: "テスト玩具9A", store: "本店", lottery: false };
    await add("n1", "テスト玩具9A本店で9A商品が11月に発売されます");
    await run();
    expect((await cand("n1")).status).not.toBe("auto_registered");
    expect((await lots()).length).toBe(before);
  });
});
