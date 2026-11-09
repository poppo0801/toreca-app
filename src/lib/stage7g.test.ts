import { describe, expect, it } from "vitest";
import { battleInputSchema, EMPTY_VIEW_FILTER, filterViews, invertResult, isSameMatch, isUnassigned, RESULT_COLOR_CLASS, RESULT_SYMBOL, tally, tallyBy, toCanonical, viewFor, viewsFor } from "@/lib/battle";
import type { BattleRecord } from "@/types/domain";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const label = (id: string) => ({ [A]: "A", [B]: "B", [C]: "C" })[id] ?? "";
const rec = (o: Partial<BattleRecord> = {}): BattleRecord => ({ id: "1", playedOn: "2026-11-09", profileId: A, opponentProfileId: null, myDeck: "リザードン", opponent: "", opponentDeck: "サーナイト", result: "win", turnOrder: "first", format: "ジムバトル", memo: "", ...o });

describe("Stage 7G: プロフィール別の見え方", () => {
  it("A対B（Aがリザードン、Bがサーナイト、Aの勝ち）: Aの画面とBの画面で自分/相手・デッキ・勝敗・先攻後攻が反転する", () => {
    const r = rec({ opponentProfileId: B });
    const a = viewFor(r, A, label)!;
    expect(a).toMatchObject({ myDeck: "リザードン", opponentDeck: "サーナイト", result: "win", turnOrder: "first", opponentName: "B", role: "player", shared: true });
    const b = viewFor(r, B, label)!;
    expect(b).toMatchObject({ myDeck: "サーナイト", opponentDeck: "リザードン", result: "lose", turnOrder: "second", opponentName: "A", role: "opponent", shared: true });
    // 対戦データは1件（同じ記録を指す）
    expect(a.record).toBe(b.record);
  });
  it("引き分けは双方とも引き分け。無関係なプロフィールには見えない", () => {
    const r = rec({ opponentProfileId: B, result: "draw" });
    expect(viewFor(r, A, label)!.result).toBe("draw");
    expect(viewFor(r, B, label)!.result).toBe("draw");
    expect(viewFor(r, C, label)).toBeNull();
  });
  it("外部の相手の対戦は、記録したプロフィールにだけ表示され、相手の名称が出る", () => {
    const r = rec({ opponent: "友だち" });
    expect(viewFor(r, A, label)).toMatchObject({ opponentName: "友だち", shared: false });
    expect(viewFor(r, B, label)).toBeNull();
  });
  it("持ち主が決まっていない記録は誰にも割り当てず、未割当として扱う", () => {
    const r = rec({ profileId: null });
    expect(isUnassigned(r)).toBe(true);
    expect(viewFor(r, A, label)).toBeNull();
    expect(viewsFor([r], A, label)).toEqual([]);
  });
  it("一覧は新しい順", () => {
    const list = [rec({ id: "1", playedOn: "2026-11-01" }), rec({ id: "2", playedOn: "2026-11-05", opponentProfileId: B }), rec({ id: "3", playedOn: "2026-11-03", profileId: B, opponentProfileId: A })];
    expect(viewsFor(list, A, label).map((v) => v.id)).toEqual(["2", "3", "1"]);
    expect(viewsFor(list, B, label).map((v) => v.id)).toEqual(["2", "3"]);
  });
  it("相手側からの編集は、保存する形（記録した側から見た形）に直る。往復で元に戻る", () => {
    const r = rec({ opponentProfileId: B });
    const v = viewFor(r, B, label)!;
    const edited = toCanonical({ myDeck: v.myDeck, opponentDeck: v.opponentDeck, result: v.result, turnOrder: v.turnOrder }, "opponent");
    expect(edited).toEqual({ myDeck: "リザードン", opponentDeck: "サーナイト", result: "win", turnOrder: "first" });
    // Bが「勝ちに直す」と、保存はAの負け
    const fixed = toCanonical({ myDeck: "サーナイト", opponentDeck: "リザードン", result: "win", turnOrder: "second" }, "opponent");
    expect(fixed).toMatchObject({ myDeck: "リザードン", opponentDeck: "サーナイト", result: "lose", turnOrder: "first" });
    expect(toCanonical({ myDeck: "x", opponentDeck: "y", result: "win", turnOrder: "" }, "player")).toEqual({ myDeck: "x", opponentDeck: "y", result: "win", turnOrder: "" });
  });
  it("同一対戦の二重登録を検出する（どちらの側から登録しても）", () => {
    const a = rec({ opponentProfileId: B });
    expect(isSameMatch(a, { ...a })).toBe(true);
    // Bが同じ対戦を自分側から登録しようとした
    expect(isSameMatch(a, { playedOn: a.playedOn, profileId: B, opponentProfileId: A, myDeck: "サーナイト", opponentDeck: "リザードン", result: "lose", format: a.format })).toBe(true);
    // 勝敗が整合しない・日付やデッキが違う・形式が違うものは別の対戦
    expect(isSameMatch(a, { playedOn: a.playedOn, profileId: B, opponentProfileId: A, myDeck: "サーナイト", opponentDeck: "リザードン", result: "win", format: a.format })).toBe(false);
    expect(isSameMatch(a, { ...a, playedOn: "2026-11-10" })).toBe(false);
    expect(isSameMatch(a, { ...a, myDeck: "ピカチュウ" })).toBe(false);
    expect(isSameMatch(rec(), rec())).toBe(false); // 外部の相手との対戦は対象外
  });
  it("入力: アプリ内の相手のIDを検証する", () => {
    const ok = { playedOn: "2026-11-09", profileId: A, opponentProfileId: B, myDeck: "", opponent: "", opponentDeck: "", result: "win", turnOrder: "", format: "", memo: "" };
    expect(battleInputSchema.safeParse(ok).success).toBe(true);
    expect(battleInputSchema.safeParse({ ...ok, opponentProfileId: "x" }).success).toBe(false);
    expect(invertResult("lose")).toBe("win");
  });
});

describe("Stage 7G: 集計（表示中のプロフィール基準）", () => {
  const list = [
    rec({ id: "1", opponentProfileId: B, result: "win", format: "ジムバトル" }),
    rec({ id: "2", profileId: B, opponentProfileId: A, myDeck: "サーナイト", opponentDeck: "リザードン", result: "win", format: "ジムバトル" }), // Aから見ると負け
    rec({ id: "3", result: "lose", format: "公認大会", myDeck: "ピカチュウ" }),
    rec({ id: "4", result: "draw", format: "公認大会" }),
  ];
  it("共有の対戦はプロフィールごとに勝敗を反転して集計する。勝率は引き分けを除く", () => {
    const a = viewsFor(list, A, label);
    expect(tally(a)).toMatchObject({ total: 4, win: 1, lose: 2, draw: 1, decided: 3 });
    expect(tally(a).winRate).toBeCloseTo(1 / 3);
    const b = viewsFor(list, B, label);
    expect(tally(b)).toMatchObject({ total: 2, win: 1, lose: 1, winRate: 0.5 }); // 記録1はBから見ると負け、記録2はBの勝ち
  });
  it("使用デッキ別・対戦形式別、絞り込み。勝敗が無いときの勝率は null（表示は－）", () => {
    const a = viewsFor(list, A, label);
    expect(tallyBy(a, (v) => v.format).map((g) => [g.key, g.win, g.lose, g.draw])).toEqual([["ジムバトル", 1, 1, 0], ["公認大会", 0, 1, 1]]);
    expect(tallyBy(a, (v) => v.myDeck).find((g) => g.key === "ピカチュウ")).toMatchObject({ lose: 1, winRate: 0 });
    expect(filterViews(a, { ...EMPTY_VIEW_FILTER, format: "公認大会" }).map((v) => v.id)).toEqual(["4", "3"]);
    expect(filterViews(a, { ...EMPTY_VIEW_FILTER, myDeck: "ピカチュウ" }).map((v) => v.id)).toEqual(["3"]);
    expect(tally([{ result: "draw" as const }]).winRate).toBeNull();
  });
  it("勝敗の記号と色（◯青・×赤・△緑）", () => {
    expect(RESULT_SYMBOL).toEqual({ win: "◯", lose: "×", draw: "△" });
    expect(RESULT_COLOR_CLASS.win).toContain("--cat-supply");
    expect(RESULT_COLOR_CLASS.lose).toContain("danger");
    expect(RESULT_COLOR_CLASS.draw).toContain("success");
  });
});
