/* eslint-disable @typescript-eslint/no-unused-vars -- 差し替え関数の引数は型付けのために宣言する */
/**
 * Stage 6I の結合テスト（実Supabase・RLS適用下）: Xブックマーク連携。
 * X APIへの通信は差し替える（実際の個人Xアカウントには接続しない）。Supabaseへの通信はそのまま通す。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { BOOKMARK_FIRST_PAGE, runBookmarkCron, runBookmarkSync, type BookmarkPage } from "@/lib/server/collector/bookmarks";
import { acquireLease, completeOAuth, consumeState, disconnect, getAccessToken, loadLink, startOAuth, type OAuthConfig } from "@/lib/server/x-oauth-server";
import { decryptSecret, DEFAULT_REDIRECT_URI } from "@/lib/x-oauth";
import type { XPost } from "@/lib/collector/x-posts";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

type Opt = { max: number; token?: string | null };
const KEY = Buffer.alloc(32, 5).toString("base64");
const CFG: OAuthConfig = { clientId: "cid", clientSecret: "csecret", redirectUri: DEFAULT_REDIRECT_URI, encKey: KEY };
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const RELATED = "【ポケモンカード】拡張パック 抽選販売のお知らせ 応募期間 11/6〜11/8 当選発表 11/10";
const post = (id: string, text: string, createdAt: string, extra: Partial<XPost> = {}): XPost => ({ id, text, createdAt, authorId: "9", url: `https://x.com/shop_a/status/${id}`, username: "shop_a", images: [], links: [], refs: [], ...extra });

describe.skipIf(!dbTestsEnabled)("Stage 6I: Xブックマーク連携", () => {
  const admin = adminClient();
  const adb = admin as unknown as Db;
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
  const x = (db: unknown) => db as any;
  let handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => new Response("{}", { status: 404 });
  const xCalls: { url: string; body: string }[] = [];

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6i", 1);
    const b = await signInTestUser(admin, "s6i", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    // X API(api.x.com)への通信だけを差し替える。Supabaseなどはそのまま通す
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (u.startsWith("https://api.x.com/")) {
        xCalls.push({ url: u, body: String(init?.body ?? "") });
        return handler(u, init);
      }
      return real(input, init);
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanupTestUsers(admin, ids);
  });
  afterEach(() => {
    xCalls.length = 0;
  });

  const setSettings = async (hid: string, v: { x_enabled: boolean; x_monthly_budget_jpy: number }) => {
    const cur = await admin.from("collection_settings").select("id").eq("household_id", hid).limit(1).maybeSingle();
    if (cur.data) await admin.from("collection_settings").update({ ...v, x_max_posts_per_run: 20 }).eq("id", cur.data.id);
    else await admin.from("collection_settings").insert({ household_id: hid, ...v, x_max_posts_per_run: 20 });
  };
  const tokenOk = (access: string, refresh: string, scope = "tweet.read users.read bookmark.read offline.access") => new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 7200, scope }), { status: 200 });
  const meOk = () => new Response(JSON.stringify({ data: { id: "55555", username: "my_x_acct" } }), { status: 200 });

  // ---------------------------------------------------------------- 認証（state / PKCE）
  it("state は10分・1回限り。別ユーザー・期限切れ・存在しない値は拒否する", async () => {
    const s = (await startOAuth(adb, CFG, { householdId: hid1, userId: ids[0] }))!;
    expect(new URL(s.url).searchParams.get("state")).toBe(s.state);
    // 保存されているのはハッシュと暗号化済みverifierだけ（stateの平文は残らない）
    const rows = (await admin.from("x_oauth_states").select("*").eq("household_id", hid1)).data ?? [];
    expect(JSON.stringify(rows)).not.toContain(s.state);
    expect(await consumeState(adb, CFG, s.state, ids[1])).toBeNull(); // 別ユーザー(この呼び出しで消費される)
    const s2 = (await startOAuth(adb, CFG, { householdId: hid1, userId: ids[0] }))!;
    const ok = await consumeState(adb, CFG, s2.state, ids[0]);
    expect(ok?.householdId).toBe(hid1);
    expect(ok?.verifier.length).toBeGreaterThanOrEqual(43);
    expect(await consumeState(adb, CFG, s2.state, ids[0])).toBeNull(); // 再利用不可
    const s3 = (await startOAuth(adb, CFG, { householdId: hid1, userId: ids[0] }))!;
    expect(await consumeState(adb, CFG, s3.state, ids[0], new Date(NOW.getTime() + 11 * 60_000))).toBeNull(); // 期限切れ
    expect(await consumeState(adb, CFG, "forged-state", ids[0])).toBeNull();
  });

  it("認可コードの交換: 必要な権限が足りなければ連携しない。成功しても自動収集はOFF。トークンは暗号化して保存", async () => {
    handler = () => tokenOk("at-limited", "rt-limited", "tweet.read users.read");
    const bad = await completeOAuth(adb, CFG, { code: "c", verifier: "v".repeat(50), householdId: hid2, userId: ids[1] });
    expect(bad.ok).toBe(false);
    expect(await loadLink(adb, hid2)).toBeNull();

    handler = (url) => (url.endsWith("/oauth2/token") ? tokenOk("at-1-plain", "rt-1-plain") : meOk());
    const r = await completeOAuth(adb, CFG, { code: "c", verifier: "v".repeat(50), householdId: hid1, userId: ids[0] });
    expect(r).toEqual({ ok: true, username: "my_x_acct" });
    const tokenCall = xCalls.find((c) => c.url.endsWith("/oauth2/token"))!;
    expect(tokenCall.body).toContain("grant_type=authorization_code");
    expect(tokenCall.body).toContain("code_verifier=");
    const link = await loadLink(adb, hid1);
    expect(link).toMatchObject({ x_username: "my_x_acct", auto_sync: false, status: "active", initial_synced_at: null });
    const tk = (await admin.from("x_oauth_tokens").select("*").eq("link_id", link!.id).single()).data!;
    expect(JSON.stringify(tk)).not.toContain("at-1-plain");
    expect(JSON.stringify(tk)).not.toContain("rt-1-plain");
    expect(decryptSecret(tk.access_token_enc, KEY)).toBe("at-1-plain");
    expect(decryptSecret(tk.refresh_token_enc, KEY)).toBe("rt-1-plain");
  });

  // ---------------------------------------------------------------- 世帯間の分離・列の権限
  it("利用者は自世帯の連携状態だけ読める。トークン・stateの表は読めず、状態の書き換え・他世帯の変更もできない", async () => {
    expect(((await x(u1).from("x_bookmark_links").select("x_username")).data ?? []).map((r: { x_username: string }) => r.x_username)).toEqual(["my_x_acct"]);
    expect((await x(u2).from("x_bookmark_links").select("x_username")).data ?? []).toHaveLength(0);
    for (const t of ["x_oauth_tokens", "x_oauth_states"]) {
      const r = await x(u1).from(t).select("*");
      expect(r.error !== null || (r.data ?? []).length === 0).toBe(true);
    }
    expect((await x(anonClient()).from("x_bookmark_links").select("id")).data ?? []).toHaveLength(0);
    // 状態・アカウント列は変更できない（auto_sync だけ許可）。作成・削除もできない
    expect((await x(u1).from("x_bookmark_links").update({ status: "needs_reauth" }).eq("household_id", hid1)).error).not.toBeNull();
    expect((await x(u1).from("x_bookmark_links").update({ x_username: "other" }).eq("household_id", hid1)).error).not.toBeNull();
    expect((await x(u1).from("x_bookmark_links").insert({ household_id: hid1, x_user_id: "1", x_username: "a" })).error).not.toBeNull();
    await x(u1).from("x_bookmark_links").delete().eq("household_id", hid1);
    expect(await loadLink(adb, hid1)).not.toBeNull();
    // 他世帯の自動収集を切り替えられない
    await x(u2).from("x_bookmark_links").update({ auto_sync: true }).eq("household_id", hid1);
    expect((await loadLink(adb, hid1))!.auto_sync).toBe(false);
    // 自世帯のON/OFFはできる
    expect((await x(u1).from("x_bookmark_links").update({ auto_sync: true }).eq("household_id", hid1)).error).toBeNull();
    expect((await loadLink(adb, hid1))!.auto_sync).toBe(true);
    await x(u1).from("x_bookmark_links").update({ auto_sync: false }).eq("household_id", hid1);
  });

  // ---------------------------------------------------------------- トークン更新・認証エラー
  it("アクセストークンの期限が近ければ更新し、新しい(使い捨ての)更新トークンを保存する", async () => {
    const link = (await loadLink(adb, hid1))!;
    // まだ有効なら更新しない
    handler = () => new Response("{}", { status: 500 });
    expect(await getAccessToken(adb, CFG, link)).toEqual({ ok: true, token: "at-1-plain" });
    expect(xCalls).toHaveLength(0);
    await admin.from("x_oauth_tokens").update({ expires_at: new Date(NOW.getTime() - 1000).toISOString() }).eq("link_id", link.id);
    handler = () => tokenOk("at-2-plain", "rt-2-plain");
    expect(await getAccessToken(adb, CFG, link)).toEqual({ ok: true, token: "at-2-plain" });
    expect(xCalls[0].body).toContain("grant_type=refresh_token");
    expect(xCalls[0].body).toContain("refresh_token=rt-1-plain");
    const tk = (await admin.from("x_oauth_tokens").select("*").eq("link_id", link.id).single()).data!;
    expect(decryptSecret(tk.refresh_token_enc, KEY)).toBe("rt-2-plain");
    expect(new Date(tk.expires_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("更新に失敗(invalid_grant)したら『再連携が必要』にして自動収集を止める。通信失敗では状態を変えない", async () => {
    const link = (await loadLink(adb, hid1))!;
    await admin.from("x_oauth_tokens").update({ expires_at: new Date(NOW.getTime() - 1000).toISOString() }).eq("link_id", link.id);
    handler = () => new Response("down", { status: 503 });
    const t1 = await getAccessToken(adb, CFG, link);
    expect(t1).toMatchObject({ ok: false, reauth: false });
    expect((await loadLink(adb, hid1))!.status).toBe("active");
    handler = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const t2 = await getAccessToken(adb, CFG, link);
    expect(t2).toMatchObject({ ok: false, reauth: true });
    const after = await loadLink(adb, hid1);
    expect(after).toMatchObject({ status: "needs_reauth", auto_sync: false });
    // 再連携が必要な間は、同期でX APIを呼ばない
    const fetchPage = vi.fn();
    await setSettings(hid1, { x_enabled: true, x_monthly_budget_jpy: 1000 });
    const r = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage });
    expect(r.ok).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
    // 再連携で復帰する
    handler = (url) => (url.endsWith("/oauth2/token") ? tokenOk("at-3", "rt-3") : meOk());
    expect((await completeOAuth(adb, CFG, { code: "c", verifier: "v".repeat(50), householdId: hid1, userId: ids[0] })).ok).toBe(true);
    expect(await loadLink(adb, hid1)).toMatchObject({ status: "active", auto_sync: false });
  });

  // ---------------------------------------------------------------- 同期（予算・初回制限・重複防止・優先収集）
  it("既定では何も取得しない: X APIの利用が無効・自動収集OFFなら、同期も定期処理もX APIを呼ばない", async () => {
    await setSettings(hid1, { x_enabled: false, x_monthly_budget_jpy: 0 });
    const fetchPage = vi.fn();
    const r = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("X APIの利用が無効");
    expect(fetchPage).not.toHaveBeenCalled();
    await setSettings(hid1, { x_enabled: true, x_monthly_budget_jpy: 1000 });
    const cron = await runBookmarkCron(adb, new Date(), { cfg: CFG, fetchPage });
    expect(cron.synced).toBe(0); // auto_sync が false のまま
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("初回: 直近14日・最大20件だけ取り込む。関係のない投稿は解析しない。優先収集の候補として保存し、利用量を記録する", async () => {
    const pages: BookmarkPage[] = [
      {
        ok: true,
        nextToken: "more",
        posts: [
          post("9000000000000000001", RELATED, daysAgo(1), { images: ["https://pbs.twimg.com/media/a.jpg"] }),
          post("9000000000000000002", "今日のランチはカレーでした", daysAgo(1)),
          post("9000000000000000003", RELATED, daysAgo(20)), // 初回は14日より古いものを取り込まない
          post("9000000000000000004", RELATED, daysAgo(60)),
        ],
      },
    ];
    const fetchPage = vi.fn(async (_t: string, _u: string, _o: Opt) => pages.shift()!);
    const r = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage });
    expect(r.ok).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1); // 初回は1ページだけ（過去の全ブックマークをたどらない）
    expect(fetchPage.mock.calls[0][2]).toMatchObject({ max: 20 });
    expect(r).toMatchObject({ fetched: 4, added: 1, irrelevant: 1, billed: 4 });
    const cands = (await admin.from("collection_candidates").select("dedupe_key,source_id,status,job_state,x_post_id,draft").eq("household_id", hid1)).data!;
    expect(cands.map((c) => c.dedupe_key)).toEqual(["x:9000000000000000001"]);
    expect(cands[0]).toMatchObject({ source_id: null, status: "pending", job_state: "pending", x_post_id: "9000000000000000001" });
    expect((cands[0].draft as { queued: { bookmark: boolean; kind: string; sourceName: string } }).queued).toMatchObject({ bookmark: true, kind: "x_post", sourceName: "Xブックマーク" });
    // 利用量(既存の月額集計に含まれる collection_runs)と、同期位置の記録
    const runs = (await admin.from("collection_runs").select("phase,x_posts,x_calls,new_count,trigger").eq("household_id", hid1)).data!;
    expect(runs).toEqual([{ phase: "bookmark", x_posts: 4, x_calls: 1, new_count: 1, trigger: "manual" }]);
    expect(await loadLink(adb, hid1)).toMatchObject({ newest_bookmark_id: "9000000000000000001" });
    expect((await loadLink(adb, hid1))!.initial_synced_at).not.toBeNull();
  });

  it("2回目以降: 小さなページから読み、前回の先頭に届いたら止める。同じ投稿・既存の候補は重複登録しない", async () => {
    // 既存の候補(別の収集元から取得済みの同じ投稿)
    expect((await admin.from("collection_candidates").insert({ household_id: hid1, dedupe_key: "x:9000000000000000010", x_post_id: "9000000000000000010", title: "既存", status: "pending" })).error).toBeNull();
    const fetchPage = vi.fn(async (_t: string, _u: string, _o: Opt): Promise<BookmarkPage> => ({
      ok: true,
      nextToken: "more",
      posts: [post("9000000000000000020", RELATED, daysAgo(0)), post("9000000000000000010", RELATED, daysAgo(0)), post("9000000000000000001", RELATED, daysAgo(1)), post("9000000000000000099", RELATED, daysAgo(2))],
    }));
    const r = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][2]).toMatchObject({ max: BOOKMARK_FIRST_PAGE });
    // 先頭(…0001)に届いたところで止まり、その先(…0099)は読まない・保存しない
    expect(r).toMatchObject({ added: 1, known: 1, fetched: 4 });
    const keys = ((await admin.from("collection_candidates").select("dedupe_key").eq("household_id", hid1)).data ?? []).map((c) => c.dedupe_key).sort();
    expect(keys).toEqual(["x:9000000000000000001", "x:9000000000000000010", "x:9000000000000000020"]);
    expect((await loadLink(adb, hid1))!.newest_bookmark_id).toBe("9000000000000000020");
    // もう一度同じ内容: 追加なし
    const again = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage: async () => ({ ok: true, nextToken: null, posts: [post("9000000000000000020", RELATED, daysAgo(0))] }) });
    expect(again.added).toBe(0);
  });

  it("ブックマークが外された(取得結果から消えた)ときも、収集済みの候補・メモ・抽選は削除しない", async () => {
    const before = ((await admin.from("collection_candidates").select("id").eq("household_id", hid1)).data ?? []).length;
    const r = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage: async () => ({ ok: true, nextToken: null, posts: [] }) });
    expect(r.ok).toBe(true);
    expect(((await admin.from("collection_candidates").select("id").eq("household_id", hid1)).data ?? []).length).toBe(before);
  });

  it("月額予算: 残りが足りなければ呼ばない。予算の範囲内で読む件数を絞る。使用量は既存の集計に含まれる", async () => {
    // 今月の使用量: 4 + 4 + 1 + ... 件。予算を使用量+2件ぶんだけに絞る
    const used = ((await admin.from("collection_runs").select("x_posts").eq("household_id", hid1)).data ?? []).reduce((a, r) => a + r.x_posts, 0);
    expect(used).toBeGreaterThan(0);
    await setSettings(hid1, { x_enabled: true, x_monthly_budget_jpy: Math.ceil((used + 2) * 1.2) });
    const fetchPage = vi.fn(async (_t: string, _u: string, _o: Opt) => ({ ok: true, nextToken: null, posts: [] }) as BookmarkPage);
    const r = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("予算");
    expect(fetchPage).not.toHaveBeenCalled();
    // 予算を戻すと、読み取り件数は残りの半分(引用元ぶん)までに絞られる
    await setSettings(hid1, { x_enabled: true, x_monthly_budget_jpy: Math.ceil((used + 12) * 1.2) });
    await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage });
    expect((fetchPage.mock.calls[0] as unknown[])[2]).toMatchObject({ max: BOOKMARK_FIRST_PAGE });
    await setSettings(hid1, { x_enabled: true, x_monthly_budget_jpy: 1000 });
  });

  it("同期の多重実行を防ぐ(貸出)。X APIが401を返したら再連携が必要になり、以後は呼ばない", async () => {
    const link = (await loadLink(adb, hid1))!;
    expect(await acquireLease(adb, link.id)).toBe(true);
    expect(await acquireLease(adb, link.id)).toBe(false);
    const fetchPage = vi.fn(async (_t: string, _u: string, _o: Opt): Promise<BookmarkPage> => ({ ok: true, nextToken: null, posts: [] }));
    const busy = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage });
    expect(busy.ok).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
    await admin.from("x_bookmark_links").update({ lease_until: null }).eq("id", link.id);
    const denied = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage: async () => ({ ok: false, code: "reauth", message: "Xの認証が無効です。再連携してください" }) });
    expect(denied.ok).toBe(false);
    expect(await loadLink(adb, hid1)).toMatchObject({ status: "needs_reauth", auto_sync: false });
  });

  it("世帯間の分離: 連携のない世帯は同期できず、他世帯の候補は見えない", async () => {
    const r = await runBookmarkSync({ db: adb, householdId: hid2, trigger: "manual", cfg: CFG, fetchPage: vi.fn() });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("連携されていません");
    expect((await x(u2).from("collection_candidates").select("id")).data ?? []).toHaveLength(0);
  });

  it("連携解除: 連携とトークンを削除する。収集済みの候補は残る", async () => {
    handler = () => new Response("{}", { status: 200 });
    const before = ((await admin.from("collection_candidates").select("id").eq("household_id", hid1)).data ?? []).length;
    const link = (await loadLink(adb, hid1))!;
    const r = await disconnect(adb, CFG, hid1);
    expect(r.ok).toBe(true);
    expect(xCalls.some((c) => c.url.endsWith("/oauth2/revoke"))).toBe(true);
    expect(await loadLink(adb, hid1)).toBeNull();
    expect(((await admin.from("x_oauth_tokens").select("link_id").eq("link_id", link.id)).data ?? []).length).toBe(0);
    expect(((await admin.from("collection_candidates").select("id").eq("household_id", hid1)).data ?? []).length).toBe(before);
    // 解除後は同期されない
    const after = await runBookmarkSync({ db: adb, householdId: hid1, trigger: "manual", cfg: CFG, fetchPage: vi.fn() });
    expect(after.ok).toBe(false);
  });
});
