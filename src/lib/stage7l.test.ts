import { describe, expect, it } from "vitest";
import { missingBadges } from "@/lib/collector/missing-badges";
import { searchDupTargets, storeDiffers, suggestDuplicates, type DupTarget } from "@/lib/collector/user-rules";
import { clearResume, loadResume, mergeResume, RESUME_TTL_MS, saveResume, type ResumeStash } from "@/lib/lottery-resume";
import type { LotteryInput } from "@/lib/lottery-input";

/** 最小のストレージ（sessionStorage の代わり） */
function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size };
}
const input = (over: Record<string, unknown> = {}) => ({ chain: { id: "c1", name: "A" }, store: { id: "s1", name: "梅田店", prefecture: "" }, memo: "", conditionsText: "", applyDeadline: { precision: "date_only", date: "2026-12-01", time: "" }, ...over }) as unknown as LotteryInput;
const stash = (over: Partial<ResumeStash> = {}): ResumeStash => ({ lotteryId: "l1", profileId: "p1", baseUpdatedAt: "t0", base: input(), baseUrls: "", edited: input({ memo: "編集中" }), editedUrls: "", sources: {}, at: 1_000_000, ...over });

describe("Stage 7L: 編集の一時保存・再開", () => {
  it("同じ抽選・同じプロフィールの、10分以内の一時保存だけ復元できる", () => {
    const st = memory();
    saveResume(stash(), st);
    expect(loadResume("l1", "p1", 1_000_000 + 60_000, st)?.edited).toMatchObject({ memo: "編集中" });
    expect(loadResume("l1", "p1", 1_000_000 + RESUME_TTL_MS, st)).not.toBeNull(); // ちょうど10分は有効
  });
  it("10分を過ぎると無効（保存内容も破棄）", () => {
    const st = memory();
    saveResume(stash(), st);
    expect(loadResume("l1", "p1", 1_000_000 + RESUME_TTL_MS + 1, st)).toBeNull();
    expect(st.size()).toBe(0);
  });
  it("別の抽選を編集すると以前の一時保存は破棄される（最後の1件だけ）", () => {
    const st = memory();
    saveResume(stash(), st);
    expect(loadResume("l2", "p1", 1_000_001, st)).toBeNull();
    expect(st.size()).toBe(0);
    saveResume(stash({ lotteryId: "l2" }), st);
    expect(loadResume("l1", "p1", 1_000_002, st)).toBeNull(); // l1 は残っていない
  });
  it("別のプロフィールには復元しない（そのプロフィールの内容は消さない）", () => {
    const st = memory();
    saveResume(stash(), st);
    expect(loadResume("l1", "p2", 1_000_100, st)).toBeNull();
    expect(loadResume("l1", "p1", 1_000_100, st)).not.toBeNull();
  });
  it("正式保存・ログアウトで削除される／壊れた内容は復元しない", () => {
    const st = memory();
    saveResume(stash(), st);
    clearResume(st);
    expect(loadResume("l1", "p1", 1_000_100, st)).toBeNull();
    st.setItem("tcg.lottery-resume.v1", "{broken");
    expect(loadResume("l1", "p1", 1_000_100, st)).toBeNull();
    expect(st.size()).toBe(0);
  });
  it("保存先が使えなくても例外にならない", () => {
    expect(() => saveResume(stash(), null)).not.toThrow();
    expect(loadResume("l1", "p1", 1, null)).toBeNull();
  });
  it("復元は項目ごとの3方向の比較: 他で更新された項目は最新を残し、上書きしない", () => {
    const base = input();
    const edited = input({ memo: "編集中", conditionsText: "条件を追加" });
    // 保存後に別の端末が、応募締切と条件を更新した
    const current = input({ conditionsText: "他で更新された条件", applyDeadline: { precision: "date_only", date: "2026-12-05", time: "" } });
    const m = mergeResume({ base, baseUrls: "", edited, editedUrls: "" }, current, "");
    expect((m.input as unknown as { memo: string }).memo).toBe("編集中"); // 他で変更されていない項目は復元
    expect((m.input as unknown as { conditionsText: string }).conditionsText).toBe("他で更新された条件"); // 競合: 最新を残す
    expect((m.input as unknown as { applyDeadline: { date: string } }).applyDeadline.date).toBe("2026-12-05"); // 編集していない項目は最新
    expect(m.conflicts).toEqual(["conditionsText"]);
    expect(m.restored).toEqual(["memo"]);
  });
  it("競合が無ければ、編集内容がそのまま戻る（URL欄を含む）", () => {
    const m = mergeResume({ base: input(), baseUrls: "", edited: input({ memo: "x" }), editedUrls: "https://example.invalid/a" }, input(), "");
    expect(m.conflicts).toEqual([]);
    expect(m.urlsText).toBe("https://example.invalid/a");
    expect((m.input as unknown as { memo: string }).memo).toBe("x");
  });
});

describe("Stage 7L: 不足情報バッジ", () => {
  const draft = (input: Record<string, unknown>, flags: Record<string, string> = {}) => ({ flags, input });
  const base = { chain: { id: "c1", name: "A" }, store: { id: "s1", name: "梅田店" }, items: [{ product: { id: "p1", name: "商品" } }], applyStart: { precision: "date_only", date: "2026-11-01" }, applyDeadline: { precision: "date_only", date: "2026-11-20" }, resultDate: { precision: "date_only", date: "2026-11-25" }, applyMethod: "web", receiveMethod: "store" };
  it("不足が無ければバッジは出ない", () => {
    expect(missingBadges({ reasons: [], draft: draft(base) })).toEqual([]);
  });
  it("重要度の順（商品→応募締切→応募方法→店舗→応募制限→発表日）で、件数を打ち切らずに全て返す", () => {
    const b = missingBadges({
      reasons: ["確認待ち"],
      draft: draft({ ...base, items: [], applyDeadline: { precision: "unknown" }, applyMethod: "unknown", store: { id: null, name: "" }, resultDate: { precision: "unknown" }, limitBasis: "unknown", sourceUrls: [] }),
    });
    expect(b.map((x) => x.label)).toEqual(["商品不明", "応募締切", "応募方法", "店舗不明", "応募制限", "発表日"]);
  });
  it("確認待ちの理由・項目の印・情報充足度の不足とも矛盾しない（同じ項目に寄せ、重複しない）", () => {
    const b = missingBadges({ reasons: ["対象地域外・都道府県が不明です", "応募締切が不明"], draft: draft({ ...base, applyDeadline: { precision: "unknown" } }, { limit: "初期値のまま", conditions: "要確認" }), assess: { missing: "応募締切・受取方法", missingItems: ["応募締切", "受取方法"] } });
    const labels = b.map((x) => x.label);
    expect(labels.filter((l) => l === "応募締切")).toHaveLength(1);
    expect(labels).toEqual(expect.arrayContaining(["応募締切", "地域", "応募制限", "応募条件", "受取方法"]));
    expect(labels.indexOf("応募締切")).toBeLessThan(labels.indexOf("地域"));
    expect(labels.indexOf("地域")).toBeLessThan(labels.indexOf("応募制限"));
  });
  it("仮登録されるだけの案内は不足に数えない。情報が補われればバッジは消える", () => {
    expect(missingBadges({ reasons: [], draft: draft(base, { store: "保存すると仮登録されます" }) })).toEqual([]);
    const before = missingBadges({ reasons: [], draft: draft({ ...base, resultDate: { precision: "unknown" } }) });
    expect(before.map((x) => x.label)).toEqual(["発表日"]);
    expect(missingBadges({ reasons: [], draft: draft(base) })).toEqual([]);
  });
  it("分類できない不足項目だけを「その他」にする（理由の文章があるだけでは不足としない）", () => {
    expect(missingBadges({ reasons: ["原因不明の保留"], draft: draft(base) })).toEqual([]);
    expect(missingBadges({ reasons: [], draft: draft(base), assess: { missingItems: ["謎の項目"] } }).map((x) => x.label)).toEqual(["その他"]);
  });
});

describe("Stage 7L: 重複の検出と手動検索", () => {
  const me = { chainId: null, chainName: "ドラスタ", storeId: null, storeName: "神戸三宮店", productIds: ["p1"], productNames: ["テスト弾 BOX"], deadline: "2026-11-20T23:59:00+09:00", urls: ["https://example.invalid/post/1?s=20"] };
  const lot = (over: Partial<DupTarget>): DupTarget => ({ kind: "lottery", id: "l1", label: "ドラゴンスター 神戸三宮店 テスト弾 BOX", chainId: "c1", chainName: "ドラゴンスター", chainAliases: [], storeId: "s1", storeName: "神戸三宮店", productIds: ["p1"], productNames: ["テスト弾 BOX"], deadline: "2026-11-20T23:59:00+09:00", urls: [], ...over });

  it("系列の別名が登録済みなら、別名でも同じ系列として候補になる", () => {
    const out = suggestDuplicates(me, [lot({ chainAliases: ["ドラスタ"] })]);
    expect(out).toHaveLength(1);
    expect(out[0].sameChain).toBe(true);
    expect(out[0].reason).toContain("同じ系列");
  });
  it("別名が未登録でも、同じ商品・近い締切なら『系列名が一致しません（表記揺れの可能性）』として候補にする", () => {
    const out = suggestDuplicates(me, [lot({})]);
    expect(out).toHaveLength(1);
    expect(out[0].sameChain).toBe(false);
    expect(out[0].reason).toContain("系列名が一致しません");
  });
  it("同じ情報源URLは、系列名・商品が違っても候補（クエリ・末尾スラッシュの差は無視）", () => {
    const out = suggestDuplicates({ ...me, productIds: [], productNames: [], deadline: null }, [lot({ urls: ["https://example.invalid/post/1/"], productIds: ["p9"], productNames: ["別商品"], deadline: null })]);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toContain("同じ情報源URL");
  });
  it("似ているだけの別系列（商品・締切・URLが違う）は候補にしない", () => {
    expect(suggestDuplicates(me, [lot({ productIds: ["p9"], productNames: ["別商品"], deadline: "2027-02-01T00:00:00+09:00" })])).toEqual([]);
  });
  it("店舗が異なる抽選は別の抽選として候補にしない（同じ系列・商品・締切でも）", () => {
    expect(suggestDuplicates({ ...me, chainId: "c1", chainName: "ドラゴンスター" }, [lot({ storeId: "s2", storeName: "日本橋店" })])).toEqual([]);
    // 同じ店舗なら候補（店舗IDが一致）
    expect(suggestDuplicates({ ...me, chainId: "c1", chainName: "ドラゴンスター", storeId: "s1" }, [lot({})])).toHaveLength(1);
  });
  it("店舗の比較: ID優先。IDが無ければ名称。片方が不明なら違うと断定しない", () => {
    expect(storeDiffers({ storeId: "a" }, { storeId: "b" })).toBe(true);
    expect(storeDiffers({ storeId: "a" }, { storeId: "a" })).toBe(false);
    expect(storeDiffers({ storeName: "梅田店" }, { storeName: "なんば店" })).toBe(true);
    expect(storeDiffers({ storeName: "梅田店" }, { storeName: "ＯＯ梅田店" })).toBe(false);
    expect(storeDiffers({ storeName: "" }, { storeName: "なんば店" })).toBe(false);
  });
  it("手動検索: 系列名・別名・店舗名・商品名・URLのすべての語に一致するものを探せる。店舗が異なるものは識別できる", () => {
    const targets: DupTarget[] = [lot({ chainAliases: ["ドラスタ"], urls: ["https://example.invalid/lot/9"] }), lot({ id: "l2", storeId: "s2", storeName: "日本橋店", label: "ドラゴンスター 日本橋店 テスト弾 BOX" }), lot({ id: "l3", chainId: "c9", chainName: "竜のしっぽ", chainAliases: [], label: "竜のしっぽ 京都店" })];
    expect(searchDupTargets("ドラスタ 神戸", targets, me).map((x) => x.id)).toEqual(["l1"]); // 別名で見つかる
    expect(searchDupTargets("lot/9", targets, me).map((x) => x.id)).toEqual(["l1"]); // URL
    expect(searchDupTargets("日本橋", targets, me).map((x) => [x.id, x.storeDiffers])).toEqual([["l2", true]]); // 店舗が異なる
    expect(searchDupTargets("   ", targets, me)).toEqual([]);
    expect(searchDupTargets("存在しない", targets, me)).toEqual([]);
  });
});
