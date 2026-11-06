/**
 * Stage 5S-A: 優先収集メモ（実Supabase・RLS適用下。外部サイトはモック。架空データのみ）:
 * 系列＋商品だけの登録、既存の抽選・収集候補との照合、参考URLの取得と内容ハッシュ（同一内容は再解析しない）、
 * 優先キューへの反映、情報不足、取得制限（回避しない・再取得しない）、取り下げ（履歴を残す）。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import type { MemoState } from "@/lib/collector/memos";
import { listMemos, runMemoPass } from "@/lib/server/collector/memos";
import type { Db } from "@/lib/server/lottery-service";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const ymd = (d: number) => new Date(NOW.getTime() + d * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
const page = (text: string): SafeFetchResult => ({ ok: true, finalUrl: "https://m.example.invalid/a", status: 200, contentType: "text/html", body: `<html><body><p>${text}</p></body></html>`, truncated: false });
const BASE = { chainId: null, chainName: "", storeId: null, storeName: "", productIds: [] as string[], productNames: [] as string[], referenceUrl: "", note: "", announcedStart: "", priority: "normal" as const };

type MemoSeed = { chainId: string | null; chainName: string; storeId: string | null; storeName: string; productIds: string[]; productNames: string[]; referenceUrl: string; note: string; announcedStart: string; priority: "normal" | "high" };

describe.skipIf(!dbTestsEnabled)("Stage 5S-A: 優先収集メモ（既存メモの照合。登録の操作は Stage 6L で廃止）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainId: string;
  let productId: string;
  let lotteryId: string;
  let fetches = 0;
  let fetchResult: SafeFetchResult = page("");
  const deps = () => ({ db: u1, householdId: hid, now: NOW, fetchPage: async () => { fetches++; return fetchResult; } });
  const memo = async (id: string) => (await listMemos(u1)).find((m) => m.id === id)!;
  // 既存のメモ（廃止前に登録されたもの）を再現する
  const createMemo = async (db: Db, household: string, by: string | null, i: MemoSeed): Promise<{ ok: true; id: string } | { ok: false }> => {
    if (!i.chainId && !i.chainName.trim() && i.productIds.length === 0 && i.productNames.length === 0) return { ok: false };
    const { data, error } = await db
      .from("collection_memos")
      .insert({ household_id: household, chain_id: i.chainId, chain_name: i.chainId ? "" : i.chainName, store_id: i.storeId, store_name: i.storeId ? "" : i.storeName, product_ids: i.productIds, product_names: i.productNames, reference_url: i.referenceUrl || null, note: i.note, announced_start: i.announcedStart || null, priority: i.priority, created_by_profile_id: by } as never)
      .select("id")
      .single();
    return error || !data ? { ok: false } : { ok: true, id: data.id };
  };
  const setMemoState = async (db: Db, id: string, state: MemoState) => !(await db.from("collection_memos").update({ state, state_detail: "取り下げました" } as never).eq("id", id)).error;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5sm", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "サンプルメモ電機" }).select("id").single()).data!.id;
    const storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "三宮店", prefecture: "兵庫県" }).select("id").single()).data!.id;
    productId = (await u1.from("products").insert({ household_id: hid, official_name: "テスト拡張パック「メモの森」", packs_per_box: 30 }).select("id").single()).data!.id;
    const base: LegacyInput = {
      chainId, storeId, campaignId: null, newCampaign: null, items: [{ productId, quantity: 1, unit: "box" }], multiMode: "single",
      applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: ymd(20), time: "" }, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
      receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "手動のメモ", applications: [], appliedAt: "",
    };
    const l = await saveLottery(u1, hid, null, base, profile);
    if (!l.ok) throw new Error("setup");
    lotteryId = l.value.id;
  });
  afterAll(async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "%example.invalid%");
    await u1.from("collection_candidates").delete().like("dedupe_key", "memo:%");
    await cleanupTestUsers(admin, userIds);
  });

  it("系列＋商品だけで保存できる。系列も商品も無ければ拒否。未登録の名称は仮名称として保存", async () => {
    expect((await createMemo(u1, hid, profile, { ...BASE, note: "x" })).ok).toBe(false);
    const a = await createMemo(u1, hid, profile, { ...BASE, chainId, productIds: [productId] });
    expect(a.ok).toBe(true);
    const b = await createMemo(u1, hid, profile, { ...BASE, chainName: "Joshin", productNames: ["未登録の新商品ZZZ"] });
    expect(b.ok).toBe(true);
    if (b.ok) expect((await memo(b.id)).state).toBe("unsurveyed");
  });

  it("既存の抽選と一致すれば「登録済み」になり、抽選へリンクされる（抽選は変更しない）", async () => {
    const m = await createMemo(u1, hid, profile, { ...BASE, chainId, productIds: [productId] });
    if (!m.ok) throw new Error("memo");
    const before = (await u1.from("lotteries").select("updated_at,memo").eq("id", lotteryId).single()).data!;
    const rep = await runMemoPass(deps(), { ids: [m.id], force: true, noFetch: true });
    expect(rep.registered).toBe(1);
    const row = await memo(m.id);
    expect(row.state).toBe("registered");
    expect(row.lotteryId).toBe(lotteryId);
    expect((await u1.from("lotteries").select("updated_at,memo").eq("id", lotteryId).single()).data).toEqual(before);
  });

  it("解析待ちの候補が該当すれば「候補発見」。待ち時間を進めて優先処理へ（他の候補は変更しない）", async () => {
    const mk = (n: string, title: string) => u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: `https://m.example.invalid/${n}`, source_url: `https://m.example.invalid/${n}`, title, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: "x", title, context: "", sourceName: "t", attempts: 0 } } as never } as never);
    await mk("hit", "ZetaMart 限定 ミラージュパック 抽選販売のお知らせ");
    await mk("other", "無関係の店 別商品 抽選");
    const m = await createMemo(u1, hid, profile, { ...BASE, chainName: "ZetaMart", productNames: ["ミラージュパック"] });
    if (!m.ok) throw new Error("memo");
    const rep = await runMemoPass(deps(), { ids: [m.id], force: true });
    expect(rep.found).toBe(1);
    expect(rep.boosted).toBe(1);
    expect((await memo(m.id)).state).toBe("found");
    const hit = (await u1.from("collection_candidates").select("memo_id,next_run_at").eq("dedupe_key", "https://m.example.invalid/hit").single()).data!;
    expect(hit.memo_id).toBe(m.id);
    expect(new Date(hit.next_run_at!).getTime()).toBeLessThan(NOW.getTime() - 100 * 3600_000);
    const other = (await u1.from("collection_candidates").select("memo_id,next_run_at").eq("dedupe_key", "https://m.example.invalid/other").single()).data!;
    expect(other.memo_id).toBeNull();
    expect(other.next_run_at).toBeNull();
  });

  it("確認待ちの候補が該当すれば「情報不足」（勝手に登録しない）", async () => {
    await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: "https://m.example.invalid/rev", source_url: "https://m.example.invalid/rev", title: "OmegaShop ナイトパレード 抽選", status: "pending", job_state: "review", reasons: ["応募締切が不明です"], draft: { input: { chain: { name: "OmegaShop" }, store: { name: "" }, items: [{ product: { name: "ナイトパレード" } }] } } as never } as never);
    const m = await createMemo(u1, hid, profile, { ...BASE, chainName: "OmegaShop", productNames: ["ナイトパレード"] });
    if (!m.ok) throw new Error("memo");
    await runMemoPass(deps(), { ids: [m.id], force: true });
    const row = await memo(m.id);
    expect(row.state).toBe("insufficient");
    expect(row.stateDetail).toContain("応募締切が不明");
    expect(row.lotteryId).toBeNull();
  });

  it("参考URLは内容が変わったときだけ解析待ちにする（同一内容は再解析しない）。優先キューに入る", async () => {
    const m = await createMemo(u1, hid, profile, { ...BASE, chainName: "KappaStore", productNames: ["ムーンライトBOX"], referenceUrl: "https://m.example.invalid/ref" });
    if (!m.ok) throw new Error("memo");
    fetchResult = page("KappaStore ムーンライトBOX の抽選販売を近日開始予定です。詳細は後日お知らせします。応募方法はWebフォームです。");
    fetches = 0;
    const r1 = await runMemoPass(deps(), { ids: [m.id], force: true });
    expect(fetches).toBe(1);
    expect(r1.boosted).toBe(1);
    let row = await memo(m.id);
    expect(row.state).toBe("surveying");
    const cands = (await u1.from("collection_candidates").select("id,job_state,memo_id").eq("memo_id", m.id)).data!;
    expect(cands).toHaveLength(1);
    expect(cands[0].job_state).toBe("pending");
    // 同じ内容: 既に候補（解析待ち）があるので、再取得も新しい解析待ちも作らない
    await runMemoPass(deps(), { ids: [m.id], force: true });
    row = await memo(m.id);
    expect(row.state).toBe("found");
    expect(fetches).toBe(1);
    expect((await u1.from("collection_candidates").select("id").eq("memo_id", m.id)).data).toHaveLength(1);
    // 候補が解析済みで確認待ちに進んだあと、ページの内容が同じなら再解析しない。変わったときだけ新しい解析待ちを作る
    await u1.from("collection_candidates").update({ job_state: "completed", status: "excluded" }).eq("memo_id", m.id);
    await u1.from("collection_memos").update({ state: "surveying" }).eq("id", m.id);
    const r2 = await runMemoPass(deps(), { ids: [m.id], force: true });
    expect(r2.boosted).toBe(0);
    expect((await memo(m.id)).stateDetail).toContain("変化はありません");
    fetchResult = page("KappaStore ムーンライトBOX の抽選販売が決定しました。11月20日まで応募を受け付けます。応募方法はWebフォームです。");
    const r3 = await runMemoPass(deps(), { ids: [m.id], force: true });
    expect(r3.boosted).toBe(1);
    expect((await u1.from("collection_candidates").select("id").eq("memo_id", m.id)).data).toHaveLength(2);
  });

  it("取得制限（ロボット）は回避せず、恒常的な取得不可として自動では再取得しない", async () => {
    const m = await createMemo(u1, hid, profile, { ...BASE, chainName: "BlockedShop", productNames: ["ブロックBOX"], referenceUrl: "https://m.example.invalid/blocked" });
    if (!m.ok) throw new Error("memo");
    fetchResult = { ok: false, code: "robots", message: "このサイトはロボットによるページ取得を許可していません。告知の文章をコピーするか、画像で読み取ってください" };
    fetches = 0;
    await runMemoPass(deps(), { ids: [m.id], force: true });
    const row = await memo(m.id);
    expect(row.fetchState).toBe("blocked");
    expect(row.stateDetail).toContain("制限は回避しません");
    const again = await runMemoPass(deps(), { ids: [m.id] }); // 自動（forceなし）
    expect(again.checked).toBe(0);
    expect(fetches).toBe(1);
  });

  it("一時的な失敗は再試行できる状態（temporary）で残り、メモは削除できず「取り下げ」で履歴に残る", async () => {
    const m = await createMemo(u1, hid, profile, { ...BASE, chainName: "SlowShop", productNames: ["スローBOX"], referenceUrl: "https://m.example.invalid/slow" });
    if (!m.ok) throw new Error("memo");
    fetchResult = { ok: false, code: "timeout", message: "ページの取得がタイムアウトしました" };
    await runMemoPass(deps(), { ids: [m.id], force: true });
    expect((await memo(m.id)).fetchState).toBe("temporary");
    expect(await setMemoState(u1, m.id, "withdrawn")).toBe(true);
    expect((await memo(m.id)).state).toBe("withdrawn");
    await u1.from("collection_memos").delete().eq("id", m.id); // 削除権限は無い
    expect((await listMemos(u1)).some((x) => x.id === m.id)).toBe(true);
  });

  it("他の世帯のメモは見えない（RLS）", async () => {
    const b = await signInTestUser(admin, "s5sm2", 2);
    userIds.push(b.userId);
    await b.db.rpc("bootstrap_household");
    expect(await listMemos(b.db)).toHaveLength(0);
  });
});
