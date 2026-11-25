// @vitest-environment node
/** 独立gold確認（開発専用）の保存・検査・R1への連携。架空のページ・一時フォルダのみ。 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyChecks, emptyDraft, progressOf, validateConfirm, type Draft, type FieldChecks } from "@/lib/gold-review/model";
import { composeR1Cases } from "@/lib/judgment/xsource/r1-worksheet";
import { validateGold } from "@/lib/judgment/xsource/compare-eval";
import { buildR1PageGold, buildRealGold, goldReviewEnabled, importState, loadPages, loadRealPages, loadState, opConfirm, opExclude, opHold, opReopen, opSaveDraft, saveState, writeR1Gold, writeRealGold } from "./store";

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
  it("締切の時刻: 引用（ページ本文）に書かれている時刻だけ入力できる。日付が無い時刻・形式不正・引用に無い時刻は拒否。時刻なしは従来どおり確認済みにできる（既存の確認を変えない）", () => {
    const text = "【新宿本店】拡張パック 抽選 応募締切 11月30日（月）23:59まで お一人様1回まで。";
    const base = { checks: allChecks(), basis: "公式ページを目視で確認", pageText: text };
    const d = { ...goodDraft("新宿本店", "拡張パック"), quotes: ["【新宿本店】拡張パック 抽選 応募締切 11月30日（月）23:59まで"] };
    expect(validateConfirm({ ...base, draft: d })).toEqual([]); // 時刻なし
    expect(validateConfirm({ ...base, draft: { ...d, applyEndTime: "23:59" } })).toEqual([]);
    expect(validateConfirm({ ...base, draft: { ...d, applyEndTime: "18:00" } }).map((x) => x.field)).toContain("applyEndTime"); // 引用に無い時刻
    expect(validateConfirm({ ...base, draft: { ...d, applyEndTime: "25:00" } }).map((x) => x.field)).toContain("applyEndTime");
    expect(validateConfirm({ ...base, draft: { ...d, applyEnd: null, applyEndUnknown: true, applyEndTime: "23:59" } }).map((x) => x.field)).toContain("applyEndTime");
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

describe("実投稿のリンク先ページ（real set）", () => {
  const caps = (text: string, o: Record<string, unknown> = {}) => ({ caseId: "rpaaaa1111", order: 0, short: "https://t.co/a", url: "https://shop-a.example.invalid/e/1", finalUrl: "https://shop-a.example.invalid/e/1", hops: 0, fetchedAt: "2026-11-24T00:00:00.000Z", status: 200, title: "", chars: text.length, textHash: "0123456789abcdef", truncated: false, text, sameContentAs: null, ...o });
  const setup = () => {
    const sdir = join(dir, "state");
    mkdirSync(sdir, { recursive: true });
    const idc = "post-1";
    const id8 = createHash("sha256").update(idc).digest("hex").slice(0, 8);
    const caseId = `rp${id8}`;
    const t1 = "【新宿本店】拡張パック 抽選受付 応募締切 ：11月30日（月）23:59まで お一人様1回まで。";
    const t2 = "【渋谷店】拡張パック 抽選受付 応募締切 ：2026年12月1日（火）まで お一人様1回まで。";
    const t3 = "【渋谷店】拡張パック 抽選受付 （再掲）応募締切 ：2026年12月1日（火）まで お一人様1回まで。";
    writeFileSync(join(sdir, "real-pages.local.json"), JSON.stringify([
      caps(t1, { caseId, order: 0, short: "https://t.co/a", url: "https://shop-a.example.invalid/e/1", textHash: "a".repeat(16) }),
      caps(t2, { caseId, order: 1, short: "https://t.co/b", url: "https://shop-b.example.invalid/e/2", textHash: "b".repeat(16) }),
      caps(t3, { caseId, order: 2, short: "https://t.co/c", url: "https://shop-b.example.invalid/e/2x", textHash: "c".repeat(16) }),
    ]));
    writeFileSync(join(sdir, "real-post-candidates.local.json"), JSON.stringify([{ id: idc, postUrl: "https://x.com/official/status/1234567890123", text: "《新宿》 https://t.co/a 《渋谷》 https://t.co/b https://t.co/c", capturedAt: "x" }]));
    writeFileSync(join(sdir, "cases.real.local.json"), JSON.stringify([{ caseId, pages: [{ url: "https://shop-a.example.invalid/e/1" }, { url: "https://shop-b.example.invalid/e/2" }, { url: "https://shop-b.example.invalid/e/2x" }] }]));
    return { caseId, t1, t2, t3 };
  };

  it("実投稿のページを、出所（投稿・短縮URL・展開先・取得）つきで読み込む。年が書かれていない締切の年は補わない（書かれていれば年を示す）", () => {
    setup();
    const pages = loadRealPages(env);
    expect(pages).toHaveLength(3);
    expect(pages[0].source).toMatchObject({ short: "https://t.co/a", postUrl: "https://x.com/official/status/1234567890123", order: 0 });
    expect(pages[0].source!.postText).toContain("https://t.co/a");
    expect(pages[0].candidate.applyEndGuess).toMatchObject({ md: "11/30", year: null }); // 年は書かれていない → 補わない
    expect(pages[1].candidate.applyEndGuess).toMatchObject({ md: "12/1", year: 2026 });
    expect(pages[0].candidate.attention.join()).toContain("構造は保存していない");
    expect(new Set(pages.map((p) => p.n)).size).toBe(3);
    // 同じ入力なら同じ番号（再取得しても同じページは同じ番号）
    expect(loadRealPages(env).map((p) => p.n)).toEqual(pages.map((p) => p.n));
  });

  it("案件のgold: 全ページが確認済みの投稿だけを案件にする。同じ応募機会（人が印を付けたもの）は1機会にまとめ、除外・保留・未確認が残る投稿は理由つきで見送る", () => {
    const { caseId } = setup();
    const pages = loadRealPages(env);
    let st = loadState(pages, env, "real");
    const d = (shop: string, product: string, end: string, quote: string, same: number | null = null): Draft => ({ ...emptyDraft(), store: shop, product, applyEnd: end, applyUnit: "one_form_one", quotes: [quote], sameOpportunityAs: same });
    st = opConfirm(st, pages[0], d("新宿本店", "拡張パック", "2026-11-30", "応募締切 ：11月30日（月）23:59まで"), allChecks(), "公式ページを目視で確認", "rev1").state;
    st = opConfirm(st, pages[1], d("渋谷店", "拡張パック", "2026-12-01", "応募締切 ：2026年12月1日（火）まで"), allChecks(), "公式ページを目視で確認", "rev1").state;
    const cases = [{ caseId, pages: pages.map((p) => ({ url: p.url })) }];
    // 3ページ目が未確認 → 案件は見送り
    let r = buildRealGold(st, pages, cases, "2026-11-25");
    expect(r.gold).toEqual([]);
    expect(r.deferred[0].reason).toContain("ページ3");
    // 3ページ目は2ページ目と同じ応募機会（再掲）→ 1機会にまとめる（2機会と数えない）
    st = opConfirm(st, pages[2], d("渋谷店", "拡張パック", "2026-12-01", "（再掲）応募締切 ：2026年12月1日（火）まで", pages[1].n), allChecks(), "公式ページを目視で確認", "rev1").state;
    r = buildRealGold(st, pages, cases, "2026-11-25");
    expect(r.gold).toHaveLength(1);
    expect(r.gold[0].opportunities).toHaveLength(2); // 3ページ・2機会
    expect(r.gold[0].opportunities[1].evidence.map((e) => e.where)).toEqual(["page:1", "page:2"]); // 重ねて書いたページの引用は、同じ機会の根拠として両方残る
    expect(validateGold(r.gold).ok).toBe(true);
    // 除外が1つでもあれば見送り
    const ex = opExclude(opReopen(st, pages[2].n), pages[2], "multi_slot", "受付枠が複数");
    expect(buildRealGold(ex, pages, cases, "2026-11-25").deferred[0].reason).toContain("除外");
    // 書き出し（gold.real.local.json）
    mkdirSync(env.GOLD_REVIEW_DIR, { recursive: true });
    expect(writeRealGold(pages, st, env)).toMatchObject({ ok: true, cases: 1 });
    expect(existsSync(join(env.GOLD_REVIEW_DIR, "gold.real.local.json"))).toBe(true);
  });

  it("公式ページを開けないときは保留（要再確認）。確認済みにはならず、確認済みのページは保留にできない。実投稿の状態は別ファイルに保存される", () => {
    setup();
    const pages = loadRealPages(env);
    let st = loadState(pages, env, "real");
    st = opHold(st, pages[0].n, "公式ページが開けない");
    expect(st.pages.find((p) => p.n === pages[0].n)).toMatchObject({ status: "needs_recheck" });
    expect(st.pages.find((p) => p.n === pages[0].n)!.history.at(-1)).toMatchObject({ action: "held", note: "公式ページが開けない" });
    saveState(st, env, "real");
    expect(existsSync(join(env.GOLD_REVIEW_DIR, "gold-review-real.local.json"))).toBe(true);
    expect(existsSync(join(env.GOLD_REVIEW_DIR, "gold-review.local.json"))).toBe(false); // lp12 の状態とは別
    const ok = opConfirm(loadState(pages, env, "real"), pages[1], { ...emptyDraft(), store: "渋谷店", product: "拡張パック", applyEnd: "2026-12-01", applyUnit: "one_form_one", quotes: ["応募締切 ：2026年12月1日（火）まで"] }, allChecks(), "公式ページを目視で確認", "rev1");
    expect(() => opHold(ok.state, pages[1].n, "x")).toThrow(/再確認/);
  });
});
