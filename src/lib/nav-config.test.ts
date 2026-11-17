import { describe, expect, it } from "vitest";
import { activeNavId, COPY_ITEMS, DEFAULT_NAV, DEFAULT_NAV_FIVE, MAX_QUICK, NAV_ITEMS, navItemsFor, normalizeProfileSettings, resolveNavConfig, SETTING_KEYS, type NavItem } from "@/lib/profile-settings";
import { hitQuickItem, movedTooFar, type Box } from "@/lib/quick-menu";

const ADMIN = { isAdmin: true, supabase: true };
const USER = { isAdmin: false, supabase: true };
const ids = (xs: NavItem[]) => xs.map((n) => n.id);

describe("UI-1: 下部メニューの構成（A=固定5項目／B=固定4項目＋メニュー）", () => {
  it("既定はB（従来の4項目＋メニュー）。保存値なしでも従来の並びを保つ。A（5項目）の既定は従来の4項目＋コレクション", () => {
    const b = resolveNavConfig({}, USER);
    expect(b.mode).toBe("four_menu");
    expect(ids(b.direct)).toEqual(DEFAULT_NAV);
    expect(b.corrected).toBe(false);
    const a = resolveNavConfig({ navMode: "five" }, USER);
    expect(ids(a.direct)).toEqual(DEFAULT_NAV_FIVE);
    expect(a.direct).toHaveLength(5);
  });
  it("メニュー画面には、固定項目も含め使える全機能が出る（長押しを使わなくても全機能に辿れる）。会員番号・抽選候補も選択できる機能", () => {
    const c = resolveNavConfig({}, ADMIN);
    expect(ids(c.menu)).toEqual(expect.arrayContaining(["lotteries", "candidates", "member-numbers", "collection", "settings"]));
    expect(c.menu.length).toBe(navItemsFor(ADMIN).length);
    for (const d of c.direct) expect(ids(c.menu)).toContain(d.id);
  });
  it("管理者専用の機能は管理者だけが選べる。一般ユーザーが選んでいた（権限が外れた）ときは使える機能に補正する", () => {
    expect(ids(navItemsFor(USER))).not.toContain("candidates");
    expect(ids(navItemsFor(USER))).not.toContain("collect");
    expect(ids(navItemsFor(ADMIN))).toContain("candidates");
    const c = resolveNavConfig({ nav: ["lotteries", "candidates", "purchases", "finance"], quickNav: ["candidates", "collect", "masters"] }, USER);
    expect(ids(c.direct)).not.toContain("candidates");
    expect(c.direct).toHaveLength(4);
    expect(ids(c.direct).slice(0, 2)).toEqual(["lotteries", "purchases"]);
    expect(ids(c.quick)).toEqual(["masters"]);
    expect(c.corrected).toBe(true);
    expect(ids(c.menu)).not.toContain("candidates");
  });
  it("不整合の補正: 存在しない・重複・多すぎる・足りない固定項目をA=5・B=4にそろえる。ショートカットは最大6・空なら既定", () => {
    const over = resolveNavConfig({ nav: ["finance", "finance", "nope", "lotteries", "purchases", "battles", "collection", "masters"] }, USER);
    expect(ids(over.direct)).toEqual(["finance", "lotteries", "purchases", "battles"]);
    const few = resolveNavConfig({ navMode: "five", nav: ["finance"] }, USER);
    expect(few.direct).toHaveLength(5);
    expect(ids(few.direct)[0]).toBe("finance");
    expect(new Set(ids(few.direct)).size).toBe(5);
    const empty = resolveNavConfig({ nav: [], quickNav: [] }, USER);
    expect(empty.direct).toHaveLength(4);
    expect(empty.quick.length).toBeGreaterThan(0);
    const many = resolveNavConfig({ quickNav: navItemsFor(USER).map((n) => n.id) }, USER);
    expect(many.quick).toHaveLength(MAX_QUICK);
    expect(resolveNavConfig({ navMode: "bogus" as never }, USER).mode).toBe("four_menu");
  });
  it("モード外のデータ（ログイン前のモック）では、保存先の無い機能を出さない", () => {
    const c = resolveNavConfig({}, { isAdmin: true, supabase: false });
    expect(ids(c.menu)).not.toContain("member-numbers");
    expect(ids(c.menu)).not.toContain("candidates");
    expect(ids(c.menu)).toContain("lotteries");
  });
  it("設定はユーザーごと: 一方の設定は他方に影響しない（純関数）", () => {
    const sa = { navMode: "five" as const, nav: ["finance", "lotteries", "purchases", "battles", "collection"] };
    const sb = {};
    const a = resolveNavConfig(sa, USER);
    const b = resolveNavConfig(sb, USER);
    expect(a.mode).toBe("five");
    expect(b.mode).toBe("four_menu");
    expect(ids(a.direct)).not.toEqual(ids(b.direct));
  });
  it("保存値の検証と設定コピーの対象: navMode・quickNav を受け付け、不正な値は捨てる。コピー項目に含まれる", () => {
    expect(normalizeProfileSettings({ navMode: "five", quickNav: ["masters", 1, "display"], nav: ["lotteries"] })).toEqual({ navMode: "five", quickNav: ["masters", "display"], nav: ["lotteries"] });
    expect(normalizeProfileSettings({ navMode: "x", quickNav: "y" })).toEqual({});
    expect(SETTING_KEYS).toEqual(COPY_ITEMS.map((c) => c.key));
    expect(SETTING_KEYS).toEqual(expect.arrayContaining(["nav", "navMode", "quickNav"]));
  });
  it("現在地: パスの接頭辞が最も長く一致した機能（抽選候補は抽選管理ではない）。設定の下層は「設定」", () => {
    expect(activeNavId("/lotteries")).toBe("lotteries");
    expect(activeNavId("/lotteries/candidates")).toBe("candidates");
    expect(activeNavId("/records")).toBe("lotteries");
    expect(activeNavId("/settings/member-numbers")).toBe("member-numbers");
    expect(activeNavId("/settings/x-link")).toBe("settings");
    expect(activeNavId("/nowhere")).toBeNull();
  });
  it("将来の機能（151図鑑・相場調査メモなど）は、一覧に1行足すだけで、メニュー・固定項目・ショートカットの選択肢に現れる。未実装（available:false）は出ない", () => {
    const extra: NavItem[] = [...NAV_ITEMS, { id: "zukan", href: "/zukan", label: "151図鑑", available: true, match: ["/zukan"] }, { id: "memo", href: "/memo", label: "相場メモ", available: false }];
    const c = resolveNavConfig({ nav: ["zukan", "lotteries", "finance", "purchases"], quickNav: ["zukan", "memo"] }, USER, extra);
    expect(ids(c.direct)).toEqual(["zukan", "lotteries", "finance", "purchases"]);
    expect(ids(c.menu)).toContain("zukan");
    expect(ids(c.menu)).not.toContain("memo");
    expect(ids(c.quick)).toEqual(["zukan"]);
    expect(activeNavId("/zukan/1", extra)).toBe("zukan");
  });
});

describe("UI-1: 長押しクイックメニューの判定", () => {
  // 展開後の項目（縦に並ぶ。上から順に 3 項目）
  const boxes: Box[] = [
    { left: 200, right: 360, top: 400, bottom: 444 },
    { left: 200, right: 360, top: 452, bottom: 496 },
    { left: 200, right: 360, top: 504, bottom: 548 },
  ];
  it("指の位置に対応する項目の番号を返す。項目の外・隙間はキャンセル（-1）。横のずれは余白の範囲で許す", () => {
    expect(hitQuickItem({ x: 280, y: 420 }, boxes)).toBe(0);
    expect(hitQuickItem({ x: 280, y: 470 }, boxes)).toBe(1);
    expect(hitQuickItem({ x: 280, y: 530 }, boxes)).toBe(2);
    expect(hitQuickItem({ x: 280, y: 448 }, boxes)).toBe(-1); // 隙間
    expect(hitQuickItem({ x: 280, y: 700 }, boxes)).toBe(-1); // 下の外（メニューのボタン付近）
    expect(hitQuickItem({ x: 170, y: 420 }, boxes)).toBe(0); // 左に少しずれても選べる
    expect(hitQuickItem({ x: 100, y: 420 }, boxes)).toBe(-1); // 大きく外れたらキャンセル
    expect(hitQuickItem({ x: 280, y: 420 }, [null, null])).toBe(-1);
  });
  it("長押し成立前に指が動いたら長押しをやめる（スクロール等の別の操作）", () => {
    expect(movedTooFar({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(false);
    expect(movedTooFar({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe(true);
  });
});

describe("Collection-1: ナビゲーションへの追加（151図鑑・相場調査メモ）", () => {
  it("一般ユーザーにも選択肢として出る（保存先のあるモードのみ）。固定項目・メニュー一覧・長押しショートカットのすべてに選べる", () => {
    expect(ids(navItemsFor(USER))).toEqual(expect.arrayContaining(["zukan", "market-memo"]));
    expect(ids(navItemsFor({ isAdmin: false, supabase: false }))).not.toContain("zukan");
    const c = resolveNavConfig({ nav: ["zukan", "market-memo", "lotteries", "finance"], quickNav: ["market-memo", "zukan"] }, USER);
    expect(ids(c.direct)).toEqual(["zukan", "market-memo", "lotteries", "finance"]);
    expect(ids(c.quick)).toEqual(["market-memo", "zukan"]);
    expect(ids(c.menu)).toEqual(expect.arrayContaining(["zukan", "market-memo"]));
    expect(NAV_ITEMS.find((n) => n.id === "zukan")).toMatchObject({ href: "/zukan", label: "151図鑑" });
    expect(NAV_ITEMS.find((n) => n.id === "market-memo")).toMatchObject({ href: "/market-memo", label: "相場調査メモ" });
  });
  it("既存の設定は壊れない: 追加前の保存値（nav・navMode・quickNav）をそのまま解釈でき、既定の並び・ショートカットは変わらない", () => {
    expect(ids(resolveNavConfig({}, USER).direct)).toEqual(DEFAULT_NAV);
    expect(ids(resolveNavConfig({ nav: ["finance", "lotteries", "purchases", "battles"], navMode: "four_menu", quickNav: ["masters", "display"] }, USER).direct)).toEqual(["finance", "lotteries", "purchases", "battles"]);
    expect(resolveNavConfig({}, USER).quick.map((n) => n.id)).toEqual(["collection", "member-numbers", "masters", "notifications", "display"]);
    expect(activeNavId("/zukan")).toBe("zukan");
    expect(activeNavId("/market-memo")).toBe("market-memo");
  });
});
