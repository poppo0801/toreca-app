/**
 * Stage 9H-3N の結合テスト（実Supabase・RLS適用下。AI・外部サイトなし）: 登録済みの抽選の履歴から系列の開催傾向を発見し、
 * 直近の抽選を起点に関連店舗の調査候補を出す。調査の記録（台帳）に残した未確認の店舗は、重複して調べない。 npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";
import { loadSiblingSignals, loadSweepLedger, nextSweepLedger } from "@/lib/server/agent/sweep-service";
import { updateSweepLedger } from "@/lib/collector/chain-sweep";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date("2026-12-10T03:00:00Z");
const dayIso = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const flex = (offset: number) => ({ precision: "date_only" as const, date: dayIso(offset), time: "" });

describe.skipIf(!dbTestsEnabled)("Stage 9H-3N: 系列横断の調査（履歴からの傾向・調査候補・台帳）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainId: string;
  const stores: Record<string, string> = {};
  const products: string[] = [];

  const lot = async (store: string, productId: string, start: number, deadline: number) => {
    const input: LegacyInput = {
      chainId,
      storeId: stores[store],
      campaignId: null,
      newCampaign: null,
      items: [{ productId, quantity: 1, unit: "box" }],
      applyStart: flex(start),
      applyDeadline: flex(deadline),
      resultDate: EMPTY_FLEX,
      procedureDeadline: EMPTY_FLEX,
      receiveMethod: "store",
      applyMethod: "web",
      conditionsText: "",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: [],
      eventState: "open",
      limitBasis: "account",
      limitMaxCount: 1,
      memo: "",
      applications: [],
      appliedAt: "",
    };
    const r = await saveLottery(u1, hid, null, input, profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
  };

  beforeAll(async () => {
    const x = await signInTestUser(admin, "s9h3n", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "横断テスト系列" }).select("id").single()).data!.id;
    for (const s of ["A1店", "A2店", "A3店", "A4店", "A5店"]) stores[s] = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: s }).select("id").single()).data!.id;
    for (const p of ["商品1", "商品2", "商品3", "新商品"]) products.push((await u1.from("products").insert({ household_id: hid, official_name: p, packs_per_box: 30 }).select("id").single()).data!.id);
    // 過去: 3つの開催機会で、A1〜A4店が同時期に開催（A5店は参加しない）
    for (const [i, start] of [-100, -70, -40].entries()) for (const [j, s] of ["A1店", "A2店", "A3店", "A4店"].entries()) await lot(s, products[i], start + (j % 2), start + 5);
    // 直近: 新商品をA1店が開始（起点）。他の店舗はまだ見つかっていない
    await lot("A1店", products[3], -2, 5);
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("履歴から傾向を発見し、起点以外の店舗を調査候補にする（参加しない店舗は選ばない・各候補に根拠）", async () => {
    const s = await loadSiblingSignals(u1, hid, NOW);
    const names = s.map((x) => x.store).sort();
    expect(names).toEqual(expect.arrayContaining(["A2店", "A3店", "A4店"]));
    expect(names).not.toContain("A5店");
    expect(names).not.toContain("A1店");
    expect(s[0].reasons.join()).toContain("確認ではない");
    expect(s.length).toBeLessThanOrEqual(15);
  });

  it("台帳: 調査した店舗は、次回の調査候補から外れる（未確認でも継続の間隔が空くまで重複して調べない）。履歴が空のときは何も出さない", async () => {
    const first = await loadSiblingSignals(u1, hid, NOW);
    const target = first[0];
    // 調査の記録（台帳つき）を保存する
    const ledger = updateSweepLedger({}, [{ kind: "chain_sibling", targetId: target.id }], [], NOW);
    const { error } = await u1.from("agent_investigation_runs" as never).insert({ household_id: hid, mode: "dry_run", brain: "mock", status: "completed", result: { sweepLedger: ledger } } as never);
    expect(error).toBeNull();
    expect(Object.keys(await loadSweepLedger(u1, hid))).toContain(target.id);
    const again = await loadSiblingSignals(u1, hid, NOW);
    expect(again.map((x) => x.id)).not.toContain(target.id);
    // 見つからなかっただけでは「開催なし」としない（未確認のまま）
    expect(["unconfirmed", "closed_unconfirmed"]).toContain((await loadSweepLedger(u1, hid))[target.id].status);
    // 結果の記録: 抽選の告知が見つかれば found
    const next = await nextSweepLedger(u1, hid, [{ kind: "chain_sibling", targetId: target.id }], [{ kind: "lottery_info", targetId: target.id, pageKind: "lottery_announcement", action: "new" }], new Date(NOW.getTime() + 3 * 86_400_000));
    expect(next[target.id].status).toBe("found");
  });
});
