/**
 * Stage 9Z の結合テスト（実Supabase・架空データ。AI・外部サイトはモック＝有料APIの実呼び出しなし）:
 * 初回収集で取得した原文を last_good.evidence に保存し、抽選ごとに読み戻せること／取得制限の記録を読めること。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { runWorker, type CollectDeps } from "@/lib/server/collector/run";
import { loadBlockedHosts, loadStoredEvidence } from "@/lib/server/agent/stored-evidence";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const html = (body: string) => `<html><body>${body}</body></html>`;
const ok = (finalUrl: string, body: string): SafeFetchResult => ({ ok: true, finalUrl, status: 200, contentType: "text/html", body, truncated: false });
const PAGE = html("<p>ポケモンカード 拡張パック 抽選販売のお知らせ。サンプル電機 三宮店にて抽選販売を実施します。応募期間をご確認ください。連絡先 secret@example.com</p>");

describe.skipIf(!dbTestsEnabled)("Stage 9Z: 取得した原文の保存と再利用", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;

  const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
    db: u1,
    householdId: hid,
    trigger: "cron",
    now: new Date(),
    actor: null,
    canRegister: false,
    extractor: getExtractor({ AI_PROVIDER: "mock" }),
    xClient: null,
    fetchList: async () => ok("https://pokeso.jp/chusen", html("")),
    fetchPage: async (u) => ok(u, PAGE),
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9z", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "サンプル電機" }).select("id").single()).data!.id;
    await u1.from("stores").insert({ household_id: hid, chain_id: chain, name: "三宮店", prefecture: "兵庫県" });
    await u1.from("collection_settings").insert({ household_id: hid, worker_enabled: true });
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("解析したページの本文を原文として last_good.evidence に保存する（URL・取得日時・取得方法つき。個人情報は伏せる。AIの抽出結果とは別）", async () => {
    const url = "https://w.example.invalid/9z-a";
    await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, title: "9z-a", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url, title: "9z-a", context: "", sourceName: "t", attempts: 0 } } } as never);
    const r = await runWorker(deps());
    expect(r.ok).toBe(true);
    const row = (await u1.from("collection_candidates").select("last_good,draft").eq("dedupe_key", url).single()).data!;
    const ev = (row.last_good as { evidence?: { url: string; via: string; text: string; fetchedAt: string; hash: string } }).evidence!;
    expect(ev).toBeTruthy();
    expect(ev.url).toBe(url);
    expect(ev.via).toBe("web_fetch");
    expect(ev.text).toContain("抽選販売のお知らせ");
    expect(ev.text).not.toContain("secret@example.com");
    expect(ev.fetchedAt).toMatch(/^20/);
    expect(Object.keys(ev).sort()).toEqual(["fetchedAt", "hash", "imageCount", "imageStatus", "links", "origin", "text", "textSource", "truncated", "url", "v", "via"]); // 原文の記録のみ（AIの抽出結果の項目は含まない）
    expect((row.draft as { input?: unknown }).input).toBeDefined(); // AIの抽出結果は draft に別に保存される
  });

  it("抽選に紐づく候補の原文を、抽選ごとに読み戻せる。保存の無い抽選は空（保存済みとして扱わない）", async () => {
    const chain = (await u1.from("chains").select("id").limit(1).single()).data!.id;
    const mk = async () => (await u1.from("lotteries").insert({ household_id: hid, chain_id: chain, apply_deadline_precision: "date_only", apply_deadline_date: "2099-01-10", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "manual" } as never).select("id").single()).data!.id as string;
    const withEv = await mk();
    const without = await mk();
    const url = "https://w.example.invalid/9z-a";
    await u1.from("collection_candidates").update({ lottery_id: withEv } as never).eq("dedupe_key", url);
    const m = await loadStoredEvidence(u1, [withEv, without]);
    expect(m.get(withEv)?.[0]).toMatchObject({ url, via: "web_fetch" });
    expect(m.get(without)).toBeUndefined();
  });

  it("再確認で原文が得られなくても、以前に保存した原文は消えない（last_good の上書きで失われない）", async () => {
    const url = "https://w.example.invalid/9z-a";
    const before = (await u1.from("collection_candidates").select("last_good").eq("dedupe_key", url).single()).data!.last_good as { evidence?: { hash: string } };
    await u1.from("collection_candidates").update({ job_state: "pending", status: "pending", draft: { queued: { kind: "web_page", url, title: "9z-a", context: "", sourceName: "t", attempts: 0 } } } as never).eq("dedupe_key", url);
    await runWorker(deps({ fetchPage: async () => ({ ok: false, code: "blocked", message: "robots.txt により取得できません" }) as SafeFetchResult }));
    const after = (await u1.from("collection_candidates").select("last_good").eq("dedupe_key", url).single()).data!.last_good as { evidence?: { hash: string } };
    expect(after.evidence?.hash).toBe(before.evidence?.hash);
  });

  it("取得制限の記録: 繰り返し失敗し、直近に再確認していないホストだけを「再取得しない」とする。一定期間後は再確認する", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 20 * 86_400_000).toISOString();
    await u1.from("collection_hard_sources").insert([
      { household_id: hid, scope: "domain", key: "blocked.example.invalid", label: "b", fail_kind: "robots", fail_count: 3, last_failed_at: now.toISOString() },
      { household_id: hid, scope: "domain", key: "once.example.invalid", label: "o", fail_kind: "robots", fail_count: 1, last_failed_at: now.toISOString() },
      { household_id: hid, scope: "domain", key: "old.example.invalid", label: "ol", fail_kind: "robots", fail_count: 5, last_failed_at: old },
    ] as never);
    const hosts = await loadBlockedHosts(u1, hid, now);
    expect(hosts.has("blocked.example.invalid")).toBe(true);
    expect(hosts.has("once.example.invalid")).toBe(false);
    expect(hosts.has("old.example.invalid")).toBe(false);
  });
});
