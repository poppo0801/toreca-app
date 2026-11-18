// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resultToCaseFile } from "@/lib/agent/case-investigator/to-case";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { integrateCandidates, type IntegrationInput } from "./integrate";
import { emptyCase, type CaseFieldKey, type CaseFile, type EvidenceRef } from "./types";

/**
 * Stage 9H-3E: フルコンプ（重点事例）の統合。保存済みの実データ（9F-2の評価セットのAの読み取り3件＋9H-3Dで保存した実AIの調査結果）だけを使う（AIの再実行なし）。
 * 同じ抽選が、LivePocketの候補・Xの投稿2件の計3候補として別々に収集されていた。個別の結果に正解が含まれているだけでは合格にせず、**統合した最終候補**を検証する。
 * 確定してよい範囲: 保存済みの一次に近い情報（LivePocket主催者本文の原文の抜粋）・人間評価（9H-3D: B「正しい」）で裏付けられる項目だけ。
 * backups/ は Git管理外。無い環境ではスキップ。
 */
const SET = "backups/review-sets";
const RUNS = "backups/eval-9h3d/runs";
const have = existsSync(SET) && existsSync(RUNS);

type Extracted = { chain: string | null; store: string | null; products: string[]; applyStart: string | null; applyDeadline: string | null; resultDate: string | null; conditions: string | null; receiveMethod: string | null; applyMethod: string | null };
interface SetCase { caseId: string; source: { url: string }; ai: { extracted: Extracted; evidence: { field: string; quote: string }[] } }

/** 評価セットのAの読み取り（要約値）→ 案件ファイル。情報源の種類から、主催者本文（LivePocket）か二次かを決める */
function fromSummary(c: SetCase): CaseFile {
  const e = c.ai.extracted;
  const lp = c.source.url.includes("livepocket.jp");
  const q = (f: string) => c.ai.evidence.find((x) => x.field === f)?.quote;
  const cf = emptyCase(c.caseId, "2026-11-14T00:00:00Z");
  const put = (k: CaseFieldKey, v: string | null, ef?: string) => {
    if (!v) return;
    const ev: EvidenceRef = { url: c.source.url, kind: lp ? "platform" : "social_other", tier: "secondary", ...(lp ? { basis: "organizer_body" as const } : {}), ...(ef && q(ef) ? { quote: q(ef) } : {}) };
    cf.fields[k] = { value: v, state: "inferred", by: "ai", evidence: [ev], alternatives: [] };
  };
  put("chain", e.chain, "chain");
  put("store", e.store, "store");
  put("items", e.products.join(" / "), "items");
  put("applyStart", e.applyStart, "applyStart");
  put("applyDeadline", e.applyDeadline);
  put("resultStart", e.resultDate, "resultDate");
  put("conditions", e.conditions, "conditions");
  put("receiveMethod", e.receiveMethod);
  put("applyMethod", e.applyMethod, "applyMethod");
  cf.sources.push({ url: c.source.url, kind: lp ? "platform" : "social_other", tier: "secondary", status: "used" });
  return cf;
}

function savedB(caseId: string): { result: CaseInvestigationResult; target: CaseTarget } | null {
  let best: { startedAt: string; result: CaseInvestigationResult; target: CaseTarget } | null = null;
  for (const run of readdirSync(RUNS)) {
    const f = `${RUNS}/${run}/case-${caseId}.json`;
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")) as { variant?: string; startedAt: string; B?: { judgment?: unknown }; investigation: { result: CaseInvestigationResult; target: CaseTarget } | null };
    if (j.investigation && j.B?.judgment && (j.variant ?? "B") === "B" && (!best || j.startedAt > best.startedAt)) best = { startedAt: j.startedAt, ...j.investigation };
  }
  return best;
}

// 評価データ（backups/。Git管理外）が無い環境（CI）では、テストが0件でファイルが失敗扱いにならないよう、スキップ表示を1件置く
it.skipIf(true)("評価データ（backups/）が無い環境ではこのファイルの検証をスキップ", () => {});
if (have) describe("フルコンプ: 複数の候補・調査結果から、1件の完成度の高い最終候補を導く（保存済みの実データ）", () => {
  const sets = readdirSync(SET).filter((f) => f.startsWith("review-set-production")).sort();
  const cases = (JSON.parse(readFileSync(`${SET}/${sets[sets.length - 1]}`, "utf8")) as { cases: SetCase[] }).cases;
  const byId = (id: string) => cases.find((c) => c.caseId === id)!;
  const lpB = savedB("k-1d2511ea");

  const build = (): { inputs: IntegrationInput[]; lp: CaseFile } => {
    const lp = fromSummary(byId("k-1d2511ea"));
    const inv = resultToCaseFile(lpB!.result, lpB!.target, "2026-11-15T07:45:00Z");
    return {
      lp,
      inputs: [
        { id: "0-lp", label: "LivePocketの候補（収集AI）", caseFile: lp },
        { id: "1-inv", label: "調査結果（実AI）", caseFile: inv, sameVerified: true },
        { id: "x1", label: "Xの投稿 pokecachan", caseFile: fromSummary(byId("k-1b76543d")) },
        { id: "x2", label: "Xの投稿 OnchainOutlaw", caseFile: fromSummary(byId("k-d8eb0a9b")) },
      ],
    };
  };

  it("保存データがある", () => {
    expect(lpB).not.toBeNull();
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it("3つの候補＋実AIの調査結果が同一抽選として統合され、1件の最終候補になる（店舗選択式・対象8店舗・応募開始/締切・当選発表の期間）", () => {
    const { inputs } = build();
    const r = integrateCandidates(inputs);
    const f = r.caseFile.fields;
    expect(r.members.map((m) => m.id).sort()).toEqual(["0-lp", "1-inv", "x1", "x2"]);
    expect(r.excluded).toEqual([]);
    expect(f.chain.value).toBe("フルコンプ");
    expect(f.items.value).toBe("ハドウシーカー");
    // 店舗選択式: 根拠は、LivePocket主催者本文の原文（複数店舗への応募は無効＝店舗を選んで1回応募）。店舗の値にはならず、対象8店舗が保持される
    expect(f.form.value).toBe("store_select");
    expect(f.form.evidence[0].quote).toContain("複数店舗へのご応募");
    expect(f.store.value).toBeNull();
    const stores = f.selectableStores.value!.split(" / ");
    expect(stores).toHaveLength(8);
    expect(stores).toEqual(expect.arrayContaining(["フルコンプ横浜店", "フルコンプ秋葉原店", "フルコンプ渋谷東口店", "フルコンプ川崎店", "フルコンプ本厚木店", "フルコンプ池袋店", "フルコンプ秋葉原ラジオ会館店", "フルコンプ千葉店"]));
    // 日時: 応募開始11/11・応募締切は受付表示12:00ではなく主催者本文の11:59・当選発表は期間（11/16〜11/21。開始日だけの候補で期間を消さない）
    expect(f.applyStart.value).toBe("2026-11-11");
    expect(f.applyDeadline.value).toBe("2026-11-15 11:59");
    expect(f.resultStart.value).toBe("2026-11-16");
    expect(f.resultEnd.value).toBe("2026-11-21");
    expect(f.applyDeadline.state).not.toBe("conflict");
    expect(r.unresolved.map((u) => u.field)).not.toContain("applyDeadline");
    // 店舗選択式の店舗受取（人間の評価の傾向。確定ではなく推定）
    expect(f.receiveMethod.value).toBe("store");
  });

  it("応募条件: 詳しい記載を短い記載に置き換えない（最も長い・根拠のある文面を採用し、別の記載は未確認の手がかりとして残す）", () => {
    const { inputs } = build();
    const r = integrateCandidates(inputs);
    const all = inputs.map((i) => i.caseFile.fields.conditions.value).filter((x): x is string => !!x);
    const adopted = r.caseFile.fields.conditions.value!;
    expect(all).toContain(adopted);
    expect(adopted.length).toBeGreaterThanOrEqual(Math.max(...all.map((x) => x.length)) - 40); // 短い記載（Xの要約）では置き換わらない
    expect(adopted).toContain("LivePocket");
    // 採用した値・採用しなかった値の理由が項目ごとに追跡できる
    const a = r.adoptions.find((x) => x.field === "conditions")!;
    expect(a.reason).toBeTruthy();
    expect(r.adoptions.find((x) => x.field === "applyDeadline")!.from.length).toBeGreaterThan(0);
  });

  it("採用の理由を情報源ごとに追跡できる。主催者本文（LivePocket）の根拠が、受付表示や転載のXより優先される", () => {
    const r = integrateCandidates(build().inputs);
    const dl = r.adoptions.find((x) => x.field === "applyDeadline")!;
    expect(dl.reason).toMatch(/一致|主催者本文|根拠が最も強い/);
    const frm = r.adoptions.find((x) => x.field === "form")!;
    expect(frm.from).toContain("調査結果（実AI）");
    expect(r.caseFile.decisions.length).toBeGreaterThan(0);
  });

  it("再現可能: 同じ入力から同じ最終候補。基準以外の候補の並びを変えても同じ", () => {
    const a = build().inputs;
    const r1 = integrateCandidates(a);
    const r2 = integrateCandidates([a[0], a[3], a[1], a[2]]);
    expect(JSON.stringify(r2.caseFile.fields)).toBe(JSON.stringify(r1.caseFile.fields));
  });

  it("誤統合しない: 同じ系列でも別の店舗・別の期間の抽選（カードラボ等）は、フルコンプの最終候補に入らない", () => {
    const { inputs } = build();
    const other: CaseFile = emptyCase("other", "2026-11-14T00:00:00Z");
    other.fields.chain = { value: "フルコンプ", state: "inferred", by: "ai", evidence: [], alternatives: [] };
    other.fields.items = { value: "ニンジャスピナー", state: "inferred", by: "ai", evidence: [], alternatives: [] };
    other.fields.applyDeadline = { value: "2026-12-20 23:59", state: "inferred", by: "ai", evidence: [], alternatives: [] };
    const r = integrateCandidates([...inputs, { id: "z-other", label: "別の抽選", caseFile: other }]);
    expect(r.excluded.map((x) => x.id)).toEqual(["z-other"]);
    expect(r.caseFile.fields.items.value).toBe("ハドウシーカー");
  });
});
