import { describe, expect, it } from "vitest";
import { lotteryInputSchema, MAX_LOTTERY_ITEMS } from "@/lib/lottery-input";

const base = {
  chain: { id: null, name: "テスト" },
  store: { id: null, name: "本店", prefecture: "大阪府" },
  items: [] as { product: { id: string | null; name: string }; quantity: number; unit: string }[],
  applyStart: { precision: "date_only", date: "2026-11-18" },
  applyDeadline: { precision: "date_only", date: "2026-11-19" },
  resultDate: { precision: "unknown" },
  sourceUrls: ["https://example.com/a"],
};
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ product: { id: null, name: `商品${i}` }, quantity: 1, unit: "box" }));

describe("抽選の商品（明細）の上限", () => {
  it("12種の商品を含む抽選（カードセット9種＋スターターセット3種）を受け付ける（以前は10を超えると自動登録が「Too big」で失敗した）", () => {
    const r = lotteryInputSchema.safeParse({ ...base, items: items(12) });
    expect(r.error?.issues.map((i) => i.message)).not.toContain("Too big: expected array to have <=10 items");
    expect(r.success || !r.error?.issues.some((i) => i.path[0] === "items")).toBe(true);
  });
  it("極端に多い入力は引き続き断る（上限あり）", () => {
    const r = lotteryInputSchema.safeParse({ ...base, items: items(MAX_LOTTERY_ITEMS + 1) });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path[0] === "items")).toBe(true);
  });
});
