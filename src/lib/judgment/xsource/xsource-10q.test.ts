// @vitest-environment node
/** Stage 10Q: 応募単位のAI推論（参考知識・検証・暫定候補・受取タイミング・例外）。架空データのみ（実AI・DB・ネットワークなし）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRestrictionPhrases, summarizePastExamples, unitKnownByInference, verifyUnitInference, type UnitContext, type UnitInference } from "./apply-unit";
import { renderUnitContext, UNIT_SYSTEM } from "./ai-unit";
import { clusterFacts } from "./cluster";
import { decideOpportunity } from "./decision";
import { addCorrection, effectiveEntries, loadKnowledge, observeTags, selectHints, validateKnowledge } from "./knowledge/knowledge";
import type { SourceFact } from "./types";

const NOW = new Date("2026-11-22T00:00:00Z");
const PROD = ["架空TCG 拡張パック「テスト弾」"];
const ev = { quoteVerified: true, range: null, image: null } as const;
const elig = { verdict: "eligible" as const, reasons: [], basis: {} };
const fact = (over: SourceFact["fields"] = {}, extra: Partial<SourceFact> = {}): SourceFact => ({ sourceId: "s1", kind: "list_item", fetchedAt: "2026-11-21T00:00:00Z", fields: { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2026-11-23 23:59", applyUnit: "unknown", applyUrl: "https://shop.example.com/lottery/20261123001", ...over }, evidence: { chain: ev, store: ev, products: ev, applyDeadline: ev }, urls: ["https://shop.example.com/lottery/20261123001"], ...extra });
const inf = (over: Partial<UnitInference> = {}): UnitInference => ({ observedFacts: [], hintUse: [], independentApplyCount: null, otherDescription: "", needsInvestigation: false, independentUnit: "unknown", selectableStores: [], storeGroups: [], perProductForm: "unknown", selectionTiming: "unknown", method: "", alternatives: [], evidence: [], confidence: "medium", unknowns: [], furtherInvestigation: [], ...over });
const baseCtx = (over: Partial<UnitContext> = {}): UnitContext => ({ texts: ["応募する店舗を選択してください（梅田店・難波店）。他店舗への同時応募は無効となります"], chain: "サンプル書店", stores: [], products: PROD, applyUrlHosts: [], formObservations: [], restrictionPhrases: [], storeMasterCompleteness: "unknown", pastExamples: [], hints: [], observedTags: [], ...over });
const decide = (f: SourceFact, unitInference: ReturnType<typeof verifyUnitInference> | null, o: Partial<Parameters<typeof decideOpportunity>[0]> = {}) => decideOpportunity({ cluster: clusterFacts([f])[0], facts: [f], eligibility: elig, now: NOW, unresolvedDuplicatePairs: 0, unitInference, ...o });

describe("ヒントストア: 判断観点のデータであり、結論の推奨・固定ルールではない", () => {
  const store = loadKnowledge();
  const ids = (ctx: Parameters<typeof selectHints>[1], now = NOW) => selectHints(store, ctx, now).map((h) => h.entry.id);
  it("メタデータ（出典・確認状態・適用対象・前提・反例・反証条件・区別する確認・更新日）を持ち、整合している。結論フィールド（suggests）を持たない", () => {
    expect(validateKnowledge(store)).toEqual([]);
    for (const e of store.entries) {
      expect(e.provenance).toMatchObject({ source: "ユーザー提供の運用知識", confirmation: "user_provided", aiGenerated: false });
      expect(e.perspective.length).toBeGreaterThan(10);
      expect("suggests" in e).toBe(false);
    }
    expect(store.entries.find((e) => e.id === "K-EVENT-ITOYOKADO-GROUPS")?.kind).toBe("event_example");
    expect(store.entries.find((e) => e.id === "K-PLATFORM-LP-MULTI")?.counterexamples).toContain("K-EVENT-ITOYOKADO-GROUPS");
    expect(validateKnowledge({ ...store, entries: [{ ...store.entries[0], suggests: { unit: "store_select" } } as never] })).toContain("conclusion_field_not_allowed:K-PLATFORM-LP-MULTI");
  });
  it("選択は関連するものだけを少数（既定4件以下）。ホスト・系列の別名（表記揺れ）・システム・観察タグが一致したもの。無関係な一般知識は渡さない", () => {
    expect(ids({ chain: null, hosts: ["livepocket.jp"], tags: [] })).toContain("K-PLATFORM-LP-MULTI");
    expect(ids({ chain: null, hosts: ["www.livepocket.jp"], tags: [] })).toContain("K-PLATFORM-LP-MULTI");
    expect(ids({ chain: "イトーヨーカドー 〇〇店", hosts: [], tags: [] })).toContain("K-EVENT-ITOYOKADO-GROUPS");
    expect(ids({ chain: "ドラゴンスター", hosts: [], tags: [] })).toContain("K-SYSTEM-DORASTA-INDEPENDENT");
    expect(ids({ chain: "ヨドバシカメラ", hosts: [], tags: ["after_win_phrase"] })).toContain("K-CHAIN-YODOBASHI-AFTERWIN");
    expect(ids({ chain: "無関係な書店", hosts: ["shop.example.com"], tags: [] })).toEqual([]); // 手掛かりが無ければ何も渡さない
    expect(ids({ chain: "無関係な書店", hosts: ["shop.example.com"], tags: ["pickup_in_store", "store_unspecified"] })).toEqual(["K-HEURISTIC-MULTISTORE-PICKUP"]);
    expect(ids({ chain: "無関係な書店", hosts: [], tags: ["cross_store_phrase"] })).toEqual(["K-RULE-NO-CROSS-STORE"]);
    const many = selectHints(store, { chain: "イトーヨーカドー", hosts: ["livepocket.jp"], tags: ["group_phrase", "cross_store_phrase", "pickup_in_store", "store_unspecified", "after_win_phrase", "multi_product_phrase"] }, NOW);
    expect(many.length).toBeLessThanOrEqual(4);
    expect(ids({ chain: "ヨドバシ", hosts: [], tags: ["after_win_phrase"] }, new Date("2030-01-01T00:00:00Z"))).toEqual([]); // 期限切れ
  });
  it("適用の前提は『確認できた(met)』か『不明(unknown)』だけ。観察されていない前提を事実扱いしない。選んだ理由を記録する", () => {
    const h = selectHints(store, { chain: null, hosts: ["livepocket.jp"], tags: ["host:livepocket.jp"] }, NOW)[0];
    expect(h.entry.id).toBe("K-PLATFORM-LP-MULTI");
    expect(h.preconditions).toEqual([{ id: "store_options_visible", text: expect.any(String), status: "unknown" }]);
    expect(h.reasons).toEqual(["応募先のホストが適用対象"]);
    const h2 = selectHints(store, { chain: null, hosts: ["livepocket.jp"], tags: ["store_options_visible"] }, NOW)[0];
    expect(h2.preconditions[0].status).toBe("met");
  });
  it("観察タグは文面・構造の観察であり結論ではない（店舗受取・他店舗の記載・当選後・グループ・店舗未特定・店舗選択肢）", () => {
    expect(observeTags({ texts: ["店頭受取のみ。他店舗への同時応募は無効。当選後に受取店舗を選択。グループAとグループB"], stores: [], hosts: ["www.livepocket.jp"], storeOptionCount: 3 })).toEqual(expect.arrayContaining(["pickup_in_store", "cross_store_phrase", "after_win_phrase", "group_phrase", "store_unspecified", "store_options_visible", "host:livepocket.jp"]));
    expect(observeTags({ texts: ["抽選販売のお知らせ"], stores: ["梅田店"], hosts: [] })).toEqual(["store_specific"]);
  });
  it("人の訂正だけが蓄積される: AI名義・理由なし・不明なIDは拒否。無効化・反例・反証条件の追記が反映される（絶対ルールにはしない）", () => {
    const base = { knowledgeId: "K-PLATFORM-LP-MULTI", reason: "実際は店舗ごとに応募できた", at: "2026-11-22", action: "invalidate" as const, detail: "" };
    expect(addCorrection(store, { ...base, by: "AI" })).toEqual({ ok: false, reason: "reviewer_must_be_human" });
    expect(addCorrection(store, { ...base, by: "claude-auto" }).ok).toBe(false);
    expect(addCorrection(store, { ...base, by: "山田", reason: " " })).toEqual({ ok: false, reason: "reason_required" });
    expect(addCorrection(store, { ...base, by: "山田", knowledgeId: "K-NONE" })).toEqual({ ok: false, reason: "unknown_knowledge_id" });
    const ok = addCorrection(store, { ...base, by: "山田" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(effectiveEntries(ok.store, NOW).some((e) => e.id === "K-PLATFORM-LP-MULTI")).toBe(false);
    const ex = addCorrection(store, { ...base, by: "山田", action: "add_exception", detail: "グループ制の開催あり" });
    if (ex.ok) expect(effectiveEntries(ex.store, NOW).find((e) => e.id === "K-PLATFORM-LP-MULTI")?.falsifiers).toContain("（人の訂正）グループ制の開催あり");
  });
  it("コードに系列名・プラットフォーム名の絶対判定を埋め込まない（静的検査）", () => {
    for (const f of ["apply-unit.ts", "ai-unit.ts", "decision.ts", "knowledge/knowledge.ts"]) {
      const src = readFileSync(`src/lib/judgment/xsource/${f}`, "utf8");
      expect(src, f).not.toMatch(/イトーヨーカドー|ヨドバシ|ドラスタ|竜のしっぽ|livepocket\.jp/);
      expect(src, f).not.toMatch(/chain\s*===|chain\s*==\s*["']/);
    }
  });
});

describe("AI出力の機械検証: 直接の根拠の実在・参照IDの妥当性・確信度の上限", () => {
  const ctx = baseCtx();
  it("直接の根拠の抜粋が文脈に実在すれば直接。実在しなければ類推へ降格", () => {
    const ok = verifyUnitInference(inf({ independentUnit: "store_select", evidence: [{ quote: "他店舗への同時応募は無効となります", basis: "direct", knowledgeIds: [], note: "" }], confidence: "high" }), ctx);
    expect(ok).toMatchObject({ directEvidence: true, confidence: "high" });
    const fake = verifyUnitInference(inf({ independentUnit: "store_select", evidence: [{ quote: "文脈に存在しない文章をここに書く", basis: "direct", knowledgeIds: [], note: "" }], confidence: "high" }), ctx);
    expect(fake).toMatchObject({ directEvidence: false, confidence: "medium" });
    expect(fake.downgraded).toEqual(expect.arrayContaining(["direct_quote_not_found", "confidence_capped_no_direct_evidence"]));
    expect(fake.evidence[0].basis).toBe("analogy");
  });
  it("実在する抜粋でも、主張した単位の手掛かりが無ければ直接の根拠にしない（無関係な文の引用で『直接』にならない）。根拠のないタイミングの主張は unknown", () => {
    const ctx2 = baseCtx({ texts: ["架空1号店 拡張パック「テスト弾」抽選販売のお知らせ。応募期間 11/22〜11/24"] });
    const v = verifyUnitInference(inf({ independentUnit: "per_store", selectionTiming: "at_apply", evidence: [{ quote: "拡張パック「テスト弾」抽選販売のお知らせ", basis: "direct", knowledgeIds: [], note: "" }], confidence: "high" }), ctx2);
    expect(v).toMatchObject({ directEvidence: false, confidence: "medium", selectionTiming: "unknown" });
    expect(v.downgraded).toEqual(expect.arrayContaining(["direct_quote_lacks_unit_cue", "timing_without_textual_cue"]));
    // 手掛かりがあれば直接
    const ctx3 = baseCtx({ texts: ["各店舗ごとに抽選を行います。応募時に店舗をお選びください"] });
    expect(verifyUnitInference(inf({ independentUnit: "per_store", selectionTiming: "at_apply", evidence: [{ quote: "各店舗ごとに抽選を行います", basis: "direct", knowledgeIds: [], note: "" }] }), ctx3)).toMatchObject({ directEvidence: true, selectionTiming: "at_apply" });
  });
  it("渡していない参考知識IDは除去。根拠が無ければ確信度は low。未定義の単位は unknown", () => {
    const v = verifyUnitInference(inf({ independentUnit: "per_store", evidence: [{ quote: "", basis: "analogy", knowledgeIds: ["K-SYSTEM-DORASTA-INDEPENDENT", "K-INVENTED"], note: "" }], hintUse: [{ id: "K-SYSTEM-DORASTA-INDEPENDENT", use: "ignored", reason: "今回は無関係" }, { id: "K-INVENTED", use: "adopted", reason: "" }] }), baseCtx({ hints: selectHints(loadKnowledge(), { chain: "ドラゴンスター", hosts: [], tags: [] }, NOW) }));
    expect(v.evidence[0].knowledgeIds).toEqual(["K-SYSTEM-DORASTA-INDEPENDENT"]);
    expect(v.downgraded).toContain("unknown_knowledge_id_removed");
    expect(v.hintUse.map((h) => h.id)).toEqual(["K-SYSTEM-DORASTA-INDEPENDENT"]); // 無視は許される（残る・降格されない）
    expect(verifyUnitInference(inf({ independentUnit: "per_store", confidence: "high" }), ctx).confidence).toBe("low");
    expect(verifyUnitInference(inf({ independentUnit: "nonsense" as never }), ctx)).toMatchObject({ independentUnit: "unknown" });
  });
  it("当選後の受取先選択（ヨドバシ型）は管理上は店舗選択式だが、応募時の選択必須とは表示しない。応募時の選択なら表示してよい", () => {
    const after = verifyUnitInference(inf({ independentUnit: "store_select", selectionTiming: "after_win" }), ctx);
    expect(after).toMatchObject({ appManagedUnit: "store_select", displayStoreSelectAtApply: false });
    const at = verifyUnitInference(inf({ independentUnit: "store_select", selectionTiming: "at_apply" }), ctx);
    expect(at.displayStoreSelectAtApply).toBe(true);
    expect(verifyUnitInference(inf({ independentUnit: "store_select", selectionTiming: "unknown" }), ctx).displayStoreSelectAtApply).toBe(false);
  });
  it("文脈の組み立て: 店舗マスターの網羅性は『不明』。過去の実例は人が確定したものと分ける。制限の文言を抜き出す。個人情報・履歴の項目を持たない", () => {
    const past = summarizePastExamples([{ chainMatch: true, storeMode: "select_on_apply", lotteryForm: "store_select", humanConfirmed: true }, { chainMatch: true, storeMode: "fixed", lotteryForm: null, humanConfirmed: false }, { chainMatch: false, storeMode: "fixed", lotteryForm: null, humanConfirmed: true }]);
    expect(past.map((p) => [p.id, p.humanConfirmed])).toEqual([["PAST-CHAIN-CONFIRMED", true], ["PAST-CHAIN-UNCONFIRMED", false]]);
    expect(extractRestrictionPhrases(["他店舗へ同時応募すると落選となります。グループAは11/22まで"])).toEqual(expect.arrayContaining([expect.stringContaining("他店舗")]));
    const text = renderUnitContext(baseCtx({ pastExamples: past }));
    expect(text).toContain("店舗マスターの網羅性】不明");
    expect(text).toContain("人の確認なし");
    expect(text).not.toMatch(/応募履歴|当選履歴|購入履歴|メール|電話|住所/);
    expect(UNIT_SYSTEM).toContain("今回の具体的な情報が、過去の傾向・ヒントより常に優先");
    expect(UNIT_SYSTEM).toContain("禁止の記載が見つからない");
  });
});

describe("判断への組み込み: 推論の確からしさに応じて 自動登録／暫定候補／確認待ち（応募単位だけで止めない）", () => {
  const verified = (i: Partial<UnitInference>, ctx = baseCtx()) => verifyUnitInference(inf(i), ctx);
  const direct = { quote: "応募する店舗を選択してください", basis: "direct" as const, knowledgeIds: ["K-PLATFORM-LP-MULTI"], note: "" };
  it("【LivePocket型】複数店舗が選択肢で、直接の根拠がある → 応募単位は推論で確定し、店舗が1つに決まらなくても自動登録（プレビュー）", () => {
    const v = verified({ independentUnit: "store_select", selectionTiming: "at_apply", selectableStores: ["梅田店", "難波店"], evidence: [direct], confidence: "high" });
    expect(unitKnownByInference(v)).toBe(true);
    const d = decide(fact({ store: null }), v);
    expect(d).toMatchObject({ decision: "auto_register_preview", unitStatus: "inferred_direct" });
  });
  it("【イトーヨーカドー型の例外】店舗グループごとに独立して応募できる（直接の根拠: グループの記載）→ per_store_group として確定。同じプラットフォームでも一括りにしない", () => {
    const ctx = baseCtx({ texts: ["グループA（梅田・難波）／グループB（京橋・天王寺）ごとに1回ずつ応募できます"] });
    const v = verifyUnitInference(inf({ independentUnit: "per_store_group", storeGroups: ["A", "B"], selectionTiming: "at_apply", evidence: [{ quote: "グループA（梅田・難波）／グループB（京橋・天王寺）ごとに1回ずつ応募できます", basis: "direct", knowledgeIds: ["K-EVENT-ITOYOKADO-GROUPS"], note: "" }], confidence: "high", alternatives: [{ unit: "store_select", why: "LivePocketの傾向" }] }), ctx);
    expect(v.directEvidence).toBe(true);
    expect(v.independentUnit).toBe("per_store_group");
    expect(decide(fact({ store: null }), v).decision).toBe("auto_register_preview");
  });
  it("【ドラスタ型】明記は無く、系列の傾向（類推）だけ → 暫定候補（未確定の応募方式を明記）。自動登録にしない。応募単位だけを理由に確認待ちにもしない", () => {
    const v = verified({ independentUnit: "per_store", selectionTiming: "at_apply", evidence: [{ quote: "", basis: "analogy", knowledgeIds: ["K-SYSTEM-DORASTA-INDEPENDENT"], note: "同じ抽選システムの傾向" }], confidence: "medium", alternatives: [{ unit: "store_select", why: "禁止の記載が無いだけでは独立応募の証明にならない" }], unknowns: ["応募ページ未取得"], furtherInvestigation: ["応募ページの店舗選択肢を確認"] });
    const d = decide(fact(), v);
    expect(d).toMatchObject({ decision: "tentative_candidate", unitStatus: "provisional" });
    expect(d.reasons).toEqual(expect.arrayContaining(["unit_hypothesis_per_store", "selection_timing_at_apply", "alt_store_select"]));
    expect(d.unitHypothesis).toMatchObject({ unit: "per_store", alternatives: ["store_select"], furtherInvestigation: ["応募ページの店舗選択肢を確認"] });
  });
  it("【他店舗応募禁止の記載】直接の根拠として最優先され、店舗別の独立応募の傾向（類推）より優先される", () => {
    const ctx = baseCtx({ texts: ["他店舗へ同時に応募すると全て落選となります。応募店舗を選択"] });
    const v = verifyUnitInference(inf({ independentUnit: "store_select", evidence: [{ quote: "他店舗へ同時に応募すると全て落選となります", basis: "direct", knowledgeIds: ["K-RULE-NO-CROSS-STORE"], note: "" }, { quote: "", basis: "analogy", knowledgeIds: ["K-SYSTEM-DORASTA-INDEPENDENT"], note: "傾向と食い違うため記載を優先" }], confidence: "high" }), ctx);
    expect(v).toMatchObject({ independentUnit: "store_select", directEvidence: true });
    expect(decide(fact({ store: null }), v).decision).toBe("auto_register_preview");
  });
  it("【店舗受取の多店舗系列・店舗不明】店舗選択式を有力な仮説にするが、直接の根拠が無ければ暫定候補（登録店舗が1つでも単店舗とは推論しない）", () => {
    const v = verified({ independentUnit: "store_select", selectionTiming: "unknown", evidence: [{ quote: "", basis: "analogy", knowledgeIds: ["K-HEURISTIC-MULTISTORE-PICKUP"], note: "" }], confidence: "low", unknowns: ["多店舗であることの補助確認"] });
    const d = decide(fact({ store: null }), v);
    expect(d.decision).toBe("tentative_candidate");
    expect(d.unitHypothesis?.displayStoreSelectAtApply).toBe(false);
  });
  it("【ヨドバシ型】当選後に受取先を選ぶ → 管理上は店舗選択式。応募時の選択必須とは表示しない（displayStoreSelectAtApply=false）", () => {
    const ctx = baseCtx({ texts: ["当選後に店頭受取または配送をお選びいただけます"] });
    const v = verifyUnitInference(inf({ independentUnit: "store_select", selectionTiming: "after_win", evidence: [{ quote: "当選後に店頭受取または配送をお選びいただけます", basis: "direct", knowledgeIds: ["K-CHAIN-YODOBASHI-AFTERWIN"], note: "" }], confidence: "high" }), ctx);
    expect(v).toMatchObject({ appManagedUnit: "store_select", displayStoreSelectAtApply: false, selectionTiming: "after_win" });
    expect(decide(fact({ store: null }), v)).toMatchObject({ decision: "auto_register_preview", unitStatus: "inferred_direct" });
  });
  it("推論が unknown・推論なしなら、従来どおり確認待ち（応募単位不明）。他の条件が止めるときは複合の理由を残す", () => {
    expect(decide(fact(), null).reasons).toContain("apply_unit_unknown");
    expect(decide(fact(), verified({ independentUnit: "unknown" })).reasons).toContain("apply_unit_unknown");
    const prov = verified({ independentUnit: "per_store", evidence: [{ quote: "", basis: "analogy", knowledgeIds: ["K-SYSTEM-DORASTA-INDEPENDENT"], note: "" }] });
    const d = decide(fact(), prov, { eligibility: { verdict: "unknown", reasons: ["region_unknown"], basis: {} } });
    expect(d.decision).toBe("needs_review");
    expect(d.reasons).toEqual(expect.arrayContaining(["region_unknown", "unit_provisional_per_store"])); // 応募単位だけ解消しても他の条件で止まる、が分かる
  });
  it("原文で応募単位が確定していれば、推論より優先（推論は使わない）。確信度の自己申告だけでは自動登録にならない", () => {
    const explicit = fact({ applyUnit: "per_store" }, { evidence: { chain: ev, store: ev, products: ev, applyDeadline: ev, applyUnit: ev } });
    const v = verified({ independentUnit: "store_select", evidence: [direct], confidence: "high" });
    expect(decide(explicit, v)).toMatchObject({ decision: "auto_register_preview", unitStatus: "explicit" });
    const onlyConf = verified({ independentUnit: "per_store", confidence: "high" }); // 根拠なし
    expect(decide(fact(), onlyConf).decision).not.toBe("auto_register_preview");
  });
  it("再現性: 同じ検証済みの推論と入力なら、判断は常に同じ。店舗別と店舗選択を取り違えて統合・分割しない（クラスタは変えない）", () => {
    const v = verified({ independentUnit: "per_store", evidence: [{ quote: "", basis: "analogy", knowledgeIds: ["K-SYSTEM-DORASTA-INDEPENDENT"], note: "" }] });
    const a = decide(fact(), v);
    for (let i = 0; i < 5; i++) expect(decide(fact(), v)).toEqual(a);
    const f1 = fact({ store: "梅田店" }, { sourceId: "a" });
    const f2 = fact({ store: "難波店" }, { sourceId: "b" });
    expect(clusterFacts([f1, f2]).length).toBe(2); // 応募単位の仮説でクラスタを自動統合しない
  });
});
