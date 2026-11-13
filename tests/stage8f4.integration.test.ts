/**
 * Stage 8F-4 の結合テスト（実Supabase・RLS適用下・架空データのみ。有料APIなし・外部ネットワークなし）:
 *  情報源の保存（lottery_source_snapshots）・AIによる情報源の取得（保存済みの架空のページ）・判断の根拠の記録・過去の保留の再評価・保持期間。
 *   npm run test:db   ※ マイグレーション 20261218000100 の適用後に実行する
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentLLM, LlmStep, ToolCall } from "@/lib/agent/core";
import type { FetchedPage, PageFetcher } from "@/lib/agent/store-location/tools";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { saveLottery, ungroupLottery, type Db } from "@/lib/server/lottery-service";
import { loadGroupingWorld, runLotteryGrouping } from "@/lib/server/agent/lottery-grouping-service";
import { loadSourceSnapshotTexts, purgeExpiredSourceSnapshots, saveSourceSnapshots } from "@/lib/server/agent/source-snapshots";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const usage = { inputTokens: 100, outputTokens: 50, costJpy: 0 };
const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolCall => ({ id, name, input });

describe.skipIf(!dbTestsEnabled)("Stage 8F-4", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let h2: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・関数は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8f4", 1);
    const b = await signInTestUser(admin, "s8f4", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    h2 = (await u2.rpc("bootstrap_household")).data as string;
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
      procedureDeadline: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", conditionsText: "共通の条件", verificationText: "", announcementMethod: "", announcementUrl: "",
      sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", ...over,
    });
  const mkLottery = async (chain: string, product: string, store: string, name: string, over: Record<string, unknown> = {}) => {
    const r = await saveLottery(u1, h1, null, input(chain, product, { id: store, name }, over), actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.ok ? r.value.id : "";
  };
  /** 同じ内容で、情報源URLだけ別（手動登録の想定・情報源の文章なし）の抽選を n 店舗ぶん作る */
  const mkSet = async (label: string, n: number) => {
    const chain = await mkChain(`8F4${label}電機`);
    const product = await mkProduct(`8F4${label}商品`);
    const lots: string[] = [];
    for (let i = 0; i < n; i++) lots.push(await mkLottery(chain, product, await mkStore(chain, `8F4${label}店${i + 1}`), `8F4${label}店${i + 1}`, { sourceUrls: [`https://example.invalid/8f4/${label}/page-${i + 1}`] }));
    return { chain, lots };
  };
  const groupOf = async (id: string) => (await x(u1).from("lotteries").select("bulk_group_id").eq("id", id).single()).data?.bulk_group_id as string | null;
  const snaps = async (lotteryId: string) => ((await x(u1).from("lottery_source_snapshots").select("*").eq("lottery_id", lotteryId)).data ?? []) as Record<string, unknown>[];

  class Pages implements PageFetcher {
    fetched: string[] = [];
    constructor(private readonly byUrl: (url: string) => string | null) {}
    async fetchPage(url: string): Promise<FetchedPage> {
      this.fetched.push(url);
      const id = this.byUrl(url);
      if (id === null) return { ok: false, message: "取得できませんでした" };
      return { ok: true, url, finalUrl: url, title: "抽選販売のお知らせ", text: `冬の検証企画 抽選販売 全店共通 ${"x".repeat(10)}`, links: [{ text: "問い合わせ", href: `https://example.invalid/contact?event_id=${id}` }], fetchedAt: "2026-11-14T00:00:00.000Z" };
    }
  }
  /** 調べる→比較→提出（new_group）。取得するのは対象と相手 */
  const investigator = (subject: string, peers: string[], action: "new_group" | "hold" = "new_group"): AgentLLM => {
    let n = 0;
    return {
      name: "scripted",
      async step(): Promise<LlmStep> {
        const i = n++;
        if (i === 0) return { kind: "tool_calls", usage, calls: [call("a", "get_subject")] };
        if (i === 1) return { kind: "tool_calls", usage, calls: [subject, ...peers].map((id, k) => call(`f${k}`, "fetch_source_page", { lotteryId: id })) };
        if (i === 2) return { kind: "tool_calls", usage, calls: peers.map((id, k) => call(`c${k}`, "compare_evidence", { a: subject, b: id })) };
        return { kind: "final", usage, output: action === "hold" ? { action: "hold", rationale: "確認できない", missing: ["同じイベントIDを確認できない"] } : { action: "new_group", memberIds: peers, rationale: "同じイベントの店舗違い", claimedCommon: ["商品", "応募期間"] } };
      },
    };
  };

  it("情報源の保存: 保存・重複しない・伏せ字・4000文字に切り詰め・世帯の分離（別世帯は読めない）・過去データ（行なし）も正常", async () => {
    const { lots } = await mkSet("保存", 1);
    const url = "https://example.invalid/8f4/snap";
    const r1 = await saveSourceSnapshots(u1, h1, [{ lotteryId: lots[0], url, kind: "web_page", origin: "manual", title: "題", body: `本文 sk-ant-api03-SECRETKEY123456 ${"あ".repeat(5000)}` }]);
    expect(r1).toEqual({ saved: 1, tableMissing: false });
    const again = await saveSourceSnapshots(u1, h1, [{ lotteryId: lots[0], url, kind: "web_page", origin: "manual", title: "題", body: `本文 sk-ant-api03-SECRETKEY123456 ${"あ".repeat(5000)}` }]);
    expect(again.saved).toBe(0); // 同じ抽選・URL・本文は1件
    const rows = await snaps(lots[0]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].body)).not.toContain("SECRETKEY");
    expect(String(rows[0].body).length).toBeLessThanOrEqual(4000);
    expect(new Date(String(rows[0].expires_at)).getTime()).toBeGreaterThan(Date.now() + 170 * 86_400_000); // 保持期間（既定180日）
    // 別世帯は読めない・書けない
    expect(((await x(u2).from("lottery_source_snapshots").select("id").eq("lottery_id", lots[0])).data ?? []).length).toBe(0);
    const forged = await x(u2).from("lottery_source_snapshots").insert({ household_id: h1, lottery_id: lots[0], url, source_kind: "web_page", origin: "manual", body: "x", body_hash: "abcdefgh" });
    expect(forged.error).toBeTruthy();
    // 読み込み: 「題 本文」の形。行が無い抽選は空（既存データと互換）
    const texts = await loadSourceSnapshotTexts(u1, [lots[0], randomUUID()]);
    expect(texts.get(lots[0])?.[0].startsWith("題 本文")).toBe(true);
    expect(texts.size).toBe(1);
    // 利用者は削除・更新できない（保持期間の削除はサービス側だけ）
    expect((await x(u1).from("lottery_source_snapshots").delete().eq("lottery_id", lots[0]).select("id")).data ?? []).toHaveLength(0);
    expect((await x(u1).rpc("purge_expired_source_snapshots", { p_limit: 10 })).error).toBeTruthy();
  });

  it("保持期間: 期限切れは読み込まれず、purge で削除される（期限内・抽選・応募には触れない）", async () => {
    const { lots } = await mkSet("期限", 1);
    await saveSourceSnapshots(u1, h1, [{ lotteryId: lots[0], url: "https://example.invalid/8f4/old", kind: "web_page", origin: "grouping_fetch", body: "古い情報源" }, { lotteryId: lots[0], url: "https://example.invalid/8f4/new", kind: "web_page", origin: "grouping_fetch", body: "新しい情報源" }]);
    await x(admin).from("lottery_source_snapshots").update({ expires_at: new Date(Date.now() - 86_400_000).toISOString() }).eq("lottery_id", lots[0]).eq("url", "https://example.invalid/8f4/old");
    const texts = await loadSourceSnapshotTexts(u1, lots);
    expect(texts.get(lots[0])).toEqual([" 新しい情報源"]);
    expect(await purgeExpiredSourceSnapshots(admin as unknown as Db, 100)).toBeGreaterThanOrEqual(1);
    expect((await snaps(lots[0])).map((r) => r.url)).toEqual(["https://example.invalid/8f4/new"]);
    expect((await u1.from("lotteries").select("id").eq("id", lots[0])).data).toHaveLength(1);
  });

  it("AIが情報源を取得 → 同じイベントIDを確認 → 自動でグループ化。取得したページが保存され、提案に根拠（sources・basis）が残る。応募・抽選は変わらない", async () => {
    const { lots } = await mkSet("取得", 3);
    const f = new Pages(() => "1135507");
    const before = (await u1.from("lotteries").select("id,apply_deadline_date,memo,event_state").in("id", lots).order("id")).data;
    const r = await runLotteryGrouping(u1, h1, lots[2], { llm: investigator(lots[2], [lots[0], lots[1]]), allowAuto: true, asService: false, actor, followUps: 0, fetcher: f });
    expect(r.status, r.message).toBe("applied");
    expect(r.tier).toBe("auto");
    const g = await groupOf(lots[2]);
    expect(g).toBeTruthy();
    expect(await groupOf(lots[0])).toBe(g);
    expect((await u1.from("lotteries").select("id,apply_deadline_date,memo,event_state").in("id", lots).order("id")).data).toEqual(before);
    // 取得したページの保存
    for (const l of lots) {
      const rows = await snaps(l);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ origin: "grouping_fetch", source_kind: "web_page" });
      expect(JSON.stringify(rows[0].identifiers)).toContain("1135507");
    }
    // 提案の根拠
    const p = ((await x(u1).from("lottery_group_proposals").select("*").eq("subject_lottery_id", lots[2])).data ?? []) as { evidence: { sources: { url: string; hash: string }[]; basis: string[]; strongSignals: string[] } }[];
    expect(p[0].evidence.strongSignals).toContain("event_id");
    expect(p[0].evidence.sources.length).toBe(3);
    expect(p[0].evidence.basis.join("\n")).toMatch(/自動確定[\s\S]*同じイベントID/);
    expect(f.fetched).toHaveLength(3);
  });

  it("根拠が確認できない（別のイベントID）→ 自動にしない（候補）。ページは保存される", async () => {
    const { lots } = await mkSet("別ID", 2);
    const f = new Pages((u) => (u.endsWith("page-1") ? "1111111" : "2222222"));
    const r = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]]), allowAuto: true, asService: false, actor, followUps: 0, fetcher: f });
    expect(r.tier).toBe("suggest");
    expect(r.status).toBe("pending");
    expect(await groupOf(lots[1])).toBeNull();
    expect((await snaps(lots[1])).length).toBe(1);
  });

  it("保留の再評価: 取得できずに保留 → 同じ状況では再実行しない（取得・AIを繰り返さない）。情報源が保存されて状況が変われば再評価する", async () => {
    const { lots } = await mkSet("保留", 2);
    const fail = new Pages(() => null);
    const r1 = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]], "hold"), allowAuto: true, asService: false, actor, followUps: 0, fetcher: fail });
    expect(r1.status).toBe("dismissed");
    expect(r1.tier).toBe("hold");
    const calls1 = fail.fetched.length;
    // 同じ状況（情報源は増えていない）: 再実行しない
    const r2 = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]]), allowAuto: true, asService: false, actor, followUps: 0, fetcher: fail });
    expect(r2.status).toBe("skipped");
    expect(r2.ranAgent).toBe(false);
    expect(fail.fetched.length).toBe(calls1);
    // 新しい情報源（手動で貼った文章）が保存されると、保留を維持せず再評価する
    await saveSourceSnapshots(u1, h1, [{ lotteryId: lots[1], url: "https://example.invalid/8f4/保留/note", kind: "manual_note", origin: "manual", title: "手動メモ", body: "冬の検証企画 抽選販売 全店共通" }]);
    const world = await loadGroupingWorld(u1, h1, lots[1]);
    expect(world!.evidence.get(lots[1])?.[0]).toContain("冬の検証企画");
    const ok = new Pages(() => "1135507");
    const r3 = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]]), allowAuto: false, asService: false, actor, followUps: 0, fetcher: ok });
    expect(r3.ranAgent).toBe(true);
    expect(r3.tier).toBe("suggest"); // 自動が無効なら候補止まり
  });

  it("取得を保存できても、次回の判定は同じ署名（取得で増えた根拠を保存したあと、同じ状況なら再実行しない）", async () => {
    const { lots } = await mkSet("署名", 2);
    const ok = new Pages(() => null); // 取得は失敗＝根拠は増えない。保留で保存
    const first = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]], "hold"), allowAuto: true, asService: false, actor, followUps: 0, fetcher: ok });
    expect(first.tier).toBe("hold");
    const second = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]]), allowAuto: true, asService: false, actor, followUps: 0, fetcher: new Pages(() => "1") });
    expect(second.ranAgent).toBe(false);
  });

  it("手動で分けた組は、情報源の根拠が増えても自動で再グループ化しない（利用者の判断を尊重）", async () => {
    const { lots } = await mkSet("手動分離", 2);
    const f = new Pages(() => "1135507");
    const first = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]]), allowAuto: true, asService: false, actor, followUps: 0, fetcher: f });
    expect(first.status).toBe("applied");
    const g = await groupOf(lots[1]);
    // 利用者が手動で外す（理由つき）
    const rm = await ungroupLottery(u1, lots[1], actor, { code: "different_campaign" });
    expect(rm.ok, JSON.stringify(rm)).toBe(true);
    expect(await groupOf(lots[1])).toBeNull();
    void g;
    // 根拠は十分でも（同じイベントID）、手動で分けた組は再びまとめない
    const again = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]]), allowAuto: true, asService: false, actor, followUps: 0, fetcher: new Pages(() => "1135507") });
    expect(again.status).not.toBe("applied");
    expect(await groupOf(lots[1])).toBeNull();
    expect(await groupOf(lots[0])).toBeNull();
  });

  it("取得部品が無い（本番の既定）ときは、情報源を取得しない。判定は従来どおり動く", async () => {
    const { lots } = await mkSet("取得なし", 2);
    const f = new Pages(() => "1");
    const r = await runLotteryGrouping(u1, h1, lots[1], { llm: investigator(lots[1], [lots[0]]), allowAuto: true, asService: false, actor, followUps: 0 });
    expect(r.outcome?.usage?.fetches).toBe(0);
    expect(f.fetched).toHaveLength(0);
    expect(r.tier).not.toBe("auto");
    expect(await snaps(lots[1])).toHaveLength(0);
  });
});
