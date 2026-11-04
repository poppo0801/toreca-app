import { describe, expect, it } from "vitest";
import { manualHeadline, manualSignature, sortManual, toManualItem, type ManualRow } from "@/lib/collector/manual-items";
import { createMockData } from "@/data/mock";
import { EXCLUSION_SCOPE_LABEL, originOf, sourceScopeOptions, xAccountOf } from "@/lib/provenance";

const NOW = new Date("2026-11-04T03:00:00Z"); // 12:00 JST
const h = (n: number) => new Date(NOW.getTime() + n * 3600_000).toISOString();
const row = (id: string, dueInH: number | null, extra: Partial<ManualRow> = {}): ManualRow => ({ id, title: `t-${id}`, source_url: `https://shop.example.invalid/${id}`, due_at: dueInH === null ? null : h(dueInH), manual_reason: "取得できていません", fail_kind: "robots", manual_since: h(-1), draft: null, ...extra });

describe("要手動確認の表示データ", () => {
  it("系列・店舗・商品・理由・締切・元情報を簡潔にまとめる。解析済みなら編集して登録できる", () => {
    const it = toManualItem(row("a", 5, { draft: { input: { chain: { name: "テスト系列" }, store: { name: "テスト店" }, items: [{ product: { name: "テスト商品" } }] } } }), NOW);
    expect(it.where).toBe("テスト系列 / テスト店");
    expect(it.products).toEqual(["テスト商品"]);
    expect(it.failLabel).toBe("取得制限（ロボット・アクセス制限）");
    expect(it.urgency).toBe("today");
    expect(it.urgencyLabel).toBe("本日締切");
    expect(it.sourceHost).toBe("shop.example.invalid");
    expect(it.editable).toBe(true);
    expect(toManualItem(row("b", null), NOW).editable).toBe(false);
  });
  it("締切が近い順に並べる（本日→明日→締切不明→余裕あり）", () => {
    const items = [row("later", 24 * 8), row("unknown", null), row("tomorrow", 14), row("today", 4)].map((r) => toManualItem(r, NOW));
    expect(sortManual(items).map((i) => i.id)).toEqual(["today", "tomorrow", "unknown", "later"]);
  });
  it("最上部の赤い警告の文言と、表示済み判定の署名（案件の集合が変わったときだけ変わる）", () => {
    expect(manualHeadline(3)).toBe("取得不可：3件／要手動確認");
    expect(manualSignature([{ id: "b" }, { id: "a" }])).toBe(manualSignature([{ id: "a" }, { id: "b" }]));
    expect(manualSignature([{ id: "a" }])).not.toBe(manualSignature([{ id: "a" }, { id: "b" }]));
  });
});

describe("登録経路", () => {
  it("4種類を区別し、確認済み=チェック／完全自動収集・未確認=ロボットのアイコン", () => {
    expect(originOf({ registrationPath: "manual", sourceKind: "manual" })).toMatchObject({ label: "手動登録", icon: "check", auto: false });
    expect(originOf({ registrationPath: "manual_ai", sourceKind: "manual" })).toMatchObject({ label: "AIを利用した手動登録", icon: "check", auto: false });
    expect(originOf({ registrationPath: "auto", sourceKind: "auto" })).toMatchObject({ label: "自動収集（未確認）", icon: "bot", auto: true });
    expect(originOf({ registrationPath: "auto_confirmed", sourceKind: "auto" })).toMatchObject({ label: "自動収集（ユーザー確認済み）", icon: "check", auto: true });
  });
  it("経路が未設定の既存データは、source_kind から推定する（自動収集=auto、それ以外=手動）", () => {
    expect(originOf({ sourceKind: "auto" }).path).toBe("auto");
    expect(originOf({ sourceKind: "import" }).path).toBe("manual");
  });
});

describe("今後この収集元を除外: 範囲の候補", () => {
  const data = createMockData(NOW);
  const l = data.lotteries[0];
  const chain = data.chains.find((c) => c.id === l.chainId)!;
  const store = data.stores.find((s) => s.id === l.storeId)!;
  it("店舗・系列・Xアカウント・個別サイトを、対象を明示して返す", () => {
    const opts = sourceScopeOptions({ ...l, sourceUrls: ["https://x.com/some_shop/status/123", "https://shop.example.invalid/news/1"] }, data);
    expect(opts.map((o) => o.scope)).toEqual(["store", "chain", "x_account", "domain"]);
    expect(opts[0].label).toContain(store.name);
    expect(opts[1].label).toContain(chain.name);
    expect(opts[2]).toMatchObject({ key: "some_shop" });
    expect(opts[3]).toMatchObject({ key: "shop.example.invalid" });
    for (const o of opts) expect(o.hint.length).toBeGreaterThan(0);
  });
  it("X全体・e-starbox全体・まとめサイト全体・短縮URLは、範囲の候補に出さない", () => {
    const opts = sourceScopeOptions({ ...l, sourceUrls: ["https://shoplottery.e-starbox.com/lottery/1", "https://pokeso.jp/chusen/1", "https://t.co/abc", "https://x.com/home"] }, data);
    expect(opts.map((o) => o.scope)).not.toContain("domain");
    expect(opts.map((o) => o.scope)).not.toContain("x_account");
    // 代わりに「このURLのみ」の投稿元だけ選べる
    expect(opts.at(-1)?.scope).toBe("source_post");
  });
  it("Xの投稿URLからアカウント名を取り出す", () => {
    expect(xAccountOf("https://x.com/abc_DEF/status/1")).toBe("abc_DEF");
    expect(xAccountOf("https://x.com/home")).toBeNull();
    expect(EXCLUSION_SCOPE_LABEL.x_account).toBe("Xアカウント");
  });
});
