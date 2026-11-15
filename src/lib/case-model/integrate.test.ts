// @vitest-environment node
import { describe, expect, it } from "vitest";
import { integrateCandidates, strengthOf, type IntegrationInput } from "./integrate";
import { emptyCase, type CaseFieldKey, type CaseFile, type CaseFieldState, type EvidenceRef } from "./types";

/** Stage 9H-3E: 複数の調査結果・候補の統合（純関数）。別抽選の誤統合防止・根拠の強さの比較・詳細な文面の保持・手動確定の保護・再現性 */
type Spec = Partial<Record<CaseFieldKey, string | [string, CaseFieldState, EvidenceRef?]>>;
const PRIMARY: EvidenceRef = { url: "https://official.example.invalid/a", quote: "原文", tier: "primary", kind: "organizer_official" };
const BODY: EvidenceRef = { url: "https://livepocket.example.invalid/e/1", quote: "本文", tier: "secondary", basis: "organizer_body" };
const META: EvidenceRef = { url: "https://livepocket.example.invalid/e/1", quote: "受付", tier: "secondary", basis: "platform_meta" };
const SUMMARY: EvidenceRef = { url: "https://matome.example.invalid/x", quote: "抜粋", tier: "secondary" };

function cf(id: string, spec: Spec, locked: CaseFieldKey[] = []): CaseFile {
  const c = emptyCase(id, "2026-11-15T00:00:00Z");
  for (const [k, v] of Object.entries(spec) as [CaseFieldKey, string | [string, CaseFieldState, EvidenceRef?]][]) {
    const [value, state, ev] = typeof v === "string" ? [v, "inferred" as CaseFieldState, undefined] : v;
    c.fields[k] = { value, state, by: "ai", evidence: ev ? [ev] : [], alternatives: [] };
  }
  c.humanLocked = locked;
  return c;
}
const inp = (id: string, spec: Spec, locked: CaseFieldKey[] = []): IntegrationInput => ({ id, label: `候補${id}`, caseFile: cf(id, spec, locked) });
const BASE: Spec = { chain: "テスト星", items: "ハドウシーカー", applyDeadline: "2026-11-15 11:59" };

describe("根拠の強さは、情報源全体ではなく、値ごとの根拠で決まる", () => {
  it("確定・一次情報・主催者本文・原文の抜粋は強く、サービス側の受付表示・根拠のない推定は弱い", () => {
    const f = (state: CaseFieldState, ev?: EvidenceRef) => cf("x", { chain: ["a", state, ev] }).fields.chain;
    expect(strengthOf(f("confirmed", PRIMARY))).toBeGreaterThan(strengthOf(f("inferred", BODY)));
    expect(strengthOf(f("inferred", BODY))).toBeGreaterThan(strengthOf(f("inferred", SUMMARY)));
    expect(strengthOf(f("inferred", SUMMARY))).toBeGreaterThan(strengthOf(f("inferred", META)));
    expect(strengthOf(f("inferred"))).toBeLessThan(strengthOf(f("inferred", SUMMARY)));
  });
});

describe("項目ごとの採用と、採用しなかった値の記録", () => {
  it("根拠の差が大きければ強い値を採用し、弱い値は理由つきで不採用。同じ意味の日時（境界・詳しさ）は矛盾にしない", () => {
    const r = integrateCandidates([
      inp("a", { ...BASE, applyStart: ["2026-11-11", "inferred", SUMMARY] }),
      inp("b", { ...BASE, applyDeadline: ["2026-11-15 11:59", "inferred", BODY], applyStart: ["2026-11-11 12:00", "inferred", META] }),
      inp("c", { ...BASE, applyDeadline: ["2026-11-16 12:00", "inferred", META] }),
    ]);
    const dl = r.adoptions.find((a) => a.field === "applyDeadline")!;
    expect(r.caseFile.fields.applyDeadline.value).toBe("2026-11-15 11:59");
    expect(dl.rejected.map((x) => x.value)).toEqual(["2026-11-16 12:00"]);
    expect(dl.reason).toContain("主催者本文");
    expect(r.caseFile.fields.applyStart.value).toBe("2026-11-11 12:00"); // 詳しい（時刻つき）方
    expect(r.unresolved).toEqual([]);
  });

  it("根拠の強さが近い食い違いは、どちらにも決めず未確認（矛盾）として保持。応募締切の暫定値は早い方", () => {
    const r = integrateCandidates([inp("a", { ...BASE, applyDeadline: ["2026-11-20 23:59", "inferred", SUMMARY] }), inp("b", { ...BASE, applyDeadline: ["2026-11-18 23:59", "inferred", SUMMARY] })]);
    expect(r.caseFile.fields.applyDeadline).toMatchObject({ value: "2026-11-18 23:59", state: "conflict" });
    expect(r.caseFile.fields.applyDeadline.alternatives.map((x) => x.value)).toEqual(["2026-11-20 23:59"]);
    expect(r.unresolved[0].field).toBe("applyDeadline");
  });

  it("不足は他の候補から補う。当選発表の期間（終了日）は、開始日だけの候補で消さない", () => {
    const r = integrateCandidates([
      inp("a", { ...BASE, resultStart: ["2026-11-16", "inferred", SUMMARY] }),
      inp("b", { ...BASE, resultStart: ["2026-11-16", "inferred", BODY], resultEnd: ["2026-11-21", "inferred", BODY], applyStart: ["2026-11-11", "inferred", BODY] }),
    ]);
    expect(r.caseFile.fields.resultEnd.value).toBe("2026-11-21");
    expect(r.caseFile.fields.applyStart.value).toBe("2026-11-11");
    expect(r.adoptions.find((a) => a.field === "applyStart")!.from).toEqual(["候補b"]);
  });

  it("商品は装飾の少ない短い名前に（MEGA 拡張パック ○○（シュリンクなし）→ ○○）。系列は短い表記に", () => {
    const r = integrateCandidates([inp("a", { chain: "イトーヨーカドーネット通販", items: "MEGA 拡張パック ハドウシーカー(シュリンクなし)", applyDeadline: "2026-11-15" }), inp("b", { chain: "イトーヨーカドー", items: "ハドウシーカー", applyDeadline: "2026-11-15" })]);
    expect(r.caseFile.fields.items.value).toBe("ハドウシーカー");
    expect(r.caseFile.fields.chain.value).toBe("イトーヨーカドー");
  });
});

describe("詳細な応募条件を短い文章に置き換えない", () => {
  const LONG = "Xアカウントの所持が必要。アカウントをフォロー＆対象ツイートのリポストで応募。当選時にDMを受け取れる設定が必要。お一人様上限1BOXまで";
  it("確定した短い記載を含むより詳しい文面があれば、詳しい方を採用する（確定ではなく推定に下げる）", () => {
    const r = integrateCandidates([inp("a", { ...BASE, conditions: [LONG, "inferred", SUMMARY] }), inp("b", { ...BASE, conditions: ["Xアカウントの所持が必要", "confirmed", PRIMARY] })]);
    expect(r.caseFile.fields.conditions.value).toBe(LONG);
    expect(r.caseFile.fields.conditions.state).toBe("inferred");
    expect(r.adoptions.find((a) => a.field === "conditions")!.reason).toContain("より詳しい記載");
  });
});

describe("誤統合の防止: 別の店舗の独立した抽選・別の応募期間・別の系列・別の商品は混ぜない", () => {
  const sap: Spec = { chain: "カードラボ", store: ["札幌店", "inferred", SUMMARY], items: "ハドウシーカー", applyDeadline: "2026-11-08", applyStart: ["2026-11-04", "inferred", SUMMARY] };
  const nam: Spec = { chain: "カードラボ", store: ["なんば店", "inferred", SUMMARY], items: "ハドウシーカー", applyDeadline: "2026-11-15", applyStart: ["2026-11-13", "inferred", SUMMARY] };
  it("特定の店舗どうしが違い、店舗選択式の根拠がなければ、別の抽選として統合しない（札幌店・なんば店）", () => {
    const r = integrateCandidates([inp("a", nam), inp("b", sap)]);
    expect(r.members.map((m) => m.id)).toEqual(["a"]);
    expect(r.excluded[0].id).toBe("b");
    expect(r.caseFile.fields.applyStart.value).toBe("2026-11-13");
    expect(r.caseFile.fields.store.value).toBe("なんば店");
  });
  it("応募期間が大きく違う（別の回）・系列が違う・商品が違うものは統合しない", () => {
    const r = integrateCandidates([inp("a", BASE), inp("b", { ...BASE, applyDeadline: "2026-12-20 23:59" }), inp("c", { ...BASE, chain: "別の店" }), inp("d", { ...BASE, items: "ニンジャスピナー" })]);
    expect(r.members.map((m) => m.id)).toEqual(["a"]);
    expect(r.excluded.map((x) => x.id).sort()).toEqual(["b", "c", "d"]);
  });
  it("同じ系列・商品・締切でも、店舗が不明な基準に、特定の店舗の告知は統合しない（保留）", () => {
    const r = integrateCandidates([inp("a", { chain: "カードラボ", items: "ハドウシーカー", applyDeadline: "2026-11-15 23:59" }), inp("b", nam)]);
    expect(r.members).toHaveLength(1);
    expect(r.excluded[0].verdict).toBe("unknown");
  });
  it("店舗をまたぐ応募制限の記載がある同じ企画の店舗別の告知（キデイランド）は、店舗選択式の1件として統合する。店舗は選べる店舗に入る", () => {
    const cond = "同販売期間にキデイランド複数店舗より同商品の案内があった場合、重複応募は無効とさせていただきます。";
    const r = integrateCandidates([
      inp("a", { chain: "キデイランド", store: ["二子玉川店", "inferred", SUMMARY], items: "スペシャルデッキセットMEGA", applyDeadline: "2026-11-04 23:59", conditions: [cond, "inferred", BODY] }),
      inp("b", { chain: "キデイランド", store: ["吉祥寺店", "inferred", SUMMARY], items: "スペシャルデッキセットMEGA", applyDeadline: "2026-11-04 23:59", conditions: [cond, "inferred", BODY] }),
    ]);
    expect(r.members).toHaveLength(2);
    expect(r.caseFile.fields.form.value).toBe("store_select");
    expect(r.caseFile.fields.store.value).toBeNull();
    expect(r.caseFile.fields.selectableStores.value?.split(" / ").sort()).toEqual(["二子玉川店", "吉祥寺店"]);
    expect(r.caseFile.fields.receiveMethod).toMatchObject({ value: "store", state: "inferred" }); // 人間の評価の傾向からの推定（確定ではない）
  });
});

describe("店舗選択式（フルコンプ型）: 構造の根拠のある候補の判断が、店舗を1つ書いた候補より優先される", () => {
  it("店舗選択式の根拠がある候補と、店舗名を持つ候補を統合しても、店舗選択式・選べる店舗が保持され、店舗の値にならない", () => {
    const form: [string, CaseFieldState, EvidenceRef] = ["store_select", "inferred", { ...BODY, quote: "店舗選択欄から1店舗を選択" }];
    const r = integrateCandidates([
      inp("x", { ...BASE, store: ["フルコンプ横浜店", "inferred", SUMMARY] }),
      inp("lp", { ...BASE, form, selectableStores: ["フルコンプ横浜店 / フルコンプ秋葉原店 / フルコンプ渋谷東口店", "inferred", BODY] }),
    ]);
    expect(r.caseFile.fields.form.value).toBe("store_select");
    expect(r.caseFile.fields.store.value).toBeNull();
    expect(r.caseFile.fields.selectableStores.value?.split(" / ")).toEqual(expect.arrayContaining(["フルコンプ横浜店", "フルコンプ秋葉原店", "フルコンプ渋谷東口店"]));
    const st = r.adoptions.find((a) => a.field === "store")!;
    expect(st.rejected[0]).toMatchObject({ value: "フルコンプ横浜店", reason: expect.stringContaining("選べる店舗の1つ") });
  });
});

describe("人間が確定した項目の保護・再現性", () => {
  it("人間が確定した項目は、より根拠の強い候補があっても上書きしない（不採用の理由を記録）", () => {
    const r = integrateCandidates([inp("a", { ...BASE, applyDeadline: ["2026-11-14 23:59", "manual"] }, ["applyDeadline"]), inp("b", { ...BASE, applyDeadline: ["2026-11-15 11:59", "confirmed", PRIMARY] })], { humanLocked: ["applyDeadline"] });
    expect(r.caseFile.fields.applyDeadline.value).toBe("2026-11-14 23:59");
    expect(r.adoptions.find((a) => a.field === "applyDeadline")!.rejected[0].reason).toContain("人間が確定");
  });
  it("同じ入力から同じ結果（再現可能）。基準以外の候補の並びで結果が変わらない", () => {
    const a = inp("a", { ...BASE, applyStart: ["2026-11-11", "inferred", BODY] });
    const b = inp("b", { ...BASE, resultStart: ["2026-11-16", "inferred", BODY] });
    const c = inp("c", { ...BASE, conditions: ["会員登録が必要", "inferred", SUMMARY] });
    const r1 = integrateCandidates([a, b, c]);
    const r2 = integrateCandidates([a, c, b]);
    expect(JSON.stringify(r1.caseFile.fields)).toBe(JSON.stringify(r2.caseFile.fields));
    expect(JSON.stringify(integrateCandidates([a, b, c]).adoptions)).toBe(JSON.stringify(r1.adoptions));
  });
});

describe("店舗が一方の候補だけで分かっているとき（逆向き）も、別の店舗の抽選として統合しない", () => {
  it("特定の店舗（大阪日本橋店）の基準に、店舗が不明な候補（同じ系列・商品・締切）は統合しない。店舗選択式どうし・店舗がどちらも不明な候補は統合する", () => {
    const known: Spec = { chain: "カードラボ", store: ["大阪日本橋店", "inferred", SUMMARY], items: "ハドウシーカー", applyDeadline: "2026-11-15" };
    const unknown: Spec = { chain: "カードラボ", items: "ハドウシーカー", applyDeadline: "2026-11-15 23:59" };
    const r = integrateCandidates([inp("a", known), inp("b", unknown)]);
    expect(r.members).toHaveLength(1);
    expect(r.excluded[0].reason).toContain("店舗が一方の候補だけ");
    // 店舗がどちらも不明（Xの投稿どうし）は統合する
    expect(integrateCandidates([inp("a", unknown), inp("b", { ...unknown, applyDeadline: "2026-11-15" })]).members).toHaveLength(2);
  });
});
