// @vitest-environment node
/**
 * Phase 2: 複数リンクの契約テスト（架空データ・取得は注入）。
 *  以前の複数URL改善（linkMap・item-links・link-evidence）は「項目↔URLの対応付け」で、リンク先本文の取得は最初の1件だけだった。
 *  A 店別応募URL3件／B 共通の親URL＋個別店URL／C URLの順序違い／D 応募ページ→正式フォーム／E 短縮・追跡URL／F 無関係・危険・ログイン必須
 */
import { describe, expect, it, vi } from "vitest";
import { allocateBudget, enrichXPost } from "./x-rich";
import { buildEvidence } from "@/lib/collector/evidence";
import { discoverLinks, planLinkFetches } from "@/lib/collector/link-plan";

vi.mock("server-only", () => ({}));

const page = (title: string, body: string, extra = "") => `<html><head><title>${title}</title></head><body><main>${body}${extra}</main></body></html>`;
const ok = (url: string, title: string, body: string, extra = "") => ({ ok: true as const, finalUrl: url, status: 200, contentType: "text/html", body: page(title, body, extra), truncated: false });
const BODY = (shop: string) => `${shop}の抽選販売のご案内です。拡張パック 抽選受付期間は11月30日23:59まで。当選発表は12月3日。お一人様1点まで。当店の会員証をお持ちの方が対象です。`;
const A = ["https://a.example.com/e/1", "https://b.example.com/e/2", "https://c.example.com/e/3"];

function fetcher(table: Record<string, ReturnType<typeof ok> | { ok: false; code: string; message: string }>, log: string[] = []) {
  return async (u: string) => {
    log.push(u);
    return (table[u] ?? { ok: false as const, code: "http_error" as const, message: "404" }) as never;
  };
}

describe("A 店別応募URL3件: 3件すべて取得・保存し、本文は混ざらない", () => {
  it("3つのリンク先の本文が全て解析入力と linkedPages に入る（以前は最初の1件だけ）", async () => {
    const log: string[] = [];
    const t = Object.fromEntries(A.map((u, i) => [u, ok(u, `店${i}`, BODY(`店舗${i}`))]));
    const r = await enrichXPost({ text: "各店の抽選", links: A, images: [] }, { fetchPage: fetcher(t, log) });
    expect(log).toEqual(A);
    expect(r.linkedPages.map((p) => p.url)).toEqual(A);
    for (let i = 0; i < 3; i++) expect(r.text).toContain(`店舗${i}の抽選販売`);
    expect(r.linkLedger.map((e) => e.status)).toEqual(["fetched", "fetched", "fetched"]);
    // 各ページの本文は、そのURLの記録にだけある（別のページの本文が混ざらない）
    expect(r.linkedPages[1].text).toContain("店舗1");
    expect(r.linkedPages[1].text).not.toContain("店舗0");
  });
  it("保存（buildEvidence）でも3件とも残る。台帳は取得できたリンクの字数・取得時刻を持つ", async () => {
    const t = Object.fromEntries(A.map((u, i) => [u, ok(u, `店${i}`, BODY(`店舗${i}`))]));
    const r = await enrichXPost({ text: "各店の抽選", links: A, images: [] }, { fetchPage: fetcher(t) });
    const ev = buildEvidence({ url: "https://x.com/s/status/1", kind: "x_post", post: { text: "各店の抽選販売のお知らせです", links: A }, linkedPages: r.linkedPages, linkLedger: r.linkLedger }, "2026-11-23T00:00:00.000Z");
    expect(ev?.linkedPages?.map((p) => p.url)).toEqual(A);
    expect(ev?.linkLedger).toHaveLength(3);
    expect(ev?.linkLedger?.[0].chars).toBeGreaterThan(30);
  });
});

describe("B 共通の親URL＋個別店URL", () => {
  it("親URLと個別URLを全て取得し、それぞれ別の出所として残る", async () => {
    const parent = "https://shop.example.com/campaign";
    const kids = ["https://shop.example.com/campaign/a", "https://shop.example.com/campaign/b"];
    const t = { [parent]: ok(parent, "親", BODY("全店共通")), [kids[0]]: ok(kids[0], "a", BODY("A店")), [kids[1]]: ok(kids[1], "b", BODY("B店")) };
    const r = await enrichXPost({ text: "キャンペーン", links: [parent, ...kids], images: [] }, { fetchPage: fetcher(t) });
    expect(r.linkedPages.map((p) => p.url)).toEqual([parent, ...kids]);
    expect(r.linkLedger.every((e) => e.status === "fetched")).toBe(true);
  });
});

describe("C URLの順序を変えても、取得される集合・各ページの本文は同じ", () => {
  it("順序違いでも欠けず、台帳のURL→本文の対応は変わらない", async () => {
    const t = Object.fromEntries(A.map((u, i) => [u, ok(u, `店${i}`, BODY(`店舗${i}`))]));
    const r1 = await enrichXPost({ text: "x", links: A, images: [] }, { fetchPage: fetcher(t) });
    const r2 = await enrichXPost({ text: "x", links: [...A].reverse(), images: [] }, { fetchPage: fetcher(t) });
    const map = (r: typeof r1) => Object.fromEntries(r.linkedPages.map((p) => [p.url, p.text]));
    expect(map(r2)).toEqual(map(r1));
  });
  it("同じページを指す別表記（末尾スラッシュ・追跡パラメータ）は1回だけ取得する", () => {
    const d = discoverLinks({ links: ["https://a.example.com/e/1", "https://a.example.com/e/1/?utm_source=x", "https://a.example.com/e/1#top"] });
    expect(d).toHaveLength(1);
  });
});

describe("D 応募ページから先の正式フォームへのリンクを、安全に（深さ1・上限つきで）追跡する", () => {
  it("応募案内の文言のリンクだけを追い、無関係なリンクは追わない。追跡分は fromUrl・depth=1 を持つ", async () => {
    const entry = "https://shop.example.com/entry-info";
    const form = "https://forms.example.com/apply/123";
    const log: string[] = [];
    const t = {
      [entry]: ok(entry, "案内", BODY("応募案内"), `<a href="${form}">応募フォームはこちら</a><a href="https://ads.example.com/banner">広告</a>`),
      [form]: ok(form, "フォーム", BODY("応募フォーム")),
    };
    const r = await enrichXPost({ text: "x", links: [entry], images: [] }, { fetchPage: fetcher(t, log) });
    expect(log).toEqual([entry, form]);
    const f = r.linkedPages.find((p) => p.url === form)!;
    expect(f.depth).toBe(1);
    expect(f.fromUrl).toBe(entry);
    expect(r.linkedPages[0].depth).toBe(0);
  });
  it("追跡は上限（1ページ3件・合計6件）を超えない", async () => {
    const entry = "https://shop.example.com/entry-info";
    const forms = Array.from({ length: 10 }, (_, i) => `https://forms.example.com/apply/${i}`);
    const t: Record<string, ReturnType<typeof ok>> = { [entry]: ok(entry, "案内", BODY("案内"), forms.map((u, i) => `<a href="${u}">応募フォーム${i}</a>`).join("")) };
    for (const u of forms) t[u] = ok(u, "f", BODY(u));
    const log: string[] = [];
    await enrichXPost({ text: "x", links: [entry], images: [] }, { fetchPage: fetcher(t, log) });
    expect(log.length).toBeLessThanOrEqual(1 + 3);
  });
});

describe("E 短縮URL・追跡URL: 追跡せず、理由つきで台帳に残す（t.co は展開結果がある場合だけ展開先を取得）", () => {
  it("展開結果（linkMap）のある短縮URLは展開先を取得し、展開できない短縮URLは取得せず shortener として残る", async () => {
    const log: string[] = [];
    const t = { "https://a.example.com/e/1": ok("https://a.example.com/e/1", "a", BODY("A店")) };
    const r = await enrichXPost({ text: "A https://t.co/aaa111 B https://t.co/bbb222", links: [], linkMap: [{ short: "https://t.co/aaa111", url: "https://a.example.com/e/1" }], images: [] }, { fetchPage: fetcher(t, log) });
    expect(log).toEqual(["https://a.example.com/e/1"]);
    const miss = r.linkLedger.find((e) => e.url === "https://t.co/bbb222")!;
    expect(miss).toMatchObject({ status: "skipped", reason: "shortener" });
    expect(r.text).toContain("取得できなかったリンク"); // AIにも「無い」ではなく「取得できなかった」と伝わる
  });
});

describe("F 無関係・危険・ログイン必須のURL: 安全に停止して記録する（回避しない）", () => {
  it("X投稿URL・IP直指定・認証情報つき・非標準ポート・ローカルは取得しない。ログイン画面は login_required", async () => {
    const log: string[] = [];
    const login = "https://members.example.com/mypage";
    const t = { [login]: ok(login, "ログイン", "ログイン メールアドレス パスワード を入力してください"), "https://a.example.com/e/1": ok("https://a.example.com/e/1", "a", BODY("A店")) };
    const links = ["https://x.com/shop/status/12345", "http://127.0.0.1/admin", "https://user:pw@a.example.com/secret", "https://a.example.com:8443/x", "http://localhost/y", login, "https://a.example.com/e/1"];
    const r = await enrichXPost({ text: "x", links, images: [] }, { fetchPage: fetcher(t, log) });
    expect(log).toEqual([login, "https://a.example.com/e/1"]);
    const by = Object.fromEntries(r.linkLedger.map((e) => [e.url, e]));
    expect(by["https://x.com/shop/status/12345"].reason).toBe("social_post");
    expect(by["http://127.0.0.1/admin"].reason).toBe("unsafe");
    expect(by["https://user:pw@a.example.com/secret"].reason).toBe("unsafe");
    expect(by["https://a.example.com:8443/x"].reason).toBe("unsafe");
    expect(by["http://localhost/y"].reason).toBe("unsafe");
    expect(by[login].status).toBe("login_required");
    expect(r.linkedPages.map((p) => p.url)).toEqual(["https://a.example.com/e/1"]);
  });
  it("取得失敗・robots拒否・本文が短いページも、理由つきで台帳に残り、他のリンクの取得は続く", async () => {
    const t = { "https://a.example.com/1": { ok: false as const, code: "robots", message: "x" }, "https://a.example.com/2": ok("https://a.example.com/2", "t", "短い"), "https://a.example.com/3": ok("https://a.example.com/3", "c", BODY("C店")) };
    const r = await enrichXPost({ text: "x", links: Object.keys(t), images: [] }, { fetchPage: fetcher(t) });
    expect(r.linkLedger.map((e) => e.status)).toEqual(["blocked", "too_short", "fetched"]);
    expect(r.linkedPages).toHaveLength(1);
  });
});

describe("上限: 無言で捨てず、選ばなかった理由を残す。解析入力は各ページへ公平に配分する", () => {
  it("取得件数・ホスト別の上限を超えたリンクは over_total_limit / over_host_limit として台帳に残る", () => {
    const links = Array.from({ length: 30 }, (_, i) => `https://h${i % 2}.example.com/p/${i}`);
    const plan = planLinkFetches(discoverLinks({ links }), { maxFetch: 10, maxPerHost: 4 });
    expect(plan.filter((p) => p.decision === "fetch")).toHaveLength(8);
    expect(plan.filter((p) => p.reason === "over_host_limit").length).toBeGreaterThan(0);
    expect(plan.every((p) => p.decision === "fetch" || p.reason)).toBe(true);
  });
  it("先頭の長いページが後続のページを押し出さない（公平配分）。全文は linkedPages に残る", async () => {
    const long = BODY("長い店").repeat(400);
    const t = { [A[0]]: ok(A[0], "a", long), [A[1]]: ok(A[1], "b", BODY("二番目の店")), [A[2]]: ok(A[2], "c", BODY("三番目の店")) };
    const r = await enrichXPost({ text: "各店", links: A, images: [] }, { fetchPage: fetcher(t) });
    expect(r.text).toContain("二番目の店の抽選販売");
    expect(r.text).toContain("三番目の店の抽選販売");
    expect(r.text).toContain("全文は"); // 省略したページには、全文が保存済みである旨
    expect(r.linkedPages[0].text.length).toBeGreaterThan(14_000); // 全文は切らない
    expect(r.text.length).toBeLessThanOrEqual(20_000);
  });
  it("allocateBudget: 少なくて済むものは全量、残りを均等に", () => {
    expect(allocateBudget([100, 100, 10_000], 1000)).toEqual([100, 100, 800]);
    expect(allocateBudget([5000, 5000], 1000)).toEqual([500, 500]);
    expect(allocateBudget([], 1000)).toEqual([]);
  });
});
