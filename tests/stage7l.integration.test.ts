/**
 * Stage 7L の結合テスト（実Supabase・RLS適用下・架空データのみ。AI・外部サイト・有料APIは使わない）:
 *  - 店舗別の一括登録（save_lottery_bulk_tx）: 店舗ごとに独立した抽選・グループ関連づけ・冪等性（同じ操作ID）・重複店舗の除外・途中失敗で全体取り消し・世帯の分離・個別編集
 *  - 除外理由つきの除外: 信頼性なし（系列を名称・別名から特定／未登録なら仮登録／情報元のみ）・重複（店舗が異なれば統合しない・参照の保持・系列の別名の登録）
 *   npm run test:db   ※ マイグレーション 20261205000087 の適用後に実行する
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { excludeWithReason } from "@/lib/server/collector/exclusion-reasons";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { loadAppData, saveLottery, saveLotteryBulk, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7L", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・関数は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7l", 1);
    const b = await signInTestUser(admin, "s7l", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    actor = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
  });
  afterAll(async () => {
    const hs = (await admin.from("households").select("id").in("owner_auth_user_id", ids)).data ?? [];
    const hh = hs.map((h) => h.id);
    for (const t of ["collection_exclusion_log", "collection_exclusions", "collection_rules"]) await admin.from(t as never).delete().in("household_id", hh);
    await cleanupTestUsers(admin, ids);
  });

  const mkChain = async (name: string) => (await u1.from("chains").insert({ household_id: h1, name } as never).select("id").single()).data!.id as string;
  const mkStore = async (chainId: string, name: string, prefecture = "兵庫県") => (await u1.from("stores").insert({ household_id: h1, chain_id: chainId, name, prefecture } as never).select("id").single()).data!.id as string;
  const mkProduct = async (name: string) => (await u1.from("products").insert({ household_id: h1, official_name: name, packs_per_box: 20 } as never).select("id").single()).data!.id as string;
  const input = (chain: string, product: string, over: Record<string, unknown> = {}) =>
    lotteryInputSchema.parse({
      chain: { id: chain, name: "" },
      store: { id: null, name: "", prefecture: "" },
      campaignId: null,
      newCampaign: null,
      items: [{ product: { id: product, name: "" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "date_only", date: "2099-01-01", time: "" },
      applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" },
      resultDate: { precision: "date_only", date: "2099-01-15", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" },
      receiveMethod: "store",
      applyMethod: "web",
      conditionsText: "共通の条件",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: ["https://example.invalid/7l/common"],
      eventState: "open",
      limitBasis: "account",
      limitMaxCount: 1,
      memo: "共通メモ",
      ...over,
    });
  const perStore = (base: ReturnType<typeof input>, stores: { id: string | null; name: string }[]) => stores.map((s) => ({ ...base, store: { id: s.id, name: s.name, prefecture: "" } }));

  describe("店舗別の一括登録", () => {
    it("選んだ店舗ごとに独立した抽選が作られ、共通情報が複製され、同じグループに関連づく。各抽選のIDは別で、応募状態は店舗ごとに独立", async () => {
      const chain = await mkChain("7L一括電機A");
      const product = await mkProduct("7L一括商品A");
      const [s1, s2, s3] = [await mkStore(chain, "7L神戸三宮店"), await mkStore(chain, "7L日本橋店", "大阪府"), await mkStore(chain, "7L京都店", "京都府")];
      const base = input(chain, product);
      const op = randomUUID();
      const res = await saveLotteryBulk(u1, perStore(base, [{ id: s1, name: "7L神戸三宮店" }, { id: s2, name: "7L日本橋店" }, { id: s3, name: "7L京都店" }]), op, null, actor);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;
      expect(res.value.ids).toHaveLength(3);
      expect(new Set(res.value.ids).size).toBe(3); // 独立したID
      expect(res.value.replayed).toBe(false);
      const lots = (await u1.from("lotteries").select("id,store_id,chain_id,memo,conditions_text,source_urls,store_mode,apply_deadline_date,registration_path").in("id", res.value.ids)).data!;
      expect(lots.map((l) => l.store_id).sort()).toEqual([s1, s2, s3].sort()); // 店舗ごとに1件
      expect(lots.every((l) => l.chain_id === chain && l.memo === "共通メモ" && l.conditions_text === "共通の条件" && l.apply_deadline_date === "2099-01-10" && l.store_mode === "fixed")).toBe(true);
      expect(lots.every((l) => (l.source_urls as string[]).includes("https://example.invalid/7l/common"))).toBe(true);
      // 商品明細も店舗ごとに独立
      const items = (await u1.from("lottery_items").select("id,lottery_id,product_id").in("lottery_id", res.value.ids)).data!;
      expect(items).toHaveLength(3);
      expect(new Set(items.map((i) => i.id)).size).toBe(3);
      // 同じグループ（グループIDで関連づけ）
      const grp = (await x(u1).from("lotteries").select("id,bulk_group_id").in("id", res.value.ids)).data as { id: string; bulk_group_id: string }[];
      expect(new Set(grp.map((g) => g.bulk_group_id)).size).toBe(1);
      expect(grp[0].bulk_group_id).toBe(res.value.groupId);
      expect((await x(u1).from("lottery_bulk_groups").select("store_count,op_id").eq("id", res.value.groupId).single()).data).toMatchObject({ store_count: 3, op_id: op });
      // 管理対象（★）は店舗ごと
      expect(((await u1.from("lottery_management").select("lottery_id").in("lottery_id", res.value.ids)).data ?? []).length).toBe(3);

      // 応募状態は店舗ごとに独立（1店舗に応募しても、他の店舗の応募状況は変わらない）
      const acc = (await u1.from("service_accounts").select("id").eq("chain_id", chain).limit(1)).data?.[0]?.id ?? (await u1.from("service_accounts").insert({ household_id: h1, chain_id: chain, identity_id: (await u1.from("identities").select("id").limit(1)).data?.[0]?.id, managed_by_profile_id: actor, account_label: "7L" } as never).select("id").single()).data?.id;
      if (acc) {
        await u1.from("applications").insert({ household_id: h1, lottery_id: res.value.ids[0], service_account_id: acc, state: "applied", result_status: "pending", fulfillment_status: "none" } as never);
        const apps = (await u1.from("applications").select("lottery_id").in("lottery_id", res.value.ids)).data!;
        expect(apps.map((a) => a.lottery_id)).toEqual([res.value.ids[0]]);
      }
      // 1店舗だけ編集しても、他の店舗は変わらない
      expect((await u1.from("lotteries").update({ apply_deadline_date: "2099-01-20" } as never).eq("id", res.value.ids[1])).error).toBeNull();
      const after = (await u1.from("lotteries").select("id,apply_deadline_date").in("id", res.value.ids)).data!;
      expect(after.filter((l) => l.apply_deadline_date === "2099-01-20").map((l) => l.id)).toEqual([res.value.ids[1]]);
    });

    it("同じ操作ID（再送・再実行）では二重に登録されず、作成済みの結果を返す", async () => {
      const chain = await mkChain("7L一括電機B");
      const product = await mkProduct("7L一括商品B");
      const s1 = await mkStore(chain, "7L梅田店");
      const s2 = await mkStore(chain, "7Lなんば店");
      const stores = [{ id: s1, name: "7L梅田店" }, { id: s2, name: "7Lなんば店" }];
      const op = randomUUID();
      const first = await saveLotteryBulk(u1, perStore(input(chain, product), stores), op, null, actor);
      const again = await saveLotteryBulk(u1, perStore(input(chain, product), stores), op, null, actor);
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;
      expect(again.value.replayed).toBe(true);
      expect(again.value.ids.sort()).toEqual(first.value.ids.sort());
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(2);
    });

    it("登録済みの同じ店舗・同じ商品の抽選は、新規登録の対象から除かれる（既存の応募履歴は変わらない）。全店舗が登録済みなら登録しない", async () => {
      const chain = await mkChain("7L一括電機C");
      const product = await mkProduct("7L一括商品C");
      const s1 = await mkStore(chain, "7L三宮店");
      const s2 = await mkStore(chain, "7L元町店");
      const s3 = await mkStore(chain, "7L新神戸店");
      const base = input(chain, product);
      const first = await saveLotteryBulk(u1, perStore(base, [{ id: s1, name: "7L三宮店" }]), randomUUID(), null, actor);
      expect(first.ok).toBe(true);
      const second = await saveLotteryBulk(u1, perStore(base, [{ id: s1, name: "7L三宮店" }, { id: s2, name: "7L元町店" }, { id: s3, name: "7L新神戸店" }]), randomUUID(), null, actor);
      expect(second.ok, JSON.stringify(second)).toBe(true);
      if (!second.ok || !first.ok) return;
      expect(second.value.ids).toHaveLength(2);
      expect(second.value.skipped.map((s) => s.storeName)).toEqual(["7L三宮店"]);
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain).eq("store_id", s1)).data ?? []).length).toBe(1); // 三宮店は1件のまま
      const all = await saveLotteryBulk(u1, perStore(base, [{ id: s1, name: "7L三宮店" }]), randomUUID(), null, actor);
      expect(all.ok).toBe(false);
    });

    it("名称だけで入力された店舗が、同じ系列の既存店舗と同じなら既存の店舗として扱う（重複登録・重複店舗を作らない）。新しい店舗は店舗マスターに作られる", async () => {
      const chain = await mkChain("7L一括電機D");
      const product = await mkProduct("7L一括商品D");
      const s1 = await mkStore(chain, "7L姫路店");
      const base = input(chain, product);
      await saveLotteryBulk(u1, perStore(base, [{ id: s1, name: "7L姫路店" }]), randomUUID(), null, actor);
      const res = await saveLotteryBulk(u1, perStore(base, [{ id: null, name: "7L姫路店" }, { id: null, name: "7L新規の店" }]), randomUUID(), null, actor);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;
      expect(res.value.skipped.map((s) => s.storeName)).toEqual(["7L姫路店"]);
      expect(res.value.ids).toHaveLength(1);
      expect(((await u1.from("stores").select("id").eq("chain_id", chain).eq("name", "7L姫路店")).data ?? []).length).toBe(1);
      expect(((await u1.from("stores").select("id").eq("chain_id", chain).eq("name", "7L新規の店")).data ?? []).length).toBe(1);
    });

    it("途中で失敗したら全体を取り消す（不完全な一括登録を残さない）。同じ操作IDで再実行しても重複しない", async () => {
      const chain = await mkChain("7L一括電機E");
      const otherChain = await mkChain("7L別の系列");
      const product = await mkProduct("7L一括商品E");
      const s1 = await mkStore(chain, "7L明石店");
      const sOther = await mkStore(otherChain, "7L別系列の店"); // 別の系列の店舗 → 保存関数が拒否する
      const op = randomUUID();
      const res = await saveLotteryBulk(u1, perStore(input(chain, product), [{ id: s1, name: "7L明石店" }, { id: sOther, name: "7L別系列の店" }]), op, null, actor);
      expect(res.ok).toBe(false);
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(0); // 先に処理した明石店も残らない
      expect((await x(u1).from("lottery_bulk_groups").select("id").eq("op_id", op)).data).toHaveLength(0);
      // 正しい内容で再実行できる
      const ok = await saveLotteryBulk(u1, perStore(input(chain, product), [{ id: s1, name: "7L明石店" }]), op, null, actor);
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
    });

    it("入力の検証: 同じ店舗の重複選択・30店舗超・新しいキャンペーンの同時作成・店舗指定方式の誤りは拒否する", async () => {
      const chain = await mkChain("7L一括電機F");
      const product = await mkProduct("7L一括商品F");
      const s1 = await mkStore(chain, "7L加古川店");
      const base = input(chain, product);
      expect((await saveLotteryBulk(u1, perStore(base, [{ id: s1, name: "a" }, { id: s1, name: "a" }]), randomUUID(), null, actor)).ok).toBe(false);
      expect((await saveLotteryBulk(u1, [], randomUUID(), null, actor)).ok).toBe(false);
      expect((await saveLotteryBulk(u1, Array.from({ length: 31 }, (_, i) => ({ ...base, store: { id: null, name: `店${i}`, prefecture: "" } })), randomUUID(), null, actor)).ok).toBe(false);
      expect((await saveLotteryBulk(u1, perStore({ ...base, newCampaign: { name: "x", storeRule: "multi" } }, [{ id: s1, name: "a" }]), randomUUID(), null, actor)).ok).toBe(false);
      expect((await saveLotteryBulk(u1, perStore({ ...base, storeMode: "select_on_apply" }, [{ id: s1, name: "a" }]), randomUUID(), null, actor)).ok).toBe(false);
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(0);
    });

    it("抽選候補からの一括登録: 候補IDがグループに残る。世帯の分離（他の世帯からグループは見えない）", async () => {
      const chain = await mkChain("7L一括電機G");
      const product = await mkProduct("7L一括商品G");
      const s1 = await mkStore(chain, "7L尼崎店");
      const cand = (await u1.from("collection_candidates").insert({ household_id: h1, dedupe_key: "https://s7l.example.invalid/c1", source_url: "https://s7l.example.invalid/c1", title: "7L候補", status: "pending", job_state: "review", kind: "new", reasons: ["要確認"] } as never).select("id").single()).data!.id as string;
      const res = await saveLotteryBulk(u1, perStore(input(chain, product), [{ id: s1, name: "7L尼崎店" }]), randomUUID(), cand, actor);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const g = (await x(u1).from("lottery_bulk_groups").select("candidate_id").eq("id", res.value.groupId).single()).data;
      expect(g.candidate_id).toBe(cand);
      expect((await x(u2).from("lottery_bulk_groups").select("id").eq("id", res.value.groupId)).data).toHaveLength(0);
      expect((await x(u2).from("lotteries").select("id").in("id", res.value.ids)).data).toHaveLength(0);
      // 既存の通常登録（店舗固定）は従来どおり
      const single = await saveLottery(u1, h1, null, perStore(input(chain, product, { sourceUrls: [] }), [{ id: await mkStore(chain, "7L西宮店"), name: "7L西宮店" }])[0], actor);
      expect(single.ok).toBe(true);
      const app = await loadAppData(u1, h1);
      expect(app.lotteries.filter((l) => l.chainId === chain)).toHaveLength(2);
    });
  });

  describe("除外理由つきの除外（信頼性なし・重複）", () => {
    const mkCand = async (n: string, draft: Record<string, unknown> | null = null) =>
      (await u1.from("collection_candidates").insert({ household_id: h1, dedupe_key: `https://s7l.example.invalid/${n}`, source_url: `https://s7l.example.invalid/${n}`, title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], ...(draft ? { draft } : {}) } as never).select("id").single()).data!.id as string;

    it("信頼性なし（系列）: 情報源が不明でも、系列名から系列マスターと照合して系列単位のルールを作る。別名でも特定でき、別の系列は除外対象にならない", async () => {
      const chain = await mkChain("7L除外対象系列");
      const other = await mkChain("7L無関係な系列");
      await x(u1).from("chain_aliases").insert({ household_id: h1, chain_id: chain, alias: "7L除外略称", normalized_alias: "7l除外略称" });
      const c = await mkCand("u1");
      const r = await excludeWithReason(u1, h1, c, actor, { reason: "untrusted", target: "chain", key: "", chainName: "7L除外略称", label: "7L除外略称" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const rule = (await x(u1).from("collection_exclusions").select("scope,key,chain_id,reason_code,active").eq("household_id", h1).eq("scope", "chain")).data as { key: string; chain_id: string; active: boolean }[];
      expect(rule.map((x) => x.key)).toContain(chain); // 別名から系列IDに解決
      expect(rule.map((x) => x.key)).not.toContain(other); // 無関係な系列は対象外
      // 候補は削除されず（除外状態）、履歴が残る
      expect((await u1.from("collection_candidates").select("status").eq("id", c).single()).data!.status).toBe("excluded");
      expect(((await x(u1).from("collection_exclusion_log").select("id,reason_code,rule_id").eq("candidate_id", c)).data ?? []).length).toBe(1);
      // 同じ系列を重ねて除外しても、ルールは1件のまま
      const c2 = await mkCand("u2");
      const r2 = await excludeWithReason(u1, h1, c2, actor, { reason: "untrusted", target: "chain", key: chain, label: "7L除外対象系列" });
      expect(r2.ok).toBe(true);
      expect(((await x(u1).from("collection_exclusions").select("id").eq("household_id", h1).eq("scope", "chain").eq("key", chain)).data ?? []).length).toBe(1);
    });

    it("信頼性なし（系列）: マスター未登録の系列は、利用者が確認したときだけ仮登録して除外する。確認が無ければルールを作らない", async () => {
      const c = await mkCand("u3");
      const refuse = await excludeWithReason(u1, h1, c, actor, { reason: "untrusted", target: "chain", key: "", chainName: "7L未登録の新系列", label: "7L未登録の新系列" });
      expect(refuse.ok).toBe(false);
      expect((await u1.from("collection_candidates").select("status").eq("id", c).single()).data!.status).toBe("pending"); // 除外されない
      expect(((await u1.from("chains").select("id").eq("name", "7L未登録の新系列")).data ?? []).length).toBe(0);
      const done = await excludeWithReason(u1, h1, c, actor, { reason: "untrusted", target: "chain", key: "", chainName: "7L未登録の新系列", label: "7L未登録の新系列", registerChain: true });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      const created = (await u1.from("chains").select("id,is_provisional").eq("name", "7L未登録の新系列")).data!;
      expect(created).toHaveLength(1);
      expect(created[0].is_provisional).toBe(true);
      expect(((await x(u1).from("collection_exclusions").select("id").eq("household_id", h1).eq("scope", "chain").eq("key", created[0].id)).data ?? []).length).toBe(1);
    });

    it("信頼性なし（情報元）: Xアカウントだけを除外できる（系列のルールは作らない）。共通の応募サービスのドメイン全体は除外できない", async () => {
      const c = await mkCand("u4");
      expect((await excludeWithReason(u1, h1, c, actor, { reason: "untrusted", target: "x_account", key: "7l_shop", label: "@7l_shop" })).ok).toBe(true);
      const rows = (await x(u1).from("collection_exclusions").select("scope,key").eq("household_id", h1).eq("key", "7l_shop")).data;
      expect(rows).toEqual([{ scope: "x_account", key: "7l_shop" }]);
      const c2 = await mkCand("u5");
      expect((await excludeWithReason(u1, h1, c2, actor, { reason: "untrusted", target: "domain", key: "x.com", label: "x.com" })).ok).toBe(false);
    });

    it("重複: 店舗が異なる抽選には統合できない（店舗ごとの独立した抽選）。同じ店舗なら統合でき、参照のURLが統合先に残る", async () => {
      const chain = await mkChain("7L重複系列");
      const product = await mkProduct("7L重複商品");
      const sA = await mkStore(chain, "7L重複A店");
      const sB = await mkStore(chain, "7L重複B店");
      const made = await saveLotteryBulk(u1, perStore(input(chain, product, { sourceUrls: [] }), [{ id: sA, name: "7L重複A店" }, { id: sB, name: "7L重複B店" }]), randomUUID(), null, actor);
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      const lotA = (await u1.from("lotteries").select("id").eq("store_id", sA).eq("chain_id", chain).single()).data!.id;
      const lotB = (await u1.from("lotteries").select("id").eq("store_id", sB).eq("chain_id", chain).single()).data!.id;
      const draft = { input: { chain: { id: chain, name: "7L重複系列" }, store: { id: sA, name: "7L重複A店" }, items: [{ product: { id: product, name: "7L重複商品" } }] } };
      const c = await mkCand("d1", draft);
      const refuse = await excludeWithReason(u1, h1, c, actor, { reason: "duplicate", target: { kind: "lottery", id: lotB } });
      expect(refuse.ok).toBe(false);
      expect(!refuse.ok && refuse.error).toContain("店舗が異なる");
      expect((await u1.from("collection_candidates").select("status").eq("id", c).single()).data!.status).toBe("pending");
      const done = await excludeWithReason(u1, h1, c, actor, { reason: "duplicate", target: { kind: "lottery", id: lotA }, matchReason: "同じ店舗・同じ商品" });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      const cand = (await u1.from("collection_candidates").select("status,lottery_id,source_url").eq("id", c).single()).data!;
      expect(cand).toMatchObject({ status: "duplicate", lottery_id: lotA }); // 候補は削除せず、統合先と関連づく
      expect(((await u1.from("lotteries").select("source_urls").eq("id", lotA).single()).data!.source_urls as string[])).toContain(cand.source_url); // 元のURLが参照として残る
      const log = (await x(u1).from("collection_exclusion_log").select("detail,duplicate_lottery_id").eq("candidate_id", c)).data[0];
      expect(log.duplicate_lottery_id).toBe(lotA);
      expect(log.detail.matchReason).toBe("同じ店舗・同じ商品"); // 判定理由も履歴に残る
    });

    it("重複: 系列の別名を、利用者が確定したときだけ登録できる。別の系列の名称と同じ別名・重複する別名は登録しない", async () => {
      const chain = await mkChain("7L別名正式系列");
      const other = await mkChain("7L別名の別系列");
      const product = await mkProduct("7L別名商品");
      const sA = await mkStore(chain, "7L別名A店");
      const made = await saveLotteryBulk(u1, perStore(input(chain, product, { sourceUrls: [] }), [{ id: sA, name: "7L別名A店" }]), randomUUID(), null, actor);
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      const draft = { input: { chain: { id: null, name: "7Lドラスタ" }, store: { id: null, name: "" }, items: [{ product: { id: product, name: "7L別名商品" } }] } };
      const c0 = await mkCand("a0", draft);
      // 別名の指定なし → 別名は登録されない
      expect((await excludeWithReason(u1, h1, c0, actor, { reason: "duplicate", target: { kind: "lottery", id: made.value.ids[0] } })).ok).toBe(true);
      expect(((await x(u1).from("chain_aliases").select("id").eq("chain_id", chain)).data ?? []).length).toBe(0);
      // 別の系列の名称は別名にできない（除外自体も実行しない）
      const c1 = await mkCand("a1", draft);
      const clash = await excludeWithReason(u1, h1, c1, actor, { reason: "duplicate", target: { kind: "lottery", id: made.value.ids[0] }, registerChainAlias: { chainId: chain, alias: "7L別名の別系列" } });
      expect(clash.ok).toBe(false);
      expect((await u1.from("collection_candidates").select("status").eq("id", c1).single()).data!.status).toBe("pending");
      expect(other).toBeTruthy();
      // 確定した別名は登録される。同じ別名を重ねても重複しない
      const c2 = await mkCand("a2", draft);
      expect((await excludeWithReason(u1, h1, c2, actor, { reason: "duplicate", target: { kind: "lottery", id: made.value.ids[0] }, registerChainAlias: { chainId: chain, alias: "7Lドラスタ" } })).ok).toBe(true);
      const c3 = await mkCand("a3", draft);
      expect((await excludeWithReason(u1, h1, c3, actor, { reason: "duplicate", target: { kind: "lottery", id: made.value.ids[0] }, registerChainAlias: { chainId: chain, alias: "７Ｌドラスタ" } })).ok).toBe(true); // 全角でも同じ別名
      expect(((await x(u1).from("chain_aliases").select("alias").eq("chain_id", chain)).data ?? []).map((a: { alias: string }) => a.alias)).toEqual(["7Lドラスタ"]);
    });
  });
});
