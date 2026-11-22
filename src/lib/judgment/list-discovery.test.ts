// @vitest-environment node
/**
 * Stage 10M: 一覧の全項目の発見・判断・カバレッジ・再開・呼び出し上限。**必須の回帰テスト（8項目・複数系列・複数店舗・複数商品の一覧。ユーザーが確認した#1と同じ構造を架空データで再現）**。
 * 架空データ・台本のモデルのみ。実AI・DB・ネットワークには触れない。
 */
import { describe, expect, it } from "vitest";
import { CallBudget, CallLimitError, withCallBudget, withCallBudgetTranscriber } from "./call-budget";
import { coverageOf, discoverList, MemoryItemStore, parseBatchOutput, verifyItem, type ListItemResult } from "./list-discovery";
import { ScriptedListModel } from "./list-model";
import { batchItems, composeBatchText, parseListItems, rangeMatches } from "./list-items";
import { ScriptedModel } from "./model";

// 8項目・7見出し・複数系列・複数店舗・複数商品（うち1見出しに2項目＝同一店舗の別商品。同じ文面の別店舗が2つ。抽選でない項目なし）。#1の構造の再現
const NOW = new Date("2099-11-21T00:00:00Z");
const HEAD = "🏯架空地方 | 3府県8件 (1/1)";
const LIST8 = `${HEAD} 《サンプル書店A（架空県）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選販売受付 https://t.co/a1 - 11/23(月)23:59〆 《サンプル書店B（架空県）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選予約販売 https://t.co/a2 - 11/22(日)23:59〆 《チェーンC 東店（架空県）- 1件》 ・別TCG 抽選販売（デッキセット） https://t.co/a3 - 11/20(金)20:00〆 《チェーンD 西店（架空県）- 1件》 ・【再入荷】別TCG ブースター 抽選販売受付 https://t.co/a4 - 11/22(日)23:59〆 《チェーンD 南店（架空県）- 1件》 ・【再入荷】別TCG ブースター 抽選販売受付 https://t.co/a5 - 11/22(日)23:59〆 《チェーンE 北店（架空県）- 2件》 ・架空TCG 商品X https://t.co/a6 - 11/20(金)22:00〆 ・架空TCG 商品Y https://t.co/a7 - 11/22(日)22:00〆 《ショップF（架空県）- 1件》 ・架空TCG「テスト弾」抽選販売受付 https://t.co/a8 - 11/22(日)22:00〆`;
const P = parseListItems(LIST8);

/** 項目ごとの独立した抽選の判断を返す台本（各項目の本文から実在する抜粋を引用する） */
const indep = (no: number, text: string, over: Record<string, unknown> = {}) => ({ itemNo: no, verdict: "independent_lottery", quote: text.replace(/^[・✅ ]+/, "").slice(0, 8), rationale: "テスト", applyUnit: "one_form_one", ...over });
const allIndependent = (req: { items: { no: number; text: string }[] }) => ({ items: req.items.map((i) => indep(i.no, i.text)) });
const newBudget = (maxCalls = 90, maxCost = 50) => new CallBudget({ maxCalls, maxCostJpy: maxCost });

describe("一覧の項目の抽出: 親投稿の全項目に番号・原文の範囲・出典を持たせる", () => {
  it("8項目・7見出しを漏れなく抽出する。各項目の範囲は親投稿の原文と一致し、リンク・締切の表記を持つ（項目数 ≠ 応募機会数）", () => {
    expect(P.isList).toBe(true);
    expect(P.items.map((i) => i.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(P.groups).toBe(7);
    expect(P.items.map((i) => i.groupNo)).toEqual([1, 2, 3, 4, 5, 6, 6, 7]);
    expect(P.items.every((i) => rangeMatches(LIST8, i))).toBe(true);
    expect(P.items.every((i) => i.links.length === 1 && i.deadlineHint)).toBe(true);
    expect(P.header).toContain("架空地方");
    expect(P.parentKey).toMatch(/^[0-9a-f]{16}$/);
  });
  it("塊は最大6項目で、全項目がちょうど1つの塊に入る（8項目→6＋2）。各塊の本文には番号と共通の見出しが付く", () => {
    const b = batchItems(P.items);
    expect(b.map((x) => x.length)).toEqual([6, 2]);
    expect(b.flat().map((i) => i.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const t = composeBatchText(P.header, b[1]);
    expect(t).toContain("架空地方");
    expect(t).toContain("【項目7】");
    expect(t).toContain("【項目8】");
    expect(t).not.toContain("【項目1】");
  });
  it("一覧でない告知は項目にしない", () => {
    expect(parseListItems("単独の告知 架空TCG 抽選 4/8まで").isList).toBe(false);
    expect(parseListItems("《サンプル書店（架空県）- 1件》 ・架空TCG 抽選 4/8〆").isList).toBe(false);
  });
});

describe("必須回帰: 8項目の一覧を、全項目について処理済み／保留／失敗で追跡する（8項目が必ず8応募機会とは限らない）", () => {
  it("全項目が独立した抽選と判断され検査を通れば、8項目すべて done・応募機会 8・呼び出し 2回（6＋2）。出力件数ではなく項目の対応表で完了を判定する", async () => {
    const m = new ScriptedListModel((req) => allIndependent(req));
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    expect(m.calls).toBe(2);
    expect(r.coverage).toMatchObject({ total: 8, done: 8, hold: 0, failed: 0, pending: 0, complete: true, opportunitiesConfirmed: 8 });
    expect(r.results.map((x) => x.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.results.every((x) => x.quoteVerified && x.status === "done")).toBe(true);
    expect(m.seen[0].items.map((i) => i.no)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(m.seen[1].items.map((i) => i.no)).toEqual([7, 8]);
  });
  it("同じ文面の別店舗（項目4・5）・同じ文面の別系列（項目1・2・8）は統合されない。同じ見出しの下の2項目（6・7）は、根拠があれば1つの応募にできる → 8項目が7応募機会", async () => {
    const m = new ScriptedListModel((req) =>
      ({ items: req.items.map((i) => (i.no === 7 ? indep(7, i.text, { verdict: "part_of_other_item", mergedInto: 6, rationale: "同じ店舗の見出しの下で、1回の応募で複数商品を選ぶ形式" }) : indep(i.no, i.text))) }),
    );
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    expect(r.coverage).toMatchObject({ done: 8, complete: true, opportunitiesConfirmed: 7 });
    expect(r.results.find((x) => x.no === 7)).toMatchObject({ verdict: "part_of_other_item", mergedInto: 6, status: "done" });
    expect(r.results.filter((x) => [4, 5].includes(x.no)).every((x) => x.verdict === "independent_lottery")).toBe(true);
  });
  it("別の見出し（店舗・系列）の項目を同一応募にする判断は、リンク先が同じと分からない限り採用せず保留（誤統合の防止）。保留でも項目は残り、AIの判断も記録される", async () => {
    const m = new ScriptedListModel((req) => ({ items: req.items.map((i) => (i.no === 5 ? indep(5, i.text, { verdict: "part_of_other_item", mergedInto: 4 }) : indep(i.no, i.text))) }));
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    const x = r.results.find((y) => y.no === 5)!;
    expect(x).toMatchObject({ status: "hold", verdict: "part_of_other_item", mergedInto: 4 });
    expect(x.issues).toContain("cross_group_merge");
    expect(r.coverage).toMatchObject({ done: 7, hold: 1, complete: true, opportunitiesConfirmed: 7 });
    // 展開済みリンクが同じ応募先と分かる場合は、統合を採用できる
    const m2 = new ScriptedListModel((req) => ({ items: req.items.map((i) => (i.no === 5 ? indep(5, i.text, { verdict: "store_select_member", mergedInto: 4 }) : indep(i.no, i.text))) }));
    const r2 = await discoverList({ parsed: P, model: m2, store: new MemoryItemStore(), budget: newBudget(), now: NOW, sameDestination: (a, b) => [a.no, b.no].sort().join() === "4,5" });
    expect(r2.results.find((y) => y.no === 5)).toMatchObject({ status: "done", verdict: "store_select_member" });
    expect(r2.coverage.opportunitiesConfirmed).toBe(7);
  });
  it("統合の連鎖・自分自身・存在しない相手・系列の不一致・保留の相手への統合は採用しない", async () => {
    const m = new ScriptedListModel((req) =>
      ({
        items: req.items.map((i) => {
          if (i.no === 7) return indep(7, i.text, { verdict: "part_of_other_item", mergedInto: 6 });
          if (i.no === 6) return indep(6, i.text, { verdict: "part_of_other_item", mergedInto: 8, rationale: "x" }); // 6→8（別見出し）: 採用されない
          if (i.no === 3) return indep(3, i.text, { verdict: "part_of_other_item", mergedInto: 3 }); // 自分自身
          if (i.no === 2) return indep(2, i.text, { verdict: "store_select_member", mergedInto: 99 }); // 存在しない
          return indep(i.no, i.text);
        }),
      }),
    );
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    const by = (n: number) => r.results.find((x) => x.no === n)!;
    expect(by(3).issues).toContain("merge_self");
    expect(by(2).issues).toContain("merge_target_invalid");
    expect(by(6).issues).toContain("cross_group_merge");
    expect(by(7).status).toBe("hold"); // 相手（6）が保留になったため
    expect(by(7).issues.some((x) => x === "merge_target_invalid" || x === "merge_chain")).toBe(true);
  });
  it("根拠の抜粋が、その項目（または共通の見出し）に実在しなければ採用しない（保留）。抽選でない項目・判断不能の項目も捨てずに結果へ残す", async () => {
    const m = new ScriptedListModel((req) =>
      ({
        items: req.items.map((i) => {
          if (i.no === 1) return indep(1, i.text, { quote: "原文に無い架空の語句です" });
          if (i.no === 2) return { itemNo: 2, verdict: "not_lottery", quote: "", rationale: "先着販売の告知" };
          if (i.no === 3) return { itemNo: 3, verdict: "undeterminable", quote: "", rationale: "応募方法が不明", unresolved: [{ question: "応募方法・応募単位が原文に無い", importance: "high" }] };
          return indep(i.no, i.text);
        }),
      }),
    );
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    const by = (n: number) => r.results.find((x) => x.no === n)!;
    expect(by(1)).toMatchObject({ status: "hold", verdict: "independent_lottery", quoteVerified: false });
    expect(by(1).issues).toContain("quote_not_found");
    expect(by(2)).toMatchObject({ status: "done", verdict: "not_lottery" });
    expect(by(3)).toMatchObject({ status: "hold", verdict: "undeterminable" });
    expect(by(3).unresolved[0].importance).toBe("high");
    expect(r.coverage).toMatchObject({ total: 8, done: 6, hold: 2, failed: 0, complete: true, opportunitiesConfirmed: 5, opportunityCandidatesOnHold: 1 });
  });
});

describe("取りこぼしの防止: モデルが一部の項目しか返さなくても、完了と判定しない", () => {
  it("返されなかった項目は1回だけ再要求し、それでも無ければ failed（出力件数ではなく項目の対応表で判定）。渡していない番号・重複した番号は採用しない", async () => {
    let n = 0;
    const m = new ScriptedListModel((req) => {
      n++;
      const items = req.items.filter((i) => i.no !== 4).map((i) => indep(i.no, i.text)); // 項目4は常に返さない
      return { items: [...items, indep(99, "存在しない項目"), ...(items[0] ? [items[0]] : [])] };
    });
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    expect(r.results.find((x) => x.no === 4)).toMatchObject({ status: "failed", issues: ["not_returned"] });
    expect(r.coverage).toMatchObject({ total: 8, done: 7, failed: 1, complete: false });
    expect(m.calls).toBe(3); // 6＋2の2回と、返されなかった項目の再要求1回
    expect(n).toBe(3);
  });
  it("モデルの出力が壊れている（項目が1つも読めない）場合、全項目が failed。成功とは数えない", async () => {
    const r = await discoverList({ parsed: P, model: new ScriptedListModel(() => ({ error: "truncated" })), store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    expect(r.coverage).toMatchObject({ done: 0, failed: 8, complete: false, opportunitiesConfirmed: 0 });
  });
  it("形式の検査: 不正な判定・番号なしの項目は読み取らない", () => {
    expect(parseBatchOutput({ items: [{ itemNo: 1, verdict: "maybe" }, { verdict: "not_lottery" }, { itemNo: 2, verdict: "not_lottery", quote: "", rationale: "x" }] }).size).toBe(1);
    expect(parseBatchOutput(null).size).toBe(0);
  });
});

describe("ハードな呼び出し上限と再開: 上限で止まったら未処理を明示し、再開では処理済みを再利用する（重複課金しない）", () => {
  it("回数の上限（1回）で止まり、7・8は pending。再実行（新しい予算）では6項目を再利用して残り2項目だけ判断する（合計2回）", async () => {
    const store = new MemoryItemStore();
    const m = new ScriptedListModel((req) => allIndependent(req));
    const b1 = newBudget(1);
    const r1 = await discoverList({ parsed: P, model: m, store, budget: b1, now: NOW });
    expect(r1.stoppedBy).toBe("calls");
    expect(r1.coverage).toMatchObject({ total: 8, done: 6, pending: 2, complete: false });
    expect(r1.results.filter((x) => x.status === "pending").map((x) => x.no)).toEqual([7, 8]);
    expect(b1.calls).toBe(1);
    const b2 = newBudget(5);
    const r2 = await discoverList({ parsed: P, model: m, store, budget: b2, now: NOW });
    expect(r2).toMatchObject({ reused: 6, processed: 2, stoppedBy: null });
    expect(r2.coverage).toMatchObject({ done: 8, pending: 0, complete: true });
    expect(m.calls).toBe(2); // 1回目の6項目を再び呼び出していない
    expect(m.seen[1].items.map((i) => i.no)).toEqual([7, 8]);
    // 完了後の再実行は、AIを1回も呼ばない
    const r3 = await discoverList({ parsed: P, model: m, store, budget: newBudget(5), now: NOW });
    expect(m.calls).toBe(2);
    expect(r3).toMatchObject({ reused: 8, processed: 0, calls: 0 });
  });
  it("再要求も呼び出し回数に含まれる（合計3回の上限: 6＋2＋再要求1）。上限に達したら再要求せず、未処理を明示", async () => {
    const m = new ScriptedListModel((req) => ({ items: req.items.filter((i) => i.no !== 2).map((i) => indep(i.no, i.text)) }));
    const b = newBudget(2);
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: b, now: NOW });
    expect(b.calls).toBe(2);
    expect(m.calls).toBe(2);
    expect(r.stoppedBy).toBe("calls");
    expect(r.results.find((x) => x.no === 2)!.status).toBe("pending"); // 再要求できなかった（上限）→ 失敗ではなく未処理
  });
  it("費用の上限（予約）でも止まる。拒否された呼び出しは回数に数えない", async () => {
    const m = new ScriptedListModel((req) => allIndependent(req), 0.3, 0.6);
    const b = newBudget(90, 0.7); // 1回目の予約0.6は通り、2回目の予約0.6は残額に収まらない
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: b, now: NOW });
    expect(r.stoppedBy).toBe("cost");
    expect(b.calls).toBe(1);
    expect(r.coverage.pending).toBe(2);
  });
  it("共通の上限（CallBudget）は、判断の再試行・画像の書き起こし・一覧の項目判断のすべてを合算し、超える前に呼び出しを拒否する", async () => {
    const b = newBudget(4, 50);
    const model = new ScriptedModel(() => ({ raw: { version: "x" }, costJpy: 0.1 }), undefined, 0.5); // 検証で必ず不合格になる出力＝再試行が起きる
    const wrapped = withCallBudget(model, b);
    const input = { version: "10e.2", caseId: null, title: "", now: NOW.toISOString(), evidence: [], related: [], masters: [], priorJudgments: [], failures: [], regionPrefectures: [] } as never;
    await wrapped.judge(input);
    await wrapped.judge(input);
    const t = withCallBudgetTranscriber(async () => ({ lines: [], costJpy: 0.2, model: "t", promptVersion: "t" }), b);
    expect(await t({ mediaType: "image/png", base64: "AA==" })).not.toBeNull();
    const s = b.start("list_batch", 0.1);
    expect(s.ok).toBe(true);
    expect(b.calls).toBe(4);
    await expect(wrapped.judge(input)).rejects.toBeInstanceOf(CallLimitError);
    expect(await t({ mediaType: "image/png", base64: "AA==" })).toBeNull();
    expect(model.calls).toBe(2); // 拒否された呼び出しは、モデルに届いていない
    expect(b.summary().byKind).toMatchObject({ judge: { calls: 2 }, image: { calls: 1 }, list_batch: { calls: 1 } });
  });
});

describe("カバレッジの定義", () => {
  it("応募機会は『検査を通った独立した抽選』の数。保留中の独立抽選は『候補』として別に数え、確認済みの機会に混ぜない", () => {
    const r = (no: number, status: ListItemResult["status"], verdict: ListItemResult["verdict"]): ListItemResult => ({ no, groupNo: no, status, verdict, mergedInto: null, unit: null, chain: null, store: null, products: [], applyDeadline: null, applyStart: null, method: null, rationale: "", quote: "", quoteVerified: false, unresolved: [], issues: [] });
    const c = coverageOf(5, new Map([r(1, "done", "independent_lottery"), r(2, "done", "part_of_other_item"), r(3, "hold", "independent_lottery"), r(4, "done", "not_lottery")].map((x) => [x.no, x])));
    expect(c).toMatchObject({ total: 5, done: 3, hold: 1, failed: 0, pending: 1, complete: false, opportunitiesConfirmed: 1, opportunityCandidatesOnHold: 1 });
  });
  it("verifyItem: 抽選でない・判断不能は抜粋が無くても通る（保留は判断不能のみ）", () => {
    const ctx = { items: new Map(P.items.map((i) => [i.no, i])), header: P.header };
    expect(verifyItem({ no: 1, verdict: "not_lottery", mergedInto: null, unit: null, chain: null, store: null, products: [], applyDeadline: null, applyStart: null, method: null, rationale: "x", quote: "", unresolved: [] }, ctx).status).toBe("done");
    expect(verifyItem({ no: 1, verdict: "undeterminable", mergedInto: null, unit: null, chain: null, store: null, products: [], applyDeadline: null, applyStart: null, method: null, rationale: "x", quote: "", unresolved: [] }, ctx).status).toBe("hold");
  });
});

describe("根拠の抜粋の検証: 実データで見つかった不具合の回帰（モデルは「見出し 【項目n】 項目の本文」をそのまま抜粋する）", () => {
  it("見出しから項目の本文へまたがる抜粋・【項目n】を含む抜粋も、原文に由来する語句なら採用する。原文に無い語句は引き続き不採用", async () => {
    const m = new ScriptedListModel((req) => ({
      items: req.items.map((i) => (i.no === 3 ? indep(3, i.text, { quote: "《チェーンC 東店（架空県）- 1件》 【項目3】 ・別TCG 抽選販売" }) : i.no === 4 ? indep(4, i.text, { quote: "チェーンD 西店 の存在しない告知です" }) : indep(i.no, i.text, { quote: `【項目${i.no}】 ${i.text.replace(/^[・✅ ]+/, "").slice(0, 8)}` }))),
    }));
    const r = await discoverList({ parsed: P, model: m, store: new MemoryItemStore(), budget: newBudget(), now: NOW });
    expect(r.results.find((x) => x.no === 3)).toMatchObject({ status: "done", quoteVerified: true });
    expect(r.results.find((x) => x.no === 4)).toMatchObject({ status: "hold", quoteVerified: false });
    expect(r.results.filter((x) => x.status === "done")).toHaveLength(7);
  });
});
