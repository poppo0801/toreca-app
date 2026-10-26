import { describe, expect, it } from "vitest";
import { buildSchema, ENTITIES, normalizeAlias, toDbValues } from "@/lib/masters";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("マスター入力検証", () => {
  it("系列: 必須・文字数・未知のキーを拒否する", () => {
    const s = buildSchema(ENTITIES.chains);
    expect(s.safeParse({ name: "A系列", default_application_rule: "", memo: "" }).success).toBe(true);
    expect(s.safeParse({ name: " ", default_application_rule: "", memo: "" }).success).toBe(false);
    expect(s.safeParse({ name: "x".repeat(81), default_application_rule: "", memo: "" }).success).toBe(false);
    // 世帯IDなどの上書きは受け付けない（strict）
    expect(s.safeParse({ name: "A", default_application_rule: "", memo: "", household_id: uuid }).success).toBe(false);
  });

  it("商品: 入数は1以上の整数。任意の日付は空欄でnull", () => {
    const s = buildSchema(ENTITIES.products);
    const base = { official_name: "P", product_code: "", category: "pokemon_card", release_date: "", packs_per_box: "20" };
    const ok = s.parse(base) as Record<string, unknown>;
    expect(ok.packs_per_box).toBe(20);
    expect(ok.release_date).toBeNull();
    expect(toDbValues(ENTITIES.products, ok).product_code).toBeNull();
    expect(s.safeParse({ ...base, packs_per_box: "0" }).success).toBe(false);
    expect(s.safeParse({ ...base, packs_per_box: "1.5" }).success).toBe(false);
  });

  it("店舗: 緯度経度は範囲内のみ、空欄はnull。参照はUUID必須", () => {
    const s = buildSchema(ENTITIES.stores);
    const base = { chain_id: uuid, name: "S", prefecture: "", nearest_station: "", address_optional: "", parking_memo: "", latitude: "", longitude: "" };
    expect((s.parse(base) as Record<string, unknown>).latitude).toBeNull();
    expect(s.safeParse({ ...base, latitude: "91" }).success).toBe(false);
    expect(s.safeParse({ ...base, chain_id: "not-uuid" }).success).toBe(false);
  });

  it("プロフィール色は定義済みの値のみ", () => {
    const s = buildSchema(ENTITIES.profiles);
    const base = { label: "D", initial: "D", color: "pink", sort_order: "4" };
    expect(s.safeParse(base).success).toBe(true);
    expect(s.safeParse({ ...base, color: "red" }).success).toBe(false);
    expect(s.safeParse({ ...base, initial: "ABC" }).success).toBe(false);
  });

  it("略称は全角半角・大小・空白の揺れを吸収して正規化する（一致でも自動確定はしない）", () => {
    expect(normalizeAlias(" Ｍ６ ひかり ")).toBe("m6ひかり");
    const v = toDbValues(ENTITIES.product_aliases, { product_id: uuid, alias: "Ｍ６" });
    expect(v.normalized_alias).toBe("m6");
  });
});
