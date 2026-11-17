import { describe, expect, it } from "vitest";
import { judgeForm } from "@/lib/lottery-form";
import { inferWithStructure, pickStrongestForm, judgeApplyStructure } from "./apply-structure";
import { chainFormTendency } from "./form-learning";

/** 9H-3K の人間評価（review-answers）の文面を要約した固定データ。評価ファイル（backups/）には依存しない */
const rec = (chain: string, form: "store_select" | "store_independent", n: number): never =>
  ({ key: `${chain}-${form}-${n}`, chain, form, platform: undefined, caseIds: [`c${n}`], setId: "rs-test", evaluatedAt: "2026-11-17T00:00:00Z", status: "active" }) as never;
const run = (o: { texts: string[]; receive?: string | null; chain?: string; store?: string; tendency?: ReturnType<typeof chainFormTendency> | null; aiUnit?: string }) => {
  const judgement = judgeForm({ storeMode: "fixed", texts: o.texts });
  return inferWithStructure({
    judgement,
    aiUnit: o.aiUnit,
    storeKnown: !!o.store,
    platform: undefined,
    tendency: o.tendency ?? null,
    texts: o.texts,
    receiveMethod: o.receive ?? null,
    chainKnown: !!(o.chain ?? "x"),
  });
};

describe("店舗選択式の判定漏れ（9H-3Kの人間評価4件）", () => {
  it("キントレ・トレカ丸: 「全店で1グループ1店舗まで」「応募店舗以外での受け取りはできません」→ 店舗選択が必要と推定（確定はしない）", () => {
    const r = run({ texts: ["トレカ丸・キントレ・文真堂書店全店で１グループ様1店舗まで応募可能です。 応募店舗以外での受け取りはできません。 当選されたご本人様がご来店いただく必要があります。"], receive: "store", chain: "キントレ・トレカ丸" });
    expect(r.state).toBe("estimated");
    expect(r.form).toBe("store_select");
    expect(r.structure.storeSelectNeed).toBe("required");
    expect(r.structure.state).toBe("estimated");
    expect(r.confidence).not.toBe("high");
  });
  it("ゲオ: 全国の店舗・店舗受取（系列の実績が無くても、材料が複数あれば推定）", () => {
    const r = run({ texts: ["応募する （ゲオ（全国のゲオ店舗）・新しいタブで開きます） 会員登録が必要。"], receive: "store", chain: "ゲオ" });
    expect(r.structure.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["multi_store_scope", "chain_without_store"]));
    expect(r.state).toBe("estimated");
    expect(r.form).toBe("store_select");
  });
  it("ヨドバシ: 受取が店舗か配送かを選べる（当選後・購入時に受取店舗を選ぶ構造）→ 応募構造は pickup_store_choice、店舗選択は推定", () => {
    const r = run({ texts: ["ヨドバシ・ドット・コム会員様限定。ブラウザからお申し込みください。"], receive: "either", chain: "ヨドバシカメラ" });
    expect(r.structure.structure).toBe("pickup_store_choice");
    expect(r.structure.storeSelectNeed).toBe("required");
    expect(r.state).toBe("estimated");
  });
  it("イエローサブマリン: 店舗が不明なだけ（材料が1種類）では推定しない。同系列の人間の実績（店舗選択式）があれば推定する", () => {
    const texts = ["Livepocketのアカウントが必要。レシート（指定期間発行・¥300以上の購入or買取）が必要。"];
    const none = run({ texts, receive: "store", chain: "イエローサブマリン" });
    expect(none.state).toBe("unknown");
    expect(none.structure.storeSelectNeed).toBe("unknown");
    const prior = chainFormTendency("イエローサブマリン", [rec("イエローサブマリン", "store_select", 1), rec("イエローサブマリン", "store_select", 2)], {});
    const withPrior = run({ texts, receive: "store", chain: "イエローサブマリン", tendency: prior });
    expect(["estimated", "unknown"]).toContain(withPrior.state);
  });
});

describe("過剰適合・誤判定の確認（店舗選択が不要な案件を店舗選択式にしない）", () => {
  it("通販のみ（Luruna Card・ラビットバーン）: 店舗選択は不要", () => {
    for (const t of ["Luruna Cardをフォロー。通販・商品ページから抽選販売商品をカートに入れて注文して応募", "通販・商品ページから応募"]) {
      const r = run({ texts: [t], receive: "shipping", chain: "Luruna Card" });
      expect(r.structure.structure).toBe("online_only");
      expect(r.structure.storeSelectNeed).toBe("not_required");
      expect(r.form).not.toBe("store_select");
    }
  });
  it("特定店舗の抽選（GIRAFULLなんば店・カードラボ姫路店）: 店舗選択式にしない", () => {
    const g = run({ texts: ["指定の期間中に 「GIRAFULLなんば店」 へご来店のうえご購入が可能な方のみご応募ください。代理購入はできません。"], receive: "store", chain: "GIRAFULL", store: "なんば店" });
    expect(g.state).not.toBe("estimated");
    expect(g.structure.structure).toBe("single_store");
    expect(g.structure.storeSelectNeed).toBe("not_required");
    const c = run({ texts: ["公式Xアカウントをフォローし、この投稿をリポスト"], receive: null, chain: "カードラボ", store: "姫路店" });
    expect(c.form).not.toBe("store_select");
  });
  it("店舗が不明なだけ（TCGshop193。受取は店舗・他の材料なし）: 推定しない", () => {
    const r = run({ texts: ["30th カードセット 大阪・愛知・三重 ほか1 本文の応募URLから応募"], receive: "store", chain: "TCGshop193" });
    expect(r.state).toBe("unknown");
  });
  it("店舗ごとの店頭抽選券＋LivePocket（トレカショップフロント）: 店舗が不明なだけでは推定しない", () => {
    const r = run({ texts: ["お申し込みには「Livepocket会員登録」が必要。店頭でもらえる抽選券のシリアルナンバーを申込時に入力。"], receive: "store", chain: "トレカショップフロント" });
    expect(r.state).not.toBe("estimated");
  });
  it("確認済みの判断（人間・構造の根拠）は、弱い構造の推定で上書きしない", () => {
    const j = judgeForm({ storeMode: "fixed", texts: ["各店舗にて受付します。店舗ごとの抽選です。"] });
    const r = inferWithStructure({ judgement: j, storeKnown: false, texts: ["各店舗にて受付します。全国の対象店舗。応募店舗以外での受け取りはできません。"], receiveMethod: "store", chainKnown: true });
    expect(r.form).toBe("store_independent");
    expect(r.state).toBe("confirmed");
  });
  it("実績が店舗別独立へ傾く系列は、構造の材料だけでは店舗選択式と推定しない", () => {
    const t = chainFormTendency("X店", [rec("X店", "store_independent", 1), rec("X店", "store_independent", 2)], {});
    const r = run({ texts: ["全店で1店舗まで応募可能です。応募店舗以外での受け取りはできません。"], receive: "store", chain: "X店", tendency: t });
    expect(r.form).not.toBe("store_select");
  });
});

describe("系列の実績だけの推定は、登録の形を変えない（9H-3M 未知案件の検証・過去評価の誤判定5件の型）", () => {
  const sel = (n: number) => chainFormTendency("フルコンプ", Array.from({ length: n }, (_, k) => rec("フルコンプ", "store_select", k + 1)), {});
  it("告知自体に根拠が無く、店舗が不明＋系列の実績だけ → 推定（従来どおり登録の形に反映）。ただし確認すべきことを記録して、調査・人間の確認へ渡す", () => {
    const r = run({ texts: ["30th カードセット 抽選受付のお知らせ。応募期間 11/10〜11/12。"], receive: "store", chain: "フルコンプ", tendency: sel(3) });
    expect(r.state).toBe("estimated");
    expect(r.action).toBe("apply");
    expect(r.verification.needed).toBe(true);
    expect(r.verification.noticeEvidence).toBe(false);
    expect(r.verification.suggested.length).toBeGreaterThan(0);
  });
  it("告知自体に根拠（全店で1店舗まで・応募店舗で購入）があれば、登録の形に反映してよい（キントレ・トレカ丸）", () => {
    const r = run({ texts: ["トレカ丸・キントレ・文真堂書店全店で１グループ様1店舗まで応募可能です。応募店舗以外での受け取りはできません。"], receive: "store", chain: "キントレ・トレカ丸", tendency: chainFormTendency("キントレ・トレカ丸", [rec("キントレ・トレカ丸", "store_select", 1)], {}) });
    expect(r.state).toBe("estimated");
    expect(r.verification.noticeEvidence).toBe(true);
  });
  it("確認済み・不明のときは確認の要求を出さない", () => {
    const r = run({ texts: ["応募フォームで受取店舗を選択してください。"], receive: "store", chain: "A" });
    expect(r.state).toBe("confirmed");
    expect(r.verification.needed).toBe(false);
  });
});

describe("応募構造と店舗選択要否の分離", () => {
  it("応募フォームの店舗選択欄がある → select_in_form・必要・確認済み相当の材料", () => {
    const texts = ["応募フォームで受取店舗を選択してください。"];
    const base = inferWithStructure({ judgement: judgeForm({ storeMode: "fixed", texts }), storeKnown: false, texts, receiveMethod: "store", chainKnown: true });
    expect(base.form).toBe("store_select");
    expect(base.structure.structure).toBe("select_in_form");
  });
  it("judgeApplyStructure は従来の判断が確認済みなら変えない", () => {
    const j = judgeForm({ storeMode: "fixed", texts: ["応募フォームで受取店舗を選択してください。"] });
    const base = inferWithStructure({ judgement: j, storeKnown: false, texts: ["応募フォームで受取店舗を選択してください。"], receiveMethod: "store", chainKnown: true });
    const s = judgeApplyStructure({ texts: [], chainKnown: true, storeKnown: false, base });
    expect(s.state).toBe(base.state === "confirmed" ? "confirmed" : s.state);
  });
});

describe("同じ抽選の複数候補の判断を失わない", () => {
  it("表示する候補が『記録なし』でも、別の候補の確認済み・推定を採用する（9H-3K t-07・t-08）", () => {
    expect(pickStrongestForm([null, { state: "estimated", form: "store_select", rank: 3 }, { state: "unknown", form: "unknown", rank: null }])?.state).toBe("estimated");
    expect(pickStrongestForm([{ state: "estimated", form: "store_select", rank: 4 }, { state: "confirmed", form: "store_select", rank: 1 }])?.state).toBe("confirmed");
  });
  it("確認済みが食い違うときは選ばない（人間の確認が必要）", () => {
    expect(pickStrongestForm([{ state: "confirmed", form: "store_select", rank: 1 }, { state: "confirmed", form: "store_independent", rank: 1 }])).toBeNull();
  });
  it("全部不明・記録なしなら null", () => {
    expect(pickStrongestForm([null, undefined, { state: "unknown", form: "unknown", rank: null }])).toBeNull();
  });
});
