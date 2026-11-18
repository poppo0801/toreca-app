import { describe, expect, it } from "vitest";
import { judgeRegion, regionExclusionOf } from "./region";
import { DEFAULT_CONDITIONS, evaluateCandidate } from "./conditions";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";

const emptyInput = (): LotteryInput => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
  ...({} as Record<string, never>),
  multiMode: "single",
  applyStart: EMPTY_FLEX,
  applyDeadline: EMPTY_FLEX,
  applyMethod: "web",
  requirementTags: [],
  sourceUrls: [],
  conditionsText: "",
  memo: "",
  chain: { id: null, name: "" },
  store: { id: null, name: "", prefecture: "" },
  items: [{ product: { id: "p1", name: "ハドウシーカー" }, quantity: 1, unit: "box" }],
  receiveMethod: "store",
}) as unknown as LotteryInput;

// 9H-3M の未知案件検証で見つかった誤除外: 「キデイランド各店」の告知に「吉祥寺店（東京都）」があり、抽選対象の三宮店（兵庫県）が東京都と判定されて除外された
describe("地域判定: 告知に登場する地名と、抽選対象店舗の所在地を区別する（9H-3N）", () => {
  it("告知の都道府県（東京都）と店舗名の地名（三宮＝兵庫県）が食い違うときは、どちらも採用せず不明（追跡できる根拠つき）", () => {
    const j = judgeRegion({ storeName: "三宮店", statedPrefecture: "東京都" });
    expect(j.basis).toBe("conflict");
    expect(j.prefecture).toBe("");
    expect(j.conflict?.map((c) => c.prefecture).sort()).toEqual(["兵庫県", "東京都"].sort());
    expect(j.note).toContain("食い違う");
  });
  it("一致するとき・片方だけのときは従来どおり（告知の都道府県を使う）", () => {
    expect(judgeRegion({ storeName: "吉祥寺店", statedPrefecture: "東京都" })).toMatchObject({ prefecture: "東京都", basis: "stated_prefecture" });
    expect(judgeRegion({ storeName: "", statedPrefecture: "東京都" })).toMatchObject({ prefecture: "東京都" });
    expect(judgeRegion({ storeName: "店", statedPrefecture: "東京都" }).prefecture).toBe("東京都");
  });
  // 9H-3O: 本番の候補プールの再判定で、店舗名の一部が別の県名・地名に一致する誤った食い違い（18件中14件）が見つかった
  it("店舗名の途中に別の地名の一部として含まれる語では、食い違いにしない（勝田東石川店の「石川」・所沢山口店の「山口」・新守山店の「守山」）", () => {
    expect(judgeRegion({ storeName: "勝田東石川店", statedPrefecture: "茨城県" })).toMatchObject({ prefecture: "茨城県", basis: "stated_prefecture" });
    expect(judgeRegion({ storeName: "所沢山口店", statedPrefecture: "埼玉県" })).toMatchObject({ prefecture: "埼玉県", basis: "stated_prefecture" });
    expect(judgeRegion({ storeName: "新守山店", statedPrefecture: "愛知県" })).toMatchObject({ prefecture: "愛知県", basis: "stated_prefecture" });
  });
  it("店舗名の先頭・カタカナの直後にある地名の食い違いは、従来どおり検出する（三宮・戸田）", () => {
    expect(judgeRegion({ storeName: "ルビットタウン戸田店", statedPrefecture: "愛知県" }).basis).toBe("conflict");
    expect(judgeRegion({ storeName: "兵庫県の店", statedPrefecture: "東京都" }).basis).toBe("conflict");
  });
  it("店舗マスター・住所があれば最優先（食い違いの判定の対象にしない）", () => {
    expect(judgeRegion({ masterPrefecture: "兵庫県", storeName: "三宮店", statedPrefecture: "東京都" })).toMatchObject({ prefecture: "兵庫県", basis: "master" });
    expect(judgeRegion({ address: "東京都千代田区1-1", storeName: "三宮店", statedPrefecture: "東京都" })).toMatchObject({ prefecture: "東京都", basis: "address" });
  });
  it("複数店舗の名称は、店舗名から地域を決めない（従来どおり）", () => {
    expect(judgeRegion({ storeName: "三宮店・吉祥寺店", statedPrefecture: "東京都" }).prefecture).toBe("");
  });
  it("評価: 食い違いは地域外として除外せず、要確認にする（既存の地域除外は維持）", () => {
    const base = { ...emptyInput(), chain: { id: null, name: "キデイランド" }, store: { id: null, name: "三宮店", prefecture: "東京都" }, receiveMethod: "store" as const };
    const input = { ...base, applyDeadline: { date: "2099-01-01", time: "23:59", precision: "date_time" as const } };
    const ctx = { prefecture: "", storeKind: "physical" as const, distanceKm: null, now: new Date("2026-11-17T00:00:00+09:00"), texts: ["ポケモンカード"] };
    const cond = { ...DEFAULT_CONDITIONS, prefectures: ["兵庫県", "大阪府", "京都府"] };
    const conflict = evaluateCandidate(input as never, cond, { ...ctx, regionConflict: "食い違い" });
    expect(conflict.verdict).not.toBe("exclude");
    expect(conflict.reasons.join()).not.toMatch(/対象外の地域/);
    // 食い違いが無く、東京都と確定している店舗は従来どおり除外される
    const tokyo = evaluateCandidate({ ...input, store: { id: null, name: "吉祥寺店", prefecture: "東京都" } } as never, cond, { ...ctx, prefecture: "東京都" });
    expect(tokyo.verdict).toBe("exclude");
    expect(tokyo.reasons.join()).toMatch(/対象外の地域/);
  });
  it("除外の記録に、食い違った根拠を残す（追跡可能）", () => {
    const j = judgeRegion({ storeName: "三宮店", statedPrefecture: "東京都" });
    const ex = regionExclusionOf(j, { at: "2026-11-17T00:00:00Z", source: "https://x.com/a/status/1", reason: "x" });
    expect(ex.conflict).toHaveLength(2);
  });
});
