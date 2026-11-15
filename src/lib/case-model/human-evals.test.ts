// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { judgeForm } from "@/lib/lottery-form";
import { judgeRegion } from "@/lib/collector/region";
import { knowledgeFor } from "@/lib/collector/knowledge/chain-knowledge";
import { productKey } from "@/lib/lottery-match";
import { buildHumanKnowledge, humanHintsFor, knownChainNames, type AnswersFileLike } from "./human-knowledge";
import { consolidateEvaluations, patternsOf, resolveEvalEntries, type EvalEntry, type ResultFileLike } from "./human-evals";

/** Stage 9H-3E: 人間の評価の取り込み（同じ抽選の評価の統合・異なる判断の保持・参考情報化）と、確認済みの誤判断の回帰テスト */
const E = (o: Partial<EvalEntry> & { caseId: string }): EvalEntry => ({ setId: "rs-x", arm: "", extracted: {}, verdict: "partial", usableAsGold: true, corrections: [], comment: "", ...o });

describe("同じ抽選の評価は1件にまとめ、異なる判断・訂正は失わない", () => {
  const fc = (id: string, dl: string, extra: Partial<EvalEntry> = {}) => E({ caseId: id, extracted: { chain: "フルコンプ", store: null, products: ["ハドウシーカー"], applyDeadline: dl }, ...extra });
  it("フルコンプ: LivePocketの候補とXの投稿2件（締切の表記差・時刻の有無）は1つの抽選にまとまり、評価の出どころ（セット・事例・方式）は全て残る", () => {
    const u = consolidateEvaluations([fc("k-1b76543d", "2026-11-15 11:59", { verdict: "correct" }), fc("k-d8eb0a9b", "2026-11-15", { corrections: [{ field: "store", correctValue: "店舗選択式" }] }), fc("k-1d2511ea", "2026-11-15 12:00", { setId: "rs-y", arm: "A", corrections: [{ field: "store", correctValue: "店舗選択式" }] }), fc("k-1d2511ea", "2026-11-15 11:59", { setId: "rs-y", arm: "B", verdict: "correct" })]);
    expect(u).toHaveLength(1);
    expect(u[0].entries).toHaveLength(4);
    expect(u[0].corrections.store[0]).toMatchObject({ value: "店舗選択式", count: 2 });
    expect(u[0].patterns).toContain("store_select");
  });
  it("食い違う訂正は、どちらも残り、確認対象（conflicts）になる。別の抽選（別の店舗の独立した抽選・別の商品）は混ぜない", () => {
    const u = consolidateEvaluations([
      fc("a", "2026-11-15", { corrections: [{ field: "store", correctValue: "店舗選択式" }] }),
      fc("b", "2026-11-15", { corrections: [{ field: "store", correctValue: "通販" }] }),
      E({ caseId: "sap", extracted: { chain: "カードラボ", store: "札幌店", products: ["ハドウシーカー"], applyDeadline: "2026-11-08" } }),
      E({ caseId: "nam", extracted: { chain: "カードラボ", store: "なんば店", products: ["ハドウシーカー"], applyDeadline: "2026-11-15" } }),
      E({ caseId: "ninja", extracted: { chain: "フルコンプ", store: null, products: ["ニンジャスピナー"], applyDeadline: "2026-11-15" } }),
    ]);
    expect(u.map((x) => x.id).sort()).toEqual(["a", "nam", "ninja", "sap"]);
    const fcg = u.find((x) => x.id === "a")!;
    expect(fcg.corrections.store.map((x) => x.value).sort()).toEqual(["店舗選択式", "通販"]);
    expect(fcg.conflicts).toEqual(["store"]);
  });
  it("キデイランド: 両方が店舗選択式と評価された店舗別の告知（二子玉川店・吉祥寺店）は、同じ企画として1つにまとまる", () => {
    const kd = (id: string, store: string) => E({ caseId: id, extracted: { chain: "キデイランド", store, products: ["スペシャルデッキセットMEGA"], applyDeadline: "2026-11-04 23:59" }, corrections: [{ field: "store", correctValue: "店舗選択式" }] });
    const u = consolidateEvaluations([kd("k-9e5d05dc", "二子玉川店"), kd("k-6336a920", "吉祥寺店")]);
    expect(u).toHaveLength(1);
  });
  it("評価の傾向（パターン）を付ける: 店舗選択式・系列/店舗の特定・商品名の正規化・取得不可・日時・重複・地域除外・Xの本文と画像・正常", () => {
    expect(patternsOf(E({ caseId: "x", corrections: [{ field: "chain", correctValue: "ガンリュウ" }, { field: "store", correctValue: "アリオ葛西店" }] }))).toContain("chain_store_identification");
    expect(patternsOf(E({ caseId: "x", corrections: [{ field: "product", correctValue: "ハドウシーカー" }] }))).toContain("product_normalization");
    expect(patternsOf(E({ caseId: "x", comment: "抽選ページはロボット制限されているため" }))).toContain("unreachable_official");
    expect(patternsOf(E({ caseId: "x", comment: "1分しか違いがない。締切時間が早い方" }))).toContain("date_conflict");
    expect(patternsOf(E({ caseId: "x", comment: "郡山店は福島県で取得範囲外の地域のため、除外が正解" }))).toContain("region_exclude");
    expect(patternsOf(E({ caseId: "x", comment: "テキストを優先して判断する。画像情報は" }))).toContain("x_text_image");
    expect(patternsOf(E({ caseId: "x", verdict: "correct" }))).toEqual(["normal"]);
  });
  it("方式を伏せた評価は、対応表で実際の事例IDと方式に戻る。事例集の接頭辞（b-）も戻る", () => {
    const f: ResultFileLike = { setId: "rs-9h3d-x", results: [{ caseId: "e-01-abc", aiOriginal: { extracted: { chain: "A" } }, human: { verdict: "correct", corrections: [], comment: "" } }] };
    const g: ResultFileLike = { setId: "rs-9h2-x", results: [{ caseId: "b-k-1", aiOriginal: { extracted: { chain: "A" } }, human: { verdict: "partial", corrections: [], comment: "" } }] };
    const r = resolveEvalEntries([f, g], { "e-01-abc": { caseId: "k-9", arm: "B2" } });
    expect(r.map((x) => [x.caseId, x.arm])).toEqual([["k-9", "B2"], ["k-1", "9H-2のB"]]);
  });
});

describe("評価の知識化: 同じ判断は1件にまとめ、事例IDを保持。商品名の別名・マスターに無い系列名も参考情報になる", () => {
  const files: AnswersFileLike[] = [
    { results: [
      { caseId: "k-41748d32", aiOriginal: { extracted: { chain: "カードラボ", store: "大阪日本橋店", products: ["MEGA 拡張パック ハドウシーカー(シュリンクなし)"] } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "product", correctValue: "ハドウシーカー" }], comment: "" } },
      { caseId: "k-9e5d05dc", aiOriginal: { extracted: { chain: "キデイランド", store: "二子玉川店" } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "store", correctValue: "店舗選択式" }], comment: "" } },
      { caseId: "k-6336a920", aiOriginal: { extracted: { chain: "キデイランド", store: "吉祥寺店" } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "store", correctValue: "店舗選択式" }], comment: "" } },
      { caseId: "k-56f3fd88", aiOriginal: { extracted: { chain: null, store: null } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "chain", correctValue: "ガンリュウ" }, { field: "store", correctValue: "アリオ葛西店" }], comment: "" } },
      { caseId: "k-1d2511ea", aiOriginal: { extracted: { chain: "フルコンプ", store: null } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "product", correctValue: "店舗選択式" }], comment: "" } },
    ] },
  ];
  const k = buildHumanKnowledge(files);
  it("同じ判断（キデイランドの店舗選択式）は1件に、事例IDは全て保持。評価者が別の欄に書いた店舗選択式（商品欄）も同じ判断として扱う", () => {
    const sel = k.entries.filter((e) => e.kind === "store_form");
    expect(sel.map((e) => (e as { chain: string }).chain).sort()).toEqual(["キデイランド", "フルコンプ"]);
    expect(sel.find((e) => (e as { chain: string }).chain === "キデイランド")!.caseIds).toEqual(["k-9e5d05dc", "k-6336a920"]);
  });
  it("商品名の正規化（MEGA 拡張パック ○○(シュリンクなし)→○○）が商品名の別名として保持され、該当する告知にだけ参考情報が付く", () => {
    expect(k.entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "product_alias", alias: "MEGA 拡張パック ハドウシーカー(シュリンクなし)", canonical: "ハドウシーカー" })]));
    expect(humanHintsFor(k, { texts: ["ハドウシーカー 抽選販売のお知らせ"] }).join("")).toContain("商品名の装飾・販売条件は商品名に含めない");
    expect(humanHintsFor(k, { texts: ["別の商品の告知"] })).toEqual([]);
  });
  it("評価で系列と確認された名称（マスターに無いガンリュウを含む）が、表示名から系列を読み取る手がかりになる", () => {
    expect(knownChainNames(k)).toEqual(expect.arrayContaining(["ガンリュウ", "キデイランド", "フルコンプ"]));
    expect(k.entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "store_name", chain: "ガンリュウ", store: "アリオ葛西店" })]));
  });
  it("すべて参考であり、今回の告知を優先する旨が付く。応募条件・日程は渡さない", () => {
    for (const h of humanHintsFor(k, { chain: "キデイランド", texts: ["キデイランド"] })) expect(h).toContain("今回の告知の記載を優先");
  });
});

/** 確認済みの誤判断（人間の評価で指摘されたもの）の回帰テスト。実際の評価ファイル（あれば）からも、指摘が存在することを確認する */
describe("確認済みの誤判断の回帰テスト", () => {
  it("商品名: 「MEGA 拡張パック ハドウシーカー(シュリンクなし)」は商品「ハドウシーカー」と同じ商品として照合される（9F-2・9H-3D の指摘）", () => {
    expect(productKey("MEGA 拡張パック ハドウシーカー(シュリンクなし)")).toBe(productKey("ハドウシーカー"));
  });
  it("系列: 「イトーヨーカドーネット通販」は登録済みの系列「イトーヨーカドー」と同一（9F-2・9H-2・9H-3D の指摘）", () => {
    expect(chainCanonicalKey("イトーヨーカドーネット通販")).toBe(chainCanonicalKey("イトーヨーカドー"));
  });
  it("店舗選択式: キデイランドの「同販売期間に複数店舗より同商品の案内があった場合、重複応募は無効」は、店舗をまたぐ応募制限として店舗選択式の根拠になる（9H-3D の指摘。従来の正規表現は距離が長くて見逃していた）", () => {
    const j = judgeForm({ storeMode: "fixed", texts: ["※同販売期間にキデイランド複数店舗より同商品の案内があった場合、重複応募は無効とさせていただきます。"], sourceUrls: [], perStorePages: true, knowledge: knowledgeFor("キデイランド") });
    expect(j.form).toBe("store_select");
  });
  it("地域除外: 郡山店（福島県）は、収集対象の都道府県（東京都など）の外のため除外が正解（9H-3D の指摘）。店舗名の市区町村から福島県と判定できる", () => {
    const j = judgeRegion({ masterPrefecture: "", address: "", storeName: "郡山店", statedPrefecture: "" });
    expect(j.prefecture).toBe("福島県");
  });
  it("実際の評価ファイル（backups/review-answers。あれば）に、上の指摘が含まれている（回帰テストの根拠）", () => {
    const dir = "backups/review-answers";
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as ResultFileLike);
    const entries = resolveEvalEntries(files);
    const all = JSON.stringify(entries.map((e) => [e.corrections, e.comment]));
    expect(all).toContain("ハドウシーカー"); // 商品名の正規化
    expect(all).toContain("イトーヨーカドー");
    expect(all).toContain("重複応募は無効");
    expect(all).toContain("取得範囲外");
    expect(all).toContain("アリオ葛西店");
  });
});

describe.skipIf(!existsSync("backups/review-answers"))("実際の評価ファイルの取り込み: 重複の統合後も、異なる判断・訂正は1件も失われない", () => {
  const dir = "backups/review-answers";
  const files = (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as ResultFileLike);
  const entries = resolveEvalEntries(files);
  const u = consolidateEvaluations(entries);
  it("評価の件数より抽選の件数が少なく（重複が統合され）、全ての（項目・訂正値）がいずれかの抽選に残っている", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
    expect(u.length).toBeLessThan(entries.length);
    const kept = new Set(u.flatMap((x) => Object.entries(x.corrections).flatMap(([f, vs]) => vs.map((v) => `${f}:${v.value}`))));
    for (const e of entries) for (const c of e.corrections) if ((c.correctValue ?? "").trim()) expect(kept.has(`${c.field}:${(c.correctValue ?? "").trim()}`), `${e.caseId} ${c.field}:${c.correctValue}`).toBe(true);
    // 評価の出どころも1件も失われない
    expect(u.reduce((n, x) => n + x.entries.length, 0)).toBe(entries.length);
  });
});

describe("ガンリュウ（Xの表示名からの系列特定）: マスターに無い系列は、評価で確認された名称を手がかりにしたときだけ特定できる", () => {
  it("手がかりなし: 従来どおり特定しない。手がかりあり（評価で系列と確認された名称を仮の系列として渡す）: 表示名から「ガンリュウ」を特定し、告知の系列を決めつけない（参考）", async () => {
    const { resolveXChain } = await import("@/lib/collector/x-chain");
    const none = resolveXChain({ extracted: "", username: "tc_4145", displayName: "ガンリュウ アリオ葛西店", saved: null, chains: [] });
    expect(none.chainName).toBe("");
    const k = buildHumanKnowledge([{ results: [{ caseId: "k-56f3fd88", aiOriginal: { extracted: { chain: null, store: null } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "chain", correctValue: "ガンリュウ" }, { field: "store", correctValue: "アリオ葛西店" }], comment: "" } }] }]);
    const virtual = knownChainNames(k).map((n) => ({ id: `human:${n}`, name: n, provisional: true }));
    const some = resolveXChain({ extracted: "", username: "tc_4145", displayName: "ガンリュウ アリオ葛西店", saved: null, chains: virtual as never });
    expect(some.chainName).toBe("ガンリュウ");
  });
});
