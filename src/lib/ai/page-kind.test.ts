import { describe, expect, it } from "vitest";
import { classifyPage } from "@/lib/ai/page-kind";
import { RuleExtractor } from "@/lib/ai/rule-extractor";

/** Stage 9E: ページの主題の判定。「抽選」の語があるだけのページを、実際の抽選の告知と区別する */
describe("classifyPage", () => {
  it("応募期間・当選発表のある告知は、抽選の告知", () => {
    const r = classifyPage({ title: "ハドウシーカー 抽選販売のお知らせ", text: "ハドウシーカー 抽選販売のお知らせ\n応募期間 11/16(日)〜11/20(木) 当選発表 11/22 店頭でお渡し" });
    expect(r).toMatchObject({ kind: "lottery_announcement", actionable: true });
  });
  it("日時が未記載でも、抽選を予定している告知は登録の対象（情報不足を理由に外さない）", () => {
    expect(classifyPage({ text: "テスト玩具 抽選販売を予定しています。詳細は後日発表します" })).toMatchObject({ kind: "lottery_announcement", actionable: true });
  });
  it("タイトルが店名だけでも、本文に抽選の見出しと応募の記載が複数あれば告知（ネット通販の応募ページ）", () => {
    const text = "｜イトーヨーカドーネット通販\nご利用ガイド よくある質問 利用規約\n抽選販売のご案内 抽選対象商品 ハドウシーカー 抽選申し込み期間 2026年11月12日(木) 12:00 ～ 11月13日(金) 11:59まで 抽選のお申し込みはお一人様1点限り 当選発表 11月27日";
    expect(classifyPage({ text }).kind).toBe("lottery_announcement");
  });
  it("ナビゲーションや新着一覧に「抽選」が1回あるだけのトップページは、抽選の告知ではない", () => {
    const text = "ポケモンカードゲーム公式ホームページ\nニュース\n「Pokémon Team Masters」の抽選結果発表の延期について イベント 2026.11.13\n商品情報 ルール カード検索 イベント";
    const r = classifyPage({ text });
    expect(r.actionable).toBe(false);
    expect(r.kind).toBe("general");
  });
  it("日付つきの告知の見出しが並ぶ一覧（店舗ブログ・お知らせ）は一覧。1件の抽選として登録しない", () => {
    const rows = Array.from({ length: 6 }, (_, i) => `『ONE PIECEカードゲーム』抽選販売のお知らせ\n店${i}\n2026.11.${10 + i}`).join("\n");
    const r = classifyPage({ text: `カードラボ - トレーディングカード\n${rows}` });
    expect(r).toMatchObject({ kind: "announcement_index", actionable: false });
  });
  it("抽選の仕組み・注意事項の説明で応募期間がないページは説明", () => {
    expect(classifyPage({ title: "抽選販売の仕組みとよくある質問", text: "抽選販売の仕組みとよくある質問\n抽選とは、応募者の中から当選者を選ぶ方法です。" })).toMatchObject({ kind: "lottery_explainer", actionable: false });
  });
  it("受付が終了した告知は、新規登録の対象にしない", () => {
    expect(classifyPage({ title: "ハドウシーカー 抽選販売のお知らせ", text: "ハドウシーカー 抽選販売のお知らせ\nこちらの抽選受付は終了いたしました。ご応募ありがとうございました。" })).toMatchObject({ kind: "past_lottery", actionable: false });
  });
  it("抽選が完了済みで、当選者への手続きを案内するお知らせは、新たに応募できる抽選ではない", () => {
    const text = "「30th CELEBRATION」関連商品 抽選への今後の手続き・お問い合わせについて\n抽選作業が完了し、順次当選者様へ当選メールをお送りしております。\n当選者様 店頭予約期間： 8月24日 ～ 9月6日 お一人様 1BOX";
    expect(classifyPage({ text })).toMatchObject({ kind: "past_lottery", actionable: false });
  });
  it("「抽選販売」よくあるお問い合わせ（応募期間なし）は、タイトルに抽選販売の語があっても説明", () => {
    expect(classifyPage({ text: "お知らせ：「抽選販売」よくあるお問い合わせについて\n抽選販売の期間中は多くのお問い合わせをいただきます。Pontaカードの登録氏名の変更について…" })).toMatchObject({ kind: "lottery_explainer", actionable: false });
  });
  it("商品紹介・店舗案内など抽選に触れないページは対象外", () => {
    expect(classifyPage({ text: "ハドウシーカー 商品情報\n発売日 11月27日 価格 6,000円 収録 30パック入り" })).toMatchObject({ kind: "general", actionable: false });
    expect(classifyPage({ text: "津田沼店 店舗情報 営業時間 11:00〜20:00 アクセス JR津田沼駅" })).toMatchObject({ kind: "general", actionable: false });
  });
  it("応募期間つきの告知は、本文に「新着一覧」の語があっても告知（一覧と取り違えない）", () => {
    const text = "再抽選販売のお知らせ\n応募期間 11/13~11/15 当選発表 11/16 お一人様1点限り\n新着情報 2026.11.01 2026.11.02 2026.11.03 2026.11.04";
    expect(classifyPage({ text }).kind).toBe("lottery_announcement");
  });
});

describe("RuleExtractor とページの主題", () => {
  const master = { chains: [{ name: "テスト玩具" }], stores: [{ chainName: "テスト玩具", name: "本店" }], products: ["ハドウシーカー"] };
  const read = async (text: string) => ((await new RuleExtractor(master).extract({ kind: "url", text, now: new Date("2026-11-14T03:00:00Z") })).raw as { is_lottery_announcement: boolean; notes: string });
  it("トップページ（ナビに「抽選」の語だけ）を抽選の告知と認識しない。実際の告知は認識する", async () => {
    expect((await read("テスト玩具 公式\nお知らせ 抽選結果発表の延期について 2026.11.13\n商品情報 店舗情報")).is_lottery_announcement).toBe(false);
    const ok = await read("テスト玩具 本店 ハドウシーカー 抽選販売のお知らせ\n応募期間 11/16〜11/20 当選発表 11/22");
    expect(ok.is_lottery_announcement).toBe(true);
    expect(ok.notes).toContain("lottery_announcement");
  });
});
