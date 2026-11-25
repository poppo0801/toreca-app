/**
 * 注意（lotteries.cautions・jsonb）の境界検証（実Supabase・ローカルのみ・架空データ）:
 * DBに message の無い古い・不完全な注意があっても、画面が使うデータ（loadAppData）では正規化され、要約（cautionSummary）が落ちない。
 * 注意そのものは消えない（既定の文言で残る）。 npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { cautionSummary } from "@/lib/collector/attention";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("注意のDB境界（message欠落・不正な要素）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let lotteryId: string;

  beforeAll(async () => {
    const x = await signInTestUser(admin, "caution-b", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id as string;
    const chainId = (await u1.from("chains").insert({ household_id: hid, name: "注意テスト系列" }).select("id").single()).data!.id as string;
    const storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "注意店" }).select("id").single()).data!.id as string;
    const productId = (await u1.from("products").insert({ household_id: hid, official_name: "注意商品", packs_per_box: 30 }).select("id").single()).data!.id as string;
    const input: LegacyInput = { chainId, storeId, campaignId: null, newCampaign: null, items: [{ productId, quantity: 1, unit: "box" }], applyStart: EMPTY_FLEX, applyDeadline: EMPTY_FLEX, resultDate: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "" };
    const r = await saveLottery(u1, hid, null, input, profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    lotteryId = (await u1.from("lotteries").select("id").eq("household_id", hid).limit(1).single()).data!.id as string;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("messageが無い要素・コードの無い要素・nullが混ざっていても、loadAppData は正規化した注意を返し、cautionSummary は落ちない（注意は消えない）", async () => {
    const bad = [{ code: "deadline_unknown", field: "applyDeadline" }, null, { message: "コードが無い" }, "文字列", { code: "ok_one", field: "other", message: "締切が未確認（詳細）" }];
    const { error } = await admin.from("lotteries").update({ cautions: bad as never }).eq("id", lotteryId);
    expect(error).toBeNull();
    const data = await loadAppData(u1, hid);
    const l = data.lotteries.find((x) => x.id === lotteryId)!;
    expect(l.cautions?.map((c) => c.code)).toEqual(["deadline_unknown", "ok_one"]);
    expect(l.cautions!.every((c) => typeof c.message === "string" && c.message.length > 0)).toBe(true);
    expect(() => cautionSummary(l.cautions)).not.toThrow();
    expect(cautionSummary(l.cautions)).toContain("締切が未確認");
  });

  it("DBの制約: cautions は配列（20件以下）だけ。配列でない値は保存できない（境界の正規化は、配列の中の不完全な要素への備え）", async () => {
    const { error } = await admin.from("lotteries").update({ cautions: { code: "x" } as never }).eq("id", lotteryId);
    expect(error?.message ?? "").toContain("lotteries_cautions_array");
  });
});
