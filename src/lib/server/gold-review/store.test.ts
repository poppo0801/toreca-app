// @vitest-environment node
/** 独立gold確認（開発専用）の保存・検査・R1への連携。架空のページ・一時フォルダのみ。 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyChecks, emptyDraft, progressOf, validateConfirm, type Draft, type FieldChecks } from "@/lib/gold-review/model";
import { composeR1Cases } from "@/lib/judgment/xsource/r1-worksheet";
import { validateGold } from "@/lib/judgment/xsource/compare-eval";
import { buildR1PageGold, goldReviewEnabled, importState, loadPages, loadState, opConfirm, opExclude, opReopen, opSaveDraft, saveState, writeR1Gold } from "./store";

vi.mock("server-only", () => ({}));

const html = (shop: string, product: string, end: string) => `<html><body><h1 class="heading01">【${shop}】${product} 抽選</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${product} 1BOX</h4><p class="event-detail-ticket-card__text">応募締切 ：${end}まで。お一人様1回まで。</p></section></body></html>`;
let dir: string;
let env: Record<string, string>;
const write = (n: number, h: string) => writeFileSync(join(dir, "pages", `lp-${n}.html`), h);
const index = (ns: number[]) => writeFileSync(join(dir, "pages", "index.json"), JSON.stringify(ns.map((n) => ({ n, url: `https://shop${n}.example.invalid/e/${n}`, ok: true, bytes: 1 }))));
const goodDraft = (shop: string, product: string): Draft => ({ ...emptyDraft(), store: shop, product, applyEnd: "2026-11-30", applyUnit: "one_form_one", quotes: [`【${shop}】${product} 抽選`] });
const allChecks = (): FieldChecks => ({ officialPageOpened: true, store: true, product: true, applyEnd: true, applyUnit: true, quotes: true });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goldrev-"));
  mkdirSync(join(dir, "pages"));
  write(1, html("新宿本店", "拡張パック", "11月30日"));
  write(2, html("渋谷店", "拡張パック", "11月29日"));
  index([1, 2]);
  env = { GOLD_REVIEW_DIR: join(dir, "state"), GOLD_REVIEW_PAGES_DIR: join(dir, "pages") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("有効条件（本番では使えない）", () => {
  it("ローカル開発・ローカルのSupabase・GOLD_REVIEW=on・Vercelでない、が全て揃うときだけ", () => {
    const ok = { TOREMANE_ENV: "local", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321", GOLD_REVIEW: "on" };
    expect(goldReviewEnabled(ok)).toBe(true);
    for (const bad of [{ ...ok, GOLD_REVIEW: undefined }, { ...ok, TOREMANE_ENV: undefined }, { ...ok, NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }, { ...ok, VERCEL: "1" }, { ...ok, VERCEL_ENV: "production" }]) expect(goldReviewEnabled(bad), JSON.stringify(bad)).toBe(false);
    expect(goldReviewEnabled({})).toBe(false);
  });
});

describe("確認の検査（一括承認・不実な確認を許さない）", () => {
  const page = () => loadPages(env)[0];
  it("項目ごとの確認が1つでも欠ければ確認済みにできない。公式ページを開いたことも必要", () => {
    const base = { draft: goodDraft("新宿本店", "拡張パック"), basis: "公式ページを目視で確認", pageText: page().text };
    expect(validateConfirm({ ...base, checks: allChecks() })).toEqual([]);
    for (const k of Object.keys(allChecks()) as (keyof FieldChecks)[]) expect(validateConfirm({ ...base, checks: { ...allChecks(), [k]: false } }).length, k).toBeGreaterThan(0);
    expect(validateConfirm({ ...base, checks: emptyChecks() }).length).toBeGreaterThanOrEqual(6);
  });
  it("引用がページの本文に無い・短すぎる・確認の基準がAI等に頼っている・締切も不明の明示も無い・店舗が本文に無い、は拒否", () => {
    const base = { checks: allChecks(), basis: "公式ページを目視で確認", pageText: page().text };
    const d = goodDraft("新宿本店", "拡張パック");
    expect(validateConfirm({ ...base, draft: { ...d, quotes: ["ページに無い文章です。ありません"] } }).map((x) => x.field)).toContain("quotes");
    expect(validateConfirm({ ...base, draft: { ...d, quotes: ["短い"] } }).map((x) => x.message).join()).toContain("短すぎ");
    expect(validateConfirm({ ...base, draft: d, basis: "AIの出力を確認した" }).map((x) => x.field)).toContain("basis");
    expect(validateConfirm({ ...base, draft: d, basis: "旧方式の結果と一致" }).map((x) => x.field)).toContain("basis");
    expect(validateConfirm({ ...base, draft: d, basis: "ok" }).map((x) => x.field)).toContain("basis");
    expect(validateConfirm({ ...base, draft: { ...d, applyEnd: null } }).map((x) => x.field)).toContain("applyEnd");
    expect(validateConfirm({ ...base, draft: { ...d, applyEnd: null, applyEndUnknown: true } })).toEqual([]);
    expect(validateConfirm({ ...base, draft: { ...d, applyUnit: null } }).map((x) => x.field)).toContain("applyUnit");
    expect(validateConfirm({ ...base, draft: { ...d, store: "存在しない店" } }).map((x) => x.field)).toContain("store");
  });
});

describe("状態の遷移・版・履歴・除外", () => {
  it("確認済みにする→版と確認者・日時・基準が残る。ページが変わると要再確認になり、再確認で下書きに戻る。確認済みは下書き保存で変わらない", () => {
    const pages = loadPages(env);
    let st = loadState(pages, env);
    expect(progressOf(st.pages)).toMatchObject({ unreviewed: 2, complete: false });
    const r = opConfirm(st, pages[0], goodDraft("新宿本店", "拡張パック"), allChecks(), "公式ページを目視で確認", "rev123");
    expect(r.problems).toEqual([]);
    st = r.state;
    saveState(st, env);
    const c = st.pages[0].confirmed!;
    expect(c).toMatchObject({ basis: "公式ページを目視で確認", reviewer: "rev123", pageVersion: pages[0].version });
    expect(st.pages[0].history.map((h) => h.action)).toContain("confirmed");
    expect(() => opSaveDraft(st, 1, emptyDraft(), emptyChecks())).toThrow(/再確認/);
    write(1, html("新宿本店", "拡張パック", "12月1日"));
    const st2 = loadState(loadPages(env), env);
    expect(st2.pages[0].status).toBe("needs_recheck");
    expect(st2.pages[0].history.at(-1)!.action).toBe("page_changed");
    const re = opReopen(st2, 1);
    expect(re.pages[0].status).toBe("unreviewed");
    expect(re.pages[0].draft.store).toBe("新宿本店");
    expect(re.pages[0].confirmed).toBeUndefined();
  });
  it("除外は理由つきで残り、『その他』は理由が必要", () => {
    const pages = loadPages(env);
    const st = loadState(pages, env);
    expect(() => opExclude(st, pages[0], "other", "")).toThrow(/理由/);
    const s2 = opExclude(st, pages[0], "multi_slot", "受付枠が3つある");
    expect(s2.pages[0]).toMatchObject({ status: "excluded", excluded: { reason: "multi_slot", note: "受付枠が3つある" } });
  });
});

describe("保存・バックアップ・インポート", () => {
  it("原子的に保存し、書き込みのたびに直前をバックアップする（最大30世代）。壊れた保存ファイルは黙って空にせず、エラーにする", () => {
    const pages = loadPages(env);
    let st = loadState(pages, env);
    for (let i = 0; i < 35; i++) {
      st = opSaveDraft(st, 1, { ...emptyDraft(), store: `s${i}` }, emptyChecks());
      saveState(st, env);
    }
    expect(readdirSync(join(dir, "state", "gold-review-backups")).length).toBeLessThanOrEqual(30);
    expect(existsSync(join(dir, "state", "gold-review.local.json.tmp"))).toBe(false);
    expect(loadState(pages, env).pages[0].draft.store).toBe("s34");
    writeFileSync(join(dir, "state", "gold-review.local.json"), "{壊れている");
    expect(() => loadState(pages, env)).toThrow(/壊れている/);
  });
  it("エクスポート→インポートで復元できる。確認済みの記録は取り込み時にページの本文・版で再検査され、改ざん・別の版は要再確認になる。未知のページは無視", () => {
    const pages = loadPages(env);
    const r = opConfirm(loadState(pages, env), pages[0], goodDraft("新宿本店", "拡張パック"), allChecks(), "公式ページを目視で確認", "rev1");
    const json = JSON.stringify(r.state);
    const ok = importState(json, pages);
    expect(ok.state.pages[0].status).toBe("confirmed");
    expect(ok.downgraded).toEqual([]);
    const tampered = JSON.parse(json);
    tampered.pages[0].confirmed.draft.quotes = ["ページに存在しない改ざんされた引用です"];
    expect(importState(JSON.stringify(tampered), pages).downgraded).toEqual([1]);
    const other = JSON.parse(json);
    other.pages[0].confirmed.pageVersion.hash = "0".repeat(16);
    expect(importState(JSON.stringify(other), pages).downgraded).toEqual([1]);
    const extra = JSON.parse(json);
    extra.pages.push({ ...extra.pages[1], n: 99 });
    expect(importState(JSON.stringify(extra), pages).ignored).toEqual([99]);
    expect(() => importState('{"v":2}', pages)).toThrow();
    expect(() => importState(JSON.stringify({ ...JSON.parse(json), pages: [{ n: "x" }] }), pages)).toThrow();
  });
});

describe("R1 への連携（未確認が残る間は入力を作らない）", () => {
  it("未確認・要再確認が残っていれば書き出さない。全て確認／除外なら、既存の r1-build が使う形式で書き出し、独立性検査を通る", () => {
    const pages = loadPages(env);
    let st = loadState(pages, env);
    expect(buildR1PageGold(st)).toBeNull();
    expect(writeR1Gold(pages, st, env)).toMatchObject({ ok: false });
    st = opConfirm(st, pages[0], goodDraft("新宿本店", "拡張パック"), allChecks(), "公式ページを目視で確認", "rev1").state;
    expect(buildR1PageGold(st)).toBeNull();
    st = opConfirm(st, pages[1], goodDraft("渋谷店", "拡張パック"), allChecks(), "公式ページを目視で確認", "rev1").state;
    mkdirSync(env.GOLD_REVIEW_DIR, { recursive: true });
    const w = writeR1Gold(pages, st, env);
    expect(w).toEqual({ ok: true, confirmed: 2, excluded: 0 });
    const gold = JSON.parse(readFileSync(join(env.GOLD_REVIEW_DIR, "r1-gold-pages.local.json"), "utf8"));
    expect(gold[0].verified.by).toBe("human");
    expect(gold[0].verified.basis).toContain(pages[0].version.hash);
    const out = composeR1Cases({ pages: pages.map((p) => ({ n: p.n, url: p.url, html: `<body>${p.text}</body>` })), gold, cases: 2, linksPerCase: 2, at: "2026-11-25" });
    expect(validateGold(out.gold).ok).toBe(true);
    const st2 = opExclude(opReopen(st, 2), pages[1], "multi_slot", "受付枠が複数");
    const b = buildR1PageGold(st2)!;
    expect(b.excluded).toEqual([{ n: 2, reason: "multi_slot", note: "受付枠が複数" }]);
    expect(b.gold.find((g) => g.n === 2)!.exclude).toBe(true);
  });
});

describe("ページの読み込み", () => {
  it("https以外・ok=falseのページは使わない", () => {
    writeFileSync(join(dir, "pages", "index.json"), JSON.stringify([{ n: 1, url: "https://ok.example.invalid/e/1", ok: true }, { n: 2, url: "http://insecure.example.invalid/e/2", ok: true }, { n: 3, url: "javascript:alert(1)", ok: true }, { n: 4, url: "https://x.example.invalid/", ok: false }]));
    write(3, "<html/>");
    expect(loadPages(env).map((p) => p.n)).toEqual([1]);
  });
});
