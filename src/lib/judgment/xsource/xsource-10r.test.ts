// @vitest-environment node
/** Stage 10R: ヒントの自由度（採用・反論・無視・再解釈）・未想定の方式・応募先ページ調査の部品・プロンプトの非誘導。架空データのみ（実AI・DB・ネットワークなし）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { candidateApplyUrls, classifyFetchFailure, excerptApplyPage } from "./application-page";
import { UNIT_SYSTEM, renderUnitContext } from "./ai-unit";
import { verifyUnitInference, type UnitContext, type UnitInference } from "./apply-unit";
import { clusterFacts } from "./cluster";
import { decideOpportunity } from "./decision";
import { loadKnowledge, observeTags, selectHints } from "./knowledge/knowledge";
import type { SourceFact } from "./types";

const NOW = new Date("2026-11-22T00:00:00Z");
const PROD = ["架空TCG 拡張パック「テスト弾」"];
const ev = { quoteVerified: true, range: null, image: null } as const;
const fact = (over: SourceFact["fields"] = {}): SourceFact => ({ sourceId: "s1", kind: "list_item", fetchedAt: "2026-11-21T00:00:00Z", fields: { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2026-11-23 23:59", applyUnit: "unknown", applyUrl: "https://shop.example.com/lottery/20261123001", ...over }, evidence: { chain: ev, store: ev, products: ev, applyDeadline: ev }, urls: ["https://shop.example.com/lottery/20261123001"] });
const inf = (over: Partial<UnitInference> = {}): UnitInference => ({ observedFacts: [], hintUse: [], independentApplyCount: null, otherDescription: "", needsInvestigation: false, independentUnit: "unknown", selectableStores: [], storeGroups: [], perProductForm: "unknown", selectionTiming: "unknown", method: "", alternatives: [], evidence: [], confidence: "low", unknowns: [], furtherInvestigation: [], ...over });
const ctxOf = (texts: string[], tags: string[], chain: string | null = "サンプル書店", hosts: string[] = []): UnitContext => ({ texts, chain, stores: [], products: PROD, applyUrlHosts: hosts, formObservations: [], restrictionPhrases: [], storeMasterCompleteness: "unknown", pastExamples: [], hints: selectHints(loadKnowledge(), { chain, hosts, tags }, NOW), observedTags: tags });
const elig = { verdict: "eligible" as const, reasons: [], basis: {} };
const decide = (f: SourceFact, v: ReturnType<typeof verifyUnitInference>) => decideOpportunity({ cluster: clusterFacts([f])[0], facts: [f], eligibility: elig, now: NOW, unresolvedDuplicatePairs: 0, unitInference: v });

describe("ヒントは判断観点: 採用・反論・無視・再解釈のどれでも差し戻さず、結論を誘導しない", () => {
  it("ヒントと異なる結論（反論）・ヒントの無視でも、検証・判断の経路は同じ。ヒントの採否で降格・却下されない", () => {
    const ctx = ctxOf(["各店舗ごとに抽選を行います。応募時に店舗をお選びください"], ["host:livepocket.jp", "store_select_phrase"], null, ["livepocket.jp"]);
    expect(ctx.hints.map((h) => h.entry.id)).toContain("K-PLATFORM-LP-MULTI");
    const quote = { quote: "各店舗ごとに抽選を行います", basis: "direct" as const, knowledgeIds: [], note: "" };
    // LivePocketのヒント（店舗選択式の観点）に反論し、今回の記載から店舗ごとの独立応募と結論
    const rebut = verifyUnitInference(inf({ independentUnit: "per_store", selectionTiming: "at_apply", evidence: [quote], confidence: "high", hintUse: [{ id: "K-PLATFORM-LP-MULTI", use: "rebutted", reason: "今回は各店舗ごとに抽選と明記" }] }), ctx);
    const ignore = verifyUnitInference(inf({ independentUnit: "per_store", selectionTiming: "at_apply", evidence: [quote], confidence: "high", hintUse: [{ id: "K-PLATFORM-LP-MULTI", use: "ignored", reason: "無関係" }] }), ctx);
    const none = verifyUnitInference(inf({ independentUnit: "per_store", selectionTiming: "at_apply", evidence: [quote], confidence: "high" }), ctx);
    expect(rebut.hintUse[0]).toMatchObject({ use: "rebutted" });
    expect(rebut.downgraded).toEqual([]);
    for (const v of [rebut, ignore, none]) expect(decide(fact(), v)).toMatchObject({ decision: "auto_register_preview", unitStatus: "inferred_direct" }); // ヒントの採否は判断に影響しない
  });
  it("ヒントが無くても推論できる（ヒント無しで明確な告知なら直接の根拠で確定）。未確認の前提のヒントは『不明』として渡る", () => {
    const ctx = ctxOf(["応募フォームで受取店舗をお選びください（梅田店・難波店）。応募は1店舗のみ"], []);
    expect(ctx.hints).toEqual([]);
    const v = verifyUnitInference(inf({ independentUnit: "store_select", selectionTiming: "at_apply", evidence: [{ quote: "応募フォームで受取店舗をお選びください", basis: "direct", knowledgeIds: [], note: "" }], confidence: "high" }), ctx);
    expect(decide(fact({ store: null }), v).unitStatus).toBe("inferred_direct");
    const withHint = ctxOf(["各店舗の抽選のご案内"], ["host:livepocket.jp"], null, ["livepocket.jp"]);
    expect(withHint.hints[0].preconditions.every((p) => p.status === "unknown")).toBe(true);
    expect(renderUnitContext(withHint)).toContain("（不明）");
  });
  it("未想定の方式（other）は既存の型に押し込まず、安全な暫定状態（暫定候補）にする。直接の根拠にはならず自動登録されない", () => {
    const ctx = ctxOf(["応募は抽選会場での先着順の整理券（当日抽選）"], []);
    const v = verifyUnitInference(inf({ independentUnit: "other", otherDescription: "当日の整理券で抽選する店頭抽選", selectionTiming: "unknown", confidence: "medium", evidence: [{ quote: "抽選会場での先着順の整理券", basis: "direct", knowledgeIds: [], note: "" }] }), ctx);
    expect(v.independentUnit).toBe("other");
    expect(v.directEvidence).toBe(false); // 'other' の手掛かりは定義しない＝直接の根拠として認めない
    const d = decide(fact(), v);
    expect(d).toMatchObject({ decision: "tentative_candidate", unitStatus: "provisional" });
    expect(d.unitHypothesis).toMatchObject({ unit: "other", otherDescription: "当日の整理券で抽選する店頭抽選" });
  });
  it("プロンプトとヒントデータは結論を強制しない: 『ヒントは規則ではない』『無視・反論してよい』『今回の具体的な情報が優先』を含み、データに結論・重み・スコアのフィールドが無い", () => {
    expect(UNIT_SYSTEM).toContain("ヒントは判断観点であり、結論の推奨でも規則でもありません");
    expect(UNIT_SYSTEM).toContain("無視や反論は問題ありません");
    expect(UNIT_SYSTEM).toContain("今回の具体的な情報が、過去の傾向・ヒントより常に優先");
    expect(UNIT_SYSTEM).toContain("既存の型に当てはまらない方式なら other");
    expect(UNIT_SYSTEM).not.toMatch(/必ず.*(store_select|per_store)|(store_select|per_store).*にしなければ/);
    const raw = readFileSync("src/lib/judgment/xsource/knowledge/apply-unit-knowledge.json", "utf8");
    expect(raw).not.toMatch(/"(suggests|weight|score|priority|unit)"\s*:/);
    for (const e of loadKnowledge().entries) {
      expect(e.perspective, e.id).not.toMatch(/^(必ず|常に)|にする。$|とする。$/);
      expect(e.considerAlso.length + e.falsifiers.length, e.id).toBeGreaterThan(0 - (e.id === "K-GENERAL-VARIANTS" ? 1 : 0)); // 併せて見る可能性または反証条件（一般観点を除く）
    }
  });
  it("無関係なヒントを毎回大量に渡さない: 手掛かりが無ければ0件、あっても最大4件。選んだ理由が付く", () => {
    expect(selectHints(loadKnowledge(), { chain: "無関係な書店", hosts: [], tags: ["store_specific"] }, NOW)).toEqual([]);
    const all = selectHints(loadKnowledge(), { chain: "イトーヨーカドー", hosts: ["livepocket.jp"], tags: observeTags({ texts: ["店頭受取。他店舗への同時応募は無効。当選後に選択。グループA"], stores: [], hosts: ["livepocket.jp"] }) }, NOW);
    expect(all.length).toBeLessThanOrEqual(4);
    expect(all.every((h) => h.reasons.length > 0)).toBe(true);
  });
});

describe("応募先ページ調査の部品: 候補URL・取得失敗の分類・観察の抜粋", () => {
  it("候補は https の公開ページ。X/Twitterの投稿・http・無効は除く。短縮URLは項目自身のリンクだけ（展開して辿る）。具体的なページを先に。最大件数で打ち切る", () => {
    const c = candidateApplyUrls({ itemLinks: ["https://t.co/abc", "http://insecure.example.com/l/20261123001"], parentLinks: ["https://x.com/shop/status/123456789", "https://t.co/def", "https://livepocket.jp/e/abcde", "https://shop.example.com/", "https://livepocket.jp/e/abcde?utm_source=x"], max: 3 });
    expect(c.map((x) => [x.cls, x.scope])).toEqual([["shortener", "item"], ["generic", "parent"], ["generic", "parent"]]);
    expect(c.some((x) => /x\.com|insecure|t\.co\/def/.test(x.url))).toBe(false);
  });
  it("取得失敗の原因を分類する（robots・ログイン・404・タイムアウト・内部/非公開・その他）。取得できなければ未確認として扱う", () => {
    expect(classifyFetchFailure("robots.txt により取得が許可されていません")).toBe("robots");
    expect(classifyFetchFailure("ログインが必要なページです")).toBe("login_required");
    expect(classifyFetchFailure("HTTP 404")).toBe("not_found");
    expect(classifyFetchFailure("取得がタイムアウトしました")).toBe("timeout");
    expect(classifyFetchFailure("内部ネットワークへのアクセスは許可されない")).toBe("private_or_blocked");
    expect(classifyFetchFailure("予期しないエラー")).toBe("other");
  });
  it("ページの観察は、応募単位に関わる手掛かりの行（選択・グループ・回数・制限・受取）だけを、長さを制限して抜き出す。フォームの送信はしない（部品は読み取りのみ）", () => {
    const page = ["トップへ戻る", "応募する店舗を選択してください", "グループA: 梅田店・難波店", "お一人様1回まで", "フッターのリンク", "当選後に受取方法を選択"].join("\n");
    expect(excerptApplyPage(page)).toEqual(["応募する店舗を選択してください", "グループA: 梅田店・難波店", "お一人様1回まで", "当選後に受取方法を選択"]);
    expect(excerptApplyPage(page, 20).length).toBeLessThan(4);
    const src = readFileSync("src/lib/judgment/xsource/application-page.ts", "utf8");
    expect(src).not.toMatch(/fetch\(|\.post\(|submit|XMLHttp|click\(/);
  });
});

import { pageMatchesItem } from "./application-page";
describe("ページと項目の対応: 親投稿のリンク先が別の店舗のページなら、この項目の根拠にしない", () => {
  const page = { head: "【ポケカ商品抽選販売/架空高槻トレカ館】", lines: ["当店店頭にて購入権利を取得できます", "お一人様1回まで応募が可能です"] };
  it("店舗名が現れれば店舗の対応。別の店舗の項目は scope_mismatch。店舗が不明な項目は、系列名があるときだけ系列レベル", () => {
    expect(pageMatchesItem(page, { store: "架空高槻トレカ館", chain: "架空" })).toBe("store_match");
    expect(pageMatchesItem(page, { store: "架空日本橋店", chain: "別の系列" })).toBe("scope_mismatch");
    expect(pageMatchesItem(page, { store: "架空日本橋店", chain: "架空高槻" })).toBe("scope_mismatch"); // 店舗が違えば系列名が現れても対応とは認めない
    expect(pageMatchesItem(page, { store: null, chain: "架空高槻トレカ館" })).toBe("chain_only");
    expect(pageMatchesItem(page, { store: null, chain: null })).toBe("scope_mismatch");
  });
});
