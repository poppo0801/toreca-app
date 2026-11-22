// @vitest-environment node
/** Stage 10O: 公式発信者の識別・対象条件の段階的解決・登録/更新/確認待ち/除外の判断・AI照合の揺れ対策・ページ抽出の検証。**架空データのみ**（実AI・DB・ネットワークなし）。 */
import { describe, expect, it } from "vitest";
import { applyAdjudicationPolicy, independentEvidenceOk } from "./adjudication-policy";
import { verifyPageFacts, type PageFacts } from "./ai-10o";
import { clusterFacts } from "./cluster";
import { resolveConditions } from "./conditions";
import { decideOpportunity, isExpired } from "./decision";
import { factFromListItem } from "./facts";
import { buildHostUsage, handleOf, hostHistoryVerdict, kindForSource, verifyOfficialPair } from "./official";
import { relateFacts } from "./relate";
import type { SourceFact } from "./types";
import type { ListItemResult } from "../list-discovery";

const NOW = new Date("2099-11-21T03:00:00Z");
const PROD = ["架空TCG 拡張パック「テスト弾」"];
const cond = { prefectures: ["兵庫県", "大阪府", "京都府"], includeOnline: true, productMode: "all" as const };
const item = (no: number, over: Partial<ListItemResult> = {}): ListItemResult => ({ no, groupNo: no, status: "done", verdict: "independent_lottery", mergedInto: null, unit: "one_form_one", chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2099-11-22 23:59", applyStart: null, method: null, rationale: "", quote: "", quoteVerified: true, unresolved: [], issues: [], ...over });
const fact = (id: string, kind: SourceFact["kind"], fields: SourceFact["fields"], extra: Partial<SourceFact> = {}): SourceFact => ({ sourceId: id, kind, fetchedAt: "2099-11-20T00:00:00Z", fields, ...extra });
const ev = { quoteVerified: true, range: null, image: null } as const;
const full = (kind: SourceFact["kind"], id = "s1", over: SourceFact["fields"] = {}): SourceFact => fact(id, kind, { chain: "サンプル書店", store: "梅田店", prefecture: "大阪府", products: PROD, applyDeadline: "2099-11-22 23:59", applyStart: "2099-11-20 10:00", resultDate: "2099-11-25", method: "web", applyUrl: "https://shop.example.com/lottery/20991122001", applyUnit: "one_form_one", ...over }, { evidence: { chain: ev, store: ev, products: ev, applyDeadline: ev, applyStart: ev } });

describe("公式発信者: ドメインとアカウントを別々に、相互リンクの根拠だけで確定する", () => {
  const now = new Date("2099-11-21T00:00:00Z");
  const base = { host: "shop.example.com", siteLinks: ["https://x.com/sample_shop", "https://shop.example.com/about"], siteCheckedAt: "2099-11-10T00:00:00Z", handle: "@Sample_Shop", accountLinks: ["https://shop.example.com/lottery/1"], accountCheckedAt: "2099-11-10T00:00:00Z" };
  it("サイト→アカウント と アカウント→サイト の両方のリンクがあるときだけ official。片側・無し・自己申告は unknown", () => {
    expect(verifyOfficialPair(base, now)).toMatchObject({ status: "official", basis: [{ code: "reciprocal_link" }] });
    expect(verifyOfficialPair({ ...base, accountLinks: ["https://other.example.com/"] }, now)).toMatchObject({ status: "unknown", basis: [{ code: "site_links_account_only" }] });
    expect(verifyOfficialPair({ ...base, siteLinks: ["https://x.com/someone_else"] }, now)).toMatchObject({ status: "unknown", basis: [{ code: "account_links_site_only" }] });
    expect(verifyOfficialPair({ ...base, siteLinks: null, accountLinks: null }, now).status).toBe("unknown");
    expect(verifyOfficialPair({ ...base, handle: null }, now).status).toBe("unknown");
  });
  it("共有サービス（フォーム・チケット・SNS・短縮）のホストは公式サイトの根拠にしない。根拠が古ければ確定せず likely（再確認）", () => {
    for (const host of ["docs.google.com", "livepocket.jp", "x.com", "t.co"]) expect(verifyOfficialPair({ ...base, host }, now)).toMatchObject({ status: "unknown", basis: [{ code: "shared_platform" }] });
    expect(verifyOfficialPair({ ...base, siteCheckedAt: "2090-01-01T00:00:00Z" }, now)).toMatchObject({ status: "likely", basis: [{ code: "stale" }] });
  });
  it("アカウント名の読み取り・履歴による補助（確定しない）", () => {
    expect(handleOf("https://x.com/Sample_Shop/status/123")).toBe("sample_shop");
    expect(handleOf("https://x.com/home")).toBeNull();
    const usage = buildHostUsage([
      { chainKey: "a", urls: ["https://shop.example.com/l/1"] },
      { chainKey: "a", urls: ["https://shop.example.com/l/2"] },
      { chainKey: "a", urls: ["https://docs.google.com/forms/1"] },
      { chainKey: "b", urls: ["https://docs.google.com/forms/2"] },
      { chainKey: "b", urls: ["https://shared.example.com/x"] },
      { chainKey: "a", urls: ["https://shared.example.com/y"] },
    ]);
    expect(hostHistoryVerdict("shop.example.com", usage, "a").status).toBe("likely");
    expect(hostHistoryVerdict("shop.example.com", usage, "b").status).toBe("unknown");
    expect(hostHistoryVerdict("docs.google.com", usage, "a").status).toBe("unknown"); // 共有サービス
    expect(hostHistoryVerdict("shared.example.com", usage, "a").status).toBe("unknown"); // 他の系列でも使われている
  });
  it("公式と確定したものだけが official_* の信頼性になる。公式不明・偽の応募ページは最上位にしない", () => {
    expect(kindForSource("x", { status: "official", basis: [] })).toBe("official_x");
    expect(kindForSource("x", { status: "likely", basis: [] })).toBe("unknown");
    expect(kindForSource("site", { status: "unknown", basis: [] })).toBe("unknown");
    expect(kindForSource("form", null)).toBe("unknown");
    expect(kindForSource("form", null, { linkedFromOfficial: true })).toBe("apply_form");
  });
});

describe("対象条件: 不明の原因別の段階的な解決（出典不明の推測は確定しない・未評価を対象にしない）", () => {
  const o = { chain: "サンプル書店", store: "梅田店", prefecture: null, products: PROD, texts: ["ポケモンカードゲーム 抽選販売"] };
  it("見出しの県名（告知に書かれた都道府県）が、一覧の項目の地域の根拠になる", () => {
    const f = factFromListItem({ candidateId: "c1", parentKey: "p", item: item(1, { store: "サンプル書店 梅田店" }), fetchedAt: null, groupLabel: "《サンプル書店 梅田店（大阪府）- 1件》" })!;
    expect(f.fields.prefecture).toBe("大阪府");
    expect(f.texts).toContain("《サンプル書店 梅田店（大阪府）- 1件》");
  });
  it("店舗マスター → 告知の県名・店舗名の地名の順に地域を解決し、使った段階を記録する", () => {
    const viaMaster = resolveConditions({ ...o, store: "謎の店" }, cond, [], { storeMaster: () => ({ prefecture: "大阪府" }) });
    expect(viaMaster).toMatchObject({ stages: { region: "store_master" }, basis: { region: "eligible" } });
    expect(resolveConditions({ ...o, store: "謎の店", prefecture: "兵庫県" }, cond).stages.region).toBe("stated_prefecture");
    expect(resolveConditions({ ...o, store: "大阪梅田店" }, cond).stages.region).toBe("store_name");
    expect(resolveConditions({ ...o, store: "謎の店", prefecture: "東京都" }, cond)).toMatchObject({ verdict: "ineligible", reasons: expect.arrayContaining(["region_out_of_scope"]) });
  });
  it("地域を特定できない・矛盾する場合は不明のまま（推測しない）。主な不明の原因は1つだけ数える", () => {
    const r = resolveConditions({ ...o, store: "謎の店" }, cond);
    expect(r).toMatchObject({ verdict: "unknown", primaryUnknown: "region_unknown", stages: { region: "none" } });
    const both = resolveConditions({ ...o, store: "謎の店", texts: [], products: ["謎の商品"] }, cond);
    expect(both.primaryUnknown).toBe("tcg_unknown"); // 重複計上しない（複数の原因があっても1つ）
    expect(both.reasons).toEqual(expect.arrayContaining(["tcg_unknown", "region_unknown"]));
  });
  it("TCGの種類: 本文 → 商品マスターへの対応。マスターに無い・文脈が無ければ不明。他TCGは対象外", () => {
    const noText = { ...o, texts: [], products: ["架空の拡張パック"], prefecture: "大阪府" };
    expect(resolveConditions(noText, cond).primaryUnknown).toBe("tcg_unknown");
    expect(resolveConditions(noText, cond, [], { productMaster: (n) => n === "架空の拡張パック" })).toMatchObject({ verdict: "eligible", stages: { tcg: "product_master" } });
    expect(resolveConditions({ ...noText, texts: ["ワンピースカード ブースターパック"] }, cond).reasons).toContain("other_tcg");
  });
  it("商品の絞り込みが有効で、商品マスターでの評価ができない場合は『対象』にしない（不明）", () => {
    const r = resolveConditions({ ...o, prefecture: "大阪府", texts: ["ポケモンカードゲーム 抽選販売"] }, { ...cond, productMode: "include" });
    expect(r).toMatchObject({ verdict: "unknown", primaryUnknown: "product_filter_not_evaluated" });
  });
  it("検証済みのAI補助だけが不明を解消できる。通販は地域に関係なく設定に従う", () => {
    const r = resolveConditions({ ...o, store: "謎の店" }, cond, [], {}, { prefecture: "大阪府" });
    expect(r).toMatchObject({ verdict: "eligible", stages: { region: "ai_assist_verified" } });
    expect(resolveConditions({ ...o, store: "通販", texts: ["ポケモンカードゲーム"] }, { ...cond, includeOnline: false }).reasons).toContain("online_excluded");
  });
});

describe("判断基準: 自動登録（プレビュー）／欠落つき候補／確認待ち／除外／更新提案", () => {
  const elig = { verdict: "eligible" as const, reasons: [], basis: {} };
  const dec = (facts: SourceFact[], over: Partial<Parameters<typeof decideOpportunity>[0]> = {}) => decideOpportunity({ cluster: clusterFacts(facts)[0], facts, eligibility: elig, now: NOW, unresolvedDuplicatePairs: 0, ...over });

  it("対象・出典確認済み・応募単位が明確・重複なし → 自動登録（プレビュー）。非公式の単独の情報源でも同じ", () => {
    expect(dec([full("apply_form")])).toMatchObject({ decision: "auto_register_preview" });
    expect(dec([full("list_item")])).toMatchObject({ decision: "auto_register_preview", reasons: expect.arrayContaining(["single_independent_source"]) });
  });
  it("軽微な項目（受付開始・結果発表）が欠けていても自動登録（プレビュー）。応募先・方法が全く不明なら『欠落を明記した候補』", () => {
    expect(dec([full("list_item", "s1", { applyStart: null, resultDate: null })])).toMatchObject({ decision: "auto_register_preview", reasons: expect.arrayContaining(["minor_gap_applyStart", "minor_gap_resultDate"]) });
    const d = dec([full("list_item", "s1", { applyUrl: null, method: null })]);
    expect(d).toMatchObject({ decision: "candidate_with_gaps", reasons: expect.arrayContaining(["gap_apply_destination"]) });
  });
  it("公式性の有無・情報源の種類によって判断は変わらない（公式性を理由にした保留はゼロ）", () => {
    const kinds: SourceFact["kind"][] = ["official_site", "official_x", "apply_form", "list_item", "aggregator", "unknown", "legacy_extraction"];
    const base = dec([full("list_item")]);
    for (const k of kinds) expect(dec([full(k)]).decision).toBe(base.decision);
    for (const k of kinds) expect(dec([full(k)]).reasons.join()).not.toMatch(/official/);
  });
  it("独立性: 同じ元・同じ転載元の複数記事は1つの根拠。独立した別の情報源は2つ", () => {
    const a = full("list_item", "a");
    const b = { ...full("aggregator", "b"), repostOf: "a" };
    const c = { ...full("list_item", "c"), originId: "cand:x" };
    const d = { ...full("list_item", "d"), originId: "cand:x" };
    expect(dec([{ ...a, repostOf: "a" }, b]).independentSources).toBe(1);
    expect(dec([c, d]).independentSources).toBe(1);
    expect(dec([a, full("official_x", "e")]).independentSources).toBe(2);
  });
  it("過去に訂正・誤報と分かった情報源・年や曜日が曖昧な締切・開始が締切より後は確認待ち。通知に使える締切は明示的に確認されたものだけ", () => {
    expect(dec([full("list_item")], { retractedSources: new Set(["s1"]) }).reasons).toContain("source_previously_corrected");
    expect(dec([full("list_item", "s1", { applyDeadline: "11/22(月)23:59" })]).reasons).toContain("deadline_year_or_weekday_unresolved");
    expect(dec([full("list_item", "s1", { applyStart: "2099-11-23 10:00" })]).reasons).toContain("period_reversed");
    expect(dec([full("list_item")]).notifiable).toBe(true);
    expect(dec([full("list_item", "s1", { applyDeadline: "11/22 23:59" })]).notifiable).toBe(false); // 年が基準日からの推定のみ（曜日も無い）
  });
  it("確認待ち: 対象条件が不明／同一性が曖昧（重複の疑い・AI照合が不安定）／締切が原文で未確認／応募単位も店舗も不明", () => {
    expect(dec([full("apply_form")], { eligibility: { verdict: "unknown", reasons: ["region_unknown"], basis: {} } })).toMatchObject({ decision: "needs_review", reasons: ["region_unknown"] });
    expect(dec([full("apply_form")], { unresolvedDuplicatePairs: 2 }).reasons).toContain("possible_duplicate_unresolved");
    expect(dec([full("apply_form")], { aiUnstable: true }).reasons).toContain("ai_adjudication_unstable");
    const unverified = { ...full("apply_form"), evidence: {} };
    expect(dec([unverified]).reasons).toContain("deadline_not_verified_in_source");
    expect(dec([full("apply_form", "s1", { store: null, applyUnit: "unknown" })]).reasons).toContain("apply_unit_and_store_unknown");
  });
  it("重要項目の矛盾（締切）は確認待ち。軽微な項目の欠落とは区別する", () => {
    const u = ["https://shop.example.com/lottery/20991122001"];
    const a = { ...full("apply_form", "a"), urls: u };
    const b = { ...full("list_item", "b", { applyDeadline: "2099-11-24 23:59" }), urls: u };
    const d = dec([a, b]);
    expect(d.decision).toBe("needs_review");
    expect(d.conflicts).toContain("applyDeadline");
    expect(d.reasons).toContain("conflict_applyDeadline");
  });
  it("除外: 対象外（理由つき）・終了済み・非抽選。除外でも理由が残る（監査可能）", () => {
    expect(dec([full("apply_form")], { eligibility: { verdict: "ineligible", reasons: ["region_out_of_scope"], basis: {} } })).toMatchObject({ decision: "excluded", reasons: ["region_out_of_scope"] });
    expect(dec([full("apply_form", "s1", { applyDeadline: "2099-11-20 23:59" })])).toMatchObject({ decision: "excluded", reasons: ["expired_closed"] });
    expect(dec([full("apply_form")], { isLottery: false })).toMatchObject({ decision: "excluded", reasons: ["not_lottery"] });
    expect(isExpired("11/20(金)22:00", NOW)).toBe(true);
    expect(isExpired("2099-11-22 23:59", NOW)).toBe(false);
  });
  it("既存の登録に結びつくものは新規登録にせず、更新はフィールド別の提案のみ。保護された登録は確認のみ。複数の登録は重複の疑い", () => {
    const reg = fact("reg:1", "registration", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2099-11-22 23:59" }, { registration: { id: "lot-1", protectedCodes: [] } });
    const d = dec([reg, full("official_site", "off")]);
    expect(d.decision).toBe("update_proposals");
    const c = clusterFacts([{ ...reg, registration: { id: "lot-1", protectedCodes: ["applications"] } }, full("official_site", "off")])[0];
    expect(c.proposals.length).toBeGreaterThan(0);
    expect(c.proposals.every((p) => p.op === "ask_human" && p.protected && p.executable === false)).toBe(true);
    const r2 = fact("reg:2", "registration", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2099-11-22 23:59" }, { registration: { id: "lot-2", protectedCodes: [] } });
    expect(dec([reg, r2]).reasons).toContain("possible_duplicate_registration");
  });
});

describe("AI照合の揺れ対策: 全回一致＋独立根拠でも『統合の候補』まで。割れたら保留。決定的な無関係は覆さない", () => {
  const a = fact("a", "list_item", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "11/22(日)23:59" });
  const partial = fact("b", "list_item", { chain: "サンプル書店", store: "サンプル書店 梅田店", products: PROD, applyDeadline: "2099-11-22 23:59" });
  const det = relateFacts(a, partial);
  it("全回が同一で、系列・店舗・商品・締切の独立根拠があれば merge_candidate", () => {
    expect(independentEvidenceOk({ kind: "unknown", score: 0.5, evidence: ["chain_same", "store_partial", "product_same", "deadline_same"], conflicts: [] })).toBe(true);
    expect(independentEvidenceOk({ kind: "unknown", score: 0.5, evidence: ["chain_same", "product_same"], conflicts: [] })).toBe(false);
    const r = applyAdjudicationPolicy({ kind: "unknown", score: 0.5, evidence: ["chain_same", "store_partial", "product_same", "deadline_same"], conflicts: [] }, ["same_opportunity", "same_opportunity"]);
    expect(r).toMatchObject({ outcome: "merge_candidate", stable: true });
    void det;
  });
  it("回ごとに結論が割れたら hold_unstable（多数決で統合しない）。1回だけでは不足。全回が同一でも独立根拠が無ければ保留", () => {
    const u = { kind: "unknown" as const, score: 0.5, evidence: ["chain_same", "store_partial", "product_same", "deadline_same"], conflicts: [] };
    expect(applyAdjudicationPolicy(u, ["same_opportunity", "unknown", "same_opportunity"]).outcome).toBe("hold_unstable");
    expect(applyAdjudicationPolicy(u, ["same_opportunity"]).outcome).toBe("hold_insufficient_evidence");
    expect(applyAdjudicationPolicy({ ...u, evidence: ["chain_same"] }, ["same_opportunity", "same_opportunity"]).outcome).toBe("hold_insufficient_evidence");
    expect(applyAdjudicationPolicy(u, ["independent", "independent"]).outcome).toBe("not_same_ai");
  });
  it("決定的な『無関係・別応募』はAIが同一と言っても覆さない", () => {
    expect(applyAdjudicationPolicy({ kind: "independent", score: 0, evidence: ["chain_different"], conflicts: [] }, ["same_opportunity", "same_opportunity"]).outcome).toBe("deterministic_overrides");
    expect(applyAdjudicationPolicy({ kind: "same_campaign_different_opportunity", score: 0.3, evidence: [], conflicts: [] }, ["same_opportunity", "same_opportunity"]).outcome).toBe("deterministic_overrides");
  });
});

describe("ページ抽出の検証（AIの申告だけで確定しない）と、別の情報源からの補完", () => {
  const page = "抽選応募のご案内 応募受付期間 11月20日(金)10:00〜11月22日(日)23:59 当選発表 11月25日(水) 応募は1つのフォームで受け付けます";
  const facts: PageFacts = { pageKind: "lottery_notice", chain: "サンプル書店", store: "梅田店", products: PROD, dates: { applyStart: { value: "11/20 10:00", quote: "11月20日(金)10:00〜11月22日(日)23:59" }, applyDeadline: { value: "11/22 23:59", quote: "11月20日(金)10:00〜11月22日(日)23:59" }, resultDate: { value: "11/28", quote: "当選発表 11月25日(水)" } }, method: null, applyUnit: "one_form_one", unitQuote: "応募は1つのフォームで受け付けます" };
  it("抜粋が本文に実在し、値の月日が抜粋に含まれるものだけ原文確認済み。抜粋と値が食い違う日付・実在しない抜粋は却下", () => {
    const v = verifyPageFacts(facts, page);
    expect(v.verified).toMatchObject({ applyStart: "11/20 10:00", applyDeadline: "11/22 23:59" });
    expect(v.verified.resultDate).toBeUndefined(); // 値(11/28)が抜粋(11月25日)と食い違う
    expect(v.rejected).toEqual(["resultDate:quote_or_value_unverified"]);
    expect(v.unitVerified).toBe(true);
    const fake = verifyPageFacts({ ...facts, unitQuote: "ページに無い文章をここに書く" }, page);
    expect(fake.unitVerified).toBe(false);
  });
  it("登録の空欄（受付開始・結果発表）を、別の情報源（応募ページ）の原文確認済みの値で補う提案になる。出典・取得日時つき。保護された登録は確認のみ", () => {
    const reg = (codes: string[]) => fact("reg:1", "registration", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2099-11-22 23:59" }, { registration: { id: "lot-1", protectedCodes: codes } });
    const pg = fact("page:1", "apply_form", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "11/22 23:59", applyStart: "11/20 10:00", resultDate: "11/25", applyUnit: "one_form_one" }, { evidence: { applyStart: ev, applyDeadline: ev, resultDate: ev, applyUnit: ev }, urls: ["https://shop.example.com/lottery/20991122001"] });
    const c = clusterFacts([reg([]), pg])[0];
    expect(c.proposals.filter((p) => p.op === "fill_empty").map((p) => p.field).sort()).toEqual(["applyStart", "resultDate"]);
    expect(c.fields.find((f) => f.field === "applyStart")?.candidates[0]).toMatchObject({ sourceId: "page:1", kind: "apply_form", quoteVerified: true });
    expect(c.applyUnit).toMatchObject({ value: "one_form_one", basis: "stated" });
    const p = clusterFacts([reg(["applications"]), pg])[0];
    expect(p.proposals.every((x) => x.op === "ask_human" && x.protected)).toBe(true);
  });
});

describe("実データ評価（10O）で見つかった不具合の回帰テスト", () => {
  it("『通販』など汎用の店舗の値は、実在の店舗名と矛盾にならない（unknown は矛盾ではない）。明確に別の店舗は矛盾のまま", async () => {
    const { resolveCluster } = await import("./resolve");
    const u = ["https://shop.example.com/lottery/20991122001"];
    const reg = fact("reg:1", "registration", { chain: "サンプル書店", store: "通販", products: PROD, applyDeadline: "2099-11-22 23:59" }, { urls: u, registration: { id: "lot-1", protectedCodes: [] } });
    const page = fact("p", "apply_form", { chain: "サンプル書店", store: "オンラインストア", products: PROD, applyDeadline: "11/22 23:59", resultDate: "11/25" }, { urls: u, evidence: { resultDate: ev, applyDeadline: ev } });
    const r = resolveCluster([reg, page]);
    expect(r.fields.find((f) => f.field === "store")?.status).not.toBe("conflict");
    expect(r.proposals.some((p) => p.field === "store")).toBe(false);
    expect(r.proposals.find((p) => p.field === "resultDate")).toMatchObject({ op: "fill_empty" });
    const other = fact("o", "list_item", { chain: "サンプル書店", store: "難波店", products: PROD, applyDeadline: "11/22 23:59" });
    const reg2 = fact("reg:2", "registration", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2099-11-22 23:59" }, { registration: { id: "lot-2", protectedCodes: [] } });
    expect(resolveCluster([reg2, other]).fields.find((f) => f.field === "store")?.status).toBe("conflict");
  });
});
