import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { kindOfUrl, loadSourceSnapshotTexts, saveSourceSnapshots } from "@/lib/server/agent/source-snapshots";

/** 情報源の保存の互換性（表が無い環境＝本番など、マイグレーション未適用でも既存の動作に影響しない）。DB・ネットワークなし */
const missingTable = (): Db => {
  const err = { error: { code: "42P01", message: 'relation "public.lottery_source_snapshots" does not exist' }, data: null };
  const chain: Record<string, unknown> = {};
  for (const m of ["upsert", "select", "in", "gt", "order", "limit", "from"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (res: (v: unknown) => unknown) => res(err);
  return { from: () => chain } as unknown as Db;
};

describe("情報源の保存: 表が無い環境でも安全（保存は何もせず、読み込みは空。例外を投げない）", () => {
  it("保存: 表が無ければ saved=0・tableMissing=true。保存できない内容（http以外・空の本文）は送らない", async () => {
    expect(await saveSourceSnapshots(missingTable(), "h", [{ lotteryId: "l", url: "https://example.invalid/p", kind: "web_page", origin: "manual", body: "本文" }])).toEqual({ saved: 0, tableMissing: true });
    expect(await saveSourceSnapshots(missingTable(), "h", [{ lotteryId: "l", url: "javascript:alert(1)", kind: "web_page", origin: "manual", body: "本文" }, { lotteryId: "l", url: "https://example.invalid/p", kind: "web_page", origin: "manual", body: "   " }])).toEqual({ saved: 0, tableMissing: false });
  });
  it("読み込み: 表が無ければ空（従来どおり、収集時の下書きだけが根拠になる）", async () => {
    expect((await loadSourceSnapshotTexts(missingTable(), ["a", "b"])).size).toBe(0);
  });
  it("情報源の種類: X・短縮URLは x_post、それ以外は web_page", () => {
    expect(kindOfUrl("https://x.com/shop/status/1")).toBe("x_post");
    expect(kindOfUrl("https://t.co/abc")).toBe("x_post");
    expect(kindOfUrl("https://livepocket.jp/e/abc")).toBe("web_page");
    expect(kindOfUrl("not a url")).toBe("web_page");
  });
});

describe("情報源の取得部品: 開発環境で明示的に許可したときだけ作る（本番・既定では作らない＝AIは外部に取得しに行けない）", () => {
  it("TOREMANE_ENV=local かつ GROUPING_FETCH=allow のときだけ", async () => {
    const { createGroupingFetcher } = await import("@/lib/server/agent/lottery-grouping-engine");
    expect(await createGroupingFetcher({})).toBeUndefined();
    expect(await createGroupingFetcher({ TOREMANE_ENV: "local" })).toBeUndefined();
    expect(await createGroupingFetcher({ GROUPING_FETCH: "allow" })).toBeUndefined();
    expect(await createGroupingFetcher({ TOREMANE_ENV: "production", GROUPING_FETCH: "allow" })).toBeUndefined();
    expect(await createGroupingFetcher({ TOREMANE_ENV: "local", GROUPING_FETCH: "allow" })).toBeDefined();
  });
});
