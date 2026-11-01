/**
 * Stage 5M の結合テスト（実Supabase・RLS適用下）: 当落発表方法の単一制約、系列ロゴ（列の整合・世帯分離・ストレージの保存/読み取り/削除）、
 * 商品画像のストレージ分離。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe.skipIf(!dbTestsEnabled)("Stage 5M: 発表方法の単一選択・系列ロゴ", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let hid2: string;
  let profs: { id: string; label: string }[];
  let chainId: string;
  let storeA: string;
  let p1: string;

  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(JSON.stringify(error)).toBe("null");
    return data as { id: string };
  };
  const base = (over: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId, storeId: storeA, campaignId: null, newCampaign: null,
    items: [{ productId: p1, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [],
    eventState: "open", limitBasis: "account", limitMaxCount: 5, memo: "", applications: [], appliedAt: "", ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5m", 1);
    const b = await signInTestUser(admin, "s5m", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profs = (await u1.from("profiles").select("id,label").order("sort_order")).data!;
    chainId = (await must(u1.from("chains").insert({ household_id: hid, name: "5M電機" }).select("id").single())).id;
    storeA = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "5M-A店", prefecture: "兵庫県" }).select("id").single())).id;
    p1 = (await must(u1.from("products").insert({ household_id: hid, official_name: "5M商品1", packs_per_box: 20 }).select("id").single())).id;
  });
  afterAll(async () => {
    // テストで作ったストレージのファイルも片付ける
    await admin.storage.from("product-images").remove([`${hid}/chain-logos/x.png`, `${hid}/chain-logos/y.png`]);
    await cleanupTestUsers(admin, userIds);
  });

  it("当落発表方法は1つだけ保存できる。複数はDBが拒否し、補足の文章は消えない", async () => {
    const r = await saveLottery(u1, hid, null, base({ announcementMethod: "LivePocketのマイページでも確認可能", announcementMethods: ["result_mail"] }), profs[0].id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const id = (r as { value: { id: string } }).value.id;
    const l = (await loadAppData(u1)).lotteries.find((x) => x.id === id)!;
    expect(l.announcementMethods).toEqual(["result_mail"]);
    expect(l.announcementMethod).toBe("LivePocketのマイページでも確認可能");
    const two = await u1.from("lotteries").update({ announcement_methods: ["result_mail", "result_page"] } as never).eq("id", id);
    expect(two.error).not.toBeNull();
    const none = await u1.from("lotteries").update({ announcement_methods: [] } as never).eq("id", id);
    expect(none.error).toBeNull();
  });

  it("移行後、複数の発表方法が残っている抽選はない", async () => {
    const { data } = await admin.from("lotteries").select("announcement_methods");
    expect((data ?? []).filter((r) => (r.announcement_methods ?? []).length > 1)).toHaveLength(0);
  });

  it("系列ロゴ: パスとハッシュは両方あるか両方ないか。登録・変更・削除ができる", async () => {
    const half = await u1.from("chains").update({ logo_path: `${hid}/chain-logos/x.png` } as never).eq("id", chainId);
    expect(half.error).not.toBeNull();
    const bad = await u1.from("chains").update({ logo_path: `${hid}/chain-logos/x.png`, logo_sha256: "zz" } as never).eq("id", chainId);
    expect(bad.error).not.toBeNull();
    const sha = "a".repeat(64);
    const set = await u1.from("chains").update({ logo_path: `${hid}/chain-logos/x.png`, logo_sha256: sha } as never).eq("id", chainId);
    expect(set.error).toBeNull();
    const d = await loadAppData(u1);
    expect(d.chains.find((c) => c.id === chainId)!.logoSrc).toBe(`/api/chain-logo/${chainId}?v=${sha.slice(0, 12)}`);
    const clear = await u1.from("chains").update({ logo_path: null, logo_sha256: null } as never).eq("id", chainId);
    expect(clear.error).toBeNull();
    expect((await loadAppData(u1)).chains.find((c) => c.id === chainId)!.logoSrc).toBeNull();
  });

  it("ロゴ画像の保存先: 自世帯のフォルダには保存・読み取り・削除でき、他世帯は読めず・保存できない", async () => {
    const path = `${hid}/chain-logos/y.png`;
    const up = await u1.storage.from("product-images").upload(path, PNG, { contentType: "image/png", upsert: true });
    expect(up.error).toBeNull();
    const own = await u1.storage.from("product-images").download(path);
    expect(own.error).toBeNull();
    const other = await u2.storage.from("product-images").download(path);
    expect(other.error).not.toBeNull();
    const intrude = await u2.storage.from("product-images").upload(`${hid}/chain-logos/z.png`, PNG, { contentType: "image/png" });
    expect(intrude.error).not.toBeNull();
    // 他世帯からの削除は効かない（ファイルが残る）
    await u2.storage.from("product-images").remove([path]);
    expect((await u1.storage.from("product-images").download(path)).error).toBeNull();
    const rm = await u1.storage.from("product-images").remove([path]);
    expect(rm.error).toBeNull();
    expect(rm.data?.length, JSON.stringify(rm)).toBe(1);
    // 削除後は一覧から消える（ダウンロードはCDNのキャッシュで少し残ることがあるため、一覧で確認する）
    const left = await u1.storage.from("product-images").list(`${hid}/chain-logos`);
    expect((left.data ?? []).map((f) => f.name)).not.toContain("y.png");
    expect(hid2).not.toBe(hid);
  });

  it("他世帯の系列のロゴは変更できない", async () => {
    const r = await u2.from("chains").update({ logo_path: `${hid2}/chain-logos/q.png`, logo_sha256: "b".repeat(64) } as never).eq("id", chainId).select("id");
    expect(r.data ?? []).toHaveLength(0);
  });
});
