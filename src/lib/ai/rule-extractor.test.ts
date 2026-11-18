import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { RuleExtractor } from "@/lib/ai/rule-extractor";

/** Stage 9D: 無料のルール抽出（本文に書かれたことだけを読む。書かれていない項目は推測しない） */
const master = {
  chains: [{ name: "BOOKOFF", aliases: ["ブックオフ"] }, { name: "キデイランド" }, { name: "テスト玩具" }],
  stores: [{ chainName: "BOOKOFF", name: "渋谷店" }, { chainName: "テスト玩具", name: "本店" }],
  products: ["ハドウシーカー", "ニンジャスピナー"],
};
const NOW = new Date("2026-11-14T03:00:00Z");
const read = async (text: string) => {
  const o = await new RuleExtractor(master).extract({ kind: "url", text, now: NOW });
  return { raw: o.raw as Record<string, unknown>, ex: normalizeExtraction(o.raw, NOW) };
};

describe("RuleExtractor", () => {
  it("系列・店舗・商品・応募期間・当選発表を、本文の記載とマスターの照合で読み取る", async () => {
    const { ex } = await read("テスト玩具 本店 ハドウシーカー 抽選販売のお知らせ 応募期間 11/16(日)〜11/20(木) 当選発表 11/22");
    expect(ex.isLotteryAnnouncement).toBe(true);
    expect(ex.chainName).toBe("テスト玩具");
    expect(ex.storeName).toBe("本店");
    expect(ex.items.map((i) => i.name)).toEqual(["ハドウシーカー"]);
    expect(ex.applyStart.date?.slice(5)).toBe("11-16");
    expect(ex.applyDeadline.date?.slice(5)).toBe("11-20");
    expect(ex.resultDate.date?.slice(5)).toBe("11-22");
  });
  it("書かれていない項目は推測しない（日時なし・店舗なし・商品なし）", async () => {
    const { ex } = await read("テスト玩具 抽選販売を予定しています。詳細は後日発表します");
    expect(ex.storeName).toBe("");
    expect(ex.items).toEqual([]);
    expect(ex.applyDeadline.precision).toBe("unknown");
    expect(ex.resultDate.precision).toBe("unknown");
  });
  it("系列の別表記（ブックオフ）はマスターの系列名に寄せる。マスターにない系列は空のまま", async () => {
    expect((await read("ブックオフ 渋谷店 ニンジャスピナー 抽選販売")).ex.chainName).toBe("BOOKOFF");
    expect((await read("知らない系列 抽選販売 ハドウシーカー")).ex.chainName).toBe("");
  });
  it("終了日の月の省略（11/16〜20）と、締切だけの記載を読める", async () => {
    expect((await read("テスト玩具 抽選 応募期間 11/16〜20")).ex.applyDeadline.date?.slice(5)).toBe("11-20");
    expect((await read("テスト玩具 抽選 応募締切 11/25")).ex.applyDeadline.date?.slice(5)).toBe("11-25");
  });
  it("抽選の語が無いページは抽選の告知と認識しない", async () => {
    expect((await read("テスト玩具 本店 新商品のご案内 ハドウシーカー 好評発売中")).ex.isLotteryAnnouncement).toBe(false);
  });
  it("「応募時に店舗を選択」の記載は店舗選択式として読み取る（AIの読み取りと同じ項目）", async () => {
    expect((await read("キデイランド 抽選販売 応募時に店舗を選択してください")).raw.apply_unit).toBe("store_select");
  });
  it("ナビゲーション・サイドバーに他の店舗名・商品名が並んでいても、ページの題に出てくる店舗・商品を読み取る", async () => {
    const { raw } = await read("テスト玩具 ハドウシーカー 抽選販売のお知らせ 本店\n店舗一覧 本店 ニンジャスピナー 新着 ハドウシーカー\n応募期間 11/16〜11/20");
    expect(raw.store_name).toBe("本店");
    expect((raw.products as { name: string }[]).map((p) => p.name)).toEqual(["ハドウシーカー"]);
  });
});
