// @vitest-environment node
/** 151図鑑・相場調査メモ・購入記録のUI修正（純関数・素材の検証）。 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { buildManifest } from "../../scripts/lib/pokemon-images.mjs";
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

describe("ポケモン画像: Gitに載せず、Supabase Storage の非公開バケット＋認証つき配信", () => {
  it("画像の整理: 番号4桁・括弧付きの姿違いは無視・151以内は図鑑名の完全一致・152以降は括弧なしの最短名（複数なら曖昧として報告）", () => {
    const names = ["フシギダネ", "フシギソウ", "フシギバナ"];
    const files = ["【公式絵No.0001】フシギダネ.png", "【公式絵No.0002】フシギソウ.png", "【公式絵No.0003】フシギバナ.png", "【公式絵No.0003】フシギバナ（キョダイマックスのすがた）.png", "【公式絵No.0003】メガフシギバナ.png", "【公式絵No.0152】チコリータ.png", "【公式絵No.0152】チコリータ（ふしぎ）.png", "【公式絵No.0153】ベイリーフ（フォルム違い）.png", "【公式絵No.0200】ムウマ.png", "【公式絵No.0200】メガムウマ.png", "bad.png"];
    const { entries, stats } = buildManifest(files, names);
    const by = Object.fromEntries(entries.map((e: { no: number }) => [e.no, e]));
    expect(by[3]).toMatchObject({ key: "official/0003.webp", name: "フシギバナ", ambiguous: false }); // メガ・括弧付きは採用しない
    expect(by[152]).toMatchObject({ name: "チコリータ", ambiguous: false });
    expect(by[153]).toBeUndefined(); // 括弧付きしか無い番号は画像なし（プレースホルダー）
    expect(by[200]).toMatchObject({ name: "ムウマ", ambiguous: true });
    expect(stats).toMatchObject({ files: 11, parsed: 10, unparsed: ["bad.png"], numbers: 6, selected: 5, ambiguous: 1, maxNo: 200 });
    expect(stats.gapNumbers).toContain(154);
    expect(entries.every((e: { key: string }) => /^official\/\d{4}\.webp$/.test(e.key))).toBe(true);
  });
  it("アップロードは本番では既定で拒否（権限確認までは本番に置かない）。画像・変換物はGit管理外", () => {
    const src = readFileSync("scripts/pokemon-images.mjs", "utf8");
    expect(src).toContain("--yes-production");
    expect(src).toContain("--yes-upload");
    const ig = readFileSync(".gitignore", "utf8");
    expect(ig).toContain("private-assets/");
    expect(ig).toContain("pokemon-image*/");
    expect(existsSync("public/zukan")).toBe(false);
    expect(existsSync("private-assets")).toBe(false);
  });
  it("配信ルートは非公開バケットだけから、ログイン中の利用者の権限（Storage RLS）で取得。service role は使わず、キャッシュは private。番号は厳密に検査", () => {
    const route = readFileSync("src/app/api/pokemon-image/[no]/route.ts", "utf8");
    expect(route).toContain("auth.getClaims()");
    expect(route).toContain('storage.from("pokemon-images")');
    expect(route).toContain('from("households").select("id")'); // 世帯は利用者自身の権限（RLS）で取得
    expect(route).toContain("/^\\d{1,4}$/");
    expect(route).toContain("private, max-age=2592000, immutable");
    expect(route.indexOf("auth.getClaims()")).toBeLessThan(route.indexOf("SUPABASE_SERVICE_ROLE_KEY")); // 認証の確認の後でだけ service role を使う
    expect(route).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SERVICE|console\.(log|error)/); // 秘密をクライアント・ログへ出さない
    const setup = readFileSync("scripts/setup-pokemon-images-bucket.mjs", "utf8");
    expect(setup).toContain("public: false"); // 非公開バケット
    expect(setup).not.toMatch(/create policy|storage\.objects/i); // 利用者向けのStorageポリシーは作らない
    expect(setup).toContain("--execute"); // 既定は dry-run
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
