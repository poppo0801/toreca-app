// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assessForm } from "@/lib/agent/reeval-ai/assess";
import { planReevaluation } from "./reeval-plan";
import type { Snapshot } from "./snapshot";

/** 店舗別カードの統合候補（9H-3S-3）。同じ情報源・同じ商品、または短縮URLだけで同じ系列・商品・締切のものを組にする。保護されたカード・店舗が1つだけの組は対象にしない */
const NOW = new Date("2026-11-19T00:00:00Z");
const lot = (id: string, store: string, urls: string[], extra: Record<string, unknown> = {}) => ({ id, chain_id: "c1", store_id: store, source_kind: "auto", registration_path: "auto", store_mode: "fixed", apply_deadline_at: "2026-11-30T14:59:00+00:00", created_at: "2026-11-10T00:00:00Z", source_urls: urls, ...extra });
const snap = (lotteries: Record<string, unknown>[]): Snapshot => ({
  chains: [{ id: "c1", name: "テスト系列", is_provisional: false }],
  chain_aliases: [],
  stores: ["s1", "s2", "s3"].map((id) => ({ id, chain_id: "c1", name: `店舗${id}`, prefecture: "東京都" })),
  products: [{ id: "p1", official_name: "テスト商品", is_provisional: false }, { id: "p2", official_name: "別の商品", is_provisional: false }],
  product_aliases: [],
  lotteries,
  lottery_items: lotteries.map((l) => ({ lottery_id: l.id, product_id: (l.prod as string) ?? "p1" })),
  lottery_management: [],
  applications: [],
  collection_candidates: [],
  collection_settings: [],
});
const groups = (s: Snapshot) => planReevaluation(s, { now: NOW, prefectures: [], includeOnline: true }).items.filter((i) => i.action === "consolidate_lotteries");

describe("店舗別カードの統合候補（9H-3S-3）", () => {
  it("同じ情報源URL・同じ商品の店舗別カードを1組にする（統合先は保護されていないカード）", () => {
    const g = groups(snap([lot("l1", "s1", ["https://a.example/x"]), lot("l2", "s2", ["https://a.example/x"]), lot("l3", "s3", ["https://b.example/y"])]));
    expect(g).toHaveLength(1);
    expect((g[0].proposal.evidence as { memberIds: string[] }).memberIds.sort()).toEqual(["l1", "l2"]);
  });
  it("短縮URL（t.co）だけのカードは、同じ系列・商品・締切（日時まで一致）で組にする。締切が違えば組にしない", () => {
    const g = groups(snap([lot("l1", "s1", ["https://t.co/aaa"]), lot("l2", "s2", ["https://t.co/bbb"]), lot("l3", "s3", ["https://t.co/ccc"], { apply_deadline_at: "2026-12-05T14:59:00+00:00" })]));
    expect(g).toHaveLength(1);
    expect((g[0].proposal.evidence as { memberIds: string[] }).memberIds.sort()).toEqual(["l1", "l2"]);
  });
  it("商品が違う・店舗が1つだけ・★の抽選は組にしない／人が確認した抽選は統合先にならない", () => {
    expect(groups(snap([lot("l1", "s1", ["https://a.example/x"]), lot("l2", "s2", ["https://a.example/x"], { prod: "p2" })]))).toHaveLength(0);
    expect(groups(snap([lot("l1", "s1", ["https://a.example/x"]), lot("l2", "s1", ["https://a.example/x"])]))).toHaveLength(0);
    const s = snap([lot("l1", "s1", ["https://a.example/x"], { confirmed_at: "2026-11-01T00:00:00Z" }), lot("l2", "s2", ["https://a.example/x"]), lot("l3", "s3", ["https://a.example/x"])]);
    const g = groups(s);
    expect(g).toHaveLength(1);
    expect(g[0].targetId).not.toBe("l1");
    expect((g[0].proposal.evidence as { protectedIds: string[] }).protectedIds).toEqual(["l1"]);
  });
  it("全員が保護されているときは組にしない", () => {
    const s = snap([lot("l1", "s1", ["https://a.example/x"], { confirmed_at: "x" }), lot("l2", "s2", ["https://a.example/x"], { confirmed_at: "x" })]);
    expect(groups(s)).toHaveLength(0);
  });
});

describe("応募構造の評価（assessForm）", () => {
  const ex = (value: string, tier: "primary" | "secondary" = "primary", via?: "structure") => ({ key: "form" as const, value, quote: "原文", sourceUrl: "https://e.example/", kind: "organizer_official" as const, tier, at: "", ...(via ? { via } : {}) });
  it("情報源の記載・構造から確認できたものだけ。食い違い・記載なしは不明（推測しない）", () => {
    expect(assessForm({ extras: [ex("store_select")] }).form).toBe("store_select");
    expect(assessForm({ extras: [ex("store_independent", "secondary")] }).form).toBe("store_independent");
    expect(assessForm({ extras: [ex("store_select"), ex("store_independent", "secondary")] }).form).toBe("unknown");
    expect(assessForm({ extras: [] }).form).toBe("unknown");
    expect(assessForm({ extras: [ex("store_select", "primary", "structure")] }).viaStructure).toBe(true);
  });
});
