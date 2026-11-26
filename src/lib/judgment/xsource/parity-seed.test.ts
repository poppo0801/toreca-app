/** PRODUCTION_PARITY §3: 判断AIへ渡す種（seed）の欠落。まとめ投稿の見出し（店舗名）・告知ページそのものの取得元 */
import { describe, expect, it } from "vitest";
import { planXPost } from "./x-origin";

const roundup = "【ポケカ抽選情報】 週末のポケモンカード抽選まとめです ━━ 11/22(日) 〆切 ━━ 🏬ホビーオフ一部店舗 ✅ハドウシーカー ⏰11/22(日) 19:30まで 🏬HMVトレカショップ ✅ハドウシーカー ⏰11/22(日) 20:59まで 🏬しまむらパーク ✅ハドウシーカー ✅スターターセットex ⏰11/22(日) 23:00まで";

describe("まとめ投稿の項目の見出し", () => {
  it("一覧の項目の種に、本文の外にある見出し（店舗名）を含める", () => {
    const p = planXPost({ postId: "1", text: roundup, links: [], recordedAt: "2026-11-20T00:00:00Z" });
    expect(p.isList).toBe(true);
    const withLabel = p.items.filter((i) => i.groupLabel.trim());
    expect(withLabel.length).toBeGreaterThan(0);
    for (const i of withLabel) expect(i.seedText).toContain(`【この項目の見出し（項目が属する店舗・区分。本文の外にある一覧の見出し）】${i.groupLabel.trim()}`);
    expect(p.items.map((i) => i.groupLabel).join("|")).toContain("HMVトレカショップ");
  });
});

describe("告知ページそのものが原文の候補", () => {
  const page = { postId: "h", text: "ポケモンカード ハドウシーカー 抽選販売のお知らせ 受付 11/20〜11/23 当店アプリより応募", links: [], recordedAt: "2026-11-20T00:00:00Z", sourcePage: { url: "https://shop.example.jp/news/1", via: "web_fetch" } };
  it("取得元ページを項目自身のリンクとし、『URLなし（応募先は不明）』にしない", () => {
    const p = planXPost({ ...page, sourceIsAnnouncement: true });
    expect(p.items[0].status).toBe("url_from_item");
    expect(p.items[0].scopedUrls).toEqual(["https://shop.example.jp/news/1"]);
    expect(p.items[0].seedText).toContain("この告知の取得元ページ");
    expect(p.items[0].seedText).not.toContain("URLなし");
  });
  it("X投稿など、告知ページそのものでない取得元は従来どおり（応募先とは限らない）", () => {
    const p = planXPost(page);
    expect(p.items[0].status).toBe("url_missing");
    expect(p.items[0].seedText).toContain("応募先とは限らない");
  });
});

import { checkExcludeSemantics } from "./claim-semantics";
describe("基準時刻より前に終わった抽選の除外（検証の過剰な制約）", () => {
  const now = new Date("2026-11-22T15:15:00Z");
  it("理由の引用が受付期間の見出しだけで、日付が締切の項目の引用（範囲・役割の語なし）にある除外を支持する", () => {
    expect(checkExcludeSemantics({ claim: "抽選応募受付期間が終了している（締切済み）", quote: "抽選応募受け付け期間", now, deadlineQuote: "11月6日(金)16時00分~11月10日(火)16時59分" }).ok).toBe(true);
  });
  it("締切が基準時刻より後なら、同じ形でも除外を支持しない（応募の機会を消さない）", () => {
    expect(checkExcludeSemantics({ claim: "受付終了", quote: "抽選応募受け付け期間", now, deadlineQuote: "11月20日(金)16時00分~11月30日(月)16時59分" }).ok).toBe(false);
  });
});

import { seedEvidence, verifyRegistration } from "./research-loop";
describe("締切以外の日付の用途の確認（§5）", () => {
  const seed = seedEvidence("s1", "抽選受付 11月20日〜11月22日。当選発表 11月23日。購入期間 11月27日〜11月29日", new Date("2026-11-21T00:00:00Z"));
  const out = (f: Record<string, unknown>) => ({ decision: "tentative" as const, fields: f, rationale: "", unresolvedImpact: "none" as const, monitor: { continue: false, why: "" }, costJpy: 0 });
  it("当選発表の日付の引用を購入開始に使ったら、用途が未確認として残る（不採用にはしない）", () => {
    const v = verifyRegistration({ output: out({ purchase_start: { value: "11/23", basis: "observed", evidenceId: "s1", quote: "当選発表 11月23日" } }) as never, evidence: [seed], protectedFields: {} });
    expect(JSON.stringify(v)).toContain("purchase_start: 日付の用途（購入）");
  });
  it("用途の語がある引用は未確認にならない", () => {
    const v = verifyRegistration({ output: out({ result_at: { value: "11/23", basis: "observed", evidenceId: "s1", quote: "当選発表 11月23日" } }) as never, evidence: [seed], protectedFields: {} });
    expect(JSON.stringify(v)).not.toContain("日付の用途");
  });
});
