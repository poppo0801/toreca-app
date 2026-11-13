// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditGroup } from "@/lib/agent/lottery-grouping/audit";
import { comparePair, isPlausiblePeer } from "@/lib/agent/lottery-grouping/compare";
import { worldOf, type Scenario } from "@/lib/agent/lottery-grouping/eval-world";
import { item, mkGroup, mkLottery, mkWorld, postText, resetSeq, PRODUCT_A } from "@/lib/agent/lottery-grouping/fixtures";
import { evaluateGrouping } from "@/lib/agent/lottery-grouping/run";
import { MockGroupingBrain } from "@/lib/agent/lottery-grouping/mock";
import type { AgentProposal } from "@/lib/agent/lottery-grouping/types";
import { GROUPING_DEFINITION, mismatchesOf, peerHashOf, verifyProposal } from "@/lib/agent/lottery-grouping/verify";

/** Stage 8F-5: グループ化の正式な定義（同一系列の複数店舗で、同一商品・同一応募期間・同一応募条件・同一抽選方式の抽選が独立に実施されているものを、一覧で1つにまとめる）の検証 */
const claim = (over: Partial<AgentProposal> = {}): AgentProposal => ({ action: "new_group", groupId: null, memberIds: [], title: "", rationale: "条件がそろっている", claimedCommon: [], claimedDiffers: [], commonPhrase: null, selfConfidence: 80, missing: [], ...over });
const d = (y: string) => ({ precision: "date_only" as const, date: y });

describe("新定義の核心（8F-5）: 条件がそろっていれば、イベントID・応募URL・キャンペーンIDが店舗ごとに違っても対象", () => {
  it("カードラボ神戸・大阪・京都（同じ商品・期間・条件・方式。URLもイベントIDも別）→ 3店舗を1グループ（auto）", () => {
    resetSeq();
    const s = mkLottery({ storeName: "神戸店", sourceUrls: ["https://c-labo.example.invalid/kobe?event_id=1000001"] });
    const o = mkLottery({ storeName: "大阪店", sourceUrls: ["https://c-labo.example.invalid/osaka?event_id=2000002"] });
    const k = mkLottery({ storeName: "京都店", sourceUrls: ["https://c-labo.example.invalid/kyoto?event_id=3000003"] });
    const v = verifyProposal(mkWorld(s, [o, k]), claim({ memberIds: [o.id, k.id] }), { allowAuto: true });
    expect(v.tier).toBe("auto");
    expect(v.lotteryIds.sort()).toEqual([s.id, o.id, k.id].sort());
    expect(v.basis.join()).toContain("店舗ごとに異なる");
  });
  it("対象外のもの: 系列が異なる・商品が異なる・期間が異なる・条件/方式が異なる・同一店舗・店舗選択式・数量が異なる", () => {
    resetSeq();
    const s = mkLottery();
    const cases: [string, ReturnType<typeof mkLottery>][] = [
      ["商品", mkLottery({ items: [item("別の商品")] })],
      ["応募期間", mkLottery({ applyStart: d("2026-12-02") })],
      ["応募期間（締切）", mkLottery({ applyDeadline: d("2026-12-08") })],
      ["応募条件", mkLottery({ requirementTags: ["purchase_history"], conditionsText: "購入履歴が必要" })],
      ["応募方法", mkLottery({ applyMethod: "store" })],
      ["数量", mkLottery({ items: [item(PRODUCT_A, 2)] })],
      ["同一店舗", mkLottery({ storeId: s.storeId })],
      ["店舗選択式", mkLottery({ storeMode: "select_on_apply", storeId: null, storeName: "" })],
    ];
    for (const [name, other] of cases) {
      const v = verifyProposal(mkWorld(s, [other]), claim({ memberIds: [other.id] }), { allowAuto: true });
      expect(v.tier, name).toBe("single");
      expect(v.kind, name).toBe("single");
    }
    // 系列が異なる抽選は、世界に入らない（同じ系列だけが比較対象）。事前の絞り込みでも対象外
    expect(isPlausiblePeer(s, mkLottery({ chainId: "別の系列" }))).toBe(false);
  });
  it("イベントIDが異なることだけを理由に拒否しない／同じイベントIDでも、内容が違えば対象外", () => {
    resetSeq();
    const s = mkLottery({ sourceUrls: ["https://x.example.invalid/e?event_id=1111111"] });
    const diffId = mkLottery({ sourceUrls: ["https://x.example.invalid/e?event_id=2222222"] });
    expect(verifyProposal(mkWorld(s, [diffId]), claim({ memberIds: [diffId.id] }), { allowAuto: true }).tier).toBe("auto");
    const sameIdDiffPeriod = mkLottery({ sourceUrls: ["https://x.example.invalid/e?event_id=1111111"], applyDeadline: d("2026-12-20") });
    expect(verifyProposal(mkWorld(s, [sameIdDiffPeriod]), claim({ memberIds: [sameIdDiffPeriod.id] }), { allowAuto: true }).tier).toBe("single");
  });
  it("情報不足を一致とみなさない: 周辺（発表日）の不明は候補、核心（応募期間）の不明は保留、条件が両方未登録で文章も無ければ候補", () => {
    resetSeq();
    const unknown = { precision: "unknown" as const };
    const s1 = mkLottery({ resultDate: unknown });
    const o1 = mkLottery({ resultDate: unknown });
    expect(verifyProposal(mkWorld(s1, [o1]), claim({ memberIds: [o1.id] }), { allowAuto: true }).tier).toBe("suggest");
    const s2 = mkLottery({ applyStart: unknown });
    const o2 = mkLottery({ applyStart: unknown });
    expect(verifyProposal(mkWorld(s2, [o2]), claim({ memberIds: [o2.id] }), { allowAuto: true }).tier).toBe("hold");
    const blank = { requirementTags: [], conditionsText: "" };
    const s3 = mkLottery(blank);
    const o3 = mkLottery(blank);
    expect(verifyProposal(mkWorld(s3, [o3]), claim({ memberIds: [o3.id] }), { allowAuto: true }).tier).toBe("suggest");
  });
  it("店舗選択式の疑い: 『対象店舗の中から1店舗のみ応募』『1店舗のみ』のタグがあれば、条件が一致していても自動にしない（候補。原則対象外のため利用者が確認）", () => {
    resetSeq();
    const choiceText = "お一人様につき対象店舗の中から１店舗のみご応募が可能です。";
    const s = mkLottery({ conditionsText: choiceText });
    const o = mkLottery({ conditionsText: choiceText });
    const v = verifyProposal(mkWorld(s, [o]), claim({ memberIds: [o.id] }), { allowAuto: true });
    expect(v.tier).toBe("suggest");
    expect(v.mismatches.some((m) => m.field === "storeMode" && m.detail.includes("店舗選択式"))).toBe(true);
    const t1 = mkLottery({ requirementTags: ["member", "one_store_only"] });
    const t2 = mkLottery({ requirementTags: ["member", "one_store_only"] });
    expect(verifyProposal(mkWorld(t1, [t2]), claim({ memberIds: [t2.id] }), { allowAuto: true }).tier).toBe("suggest");
    // 情報源の文章（取得したページ）にあっても同じ
    const e1 = mkLottery();
    const e2 = mkLottery();
    const ev = { [e1.id]: [postText("冬の企画", "A", " 応募時に応募店舗を選んでください。")], [e2.id]: [postText("冬の企画", "B")] };
    expect(verifyProposal(mkWorld(e1, [e2], { evidence: ev }), claim({ memberIds: [e2.id] }), { allowAuto: true }).tier).toBe("suggest");
  });
  it("同じ内容の既存グループが複数ある（どれに入れるか決められない）: 自動にしない", () => {
    resetSeq();
    const s = mkLottery();
    const a = mkLottery({ groupId: "g1" });
    const b = mkLottery({ groupId: "g1" });
    const c = mkLottery({ groupId: "g2" });
    const e = mkLottery({ groupId: "g2" });
    const w = mkWorld(s, [a, b, c, e], { groups: [mkGroup("g1", "bulk_registration", [a.id, b.id]), mkGroup("g2", "bulk_registration", [c.id, e.id])] });
    const v = verifyProposal(w, claim({ action: "add_to_group", groupId: "g1" }), { allowAuto: true });
    expect(v.tier).toBe("suggest");
    expect(v.downgrades.join()).toContain("他にもある");
    const one = mkWorld(s, [a, b], { groups: [mkGroup("g1", "bulk_registration", [a.id, b.id])] });
    expect(verifyProposal(one, claim({ action: "add_to_group", groupId: "g1" }), { allowAuto: true }).tier).toBe("auto");
  });
  it("安全: 手動で分けた組は再びまとめない／応募・当選済みでも対象（記録は変えない）／AIが全部『共通』と主張しても事実が優先", () => {
    resetSeq();
    const s = mkLottery();
    const a = mkLottery({ hasApplication: true });
    const sep = verifyProposal(mkWorld(s, [a], { separated: [[s.id, a.id]] }), claim({ memberIds: [a.id] }), { allowAuto: true });
    expect(sep.tier).toBe("single");
    expect(sep.skipReason).toBe("手動で分けた組");
    expect(verifyProposal(mkWorld(s, [a]), claim({ memberIds: [a.id] }), { allowAuto: true }).tier).toBe("auto");
    const diff = mkLottery({ applyDeadline: d("2026-12-30") });
    const liar = verifyProposal(mkWorld(s, [diff]), claim({ memberIds: [diff.id], claimedCommon: ["応募期間", "対象商品", "応募条件"], selfConfidence: 100 }), { allowAuto: true });
    expect(liar.tier).toBe("single");
  });
  it("定義の版が記録キーに入る: 旧定義の過去の単独・保留は、新定義で再評価される。手動で分けた組・却下済みの組は別の記録で、再びまとめない", async () => {
    resetSeq();
    const s = mkLottery();
    const a = mkLottery();
    const w = mkWorld(s, [a]);
    expect(GROUPING_DEFINITION).toBe("def8f5");
    const oldKey = `single:${s.id}:oldhash`;
    const w2 = mkWorld(s, [a], { knownKeys: { [oldKey]: "dismissed" } });
    expect(peerHashOf(w)).toBe(peerHashOf(w2));
    const r = await evaluateGrouping(w2, { llm: new MockGroupingBrain("careful"), allowAuto: true });
    expect(r.ranAgent).toBe(true); // 旧定義のキーは、新定義の判定をスキップさせない
    expect(r.decision.tier).toBe("auto");
    // 手動で分けた組は、同じ内容でも新定義で再びまとめない
    const w3 = mkWorld(s, [a], { separated: [[s.id, a.id]] });
    const r3 = await evaluateGrouping(w3, { llm: new MockGroupingBrain("eager"), allowAuto: true });
    expect(r3.decision.tier).toBe("single");
  });
});

describe("既存グループの再評価（8F-5。読み取りのみ。自動では解除・変更しない）", () => {
  it("新定義に合うグループは変更不要。所属に期間・条件・方式の違いがあれば inconsistent、記載なし・不明は needs_review。手動グループは変更しない旨を案内", () => {
    resetSeq();
    const a = mkLottery();
    const b = mkLottery();
    const c = mkLottery({ applyDeadline: d("2026-12-20") });
    const e = mkLottery({ resultDate: { precision: "unknown" } });
    const by = new Map([a, b, c, e].map((l) => [l.id, l]));
    expect(auditGroup(mkGroup("g1", "ai", [a.id, b.id]), by)).toMatchObject({ status: "consistent", memberCount: 2, issues: [] });
    const bad = auditGroup(mkGroup("g2", "ai", [a.id, c.id]), by);
    expect(bad.status).toBe("inconsistent");
    expect(bad.issues.some((x) => x.field === "applyDeadline" && x.severity === "hard")).toBe(true);
    expect(bad.advice).toContain("自動では解除しません");
    expect(auditGroup(mkGroup("g3", "ai", [a.id, e.id]), by).status).toBe("needs_review");
    expect(auditGroup(mkGroup("g4", "manual", [a.id, c.id]), by).advice).toContain("利用者の意思なので変更しません");
    // 除外済みの所属は数えない
    const gone = mkLottery({ archived: true });
    expect(auditGroup(mkGroup("g5", "ai", [a.id, b.id, gone.id]), new Map([...by, [gone.id, gone]])).memberCount).toBe(2);
  });
});

describe("評価データの再構築（8F-5）: 旧定義の正解を保持したまま、新定義の正解を別ファイルに持つ", () => {
  it("架空の40シナリオ: 旧正解 gold.json は不変（oldLabel と一致）。変更は定義の違いに由来するものだけ", () => {
    const oldGold = JSON.parse(readFileSync("eval/lottery-grouping/gold.json", "utf8")).labels as Record<string, { label: string }>;
    const next = JSON.parse(readFileSync("eval/lottery-grouping/gold-8f5.json", "utf8")).labels as Record<string, { label: string; oldLabel: string }>;
    expect(Object.keys(next)).toEqual(Object.keys(oldGold));
    for (const [id, v] of Object.entries(next)) expect(v.oldLabel, id).toBe(oldGold[id].label);
    const changed = Object.entries(next).filter(([, v]) => v.label !== v.oldLabel).map(([k]) => k);
    expect(changed).toEqual(["G04", "G09", "G11", "G14", "G17", "G18", "G21", "G23", "G25", "G28", "G33", "G39"]);
  });
  it("架空の40シナリオ: 検証層（固定ロジック）の結果が、新定義の正解と食い違わない（auto と判定したものは正解が auto。慎重なモックで）", async () => {
    const scenarios = JSON.parse(readFileSync("eval/lottery-grouping/scenarios.json", "utf8")).scenarios as Scenario[];
    const gold = JSON.parse(readFileSync("eval/lottery-grouping/gold-8f5.json", "utf8")).labels as Record<string, { label: string }>;
    for (const sc of scenarios) {
      const o = await evaluateGrouping(worldOf(sc), { llm: new MockGroupingBrain("careful"), allowAuto: true });
      if (o.decision.tier === "auto" && !o.decision.skipReason) expect(gold[sc.id].label, sc.id).toBe("auto");
      if (gold[sc.id].label === "none") expect(["single", "hold", "suggest"]).toContain(o.decision.tier);
    }
  });
  const REAL = "eval/lottery-grouping-real";
  const sets: [string, string][] = [["", "8F-2"], ["-8f3", "8F-3"], ["-8f4", "8F-4"]];
  for (const [suffix, name] of sets) {
    it.skipIf(!existsSync(`${REAL}/gold${suffix}-d8f5.json`))(`実データ ${name}: 旧正解は不変。新正解で none のケースは、登録内容で全員に決定的な相違（期間・条件・方式・商品・数量）がある（イベントIDには依らない）`, () => {
      const oldG = JSON.parse(readFileSync(`${REAL}/gold${suffix}.json`, "utf8")).labels as Record<string, { label: string }>;
      const newG = JSON.parse(readFileSync(`${REAL}/gold${suffix}-d8f5.json`, "utf8")).labels as Record<string, { label: string; oldLabel: string; definition: string }>;
      const cases = JSON.parse(readFileSync(`${REAL}/cases${suffix}.json`, "utf8")).cases as (Scenario & { id: string })[];
      for (const [id, v] of Object.entries(newG)) {
        expect(v.oldLabel, id).toBe(oldG[id].label);
        expect(v.definition).toBe("8F-5");
      }
      for (const c of cases.filter((x) => newG[x.id].label === "none")) {
        const w = worldOf(c);
        const peers = w.lotteries.filter((l) => isPlausiblePeer(w.subject, l));
        for (const p of peers) expect(mismatchesOf(comparePair(w.subject, p), p.id).some((m) => m.severity === "hard"), `${c.id}↔${p.id}`).toBe(true);
      }
    });
  }
  it.skipIf(!existsSync(`${REAL}/gold-8f3-d8f5.json`))("実データの再分類: 8F-3 の auto 正解6件は、店舗選択式の記載（1店舗のみ応募）があり、新定義では review（候補のみ）。新定義での実データの auto 正解は0件（不足として報告）", () => {
    const g3 = JSON.parse(readFileSync(`${REAL}/gold-8f3-d8f5.json`, "utf8")).labels as Record<string, { label: string; oldLabel: string }>;
    expect(Object.entries(g3).filter(([, v]) => v.oldLabel === "auto").every(([, v]) => v.label === "review")).toBe(true);
    const all = ["", "-8f3", "-8f4"].flatMap((s) => Object.values(JSON.parse(readFileSync(`${REAL}/gold${s}-d8f5.json`, "utf8")).labels as Record<string, { label: string }>));
    expect(all.filter((v) => v.label === "auto")).toHaveLength(0);
    expect(all).toHaveLength(37);
  });
});
