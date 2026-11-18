// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeForm } from "@/lib/lottery-form";
import { knowledgeFor } from "@/lib/collector/knowledge/chain-knowledge";
import { analyzeLivePocket } from "@/lib/collector/livepocket-structure";
import { inferStoreForm, platformOf, tendencyFor, type FormInference } from "./form-inference";
import { recordsFor } from "./form-learning";
import { resolveChainName, type MasterChain } from "./chain-resolve";
import { buildHumanKnowledge, humanHintsFor, type AnswersFileLike } from "./human-knowledge";

/**
 * Stage 9H-3G: 店舗選択式の推定（確認済み／推定／不明）・LivePocketの構造解析・系列名の解決。
 * 人間の評価（9H-3F）は回帰テストの材料。ただし、評価に合わせただけで改善が証明されたとは扱わない。未知の系列でも同じ仕組みで動くことを、合成データでも確認する。
 */
const ans = (items: { id: string; aiChain: string; url: string; corrections: { field: string; correctValue: string }[]; comment?: string }[]): AnswersFileLike[] => [
  { setId: "rs-test", results: items.map((x) => ({ caseId: x.id, aiOriginal: { extracted: { chain: x.aiChain, store: null, products: ["ハドウシーカー"] } }, source: { url: x.url }, human: { verdict: "partial", usableAsGold: true, corrections: x.corrections, comment: x.comment ?? "" } })) },
];
const SEL = { field: "store", correctValue: "店舗選択式" };
const HK = buildHumanKnowledge(
  ans([
    { id: "t-05", aiChain: "ゲオ", url: "https://geo-online.co.jp/news/790", corrections: [SEL] },
    { id: "t-11", aiChain: "ゲオ", url: "https://geo-online.co.jp/news/789", corrections: [{ field: "chain", correctValue: "GEO" }, SEL] },
    { id: "t-07", aiChain: "ファミマオンライン", url: "https://x.com/pokecachan/status/2117784685212475668", corrections: [SEL] },
    { id: "t-03", aiChain: "トレカステーション", url: "https://x.com/OnchainOutlaw/status/2119219401945935927", corrections: [SEL] },
    { id: "t-04", aiChain: "イオン・イオンスタイル・スーパーセンター", url: "https://www.kidsrepublic.jp/campaign/campaign_detail/20261127pokemoncardgame", corrections: [{ field: "chain", correctValue: "イオンキッズキパブリック" }, SEL] },
  ]),
);

/** 今回の告知から構造を確認できないとき（AIも読み取れなかった）の推定 */
function infer(chain: string, o: { texts?: string[]; storeKnown?: boolean; platform?: string; aiUnit?: string; hk?: typeof HK | null; livepocket?: string; primary?: boolean } = {}): FormInference {
  const knowledge = knowledgeFor(chain);
  const judgement = judgeForm({ storeMode: "fixed", texts: o.texts ?? ["拡張パック ハドウシーカー 抽選のお知らせ。応募期間 11/9 11:00〜11/12 17:59"], knowledge });
  const tendency = tendencyFor({ human: o.hk === undefined ? HK : o.hk, chain, knowledge, platform: o.platform });
  return inferStoreForm({ judgement, aiUnit: o.aiUnit, livepocket: o.livepocket ? analyzeLivePocket({ text: o.livepocket }) : null, storeKnown: o.storeKnown ?? false, platform: o.platform, tendency, primaryEvidence: o.primary });
}

describe("系列の過去の実績・傾向からの推定（今回の告知に根拠が無いときだけ）", () => {
  it("GEO: 今回の告知から読み取れなくても、過去の確認済みの実績（2抽選・同じ応募方式）から店舗選択式を『推定』する。確認済みとは区別する", () => {
    const r = infer("ゲオ", { platform: "web" });
    expect(r.state).toBe("estimated");
    expect(r.form).toBe("store_select");
    expect(r.rank).toBe(3);
    expect(r.confidence).toBe("medium");
    expect(r.priorUsed).toBe(true);
    expect(r.action).toBe("apply");
    expect(r.basis.join("")).toContain("推定");
    // 表記揺れ（GEO / ゲオ / GEO(ゲオ)）でも同じ系列の実績として使う
    expect(infer("GEO(ゲオ)", { platform: "web" }).state).toBe("estimated");
  });
  it("ファミマオンライン・トレカステーション・イオン（キッズリパブリック）も、実績から推定される。応募方式がXだけで不明でも、同じ系列の実績は使える", () => {
    expect(infer("ファミマオンライン").state).toBe("estimated");
    expect(infer("トレカステーション").state).toBe("estimated");
    expect(infer("イオンキッズキパブリック").state).toBe("estimated");
  });
  it("未知の系列でも、人間の評価が1件あれば同じ仕組みで推定できる（辞書に書かなくてよい）。実績の無い系列は『不明』のまま", () => {
    const hk = buildHumanKnowledge(ans([{ id: "n-1", aiChain: "ホビーステーション", url: "https://example.invalid/e", corrections: [SEL] }]));
    const r = infer("ホビーステーション", { hk, platform: "web" });
    expect(r.state).toBe("estimated");
    expect(r.confidence).toBe("low"); // 実績1件
    const unknown = infer("まったく新しい系列", { hk });
    expect(unknown.state).toBe("unknown");
    expect(unknown.form).toBe("unknown");
    expect(unknown.action).toBe("none");
  });
  it("応募方式が違う実績や、一般的な傾向だけのときは、優先順位4（信頼度は低い）の推定", () => {
    // 実績の応募方式は web。今回は LivePocket → 同じ応募方式の実績ではない
    const r = infer("ゲオ", { platform: "livepocket" });
    expect(r.state).toBe("estimated");
    expect(r.rank).toBe(4);
    expect(r.confidence).toBe("low");
    // 人間の評価が無く、辞書の一般的な傾向（GEO）だけ
    const g = infer("ゲオ", { hk: null, platform: "web" });
    expect(g.rank).toBe(4);
  });
  it("店舗が特定できているときは、推定を『提案』にとどめる（登録の形を変えない・独立抽選を統合しない）", () => {
    const r = infer("ゲオ", { storeKnown: true, platform: "web" });
    expect(r.state).toBe("estimated");
    expect(r.action).toBe("propose");
  });
});

describe("今回の情報を優先する（系列の傾向より上）", () => {
  it("今回の告知に店舗選択欄の記載があれば『確認済み』。推定にしない", () => {
    const r = infer("ゲオ", { texts: ["応募フォームで受取店舗を選択してください"], platform: "web" });
    expect(r.state).toBe("confirmed");
    expect(r.form).toBe("store_select");
    expect(r.priorUsed).toBe(false);
    expect(r.rank).toBe(1);
  });
  it("系列の傾向と今回の一次情報が矛盾（店舗ごとに独立して受付）するときは、今回を優先し、傾向を使わなかったことを記録する", () => {
    const r = infer("ゲオ", { texts: ["各店舗にて受付します。店舗ごとに抽選を実施します"], platform: "web" });
    expect(r.state).toBe("confirmed");
    expect(r.form).toBe("store_independent");
    expect(r.priorUsed).toBe(false);
    expect(r.priorOverridden).toBe(true);
    expect(r.action).toBe("none");
    expect(r.basis.join("")).toContain("優先");
  });
  it("AIが今回の告知から店舗別の独立抽選と読み取ったときも、傾向では上書きしない", () => {
    const r = infer("ゲオ", { aiUnit: "store_independent" });
    expect(r.form).toBe("store_independent");
    expect(r.priorUsed).toBe(false);
    expect(r.priorOverridden).toBe(true);
  });
  it("店舗名が明確な通常の店舗別抽選（来店・店頭受付）は、傾向で店舗選択式にしない", () => {
    const r = infer("ゲオ", { texts: ["ゲオ新宿店にて店頭で抽選を受付します。当店の抽選のみ有効"], storeKnown: true, platform: "web" });
    expect(r.form).toBe("store_independent");
    expect(r.state).toBe("confirmed");
  });
  it("店舗が不明なだけで、系列の傾向も実績も無いなら、店舗選択式と断定しない（不明）", () => {
    const r = infer("見知らぬ系列", { texts: ["抽選販売のお知らせ。対象店舗は告知をご確認ください"] });
    expect(r.state).toBe("unknown");
    expect(r.action).toBe("none");
  });
  it("「1店舗のみ応募」の制限だけの記載では店舗選択式と断定しない（実績が無い系列）", () => {
    const r = infer("見知らぬ系列", { texts: ["1店舗のみ応募できます"] });
    expect(r.state).toBe("unknown");
    expect(r.basis.join("")).toContain("制限");
  });
  it("食い違う記載（店舗を選ぶ記載と店舗ごとの受付の両方）は、推定で埋めず確認が必要", () => {
    const r = infer("ゲオ", { texts: ["応募時に受取店舗を選択してください。各店舗にて受付します"] });
    expect(r.state).toBe("unknown");
    expect(r.priorUsed).toBe(false);
  });
  it("通販・店舗を持たない抽選は、推定の対象にしない", () => {
    const judgement = judgeForm({ storeMode: "none", texts: ["通販サイトでの抽選"], online: true });
    const r = inferStoreForm({ judgement, storeKnown: false, tendency: tendencyFor({ chain: "ゲオ", knowledge: knowledgeFor("ゲオ") }) });
    expect(r.form).toBe("other");
    expect(r.priorUsed).toBe(false);
  });
});

describe("LivePocketの構造解析（A 店舗選択式／B 店舗別独立／C 不明）", () => {
  const SELECT_PAGE = `ハドウシーカー 抽選販売
対象店舗: 渋谷店・新宿店・池袋店
チケット種別
渋谷店 受取 ¥6,000
新宿店 受取 ¥6,000
池袋店 受取 ¥6,000
受取店舗をチケット種別から選択してください。応募方法: 申込フォームに必要事項を入力
複数店舗への重複応募は無効とさせていただきます。
受取は選択した店舗にて`;
  const INDEPENDENT_PAGE = `ハドウシーカー 抽選販売
渋谷店の抽選です。各店舗にて受付し、店舗ごとに抽選を実施します。他店舗への応募も可能です。
応募期間は店舗ごとに異なります。受取は当店にて`;
  it("A: チケット種別に複数店舗が並び、受取店舗を選び、店舗をまたぐ重複応募が無効 → 店舗選択式", () => {
    const r = analyzeLivePocket({ text: SELECT_PAGE, organizerVerified: true });
    expect(r.klass).toBe("A");
    expect(r.confidence).toBe("high");
    expect(r.items.targetStores.length).toBeGreaterThanOrEqual(3);
    expect(r.items.storeSelectField).toBe(true);
    expect(r.items.crossStoreLimit).toBe(true);
    expect(r.items.formDescription).toBe(true);
    expect(r.missing).not.toContain("主催者本文（主催者の同一性を確認できていない）");
  });
  it("B: 店舗ごとに受付・期間が独立し、他店舗への応募も可能 → 店舗別の独立抽選", () => {
    const r = analyzeLivePocket({ text: INDEPENDENT_PAGE });
    expect(r.klass).toBe("B");
    expect(r.missing).toContain("主催者本文（主催者の同一性を確認できていない）");
  });
  it("C: 複数店舗への応募禁止の文言だけでは、店舗選択式と断定しない", () => {
    const r = analyzeLivePocket({ text: "ハドウシーカー 抽選。複数店舗への重複応募は無効です。" });
    expect(r.klass).toBe("C");
    expect(r.reasons.join("")).toContain("断定しない");
  });
  it("C: 店舗別のチケットが並ぶだけで、制限も選択欄もないなら不明", () => {
    const r = analyzeLivePocket({ text: "渋谷店 ¥6,000 チケット\n新宿店 ¥6,000 チケット" });
    expect(r.klass).toBe("C");
  });
  it("選ぶ構造と店舗ごとに独立の記載が両方あれば『食い違い』（人の確認）", () => {
    const r = analyzeLivePocket({ text: "受取店舗を選択してください。店舗ごとに抽選を実施します。" });
    expect(r.klass).toBe("conflict");
  });
  it("推定への接続: LivePocketがA → 確認済み（傾向は使わない）／B → 傾向より優先", () => {
    expect(infer("ゲオ", { livepocket: SELECT_PAGE, platform: "livepocket" })).toMatchObject({ state: "confirmed", form: "store_select", priorUsed: false });
    expect(infer("ゲオ", { livepocket: INDEPENDENT_PAGE, platform: "livepocket" })).toMatchObject({ state: "confirmed", form: "store_independent", priorOverridden: true });
  });
  it("LivePocket以外のURL・X投稿は応募方式を『不明』にする", () => {
    expect(platformOf("https://livepocket.jp/e/abc")).toBe("livepocket");
    expect(platformOf("https://x.com/a/status/1")).toBeUndefined();
    expect(platformOf("https://docs.google.com/forms/d/e/x/viewform")).toBe("form");
  });
});

describe("系列マスターとの連携（登録名優先・表記揺れ・人間が確定した別名・似た別系列を誤統合しない）", () => {
  const masters: MasterChain[] = [
    { id: "c-geo", name: "GEO" },
    { id: "c-tsutaya", name: "TSUTAYA" },
    { id: "c-aeon", name: "イオン" },
    { id: "c-aeon-q", name: "イオン九州" },
    { id: "c-geomart", name: "ゲオマート" },
  ];
  it("ゲオ → 登録済みの GEO（登録名を優先）。GEO(ゲオ)も同じ", () => {
    expect(resolveChainName({ name: "ゲオ", masters })).toMatchObject({ source: "master", name: "GEO", id: "c-geo", changed: true });
    expect(resolveChainName({ name: "GEO(ゲオ)", masters })).toMatchObject({ source: "master", name: "GEO" });
  });
  it("似た名前の別系列（ゲオマート・イオン九州）へは自動で寄せず、候補を示す", () => {
    const r = resolveChainName({ name: "ゲオモバイル", masters });
    expect(r.source).toBe("none");
    expect(r.changed).toBe(false);
    expect(resolveChainName({ name: "イオン九州", masters }).id).toBe("c-aeon-q");
    const k = resolveChainName({ name: "イオンキッズリパブリック", masters });
    expect(k.source).toBe("none"); // イオン（別系列）に寄せない
    expect(k.name).toBe("イオンキッズリパブリック");
  });
  it("人間が確定した別名（イオン…スーパーセンター → イオンキッズキパブリック）を次回から使う。確定名がマスターにあればマスター名", () => {
    const r = resolveChainName({ name: "イオン・イオンスタイル・スーパーセンター", masters, human: HK });
    expect(r).toMatchObject({ source: "human_alias", name: "イオンキッズキパブリック", changed: true });
    const withMaster = resolveChainName({ name: "イオン・イオンスタイル・スーパーセンター", masters: [...masters, { id: "c-kq", name: "イオンキッズキパブリック" }], human: HK });
    expect(withMaster).toMatchObject({ source: "master", id: "c-kq" });
  });
  it("系列名の解決は店舗選択式の判断と独立（名前が変わっても推定の結果は変わらない）", () => {
    const a = infer("ゲオ", { platform: "web" });
    const b = infer("GEO", { platform: "web" });
    expect({ ...a, basis: [] }).toEqual({ ...b, basis: [] });
  });
});

describe("人間の評価を、実際の収集経路で使える知識に変換できている（保存だけで終わらない）", () => {
  it("店舗選択式の実績が、系列・応募方式つきで参考情報として取り出せる。実績の評価コメントは参考（今回の告知を優先）", () => {
    const p = recordsFor(HK.forms?.records, "GEO");
    expect(p).toHaveLength(2);
    expect(p.every((r) => r.form === "store_select" && r.platform === "web")).toBe(true);
    const hints = humanHintsFor(HK, { chain: "ゲオ" });
    expect(hints.join("")).toContain("店舗選択式");
    expect(hints.join("")).toContain("今回の告知の記載を優先");
  });
  const FILE = "backups/review-answers/review-answers-rs-9h3f-76e476d4235b85a0-2026-11-15T14-42-37-304Z.json";
  it.skipIf(!existsSync(FILE))("保存済みの実際の評価JSON（9H-3F）: 未評価の1件は使わず、店舗選択式の実績が系列ごとに作られる", () => {
    const f = JSON.parse(readFileSync(FILE, "utf8")) as AnswersFileLike & { results: { caseId: string; human?: { verdict?: string } }[] };
    expect(f.results.filter((r) => r.human?.verdict === "unknown")).toHaveLength(1);
    const hk = buildHumanKnowledge([f]);
    const forms = hk.entries.filter((e) => e.kind === "store_form");
    expect(forms.length).toBeGreaterThanOrEqual(4);
    // 店舗選択式の修正5件のうち、系列を特定できるもの（GEO・ファミマ・トレカステーション・イオン）が実績になる
    expect(recordsFor(hk.forms?.records, "GEO")).toHaveLength(2);
    expect(recordsFor(hk.forms?.records, "ファミマオンライン")).toHaveLength(1);
    expect(recordsFor(hk.forms?.records, "トレカステーション")).toHaveLength(1);
  });
});

describe("手動で確定した抽選形態は、実績・傾向で変えない", () => {
  it("利用者が手動で店舗別独立にしている抽選は、系列の傾向（店舗選択式）があっても推定の対象にしない", () => {
    const judgement = judgeForm({ storeMode: "fixed", texts: ["抽選のお知らせ"], decl: { form: "store_independent", source: "manual" } });
    const r = inferStoreForm({ judgement, storeKnown: false, tendency: tendencyFor({ human: HK, chain: "ゲオ", knowledge: knowledgeFor("ゲオ"), platform: "web" }) });
    expect(r).toMatchObject({ state: "confirmed", form: "store_independent", priorUsed: false, action: "none" });
  });
});

describe("9H-3J: 系列名の重複判定（英語表記・カタカナ表記・略称）。新規の系列を作る前の既存系列との照合", () => {
  const masters: MasterChain[] = [{ id: "c-ys", name: "イエローサブマリン" }, { id: "c-geo", name: "GEO" }, { id: "c-other", name: "イエローハット" }];
  it("Yellow Submarine は、既存の「イエローサブマリン」と同じ系列。英語表記・略称・空白違いも同じ。別の系列（イエローハット）には寄せない", () => {
    for (const n of ["Yellow Submarine", "YELLOW SUBMARINE", "YellowSubmarine", "イエサブ", "イエローサブマリン"]) expect(resolveChainName({ name: n, masters }), n).toMatchObject({ source: "master", id: "c-ys" });
    expect(resolveChainName({ name: "イエローハット", masters })).toMatchObject({ id: "c-other" });
    expect(resolveChainName({ name: "Yellow Hat Shop", masters }).source).toBe("none");
  });
  it("登録済みの別名（人間が登録）も使える。確信できない名前は寄せず、新規系列の候補として保留（名前を変えない）", () => {
    const withAlias: MasterChain[] = [{ id: "c-x", name: "テスト堂", aliases: ["Test-Do"] }];
    expect(resolveChainName({ name: "test do", masters: withAlias })).toMatchObject({ source: "master", id: "c-x" });
    const unsure = resolveChainName({ name: "テスト堂モバイル", masters: withAlias });
    expect(unsure.source).toBe("none");
    expect(unsure.name).toBe("テスト堂モバイル");
  });
});
