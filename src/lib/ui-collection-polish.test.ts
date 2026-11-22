// @vitest-environment node
/** 151図鑑・相場調査メモ・購入記録のUI修正（純関数・素材の検証）。 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addPricesSequentially } from "@/components/price-form";
import { normalizeProfileSettings, SAVEABLE_KEYS, SETTING_KEYS } from "@/lib/profile-settings";
import { dexOfCardName, POKEMON_151 } from "@/lib/zukan/pokemon151";
import { dexStatus, zukanRows, type ZukanCard } from "@/lib/zukan/zukan";
import { orderTotalsForDisplay, type UsageTotal } from "@/lib/usage-records";

const card = (dexNo: number, quantity = 1): ZukanCard => ({ id: `c${dexNo}`, profileId: "p", dexNo, cardName: "x", setName: "", cardNumber: "", rarity: "", quantity, acquiredOn: null, acquireMethod: "pack_opening", purchaseAmountYen: null, storeName: "", condition: "", memo: "", priceRecordId: null });

describe("151図鑑の状態: 入手済み > 相場登録済み > 対象レア未収録 > 未登録", () => {
  it("優先順位", () => {
    expect(dexStatus({ owned: true, hasPrice: true, rareMissing: true })).toBe("owned");
    expect(dexStatus({ owned: false, hasPrice: true, rareMissing: true })).toBe("market");
    expect(dexStatus({ owned: false, hasPrice: false, rareMissing: true })).toBe("rare_missing");
    expect(dexStatus({ owned: false, hasPrice: false, rareMissing: false })).toBe("unregistered");
  });
  it("対象レア未収録は手動フラグだけで付く（フラグが無ければ自動では付かない）。収集済みの絞り込み・件数は従来どおり", () => {
    const rows = zukanRows([card(25)], "all", { prices: [{ dexNo: 6 }], rareMissing: new Set([1]) });
    const st = (n: number) => rows.find((r) => r.no === n)!.status;
    expect([st(25), st(6), st(1), st(2)]).toEqual(["owned", "market", "rare_missing", "unregistered"]);
    expect(rows.filter((r) => r.status === "rare_missing")).toHaveLength(1);
    expect(zukanRows([card(25)], "collected", {})).toHaveLength(1);
    expect(zukanRows([card(25)], "uncollected", {})).toHaveLength(150);
    // 引数なし（従来の呼び出し）は全て未登録/入手済みのみ
    expect(new Set(zukanRows([], "all").map((r) => r.status))).toEqual(new Set(["unregistered"]));
  });
  it("並び替え: 図鑑番号順（既定）／五十音順（読み順。同じ読みは番号順）。件数は変わらない", () => {
    const byNo = zukanRows([], "all", { sort: "no" });
    expect(byNo.map((r) => r.no)).toEqual(Array.from({ length: 151 }, (_, i) => i + 1));
    const kana = zukanRows([], "all", { sort: "kana" });
    expect(kana).toHaveLength(151);
    expect(new Set(kana.map((r) => r.no)).size).toBe(151);
    const c = new Intl.Collator("ja");
    for (let i = 1; i < kana.length; i++) expect(c.compare(kana[i - 1].name, kana[i].name)).toBeLessThanOrEqual(0);
  });
});

describe("151図鑑の画像素材（private-assets/zukan）", () => {
  it("No.001〜151が全て存在し、配信用に小さい（1枚100KB未満・合計3MB未満）。余計なファイルは無い", () => {
    const files = readdirSync("private-assets/zukan").sort();
    expect(files).toEqual(Array.from({ length: 151 }, (_, i) => `${String(i + 1).padStart(3, "0")}.webp`));
    const sizes = files.map((f) => statSync(`private-assets/zukan/${f}`).size);
    expect(Math.max(...sizes)).toBeLessThan(100_000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(3_000_000);
  });
  it("変換スクリプトは、番号と日本語名が完全一致する通常版だけを採用する（括弧付きの派生形・メガ等は無視）", () => {
    const src = readFileSync("scripts/build-zukan-images.mjs", "utf8");
    expect(src).toContain("【公式絵No.${String(no).padStart(4, \"0\")}】${name}.png");
    expect(src).not.toMatch(/startsWith|includes\(/); // 前方一致・部分一致で派生形を拾わない
  });
  it("画像は公開フォルダに置かない（認証つきの配信ルートだけ）。ルートは番号を厳密に検査し、ログインを要する", () => {
    expect(existsSync("public/zukan")).toBe(false);
    const route = readFileSync("src/app/api/zukan-image/[no]/route.ts", "utf8");
    expect(route).toContain("auth.getUser()");
    expect(route).toContain("/^\\d{1,3}$/");
    expect(route).toContain("n < 1 || n > 151");
  });
});

describe("カード名からのポケモン画像（相場調査メモ。記録は変更しない）", () => {
  it("最も長く一致する名前を選ぶ（レアコイル≠コイル、ミュウツー≠ミュウ）。該当なしは null", () => {
    expect(dexOfCardName("レアコイル ex")?.name).toBe("レアコイル");
    expect(dexOfCardName("ミュウツーV")?.name).toBe("ミュウツー");
    expect(dexOfCardName("ミュウ")?.name).toBe("ミュウ");
    expect(dexOfCardName("ピカチュウ SAR")?.no).toBe(25);
    expect(dexOfCardName("サポートカード（博士）")).toBeNull();
    expect(POKEMON_151.every((p) => dexOfCardName(p.name)?.no === p.no)).toBe(true);
  });
});

describe("商品別累計の並び: 発売日の新しい順 → 発売日未設定 → その他（シングル等）が最後", () => {
  const t = (label: string, productId: string | null, extra: Partial<UsageTotal> = {}): UsageTotal => ({ productId, label, boxes: 0, packs: 0, directPacks: 0, sets: 0, singleQty: 0, packEquivalent: null, amount: 0, amountUnknown: 0, category: "pokemon_card", single: false, ...extra });
  const info: Record<string, { releaseDate: string | null; other: boolean }> = {
    old: { releaseDate: "2026-01-01", other: false },
    new: { releaseDate: "2026-11-27", other: false },
    same1: { releaseDate: "2026-06-01", other: false },
    same2: { releaseDate: "2026-06-01", other: false },
    nodate: { releaseDate: null, other: false },
    oripa: { releaseDate: "2026-12-31", other: true },
  };
  const rows = [t("単カード", null, { single: true, singleQty: 3 }), t("オリパ", "oripa"), t("日付なし", "nodate"), t("古い", "old"), t("同日B", "same2"), t("新しい", "new"), t("同日A", "same1")];
  const f = (x: UsageTotal) => (x.single ? { releaseDate: null, other: true } : (info[x.productId!] ?? { releaseDate: null, other: false }));
  it("並び", () => {
    expect(orderTotalsForDisplay(rows, f).map((r) => r.label)).toEqual(["新しい", "同日A", "同日B", "古い", "日付なし", "オリパ", "単カード"]);
  });
  it("入力順を変えても同じ並び（同日の順序は安定）。入力は変更しない", () => {
    const a = orderTotalsForDisplay(rows, f).map((r) => r.label);
    const b = orderTotalsForDisplay([...rows].reverse(), f).map((r) => r.label);
    expect(b).toEqual(a);
    expect(rows[0].label).toBe("単カード");
  });
});

describe("プロフィール設定: 対象レア未収録フラグ", () => {
  it("1〜151の整数だけ・重複除去・昇順。保存できるが、設定のコピー対象には含めない", () => {
    expect(normalizeProfileSettings({ zukanRareMissing: [25, 1, 25, 0, 152, 3.5, "x", 151] }).zukanRareMissing).toEqual([1, 25, 151]);
    expect(normalizeProfileSettings({ zukanRareMissing: "bad" }).zukanRareMissing).toBeUndefined();
    expect(SAVEABLE_KEYS).toContain("zukanRareMissing");
    expect(SETTING_KEYS).not.toContain("zukanRareMissing");
  });
});

describe("状態違いの複数価格の一括登録", () => {
  const item = (c: string) => ({ storeName: "店", chainName: "", surveyedOn: "2026-11-17", condition: c as never, priceYen: 100, note: "" });
  it("順に登録する。途中で失敗したら止め、保存済みの件数を伝える", async () => {
    const seen: string[] = [];
    const ok = await addPricesSequentially([item("A"), item("B")], async (v) => (seen.push(v.condition), { ok: true as const }));
    expect(ok).toEqual({ done: 2, error: null });
    const seen2: string[] = [];
    const ng = await addPricesSequentially([item("A"), item("B"), item("C")], async (v) => (seen2.push(v.condition), v.condition === "B" ? { ok: false as const, error: "保存できませんでした" } : { ok: true as const }));
    expect(seen2).toEqual(["A", "B"]); // 失敗で停止（Cは試さない）
    expect(ng.done).toBe(1);
    expect(ng.error).toContain("2件目で失敗");
    expect(ng.error).toContain("1件は保存済み");
  });
});
