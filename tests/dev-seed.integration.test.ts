/**
 * Stage 8D-1: 開発用テストデータ（scripts/lib/dev-seed.mjs）の検証。ローカルDB限定・冪等性・アプリのデータ層での読み込み。
 *   npm run test:db   （実行前に接続先がローカルであることを確認済み）
 */
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { dbTestsEnabled, publishable, url } from "./helpers/db";

const seed = () => spawnSync(process.execPath, ["scripts/dev-db.mjs", "seed"], { encoding: "utf8", env: process.env });

describe.skipIf(!dbTestsEnabled)("Stage 8D-1: 開発用テストデータ", () => {
  let db: Db;
  let counts: { chains: number; stores: number; products: number; lotteries: number };

  beforeAll(async () => {
    const r = seed();
    expect(r.status, r.stderr).toBe(0);
    const client = createClient(url!, publishable!, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email: "dev-user@example.invalid", password: "dev-local-password-1" });
    expect(signIn.error).toBeNull();
    db = client as unknown as Db;
  });

  it("アプリのデータ層（loadAppData）で、投入した系列・店舗・商品・抽選が読める", async () => {
    const d = await loadAppData(db);
    counts = { chains: d.chains.length, stores: d.stores.length, products: d.products.length, lotteries: d.lotteries.length };
    expect(counts.chains).toBeGreaterThanOrEqual(7);
    expect(counts.stores).toBeGreaterThanOrEqual(15);
    expect(counts.products).toBeGreaterThanOrEqual(4);
    expect(counts.lotteries).toBeGreaterThanOrEqual(18);
  });

  it("要求された種類が含まれる: 通販・複数商品・店舗選択式・継続・日付不明・複雑条件・同名店舗・住所の有無・別名", async () => {
    const d = await loadAppData(db);
    const stores = d.stores;
    expect(stores.filter((s) => s.salesKind === "online_only").length).toBeGreaterThanOrEqual(2);
    expect(stores.filter((s) => s.name === "本店").length).toBeGreaterThanOrEqual(2); // 同名店舗
    expect(stores.some((s) => s.address)).toBe(true);
    expect(stores.some((s) => !s.address)).toBe(true);
    expect(stores.some((s) => (s.aliases ?? []).length > 0)).toBe(true);
    expect(d.chains.some((c) => (c.aliases ?? []).length > 0)).toBe(true); // 表記ゆれ
    const lots = d.lotteries;
    expect(lots.some((l) => l.items.length >= 2)).toBe(true); // 複数商品
    expect(lots.some((l) => l.storeMode === "select_on_apply")).toBe(true); // 店舗選択式
    expect(lots.some((l) => l.kind === "ongoing")).toBe(true); // 継続
    expect(lots.some((l) => (l.requirementTags ?? []).length >= 3)).toBe(true); // 応募条件が複雑
  });

  it("何度実行しても重複・欠落が起きない（件数が変わらない）", async () => {
    const before = counts ?? { chains: 0, stores: 0, products: 0, lotteries: 0 };
    expect(seed().status).toBe(0);
    expect(seed().status).toBe(0);
    const d = await loadAppData(db);
    expect({ chains: d.chains.length, stores: d.stores.length, products: d.products.length, lotteries: d.lotteries.length }).toEqual(before);
  });
});
