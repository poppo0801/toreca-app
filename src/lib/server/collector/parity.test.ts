// @vitest-environment node
/** PRODUCTION_PARITY §1・§2: 本番で動いていなかった証拠の取得・保存の経路（本番の許可・取得元ページの全文・画像の参照・小さな変化での再評価の抑制） */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { evidenceCollectStoreEnabled, linkRecheckEnabled, productionEvidenceEnabled, proposalAutoGenerateEnabled, dbHostGateEnabled } from "@/lib/server/proposals/flag";
import { imageIntakeEnabled } from "./image-intake";
import { evidenceFields } from "./run";
import { addFullPage, carryFullPages, takeFullPages } from "./collected-docs";
import { BOOKMARK_FAILURE_BACKOFF_MS, runBookmarkCron } from "./bookmarks";

const PROD = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", PROPOSAL_PROD_APPROVED: "yes", SHADOW_WORKER_PRODUCTION_APPROVED: "yes", PROPOSAL_PROD_HOUSEHOLDS: "h1,h2", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" };

describe("本番の証拠の取得・保存の許可（AIを呼ばない）", () => {
  it("本番の承認済みスイッチ・世帯の許可リストが揃えば、全文の保存・リンクの再調査・画像の取得が動く（以前は本番で常に false）", () => {
    expect(productionEvidenceEnabled(PROD, "h1")).toBe(true);
    expect(evidenceCollectStoreEnabled(PROD, "h1")).toBe(true);
    expect(linkRecheckEnabled(PROD, "h1")).toBe(true);
    expect(imageIntakeEnabled(PROD, "h1")).toBe(true);
  });
  it("許可リストに無い世帯・停止スイッチ・本番以外・承認の欠けでは動かない", () => {
    expect(evidenceCollectStoreEnabled(PROD, "other")).toBe(false);
    expect(evidenceCollectStoreEnabled({ ...PROD, PROPOSAL_KILL: "1" }, "h1")).toBe(false);
    expect(evidenceCollectStoreEnabled({ ...PROD, SHADOW_WORKER_KILL: "on" }, "h1")).toBe(false);
    expect(evidenceCollectStoreEnabled({ ...PROD, EVIDENCE_PROD: "off" }, "h1")).toBe(false);
    expect(evidenceCollectStoreEnabled({ ...PROD, VERCEL_ENV: "preview" }, "h1")).toBe(false);
    expect(evidenceCollectStoreEnabled({ ...PROD, SHADOW_WORKER_PRODUCTION_APPROVED: undefined }, "h1")).toBe(false);
    expect(linkRecheckEnabled({ ...PROD, LINK_RECHECK: "off" }, "h1")).toBe(false);
    expect(imageIntakeEnabled({ ...PROD, IMAGE_INTAKE: "off" }, "h1")).toBe(false);
  });
  it("開発のモック生成・DB共有のホスト制御は本番で無効のまま（無条件に全機能をONにしない）", () => {
    expect(proposalAutoGenerateEnabled({ ...PROD, PROPOSAL_AUTO: "on", PROPOSAL_PREVIEW: "on" })).toBe(false);
    expect(dbHostGateEnabled({ ...PROD, FETCH_GATE: "db" })).toBe(false);
  });
});

const card = (text: string) => ({ kind: "web_page", url: "https://shop.example.jp/lottery", title: "t", context: text, card: text } as never);

describe("証拠の保存（取得元ページの全文・画像の参照・小さな変化）", () => {
  it("本番（fetchPage の注入なし）でも取得したページ本文を控える包みが作られる（以前は rawFetch && … で本番だけ控えが作られなかった）", () => {
    const src = readFileSync("src/lib/server/collector/run.ts", "utf8");
    expect(src).toContain("deps.fetchPage ?? ((u: string) => fetchRespectingRobots(u))");
    expect(src).not.toMatch(/fetchPageCap: typeof deps\.fetchPage = rawFetch &&/);
  });
  it("取り直しで別のオブジェクトに控えた全文を元の項目へ引き継ぐ", () => {
    const a = {};
    const b = {};
    addFullPage(a, { url: "https://e.jp/p", finalUrl: "https://e.jp/p", title: "", text: "x".repeat(40), truncated: false, fetchedAt: "2026-11-26T00:00:00Z", depth: 0, origins: ["post"] });
    carryFullPages(a, b);
    expect(takeFullPages(b)).toHaveLength(1);
  });
  it("画像への参照は、収集時の解析が画像から読み取れなかった投稿でも保存する（以前は参照0件）", () => {
    const q = { kind: "x_post", url: "https://x.com/a/status/1", title: "t", context: "", post: { id: "1", text: "抽選のお知らせです。詳細は画像をご確認ください", images: ["https://pbs.twimg.com/media/a.jpg"], links: [], createdAt: "2026-11-26T00:00:00Z", username: "a" } } as never;
    const ev = evidenceFields("https://x.com/a/status/1", q, "2026-11-26T00:00:00Z", null).evidence!;
    expect(ev.imageRefs).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
    expect(ev.imageReadings).toBeUndefined();
  });
  it("残り日数など正規化の範囲だけの変化なら、前回の本文・ハッシュを保つ（再評価の多重投入を防ぐ）。実質の変化ならハッシュが変わる", () => {
    const p1 = evidenceFields("https://shop.example.jp/lottery", card("ポケモンカード 抽選販売 受付 11/30まで 残り5日"), "2026-11-25T00:00:00Z", null).evidence!;
    const p2 = evidenceFields("https://shop.example.jp/lottery", card("ポケモンカード 抽選販売 受付 11/30まで 残り4日"), "2026-11-26T00:00:00Z", p1).evidence!;
    expect(p2.hash).toBe(p1.hash);
    const p3 = evidenceFields("https://shop.example.jp/lottery", card("ポケモンカード 抽選販売 受付 12/5まで 残り4日"), "2026-11-26T00:00:00Z", p1).evidence!;
    expect(p3.hash).not.toBe(p1.hash);
  });
});

describe("ブックマークの自動同期の失敗時の間隔", () => {
  it("失敗の直後（last_error あり・1時間以内）は再試行しない（以前は5分ごと）", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const rows = [{ household_id: "h1", last_error: "残高不足", updated_at: new Date(now.getTime() - 10 * 60_000).toISOString() }];
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "eq", "or"]) chain[k] = () => chain;
    chain.limit = async () => ({ data: rows });
    let calls = 0;
    const db = { from: () => (calls++, chain) } as never;
    const r = await runBookmarkCron(db, now, { cfg: { clientId: "x", clientSecret: "y", encKey: "z" } as never });
    expect(r.synced).toBe(0);
    expect(calls).toBe(1); // 一覧の読み取りだけ（同期は試みない）
    // 間隔を過ぎた失敗は再試行する（同期の処理がDBを読む）
    rows[0].updated_at = new Date(now.getTime() - BOOKMARK_FAILURE_BACKOFF_MS - 1000).toISOString();
    calls = 0;
    await runBookmarkCron(db, now, { cfg: { clientId: "x", clientSecret: "y", encKey: "z" } as never });
    expect(calls).toBeGreaterThan(1);
  });
});
