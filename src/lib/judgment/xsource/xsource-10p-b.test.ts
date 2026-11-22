// @vitest-environment node
/** Stage 10P: ページ抽出の日時の意味の検証・商品マスターの対応づけ・条件解決への組み込み。架空データのみ。 */
import { describe, expect, it } from "vitest";
import { verifyPageFacts, type PageFacts } from "./ai-10o";
import { resolveConditions } from "./conditions";
import { buildProductMatcher, productCoreKey } from "./product-master";

const REF = new Date("2026-11-10T00:00:00Z");
const base = (dates: PageFacts["dates"]): PageFacts => ({ pageKind: "lottery_notice", chain: null, store: null, products: [], dates, method: null, applyUnit: "unknown", unitQuote: "" });

describe("ページ抽出の日時: 注文対象期間・販売期間・受取期間を応募の日付にしない。確認済みの値は登録形式へ正規化", () => {
  const page = "抽選応募のご案内 応募受付期間 2026年11月20日(金)10:00〜2026年11月22日(日)23:59 当選発表 11月25日(水) 11月1日（日）～11月10日（火）のご注文分 店頭お受け取り期間 11月26日(木)";
  it("応募期間は確認済み・正規化。ご注文分の日付を応募開始にしようとしたものは role_mismatch で却下", () => {
    const f = base({
      applyStart: { value: "2026年11月20日(金)10:00", quote: "応募受付期間 2026年11月20日(金)10:00〜2026年11月22日(日)23:59" },
      applyDeadline: { value: "11月10日（火）", quote: "11月1日（日）～11月10日（火）のご注文分" },
      resultDate: { value: "11月25日(水)", quote: "当選発表 11月25日(水)" },
    });
    const v = verifyPageFacts(f, page, REF);
    expect(v.verified.applyStart).toBe("2026年11月20日(金)10:00");
    expect(v.preview.applyStart).toBe("2026-11-20 10:00");
    expect(v.rejected).toEqual(["applyDeadline:role_mismatch:order_period"]);
    expect(v.preview.resultDate).toBe("2026-11-25"); // 曜日(水)で年を確認
    expect(v.normalized.resultDate).toMatchObject({ yearBasis: "inferred_weekday_confirmed", precision: "date" });
  });
  it("受取期間を結果発表にしない。曜日が合わない日付は年を決めず preview=null（根拠のない補完をしない）", () => {
    const v = verifyPageFacts(base({ resultDate: { value: "11月26日(木)", quote: "店頭お受け取り期間 11月26日(木)" } }), page, REF);
    expect(v.rejected).toEqual(["resultDate:role_mismatch:pickup_window"]);
    const w = verifyPageFacts(base({ resultDate: { value: "11月25日(月)", quote: "当選発表 11月25日(月)" } }), page.replace("(水)", "(月)"), REF);
    expect(w.preview.resultDate).toBeNull();
  });
});

describe("商品マスター: 名称揺れ・別名・セット名・接頭辞を吸収し、汎用語だけでは対応づけない（未知は未知）", () => {
  const m = buildProductMatcher([
    { id: "1", officialName: "拡張パック「テストの弾」", aliases: ["テスト弾"] },
    { id: "2", officialName: "ハイクラスパック「架空の輝き」" },
  ]);
  it("セット名（「」内）・接頭辞・別名で対応づける", () => {
    expect(productCoreKey("【再入荷】拡張パック「テストの弾」 BOX")).toBe(productCoreKey("拡張パック「テストの弾」"));
    expect(m.match("【再入荷】拡張パック「テストの弾」")?.id).toBe("1");
    expect(m.match("テスト弾")?.id).toBe("1");
    expect(m.match("ハイクラスパック 架空の輝き")?.id).toBe("2");
  });
  it("汎用語だけ・マスターに無い名前は対応づけない。複数商品は all／partial／none", () => {
    expect(m.match("拡張パック")).toBeNull();
    expect(m.match("BOX")).toBeNull();
    expect(m.match("まったく知らない商品")).toBeNull();
    expect(m.matchAll(["テスト弾", "架空の輝き"]).status).toBe("all");
    expect(m.matchAll(["テスト弾", "知らない商品"])).toMatchObject({ status: "partial", unknown: ["知らない商品"] });
    expect(m.matchAll(["知らない商品"]).status).toBe("none");
  });
  it("条件解決: 本文にTCG名が無くてもマスターに対応する商品ならポケモン（段階を記録）。マスターに無ければ不明のまま", () => {
    const cond = { prefectures: ["大阪府"], includeOnline: true, productMode: "all" as const };
    const o = { chain: "サンプル書店", store: "大阪梅田店", prefecture: null, products: ["【再入荷】テスト弾"], texts: [] };
    expect(resolveConditions(o, cond, [], { productMaster: (n) => !!m.match(n) })).toMatchObject({ verdict: "eligible", stages: { tcg: "product_master" } });
    expect(resolveConditions({ ...o, products: ["知らない商品"] }, cond, [], { productMaster: (n) => !!m.match(n) })).toMatchObject({ verdict: "unknown", primaryUnknown: "tcg_unknown" });
  });
});

import { factFromListItem } from "./facts";
import type { ListItemResult } from "../list-discovery";

describe("応募単位の構造からの推定: 原文に書かれていない場合、応募先が別と確認できたときだけ（それ以外は不明のまま）", () => {
  const item: ListItemResult = { no: 1, groupNo: 1, status: "done", verdict: "independent_lottery", mergedInto: null, unit: "unknown", chain: "サンプル書店", store: "梅田店", products: ["架空の商品"], applyDeadline: "2026-11-22 23:59", applyStart: null, method: null, rationale: "", quote: "", quoteVerified: true, unresolved: [], issues: [] };
  it("応募先が別・店舗あり → per_store（推定）。応募先が不明・店舗なしなら unknown。原文の応募単位は上書きしない", () => {
    expect(factFromListItem({ candidateId: "c", parentKey: "p", item, fetchedAt: null, destinationDistinct: true })?.fields.applyUnit).toBe("per_store");
    expect(factFromListItem({ candidateId: "c", parentKey: "p", item, fetchedAt: null })?.fields.applyUnit).toBe("unknown");
    expect(factFromListItem({ candidateId: "c", parentKey: "p", item: { ...item, store: null }, fetchedAt: null, destinationDistinct: true })?.fields.applyUnit).toBe("unknown");
    expect(factFromListItem({ candidateId: "c", parentKey: "p", item: { ...item, unit: "store_select" }, fetchedAt: null, destinationDistinct: true })?.fields.applyUnit).toBe("store_select");
  });
});
