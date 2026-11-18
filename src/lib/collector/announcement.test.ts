import { describe, expect, it } from "vitest";
import { carryOver, isInternalTeaser, judgeAnnouncement, nextOutcome, type AnnouncementFacts, type TeaserState } from "./announcement";

const F = (o: Partial<AnnouncementFacts> = {}): AnnouncementFacts => ({ texts: [], hasProduct: true, applyStartKnown: false, applyDeadlineKnown: false, resultDateKnown: false, hasApplyUrl: false, hasConditions: false, chainKnown: true, ...o });

describe("予告と正式発表の総合判断（9H-3N）", () => {
  it("「抽選予定」だけで日程・応募先・条件が未発表 → 予告（内部管理）", () => {
    const j = judgeAnnouncement(F({ texts: ["ハドウシーカーの抽選販売を予定しています。詳細は後日お知らせします。"] }));
    expect(j.state).toBe("teaser");
    expect(j.toVerify).toEqual(expect.arrayContaining(["応募先（応募URL・フォーム）", "受付期間（開始日・締切）"]));
  });
  it("応募開始前でも、公式が具体的な日程・応募先・条件を発表していれば正式発表", () => {
    const j = judgeAnnouncement(F({ texts: ["11/20 10:00から抽選受付を開始します。応募はこちらのURLから。"], applyStartKnown: true, applyDeadlineKnown: true, hasApplyUrl: true, hasConditions: true, officialSource: true }));
    expect(j.state).toBe("formal");
    expect(j.confidence).toBe("high");
  });
  it("締切が欠けているだけでは予告にしない（受付開始日と応募先・条件が公表されている）", () => {
    const j = judgeAnnouncement(F({ texts: ["抽選受付を開始しました"], applyStartKnown: true, hasApplyUrl: true, hasConditions: true }));
    expect(j.state).toBe("formal");
  });
  it("日程が一部あっても、「模様」「噂」など確定していない言い回しなら正式発表にしない", () => {
    const j = judgeAnnouncement(F({ texts: ["来週抽選が始まる模様です"], applyStartKnown: true }));
    expect(j.state).toBe("teaser");
  });
  it("中止・延期は明示されたときだけ判断する（応募先が残っていても）", () => {
    expect(judgeAnnouncement(F({ texts: ["抽選販売は中止となりました"], hasApplyUrl: true })).state).toBe("cancelled");
    expect(judgeAnnouncement(F({ texts: ["抽選受付は延期となりました。日程は決まり次第お知らせします"] })).state).toBe("postponed");
    expect(judgeAnnouncement(F({ texts: ["抽選受付中。応募期限は11/20です"], applyDeadlineKnown: true, hasApplyUrl: true })).state).toBe("formal");
  });
  it("抽選・応募に関する記載が無い告知は、正式発表にしない", () => {
    expect(judgeAnnouncement(F({ texts: ["新商品が入荷予定です"] })).state).toBe("teaser");
  });
  it("判断の根拠と確認事項を記録する（推測を確定にしない）", () => {
    const j = judgeAnnouncement(F({ texts: ["近日、抽選販売を行います"] }));
    expect(j.signals.length).toBeGreaterThan(0);
    expect(j.reasons[0]).toContain("未発表");
    expect(j.confidence).not.toBe("high");
  });
});

describe("予告の経過・昇格・引き継ぎ", () => {
  const now = new Date("2026-11-20T00:00:00+09:00");
  const prev: TeaserState = { since: "2026-11-01T00:00:00Z", lastNewsAt: "2026-11-10T00:00:00Z", outcome: "active", carried: { chain: "ドラゴンスター", products: ["ハドウシーカー"], sourceUrls: ["https://x.com/a/status/1"] } };
  const teaser = judgeAnnouncement(F({ texts: ["抽選予定です"] }));
  const formal = judgeAnnouncement(F({ texts: ["受付中"], applyDeadlineKnown: true, hasApplyUrl: true }));
  it("正式発表 → 昇格。中止 → 終了。延期 → 保持", () => {
    expect(nextOutcome({ prev, judgement: formal, now })).toBe("promoted");
    expect(nextOutcome({ prev, judgement: judgeAnnouncement(F({ texts: ["抽選販売は中止となりました"] })), now })).toBe("cancelled");
    expect(nextOutcome({ prev, judgement: judgeAnnouncement(F({ texts: ["抽選受付は延期となりました"] })), now })).toBe("postponed");
  });
  it("未発表のまま長期間続報が無い／予定日を過ぎて続報が無い → 終了（履歴は残す）。上限内は継続", () => {
    expect(nextOutcome({ prev, judgement: teaser, now })).toBe("active");
    expect(nextOutcome({ prev: { ...prev, lastNewsAt: "2026-08-01T00:00:00Z" }, judgement: teaser, now })).toBe("expired");
    expect(nextOutcome({ prev, judgement: teaser, now, expectedStart: "2026-11-12" })).toBe("expired");
  });
  it("昇格・中止の後は状態を戻さない", () => {
    expect(nextOutcome({ prev: { ...prev, outcome: "promoted" }, judgement: teaser, now })).toBe("promoted");
    expect(nextOutcome({ prev: { ...prev, outcome: "cancelled" }, judgement: formal, now })).toBe("cancelled");
  });
  it("予告段階の情報を正式発表後に引き継ぐ（新しい告知の値を優先し、空の項目だけ補う）", () => {
    expect(carryOver({ chain: "", store: "", products: [] }, prev.carried)).toMatchObject({ chain: "ドラゴンスター", products: ["ハドウシーカー"] });
    expect(carryOver({ chain: "カードラボ", store: "A店", products: ["X"] }, prev.carried)).toMatchObject({ chain: "カードラボ", products: ["X"] });
  });
  it("通常の候補・件数に出さないのは、予告（有効・延期）だけ", () => {
    expect(isInternalTeaser({ announcement: "teaser", outcome: "active" })).toBe(true);
    expect(isInternalTeaser({ announcement: "teaser" })).toBe(true);
    expect(isInternalTeaser({ announcement: "teaser", outcome: "promoted" })).toBe(false);
    expect(isInternalTeaser({ announcement: "formal" })).toBe(false);
    expect(isInternalTeaser(null)).toBe(false);
  });
});
