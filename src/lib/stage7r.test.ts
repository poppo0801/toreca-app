import { describe, expect, it } from "vitest";
import { chainDisplayName, chainKindTag } from "@/lib/chain-display";
import { findDuplicates, matchChain } from "@/lib/lottery-match";
import { groupStores } from "@/lib/store-master-view";
import { isReady } from "@/lib/collector/ready";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Chain, Lottery, Store } from "@/types/domain";

/** Stage 7R: カードボックスの2系列（直営/その他）の識別と重複判定 */
const NOW = new Date("2026-11-10T03:00:00Z");
const BRAND = "カードボックス";
// 表示名はどちらも「カードボックス」（アプリの読み込みで chainDisplayName が適用される）
const mk = (id: string, name: string, kind: Chain["operationKind"]): Chain => ({ id, name: chainDisplayName({ name, brandGroup: BRAND, operationKind: kind }), brandGroup: BRAND, operationKind: kind, aliases: [] }) as Chain;
const direct = mk("d", "カードボックス（直営）", "direct");
const other = mk("o", "カードボックス（その他）", "other");
const unk = mk("u", "カードボックス", "unconfirmed");
const normal = { id: "n", name: "テスト電機", aliases: [] } as unknown as Chain;
const chains = [direct, other, unk, normal];
const st = (id: string, chainId: string, name: string) => ({ id, chainId, name, prefecture: "大阪府", salesKind: "physical" }) as unknown as Store;
const stores = [st("sd", "d", "日本橋店"), st("so", "o", "江坂店"), st("su", "u", "京都"), st("sn", "n", "梅田店")];
const master = { chains, stores };
const flex = (d: string) => ({ precision: "date_only" as const, date: d, time: "" });
const lot = (id: string, chainId: string, storeId: string | null): Lottery =>
  ({ id, chainId, storeId, storeMode: "fixed", items: [{ productId: "p1", quantity: 1, unit: "box" }], sourceUrls: ["https://x.com/a/status/100000001"], applyStart: { precision: "date_only", date: "2026-11-09" }, applyDeadline: { precision: "date_only", date: "2026-11-12" } }) as unknown as Lottery;
const input = (chainId: string | null, storeId: string | null, storeName = ""): LotteryInput =>
  ({ chain: { id: chainId, name: BRAND }, store: { id: storeId, name: storeName, prefecture: "" }, storeMode: "fixed", items: [{ product: { id: "p1", name: "p1" }, quantity: 1, unit: "box" }], applyStart: flex("2026-11-09"), applyDeadline: flex("2026-11-12"), sourceUrls: ["https://example.com/new"], multiMode: "single" }) as unknown as LotteryInput;

describe("カードボックスの表示名と内部系列", () => {
  it("直営・その他はどちらも「カードボックス」。IDは別。所属未確認は区別して表示する。通常の系列は変わらない", () => {
    expect(direct.name).toBe("カードボックス");
    expect(other.name).toBe("カードボックス");
    expect(direct.id).not.toBe(other.id);
    expect(unk.name).toBe("カードボックス（所属未確認）");
    expect(chainDisplayName({ name: "テスト電機" })).toBe("テスト電機");
    expect(chainDisplayName({ name: "GEO", brandGroup: null, operationKind: null })).toBe("GEO");
    expect(chainKindTag({ name: "x", brandGroup: BRAND, operationKind: "direct" })).toBe("直営");
    expect(chainKindTag({ name: "x", brandGroup: BRAND, operationKind: "other" })).toBe("その他");
    expect(chainKindTag({ name: "x" })).toBeNull();
  });
  it("店舗マスターの並びで、同じ表示名の系列も内部名で安定して並ぶ。他の系列は影響を受けない", () => {
    const rows = [
      { id: "d", name: "カードボックス（直営）", brand_group: BRAND, operation_kind: "direct", archived_at: null },
      { id: "o", name: "カードボックス（その他）", brand_group: BRAND, operation_kind: "other", archived_at: null },
      { id: "n", name: "テスト電機", archived_at: null },
    ];
    const g = groupStores(rows, [], { q: "", showRetired: false, distanceKm: () => null });
    expect(g.map((x) => x.chain.id)).toEqual(["o", "d", "n"]); // 内部名の五十音順（その他 → 直営）。同じ入力なら常に同じ順
  });
});

describe("店舗名からの所属系列の判定（自動収集・手動登録で共通の照合）", () => {
  it("確認済みの店舗は、その店舗の系列（直営/その他）に決まる", () => {
    expect(matchChain(BRAND, chains, { stores, storeName: "日本橋店" }).item?.id).toBe("d");
    expect(matchChain(BRAND, chains, { stores, storeName: "カードボックス江坂店" }).item?.id).toBe("o");
  });
  it("店舗名が不明、または複数系列に同名があるときは、直営/その他を推測せず「部分一致」（確認が必要）にする", () => {
    const none = matchChain(BRAND, chains, { stores, storeName: "" });
    expect(none.kind).toBe("partial");
    expect(none.item?.id).toBe("u");
    expect(none.candidates.map((c) => c.id).sort()).toEqual(["d", "o"]);
    // 直営の一覧に無い店舗は「その他」（確定）
    const ot = matchChain(BRAND, chains, { stores, storeName: "秋葉原店" });
    expect(ot.item?.id).toBe("o");
    expect(ot.kind).toBe("exact");
    const dup = [...stores, st("sd2", "o", "日本橋店")];
    expect(matchChain(BRAND, chains, { stores: dup, storeName: "日本橋店" }).kind).toBe("partial");
  });
  it("系列が確実でない候補は自動登録されない（登録に十分でない）", () => {
    const m = matchChain(BRAND, chains, { stores, storeName: "" });
    const draft = { input: input(m.item!.id, null), summary: { chain: m.kind, store: "none", items: [{ name: "p1", kind: "exact", matchedName: "p1" }] }, candidates: { chain: m.candidates, store: [], items: [[]] }, modePending: false } as never;
    const r = isReady(draft);
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("系列を確実に特定できません");
  });
  it("所属未確認の既存店舗は、その店舗の系列（未確認）に照合される（推測で移さない）", () => {
    expect(matchChain(BRAND, chains, { stores, storeName: "京都" }).item?.id).toBe("u");
  });
  it("カードボックス以外の系列には、同名系列の分離仕様を適用しない", () => {
    expect(matchChain("テスト電機", chains, { stores, storeName: "梅田店" }).item?.id).toBe("n");
  });
});

describe("重複判定は系列IDを区別する", () => {
  it("直営と その他 に、同じ商品・同じ締切・同名の店舗があっても別カード", () => {
    expect(findDuplicates(input("o", null), [lot("L1", "d", null)], undefined, master, { now: NOW })).toEqual([]);
    expect(findDuplicates(input("d", "sd", "日本橋店"), [lot("L2", "o", "so")], undefined, master, { now: NOW })).toEqual([]);
  });
  it("系列未確定の入力（名称だけ）は、直営・その他のどちらの既存抽選とも結び付けない", () => {
    expect(findDuplicates(input(null, null), [lot("L1", "d", null), lot("L2", "o", null)], undefined, master, { now: NOW })).toEqual([]);
  });
  it("同じ系列IDなら従来どおり重複と判定する（同じ系列・同じ商品・店舗未確定どうし）", () => {
    const d = findDuplicates(input("d", null), [lot("L1", "d", null)], undefined, master, { now: NOW });
    expect(d[0]).toMatchObject({ lotteryId: "L1", level: "high" });
  });
  it("ブランドを持たない系列は従来どおり（名称が同じなら同じ系列）", () => {
    const twin = { id: "n2", name: "テスト電機", aliases: [] } as unknown as Chain;
    const m = { chains: [...chains, twin], stores };
    const i = { ...input("n", null), chain: { id: "n", name: "テスト電機" } } as LotteryInput;
    expect(findDuplicates(i, [lot("L1", "n2", null)], undefined, m, { now: NOW })[0]?.lotteryId).toBe("L1");
  });
});

describe("自動収集画面へ渡す草稿の絞り込み", () => {
  it("画面・編集フォームで使う項目だけを残し、使わない大きな項目を除く（元の草稿は変更しない）", async () => {
    const { slimDraft } = await import("@/lib/collector/slim-draft");
    const draft = { input: { chain: { name: "A" } }, flags: { chain: "x" }, evidence: { e: 1 }, summary: {}, warnings: [], fields: { big: "x".repeat(5000) }, xpost: { t: "y" }, reeval: [1], listInfo: {}, queued: true };
    const s = slimDraft(draft) as Record<string, unknown>;
    expect(Object.keys(s).sort()).toEqual(["evidence", "flags", "input", "queued", "summary", "warnings"]);
    expect(draft.fields.big).toHaveLength(5000);
    expect(slimDraft(null)).toBeNull();
    expect(JSON.stringify(s).length).toBeLessThan(JSON.stringify(draft).length / 10);
  });
});
