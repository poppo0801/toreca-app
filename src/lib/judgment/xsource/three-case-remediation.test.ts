// @vitest-environment node
/**
 * Phase 3 THREE_CASE_REMEDIATION: 初回3件の保留原因の、匿名化した再現（架空の店名・ページ。構造だけを本番の実証拠に合わせる）。
 *  案1: 複数店舗選択式の抽選ページ。AIの店舗の値が「要約」で、引用（見出し）と対応せず自己修正が効かなかった
 *  案3: 通販の商品ページ。<title> が「商品名 | サイト名」で、本文に無いサイト名の接尾辞が「本文欠落」と誤判定され、検証が全項目で止まった
 *  案2: 地域外の店舗限定の抽選。地域外を理由とする除外を検証できる経路が無かった
 * 特定の案件・店舗に固有の分岐は無い。検証層の基準は緩めていない（欠落は本当に欠けていれば従来どおり保留）。AIの代役は、指摘の文面にある情報だけを使って訂正する（指摘が十分な情報を持つことの確認）。
 */
import { describe, expect, it } from "vitest";
import { CallBudget } from "../call-budget";
import { checkRegionExclusion, checkValueCorrespondence, claimClassOf, prefecturesIn, uncoveredParts } from "./claim-semantics";
import { pageTextChecked, refineTextLoss, titleCore } from "./html-text";
import { runResearch, seedEvidence, type AgentTurnOutput, type FetchOutcome, type JudgeOutput, type RegistrationJudge, type ResearchAgent, type ResearchTools } from "./research-loop";

const NOW = new Date("2026-11-24T21:05:00Z");
const budget = () => new CallBudget({ maxCalls: 30, maxCostJpy: 100 });
const html = (body: string, title = "") => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const textOf = (h: string) => pageTextChecked(h, []).text;
const turn = (next: AgentTurnOutput["next"]): AgentTurnOutput => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], next, costJpy: 0.1 });
const agent = (url: string): ResearchAgent => {
  let i = 0;
  return (async () => (i++ === 0 ? turn({ kind: "fetch", url, why: "取得元ページを確認" }) : turn({ kind: "stop", reason: "sufficient", why: "十分" }))) as unknown as ResearchAgent;
};
const toolsFor = (url: string, page: string, title = ""): ResearchTools => {
  let t = NOW.getTime();
  const h = html(page, title);
  const { text, loss } = pageTextChecked(h, []);
  void loss;
  const out: FetchOutcome = { ok: true, finalUrl: url, html: h, text };
  return { now: () => new Date((t += 1000)), fetchPage: async () => out };
};
const SEED = (text: string) => seedEvidence("s1", text, NOW);
const out = (o: Partial<JudgeOutput>): JudgeOutput => ({ decision: "register", fields: {}, rationale: "r", unresolvedImpact: "none", monitor: { continue: true, why: "w" }, costJpy: 0.1, ...o });

const MULTI_STORE_PAGE = `<h1>チェーンX「商品Z」抽選販売</h1><h2>概要</h2><p>■応募方法：お一人様につき対象店舗の中から１店舗のみご応募が可能です。</p><p>■応募期間：2026年11月24日(火)12：00～11月26日(木)23：59まで</p><p>※複数店舗にご応募された場合は無効となります。</p><h2>受付・チケット情報</h2><p>このイベントは、お1人様1回のみ申込が可能です。</p>`;

describe("案1: 複数店舗選択式。値が要約で引用と対応しない → 指摘が『引用に無い部分』と直し方を具体的に返し、AIが訂正して検証済みの登録案になる", () => {
  const SUMMARY = "チェーンX（関東15店・関東以外13店、受付枠28件。応募は対象店舗から1店舗のみ）";
  const TITLE_QUOTE = "チェーンX「商品Z」抽選販売";
  it("検証の指摘は、値のうち引用に書かれていない部分と直し方を含む（値を null にせよ、だけではない）", () => {
    expect(checkValueCorrespondence(SUMMARY, TITLE_QUOTE)).toMatchObject({ ok: false });
    const miss = uncoveredParts(SUMMARY, TITLE_QUOTE);
    expect(miss.join("|")).toContain("関東15店");
    expect(miss.join("|")).not.toContain("チェーンX"); // 引用にある語は『無い部分』に含めない
    const v = checkValueCorrespondence(SUMMARY, TITLE_QUOTE);
    expect(v.reason).toContain("引用に書かれていない部分");
  });
  it("訂正の入力（verificationIssues）に具体的な指摘が届き、AIが指摘の情報だけで値を直すと、1回の訂正で検証済みの本登録案（店舗選択式）になる", async () => {
    const seen: string[][] = [];
    const judge: RegistrationJudge = async (i) => {
      seen.push(i.verificationIssues ?? []);
      const hint = (i.verificationIssues ?? []).find((x) => x.startsWith("value_not_in_quote:store")) ?? "";
      // 代役のAI: 指摘が示す『引用に無い部分』を値から外す（指摘に十分な情報がなければ直せない）
      let value = SUMMARY;
      for (const m of hint.matchAll(/「([^」]+)」/g)) value = value.replace(m[1], "");
      value = value.replace(/[（()）、,，。\s]+$/g, "").replace(/（[^）]*$/, "").trim() || SUMMARY;
      return out({
        fields: {
          store: { value: hint ? value : SUMMARY, basis: "observed", evidenceId: "p1", quote: TITLE_QUOTE },
          product: { value: "商品Z", basis: "observed", evidenceId: "p1", quote: TITLE_QUOTE },
          deadline: { value: "2026年11月26日(木) 23:59", basis: "observed", evidenceId: "p1", quote: "■応募期間：2026年11月24日(火)12：00～11月26日(木)23：59まで" },
          apply_unit: { value: "store_select", basis: "observed", evidenceId: "p1", quote: "お一人様につき対象店舗の中から１店舗のみご応募が可能です。" },
        },
      });
    };
    const url = "https://pocket.example.invalid/e/x1";
    const r = await runResearch({ caseId: "k1", seed: SEED("【チェーンX】商品Z 抽選 11/26 23:59まで"), agent: agent(url), judge, tools: toolsFor(url, MULTI_STORE_PAGE), budget: budget(), registerRequiresUnit: true });
    expect(seen).toHaveLength(2); // 1回の訂正
    expect(seen[0]).toEqual([]);
    expect(seen[1].join(" ")).toContain("value_not_in_quote:store");
    expect(seen[1].join(" ")).toContain("直し方");
    expect(r.registration).toMatchObject({ decision: "register", finalDecision: "register", verified: true });
    expect(r.registration.output?.fields.store.value).toBe("チェーンX");
    expect(r.registration.output?.fields.apply_unit.value).toBe("store_select");
  });
  it("基準は緩めていない: 値が引用と対応しないまま直されなければ、従来どおり暫定へ下がる", async () => {
    const url = "https://pocket.example.invalid/e/x1";
    const judge: RegistrationJudge = async () => out({ fields: { store: { value: SUMMARY, basis: "observed", evidenceId: "p1", quote: TITLE_QUOTE }, product: { value: "商品Z", basis: "observed", evidenceId: "p1", quote: TITLE_QUOTE }, deadline: { value: "2026年11月26日(木) 23:59", basis: "observed", evidenceId: "p1", quote: "■応募期間：2026年11月24日(火)12：00～11月26日(木)23：59まで" }, apply_unit: { value: "store_select", basis: "observed", evidenceId: "p1", quote: "お一人様につき対象店舗の中から１店舗のみご応募が可能です。" } } });
    const r = await runResearch({ caseId: "k1", seed: SEED("seed"), agent: agent(url), judge, tools: toolsFor(url, MULTI_STORE_PAGE), budget: budget(), registerRequiresUnit: true });
    expect(r.registration.verified).toBe(false);
    expect(r.registration.finalDecision).toBe("tentative");
  });
});

describe("案3: 通販の商品ページ。<title> のサイト名の接尾辞を『本文の欠落』と誤判定して検証が全項目で止まる欠陥", () => {
  const TITLE = "商品Z 1BOX | ショップY";
  const BODY = "<h1>商品Z 1BOX</h1><p>¥ 6,000</p><p>抽選販売</p><p>応募期間：2026年11月24日 20:00 〜 2026年11月27日 10:00</p><p>抽選に応募する</p>";
  it("題名の核（区切りで分けた最長の区間）が本文にあれば、欠落としない。本文に核が無ければ従来どおり欠落（基準は緩めない）", () => {
    expect(titleCore(TITLE)).toBe("商品Z 1BOX");
    expect(titleCore("単独の題名")).toBe("単独の題名");
    expect(pageTextChecked(html(BODY, TITLE), [TITLE]).loss).toEqual([]);
    expect(pageTextChecked(html("<p>無関係な本文だけ</p>", TITLE), [TITLE]).loss).toEqual(["商品Z 1BOX"]); // 欠落として報告されるのは題名の核
    // 保存済みの欠落の記録（60字に切り詰め）も、現在の規則で再判定される
    expect(refineTextLoss([TITLE.slice(0, 12)], textOf(html(BODY, TITLE)))).toEqual([]);
    expect(refineTextLoss([TITLE], "別の本文")).toEqual([TITLE]);
  });
  it("実行の通し: 取得したページに欠落の印が付かず、店舗・商品・締切の検証が通って、本登録案が検証済みで残る（応募単位を推定できる場合）", async () => {
    const url = "https://shop.example.invalid/items/1";
    const t = toolsFor(url, BODY, TITLE);
    // toolsFor は textLoss を付けない: 実取得では evidence 生成時に pageTextChecked が走る（html 経由）。ここでは html を渡して、その経路を通す
    const tools: ResearchTools = { ...t, fetchPage: async () => ({ ok: true, finalUrl: url, html: html(BODY, TITLE), text: "" }) };
    const judge: RegistrationJudge = async () => out({ fields: {
      store: { value: "ショップY", basis: "observed", evidenceId: "p1", quote: "ショップY" },
      product: { value: "商品Z 1BOX", basis: "observed", evidenceId: "p1", quote: "商品Z 1BOX" },
      deadline: { value: "2026年11月27日 10:00", basis: "observed", evidenceId: "p1", quote: "応募期間：2026年11月24日 20:00 〜 2026年11月27日 10:00" },
      apply_unit: { value: "one_form_one", basis: "inferred", evidenceId: "p1", quote: "抽選に応募する" },
    } });
    const r = await runResearch({ caseId: "k3", seed: SEED("【ショップY】商品Z 11/27 10:00まで 抽選に応募する"), agent: agent(url), judge, tools, budget: budget(), registerRequiresUnit: true });
    const page = r.evidence.find((e) => e.kind === "page");
    expect(page?.textLoss ?? []).toEqual([]);
    expect(r.registration.held?.reasons ?? []).not.toContain("page_text_loss:store");
  });
});

describe("案2: 地域外の店舗限定。『対象地域外』を理由とする除外を、設定と引用の事実で検証できる（実在と適合は別記録）", () => {
  const REGION = { prefectures: ["兵庫県", "大阪府", "京都府"], includeOnline: false };
  const ADDRESS = "所在地：佐賀県武雄市武雄町大字武雄1-1";
  it("所在地の都道府県の抽出と、除外理由の種類の判別（固定の店名・県名のルールではなく、設定との比較）", () => {
    expect(prefecturesIn(ADDRESS)).toEqual(["佐賀"]);
    expect(prefecturesIn("東京都府中市")).toEqual(["東京"]); // 京都府と誤認しない
    expect(prefecturesIn("所在地：京都府京都市")).toEqual(["京都"]);
    expect(claimClassOf("対象地域外（佐賀県の店舗。店頭掲示のQRからの応募のみ）")).toBe("out_of_area");
    expect(claimClassOf("受付終了")).toBe("closed");
    expect(claimClassOf("対象外の商品")).toBe("ineligible");
  });
  it("設定に含まれない都道府県の所在地は成立。設定に含まれる・所在地の記載なし・設定が全国・設定なしは成立しない", () => {
    expect(checkRegionExclusion(ADDRESS, REGION)).toMatchObject({ ok: true });
    expect(checkRegionExclusion("所在地：大阪府大阪市北区", REGION)).toMatchObject({ ok: false, code: "contradicted" });
    expect(checkRegionExclusion("店頭掲示のQRコードからご応募ください", REGION)).toMatchObject({ ok: false, code: "unsupported" });
    expect(checkRegionExclusion(ADDRESS, { prefectures: [], includeOnline: true })).toMatchObject({ ok: false, code: "unsupported" });
    expect(checkRegionExclusion(ADDRESS, undefined)).toMatchObject({ ok: false, code: "unverifiable" });
    // オンラインも対象の設定なら、通販等の有無が引用では確認できない旨を残す（検証済みと称さない部分）
    expect(checkRegionExclusion(ADDRESS, { ...REGION, includeOnline: true }).unconfirmed?.join("")).toContain("オンライン");
  });
  it("実行の通し: 地域外の店舗限定の抽選は、取得したページの所在地の引用に基づく exclude が検証済みになる。機会の実在は別項目に残る。設定が地域内なら除外は成立しない", async () => {
    const url = "https://shop-s.example.invalid/archives/1";
    const page = `<h1>商品Z 抽選販売 受付開始</h1><p>【抽選期間】11/22 10:00〜11/26 18:00</p><p>【応募方法】店頭掲示のQRコードからご応募ください。</p><p>${ADDRESS}</p>`;
    const mk = (): RegistrationJudge => async () => out({ decision: "exclude", fields: {
      store: { value: "店舗S", basis: "observed", evidenceId: "s1", quote: "店舗S" },
      product: { value: "商品Z", basis: "observed", evidenceId: "p1", quote: "商品Z 抽選販売" },
      deadline: { value: "11/26 18:00", basis: "observed", evidenceId: "p1", quote: "【抽選期間】11/22 10:00〜11/26 18:00" },
      opportunity: { value: "実在（受付中・店頭掲示のQRからの応募）", basis: "observed", evidenceId: "p1", quote: "店頭掲示のQRコードからご応募ください。" },
      exclude_reason: { value: "対象地域外（佐賀県の店舗限定。通販・発送の記載なし）", basis: "observed", evidenceId: "p1", quote: ADDRESS },
    } });
    const run = (region: typeof REGION | undefined) => runResearch({ caseId: "k2", seed: SEED("【店舗S】商品Z 抽選 11/26 18:00まで"), agent: agent(url), judge: mk(), tools: toolsFor(url, page), budget: budget(), registerRequiresUnit: true, ...(region ? { userRegion: region } : {}) });
    const ok = await run(REGION);
    expect(ok.registration).toMatchObject({ decision: "exclude", finalDecision: "exclude", verified: true });
    expect(ok.registration.output?.fields.opportunity.basis).toBe("observed"); // 実在と適合は別記録
    const inside = await run({ prefectures: ["佐賀県"], includeOnline: false });
    expect(inside.registration.verified).toBe(false);
    expect(inside.registration.finalDecision).toBe("tentative");
    const none = await run(undefined);
    expect(none.registration.verified).toBe(false); // 設定が分からなければ、地域を理由に除外しない
  });
});

describe("取得時刻: ページの取得時刻は実際に取得した時刻。評価の基準時刻（収集時刻）で上書きしない（本番の保存全文で、取得時刻が基準時刻のラベルになっていた欠陥）", () => {
  it("取得結果の fetchedAt が証拠にそのまま残る。無ければ従来どおり基準時刻", async () => {
    const url = "https://shop.example.invalid/items/9";
    const page = "<h1>商品Z 1BOX</h1><p>応募期間：2026年11月24日 20:00 〜 2026年11月27日 10:00</p>";
    const mk = (fetchedAt?: string): ResearchTools => ({ now: () => NOW, fetchPage: async () => ({ ok: true, finalUrl: url, html: html(page), text: "", ...(fetchedAt ? { fetchedAt } : {}) }) });
    const judge: RegistrationJudge = async () => out({ decision: "tentative", fields: {} });
    const actual = await runResearch({ caseId: "t1", seed: SEED("seed"), agent: agent(url), judge, tools: mk("2026-11-25T10:00:00.000Z"), budget: budget(), registerRequiresUnit: true });
    expect(actual.evidence.find((e) => e.kind === "page")?.fetchedAt).toBe("2026-11-25T10:00:00.000Z");
    expect(actual.evidence.find((e) => e.kind === "seed")?.fetchedAt).toBe(NOW.toISOString()); // 基準時刻は seed のまま
    const legacy = await runResearch({ caseId: "t2", seed: SEED("seed"), agent: agent(url), judge, tools: mk(), budget: budget(), registerRequiresUnit: true });
    expect(legacy.evidence.find((e) => e.kind === "page")?.fetchedAt).toMatch(/^2026-11-24T21:05/);
  });
});

describe("ページ内リンクの候補（案3: FAQ・規約などへ自律的に到達できなかった）", () => {
  const base = "https://shop.example.invalid/items/1";
  const h = `<a href="/faq">よくある質問</a><a href="https://shop.example.invalid/guide/lottery?x=1#top">抽選のご案内</a><a href="/login">ログイン</a><a href="/cart">カート</a><a href="https://other.example.invalid/x">別サイト</a><a href="mailto:a@b.c">連絡</a><a href="#top">上へ</a><a href="/faq">重複</a><a href="https://x.com/foo">X</a><a href="/items/1">自分自身</a><a href="/img"><img src="a.png"></a>`;
  it("同一サイトの公開リンクだけを、重複なしで抽出する（ログイン・カート・別サイト・mailto・アンカー・X・自分自身・文言なしは除く）", async () => {
    const { extractPageLinks } = await import("./page-links");
    const l = extractPageLinks(h, base);
    expect(l.map((x) => x.url)).toEqual(["https://shop.example.invalid/faq", "https://shop.example.invalid/guide/lottery?x=1"]);
    expect(extractPageLinks(h, "not a url")).toEqual([]);
    expect(extractPageLinks(Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">ページ${i}</a>`).join(""), base)).toHaveLength(25);
  });
  it("取得したページのリンク候補が、AIへの観察に出る（次に調べる先をAIが選べる）", async () => {
    const { toAgentView } = await import("./research-loop");
    const url = base;
    const tools: ResearchTools = { now: () => NOW, fetchPage: async () => ({ ok: true, finalUrl: url, html: html(`<h1>商品Z 1BOX</h1>${h}`), text: "" }) };
    const judge: RegistrationJudge = async () => out({ decision: "tentative", fields: {} });
    const r = await runResearch({ caseId: "l1", seed: SEED("seed"), agent: agent(url), judge, tools, budget: budget(), registerRequiresUnit: true });
    const p = r.evidence.find((e) => e.kind === "page")!;
    expect(p.structure?.links?.length).toBe(2);
    expect(toAgentView(p).observations.join(" ")).toContain("ページ内リンク");
    expect(toAgentView(p).observations.join(" ")).toContain("https://shop.example.invalid/faq");
  });
});

describe("応募単位が未確定の暫定: 証拠にある関連記載を読み直す再確認（1回。AIの判断は書き換えない）", () => {
  const url = "https://pocket.example.invalid/e/x1";
  const tent = (unit: { value: string | null; basis: "observed" | "inferred" | "unknown" }, bad = false): JudgeOutput => out({ decision: unit.value ? "register" : "tentative", fields: {
    store: { value: "チェーンX", basis: "observed", evidenceId: "p1", quote: bad ? "存在しない引用文字列です" : "チェーンX「商品Z」抽選販売" },
    product: { value: "商品Z", basis: "observed", evidenceId: "p1", quote: "チェーンX「商品Z」抽選販売" },
    deadline: { value: "2026年11月26日(木) 23:59", basis: "observed", evidenceId: "p1", quote: "■応募期間：2026年11月24日(火)12：00～11月26日(木)23：59まで" },
    apply_unit: unit.value ? { value: unit.value, basis: unit.basis, evidenceId: "p1", quote: "お一人様につき対象店舗の中から１店舗のみご応募が可能です。" } : { value: null, basis: "unknown" },
  } });
  it("1回目が単位未確定の暫定で、証拠に応募単位の記載があるとき、その記載を添えて再確認し、2回目で確定できれば採用する", async () => {
    const seen: string[][] = [];
    let n = 0;
    const judge: RegistrationJudge = async (i) => { seen.push(i.verificationIssues ?? []); return n++ === 0 ? tent({ value: null, basis: "unknown" }) : tent({ value: "store_select", basis: "observed" }); };
    const r = await runResearch({ caseId: "u1", seed: SEED("seed"), agent: agent(url), judge, tools: toolsFor(url, MULTI_STORE_PAGE), budget: budget(), registerRequiresUnit: true });
    expect(seen).toHaveLength(2);
    expect(seen[1].join(" ")).toContain("unit_recheck");
    expect(seen[1].join(" ")).toContain("対象店舗の中から");
    expect(r.registration).toMatchObject({ decision: "register", verified: true });
  });
  it("再確認の出力が検証に通らなければ、最初の検証済みの出力（暫定）へ戻す。AIが unknown のままにするのも自由（強制しない）", async () => {
    let n = 0;
    const bad: RegistrationJudge = async () => (n++ === 0 ? tent({ value: null, basis: "unknown" }) : tent({ value: "store_select", basis: "observed" }, true));
    const r = await runResearch({ caseId: "u2", seed: SEED("seed"), agent: agent(url), judge: bad, tools: toolsFor(url, MULTI_STORE_PAGE), budget: budget(), registerRequiresUnit: true });
    expect(r.registration).toMatchObject({ decision: "tentative", verified: true });
    expect(r.trace.some((t) => t.detail === "unit_recheck_reverted")).toBe(true);
    let m = 0;
    const keep: RegistrationJudge = async () => (m++, tent({ value: null, basis: "unknown" }));
    const k = await runResearch({ caseId: "u3", seed: SEED("seed"), agent: agent(url), judge: keep, tools: toolsFor(url, MULTI_STORE_PAGE), budget: budget(), registerRequiresUnit: true });
    expect(k.registration).toMatchObject({ decision: "tentative", verified: true });
    expect(m).toBe(2); // 再確認は1回だけ
  });
  it("関連記載が証拠に無ければ、再確認は行わない（余計な呼び出し・費用なし）", async () => {
    let n = 0;
    const j: RegistrationJudge = async () => (n++, out({ decision: "tentative", fields: {} }));
    await runResearch({ caseId: "u4", seed: SEED("seed"), agent: agent(url), judge: j, tools: toolsFor(url, "<h1>商品Z</h1><p>抽選販売</p>"), budget: budget(), registerRequiresUnit: true });
    expect(n).toBe(1);
  });
});

describe("案2: 所在地は投稿・カードの文（証拠s1）の引用でもよい。店頭限定の記載は、除外の根拠になる", () => {
  it("カード文の所在地（県名）を引用した地域外の除外が、検証済みになる", async () => {
    const url = "https://shop-s.example.invalid/archives/1";
    const page = "<h1>商品Z 抽選販売 受付開始</h1><p>【抽選期間】11/22 10:00〜11/26 18:00</p><p>【応募方法】店頭掲示のQRコードからご応募ください。</p>";
    const seedText = "店頭受取・来店 商品Z 抽選 店頭で受け取る（佐賀県）・ 店舗S 店頭・佐賀県 受付中 11/26(木) 18:00 まで";
    const judge: RegistrationJudge = async () => out({ decision: "exclude", fields: {
      store: { value: "店舗S", basis: "observed", evidenceId: "s1", quote: "店舗S" },
      product: { value: "商品Z", basis: "observed", evidenceId: "p1", quote: "商品Z 抽選販売" },
      deadline: { value: "11/26 18:00", basis: "observed", evidenceId: "p1", quote: "【抽選期間】11/22 10:00〜11/26 18:00" },
      exclude_reason: { value: "対象地域外（佐賀県の店舗。応募・受取は店頭のみで通販・発送の記載なし）", basis: "observed", evidenceId: "s1", quote: "店頭で受け取る（佐賀県）" },
    } });
    const r = await runResearch({ caseId: "k2b", seed: SEED(seedText), agent: agent(url), judge, tools: toolsFor(url, page), budget: budget(), registerRequiresUnit: true, userRegion: { prefectures: ["兵庫県", "大阪府", "京都府"], includeOnline: false } });
    expect(r.registration).toMatchObject({ decision: "exclude", finalDecision: "exclude", verified: true });
  });
});

describe("保存文書の実際の取得時刻（基準時刻で記録された古い記録の補正）", () => {
  it("AIの実取得の文書は、保存時刻が記録の取得時刻より10分以上あとなら保存時刻を使う。収集由来は変えない", async () => {
    const { actualFetchedAt } = await import("@/lib/server/proposals/evidence-store");
    expect(actualFetchedAt("discovered", "2026-11-24T21:05:01.670Z", "2026-11-25T10:00:04.420Z")).toBe("2026-11-25T10:00:04.420Z");
    expect(actualFetchedAt("discovered", "2026-11-25T10:00:00.000Z", "2026-11-25T10:00:04.420Z")).toBe("2026-11-25T10:00:00.000Z");
    expect(actualFetchedAt("collector_followed", "2026-11-24T21:05:01.670Z", "2026-11-25T10:00:04.420Z")).toBe("2026-11-24T21:05:01.670Z");
    expect(actualFetchedAt("discovered", "2026-11-24T21:05:01.670Z", undefined)).toBe("2026-11-24T21:05:01.670Z");
  });
});

describe("再確認の呼び出しが失敗しても、最初の検証済みの出力を失わない", () => {
  it("2回目の判断が null（不正出力）でも、1回目の検証済みの暫定へ戻る（judge_failed にしない）", async () => {
    const url = "https://pocket.example.invalid/e/x1";
    let n = 0;
    const judge: RegistrationJudge = async () => (n++ === 0 ? out({ decision: "tentative", fields: {
      store: { value: "チェーンX", basis: "observed", evidenceId: "p1", quote: "チェーンX「商品Z」抽選販売" },
      product: { value: "商品Z", basis: "observed", evidenceId: "p1", quote: "チェーンX「商品Z」抽選販売" },
      deadline: { value: "2026年11月26日(木) 23:59", basis: "observed", evidenceId: "p1", quote: "■応募期間：2026年11月24日(火)12：00～11月26日(木)23：59まで" },
      apply_unit: { value: null, basis: "unknown" },
    } }) : (null as unknown as JudgeOutput));
    const r = await runResearch({ caseId: "u5", seed: SEED("seed"), agent: agent(url), judge, tools: toolsFor(url, MULTI_STORE_PAGE), budget: budget(), registerRequiresUnit: true });
    expect(n).toBe(2);
    expect(r.registration).toMatchObject({ decision: "tentative", verified: true });
    expect(r.registration.held).toBeNull();
    expect(r.trace.some((t) => t.detail === "unit_recheck_failed_reverted")).toBe(true);
  });
});
