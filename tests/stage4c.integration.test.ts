/**
 * Stage 4C の結合テスト（実Supabase・RLS適用下。AI・外部サイト・X APIはモック＝有料APIの実呼び出しなし）:
 * 収集 → 関連判定 → 解析 → 条件判定 → マスター照合 → 重複 → 自動登録/確認待ち、再収集の冪等性、既存データの保護、
 * 取得失敗の分離、Xの停止条件（無効・予算0円・キー未設定）、多重実行防止、世帯間の分離、定期実行（ログインなし）の挙動。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { runCollection, type CollectDeps } from "@/lib/server/collector/run";
import type { XClient } from "@/lib/server/collector/x-client";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// 架空の「現在」。モック解析の日付（1/10 開始・1/20 締切）がちょうど受付中になる
const NOW = new Date("2027-01-15T00:00:00+09:00");
const html = (body: string) => `<html><body>${body}</body></html>`;
const ok = (finalUrl: string, body: string): SafeFetchResult => ({ ok: true, finalUrl, status: 200, contentType: "text/html", body, truncated: false });
const PAGE = html("<p>ポケモンカード 拡張パック 抽選販売のお知らせ。サンプル電機 三宮店にて抽選販売を実施します。応募期間をご確認ください。</p>");
const LIST = (links: string[]) => ok("https://list.example.invalid/chusen", html(links.map((l) => `<a href="${l}">ポケモンカード 抽選 受付中 ${l.slice(-8)}</a>`).join("<div></div>")));

describe.skipIf(!dbTestsEnabled)("Stage 4C: 自動収集", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let hid2: string;
  let profile: string;
  let xCalls = 0;
  let pagesFetched: string[] = [];

  const fakeX = (posts: { id: string; text: string }[]): XClient => ({
    async lookupUser(username) {
      xCalls++;
      return { ok: true, id: "1234567890", username };
    },
    async getPost(id, username) {
      xCalls++;
      return { ok: true, post: { id, text: "", createdAt: "2027-01-12T00:00:00.000Z", authorId: "1234567890", url: `https://x.com/${username}/status/${id}`, images: [], links: [], refs: [] } };
    },
    async userPosts(_id, username, opts) {
      xCalls++;
      void opts;
      return { ok: true, posts: posts.map((p) => ({ id: p.id, text: p.text, createdAt: "2027-01-12T00:00:00.000Z", authorId: "1234567890", url: `https://x.com/${username}/status/${p.id}`, images: [], links: [], refs: [] })), newestId: posts[0]?.id ?? null };
    },
  });

  const deps = (over: Partial<CollectDeps> & { list?: SafeFetchResult | ((u: string) => SafeFetchResult) } = {}): CollectDeps => {
    const { list, ...rest } = over;
    return {
      db: u1,
      householdId: hid,
      trigger: "manual",
      now: NOW,
      actor: profile,
      canRegister: true,
      extractor: getExtractor({ AI_PROVIDER: "mock" }),
      xClient: null,
      fetchList: async (u) => (typeof list === "function" ? list(u) : (list ?? LIST([]))),
      fetchPage: async (u) => {
        pagesFetched.push(u);
        return ok(u, PAGE);
      },
      fetchOembed: async () => ({ ok: true, text: "ポケモンカード 抽選販売 サンプル電機 三宮店", author: "x", notice: [], postedOn: "2027-01-10" }),
      ...rest,
    };
  };

  const setSettings = (patch: Record<string, unknown>) => u1.from("collection_settings").update(patch as never).eq("household_id", hid);
  const sourceOf = async (name: string) => (await u1.from("collection_sources").select("*").eq("name", name).single()).data!;
  const cands = async () => (await u1.from("collection_candidates").select("dedupe_key,status,reasons,lottery_id,draft").order("created_at")).data!;
  const lotteries = async () => (await u1.from("lotteries").select("id,source_kind,is_new,source_urls,updated_at")).data ?? [];

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s4c", 1);
    const b = await signInTestUser(admin, "s4c", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "サンプル電機" }).select("id").single()).data!.id;
    await u1.from("stores").insert({ household_id: hid, chain_id: chain, name: "三宮店", prefecture: "兵庫県" });
    await u1.from("products").insert({ household_id: hid, official_name: "テスト拡張パック「ひかりの森」", packs_per_box: 30 });
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("初期設定: 収集元4件（Web2・X2）・既定の収集条件（6都府県・通販あり・全商品・現在応募可能）。定期実行とX APIは無効", async () => {
    const r = await runCollection(deps({ onlySourceIds: [] }));
    expect(r.ok).toBe(true);
    const src = (await u1.from("collection_sources").select("kind,name,url,x_username,enabled,adapter")).data!;
    expect(src.map((s) => s.name).sort()).toEqual(["OnchainOutlaw", "pokecachan", "pokeso", "トレカ日和"]);
    expect(src.find((s) => s.name === "pokeso")).toMatchObject({ url: "https://pokeso.jp/chusen", adapter: "pokeso" });
    expect(src.find((s) => s.name === "pokecachan")).toMatchObject({ kind: "x", x_username: "pokecachan" });
    const st = (await u1.from("collection_settings").select("*").single()).data!;
    expect(st.prefectures).toEqual(["兵庫県", "大阪府", "京都府", "東京都", "千葉県", "神奈川県"]);
    expect(st).toMatchObject({ include_online: true, max_distance_km: null, product_mode: "all", status_mode: "open", schedule_enabled: false, x_enabled: false, x_monthly_budget_jpy: 0 });
  });

  it("収集: 対象外の地域は除外・一致は自動登録（★管理対象にしない・応募記録なし・NEW）・別TCGは候補にしない・再収集は冪等でAIを呼ばない", async () => {
    // 他の収集元は止め、テスト用の1つだけを使う
    await u1.from("collection_sources").update({ enabled: false }).neq("name", "pokeso");
    const pokeso = await sourceOf("pokeso");
    const list = LIST(["https://shop-a.example.invalid/lottery/a1", "https://shop-a.example.invalid/lottery/a2", "https://shop-a.example.invalid/lottery/a3"]);
    if (list.ok) list.body += `<a href="https://other.example.invalid/yugioh">遊戯王 抽選販売 受付中</a><a href="https://hb.afl.rakuten.co.jp/hgc/x">広告</a>`;

    // 地域を北海道だけにすると、三宮店（兵庫県）の抽選は除外される
    await setSettings({ prefectures: ["北海道"] });
    const r1 = await runCollection(deps({ list: () => ok("https://pokeso.jp/chusen", html(`<a href="https://shop-a.example.invalid/lottery/a1">ポケモンカード 抽選 受付中</a>`)), onlySourceIds: [pokeso.id] }));
    expect(r1.ok && r1.newCount).toBe(1);
    let c = await cands();
    expect(c.find((x) => x.dedupe_key.endsWith("/a1"))).toMatchObject({ status: "excluded" });
    expect((await lotteries()).length).toBe(0);

    // 既定の6都府県に戻して、新しい告知を収集 → 自動登録
    await setSettings({ prefectures: ["兵庫県", "大阪府", "京都府", "東京都", "千葉県", "神奈川県"] });
    const r2 = await runCollection(deps({ list: () => ok("https://pokeso.jp/chusen", list.ok ? list.body : ""), onlySourceIds: [pokeso.id] }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    c = await cands();
    // 別TCG・広告は候補にならない。a1は除外済みのまま再解析されない
    expect(c.some((x) => x.dedupe_key.includes("yugioh") || x.dedupe_key.includes("rakuten"))).toBe(false);
    expect(c.find((x) => x.dedupe_key.endsWith("/a1"))!.status).toBe("excluded");
    const registered = c.filter((x) => x.status === "auto_registered");
    expect(registered).toHaveLength(1);
    // 同じ店舗・商品・締切の別URLは、別の抽選にせず重複として扱う（既存抽選に情報源URLを追加）
    expect(c.filter((x) => x.status === "duplicate")).toHaveLength(1);
    const lots = await lotteries();
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ source_kind: "auto", is_new: true });
    expect(lots[0].source_urls.length).toBe(2); // 登録時の情報源URL＋重複した告知のURL
    // ★管理対象・応募記録は作られない
    expect(((await u1.from("lottery_management").select("is_managed").eq("lottery_id", lots[0].id)).data ?? []).filter((m) => m.is_managed)).toHaveLength(0);
    expect(((await u1.from("applications").select("id").eq("lottery_id", lots[0].id)).data ?? []).length).toBe(0);

    // 再収集: 新しい候補なし・AIを呼ばない・ページも再取得しない（冪等）
    pagesFetched = [];
    const r3 = await runCollection(deps({ list: () => ok("https://pokeso.jp/chusen", list.ok ? list.body : ""), onlySourceIds: [pokeso.id] }));
    expect(r3.ok && r3.newCount).toBe(0);
    expect(r3.ok && r3.aiCalls).toBe(0);
    expect(pagesFetched).toHaveLength(0);
    expect((await lotteries()).length).toBe(1);

    // 履歴と収集元の状態
    const src = await sourceOf("pokeso");
    expect(src).toMatchObject({ status: "ok", last_item_count: 4 });
    expect(src.last_success_at).not.toBeNull();
    expect(((await u1.from("collection_runs").select("id,status")).data ?? []).every((x) => x.status === "done")).toBe(true);
  });

  it("利用者が確定した抽選は書き換えない: 重複の情報は情報源URLの追加だけ。応募・スルー・購入に触れない", async () => {
    const lot = (await lotteries())[0];
    const before = (await u1.from("lotteries").select("memo,conditions_text,apply_deadline_date,limit_max_count").eq("id", lot.id).single()).data!;
    // 利用者が値を直し、応募を記録する
    await u1.from("lotteries").update({ memo: "利用者の確定メモ" }).eq("id", lot.id);
    const pokeso = await sourceOf("pokeso");
    await runCollection(deps({ list: () => ok("https://pokeso.jp/chusen", html(`<a href="https://shop-b.example.invalid/lottery/b1">ポケモンカード 抽選 受付中</a>`)), onlySourceIds: [pokeso.id] }));
    const after = (await u1.from("lotteries").select("memo,conditions_text,apply_deadline_date,limit_max_count,source_urls").eq("id", lot.id).single()).data!;
    expect(after.memo).toBe("利用者の確定メモ");
    expect(after.conditions_text).toBe(before.conditions_text);
    expect(after.apply_deadline_date).toBe(before.apply_deadline_date);
    expect(after.source_urls.length).toBe(3);
    expect(((await lotteries()).length)).toBe(1);
  });

  it("取得失敗は他の収集元に影響しない。構造が変わって0件のサイトは『解析設定が必要』で、取得できたことにしない。アクセス制限は回避しない", async () => {
    await u1.from("collection_sources").update({ enabled: true }).eq("kind", "web");
    const pokeso = await sourceOf("pokeso");
    const tb = await sourceOf("トレカ日和");
    const r = await runCollection(deps({ list: (u) => (u.includes("pokeso") ? { ok: false, code: "http_error", status: 403, message: "403" } : ok(u, html("<p>構造が変わりました</p>"))), onlySourceIds: [pokeso.id, tb.id] }));
    expect(r.ok && r.errors).toBe(2);
    expect(await sourceOf("pokeso")).toMatchObject({ status: "blocked" });
    expect((await sourceOf("pokeso")).error_message).toContain("回避しません");
    expect(await sourceOf("トレカ日和")).toMatchObject({ status: "needs_setup", last_item_count: 0 });
    // 片方が失敗しても、もう片方は処理される
    const r2 = await runCollection(deps({ list: (u) => (u.includes("pokeso") ? { ok: false, code: "network", message: "x" } : ok(u, html(`<a href="https://shop-c.example.invalid/lottery/c1">ポケモンカード 抽選 受付中</a>`))), onlySourceIds: [pokeso.id, tb.id] }));
    expect(r2.ok && r2.sources.map((s) => s.status).sort()).toEqual(["error", "ok"]);
    await u1.from("collection_sources").update({ enabled: false }).eq("kind", "web");
  });

  it("X: 無効・予算0円・キー未設定の間は1回もAPIを呼ばない。予算を設定して初めて取得し、同じ投稿は再解析しない", async () => {
    await u1.from("collection_sources").update({ enabled: false }).eq("kind", "web");
    await u1.from("collection_sources").update({ enabled: true }).eq("kind", "x");
    xCalls = 0;
    const posts = [
      { id: "900000000000000002", text: "【抽選】ポケモンカード 拡張パック サンプル電機 三宮店で抽選販売。応募はこちら" },
      { id: "900000000000000001", text: "今日のランチはカレーでした" },
    ];
    // 無効
    let r = await runCollection(deps({ xClient: fakeX(posts) }));
    expect(r.ok && r.sources.every((s) => s.status === "disabled")).toBe(true);
    // 有効だが予算0円
    await setSettings({ x_enabled: true, x_monthly_budget_jpy: 0 });
    r = await runCollection(deps({ xClient: fakeX(posts) }));
    expect(r.ok && r.sources.every((s) => s.status === "error")).toBe(true);
    expect(xCalls).toBe(0);
    // 予算あり・キー未設定
    await setSettings({ x_monthly_budget_jpy: 3000 });
    r = await runCollection(deps({ xClient: null }));
    expect(r.ok && r.sources.every((s) => s.status === "not_configured")).toBe(true);
    expect(xCalls).toBe(0);
    // 予算あり・キーあり: 取得 → 抽選らしい投稿だけ候補（ユーザーIDも保存）
    r = await runCollection(deps({ xClient: fakeX(posts) }));
    expect(r.ok && r.xPosts).toBeGreaterThan(0);
    expect(xCalls).toBeGreaterThan(0);
    const x = await sourceOf("pokecachan");
    expect(x).toMatchObject({ status: "ok", x_user_id: "1234567890", x_since_id: "900000000000000002" });
    const xc = (await cands()).filter((c) => c.dedupe_key.startsWith("x:9000"));
    expect(xc.map((c) => c.dedupe_key)).toEqual(expect.arrayContaining(["x:900000000000000002"]));
    expect(xc.some((c) => c.dedupe_key === "x:900000000000000001")).toBe(false); // 抽選と無関係な投稿は対象外
    // 同じ投稿を再度取得しても、候補は増えずAIも呼ばない
    const before = (await cands()).length;
    const r2 = await runCollection(deps({ xClient: fakeX(posts) }));
    expect((await cands()).length).toBe(before);
    expect(r2.ok && r2.aiCalls).toBe(0);
    // 月額予算の上限に達したら止まる
    await setSettings({ x_monthly_budget_jpy: 1 });
    const calls = xCalls;
    const r3 = await runCollection(deps({ xClient: fakeX(posts) }));
    expect(r3.ok && r3.sources.some((s) => s.message.includes("予算"))).toBe(true);
    expect(xCalls).toBe(calls);
    await setSettings({ x_enabled: false });
  });

  it("定期実行（ログインなし）は候補の作成まで: 登録はしない。無効な世帯・多重実行は実行しない", async () => {
    // 同時に1つだけ
    const run = await u1.from("collection_runs").insert({ household_id: hid, trigger: "manual" }).select("id").single();
    const dup = await runCollection(deps());
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.code).toBe("already_running");
    await u1.from("collection_runs").update({ status: "done" }).eq("id", run.data!.id);

    const pokeso = await sourceOf("pokeso");
    await u1.from("collection_sources").update({ enabled: true }).eq("id", pokeso.id);
    // 別の店舗の告知（新しい抽選）を、サービスロールの接続（ログインなし）で収集
    // 定期実行は取得間隔(既定24時間)を守る: 直近に取得した収集元は飛ばし、間隔が過ぎたものだけ実行する
    const skipped = await runCollection(deps({ db: admin as unknown as Db, trigger: "cron", actor: null, canRegister: false, list: () => ok("https://pokeso.jp/chusen", html("<a href=\"https://shop-d.example.invalid/lottery/d0\">ポケモンカード 抽選 受付中</a>")), onlySourceIds: [pokeso.id] }));
    expect(skipped.ok && skipped.sources).toHaveLength(0);
    await u1.from("collection_sources").update({ last_attempt_at: "2020-01-01T00:00:00Z" }).eq("id", pokeso.id);
    const lotsBefore = (await lotteries()).length;
    const cron = await runCollection(deps({ db: admin as unknown as Db, trigger: "cron", actor: null, canRegister: false, list: () => ok("https://pokeso.jp/chusen", html(`<a href="https://shop-d.example.invalid/lottery/d1">ポケモンカード 抽選 受付中</a>`)), onlySourceIds: [pokeso.id] }));
    expect(cron.ok).toBe(true);
    const d1 = (await cands()).find((c) => c.dedupe_key.endsWith("/d1"))!;
    expect(["pending", "duplicate"], JSON.stringify({ s: d1.status, r: d1.reasons })).toContain(d1.status);
    expect(d1.status === "pending" ? (d1.draft as { ready?: boolean }).ready : true).toBe(true);
    expect((await lotteries()).length).toBeLessThanOrEqual(lotsBefore);
  });

  it("定期実行（ログインなし）でも、サービス用の登録関数で条件に一致した抽選を自動登録する（重複作成・★管理への自動追加はしない）", async () => {
    const pokeso = await sourceOf("pokeso");
    await u1.from("collection_sources").update({ enabled: true, last_attempt_at: "2020-01-01T00:00:00Z" }).eq("id", pokeso.id);
    const list = () => ok("https://pokeso.jp/chusen", html(`<a href="https://shop-d.example.invalid/lottery/d2">ポケモンカード 抽選 受付中</a>`));
    // 既存の抽選と重複しないよう、商品名だけ別の（架空の）新商品に変えたAI結果を返す
    const base = getExtractor({ AI_PROVIDER: "mock" })!;
    const variant = { engine: base.engine, extract: async (req: Parameters<typeof base.extract>[0]) => { const o = await base.extract(req); const raw = JSON.parse(JSON.stringify(o.raw)) as { products: { name: string }[] }; raw.products[0].name = "架空の新商品ZZ"; return { ...o, raw }; } } as typeof base;
    const before = (await lotteries()).length;
    const r1 = await runCollection(deps({ db: admin as unknown as Db, trigger: "cron", actor: null, canRegister: false, serviceRegister: true, extractor: variant, list, onlySourceIds: [pokeso.id] }));
    expect(r1.ok).toBe(true);
    const d2 = (await cands()).find((c) => c.dedupe_key.endsWith("/d2"))!;
    expect(d2.status, JSON.stringify({ s: d2.status, r: d2.reasons })).toBe("auto_registered");
    {
      expect((await lotteries()).length).toBe(before + 1);
      const lot = await admin.from("lotteries").select("source_kind,is_new").eq("id", d2.lottery_id!).single();
      expect(lot.data).toMatchObject({ source_kind: "auto", is_new: true });
      const mg = await admin.from("lottery_management").select("is_managed").eq("lottery_id", d2.lottery_id!).maybeSingle();
      expect(mg.data?.is_managed ?? false).toBe(false);
    }
    // 一般の利用者（ログイン中）は、サービス専用の登録関数を呼べない
    const denied = await u1.rpc("save_lottery_tx_as", { p: {} as never, p_actor: null as never, p_household: hid });
    expect(denied.error).not.toBeNull();
    // 同じ一覧を再収集しても重複して登録しない
    await u1.from("collection_sources").update({ last_attempt_at: "2020-01-01T00:00:00Z" }).eq("id", pokeso.id);
    const after = (await lotteries()).length;
    await runCollection(deps({ db: admin as unknown as Db, trigger: "cron", actor: null, canRegister: false, serviceRegister: true, extractor: variant, list, onlySourceIds: [pokeso.id] }));
    expect((await lotteries()).length).toBe(after);
  });

  it("解析待ちは、AI読み取りの前に一覧の表示で絞り込み、締切が近い順に上限まで解析し、収集のたびに減る。済んだものは再解析しない", async () => {
    const pokeso = await sourceOf("pokeso");
    await u1.from("collection_sources").update({ enabled: true }).eq("id", pokeso.id);
    await setSettings({ max_ai_per_run: 2 });
    const a = (u: string, t: string) => `<a href="https://shop-q.example.invalid/lottery/${u}">ポケモンカード 抽選 ${t}</a>`;
    const listHtml = html(
      [
        a("end1", "1/10(日) 20:00まで 兵庫県・LivePocket"), // 締切済み
        a("end2", "1/14(木) 23:00まで 大阪府・LivePocket"), // 締切済み
        a("pref", "1/22(金) 20:00まで 愛知県・LivePocket"), // 対象外の地域
        a("late", "1/25(月) 20:00まで 兵庫県・LivePocket"),
        a("mid", "1/20(水) 20:00まで 兵庫県・LivePocket"),
        a("soon", "1/18(月) 20:00まで 兵庫県・LivePocket"),
      ].join("<div></div>"),
    );
    // 過去の版で溜まった解析待ち（一覧の読み取り結果を持たない）も、次の収集で見直される
    await u1.from("collection_candidates").insert({ household_id: hid, source_id: pokeso.id, dedupe_key: "https://shop-q.example.invalid/lottery/old", source_url: "https://shop-q.example.invalid/lottery/old", title: "old", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: "https://shop-q.example.invalid/lottery/old", title: "応募する", context: "1/9(土) 20:00まで 兵庫県・LivePocket", sourceName: "pokeso", attempts: 0 } } } as never);

    pagesFetched = [];
    const r1 = await runCollection(deps({ list: () => ok("https://pokeso.jp/chusen", listHtml), onlySourceIds: [pokeso.id] }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.screened).toBe(4); // 締切済み3件（過去の版の分を含む）＋対象外の地域1件。AIは使っていない
    expect(r1.aiCalls).toBe(2); // 上限(2件)まで
    expect(pagesFetched.map((u) => u.split("/").pop()).sort()).toEqual(["mid", "soon"]); // 締切が近い順（1/18, 1/20）
    expect(r1.queued).toBe(1);
    let c = await cands();
    const by = (k: string) => c.find((x) => x.dedupe_key.endsWith("/" + k))!;
    for (const k of ["end1", "end2", "pref", "old"]) expect(by(k).status, k).toBe("excluded");
    expect(by("end1").reasons[0]).toContain("締切");
    expect(by("pref").reasons[0]).toContain("愛知県");
    expect((by("late").draft as { queued?: unknown }).queued).toBeTruthy(); // 締切が遠いものは次回

    // 次の収集: 残りの1件だけを解析する（解析済み・除外済みは再取得も再解析もしない）
    pagesFetched = [];
    const r2 = await runCollection(deps({ list: () => ok("https://pokeso.jp/chusen", listHtml), onlySourceIds: [pokeso.id] }));
    expect(r2.ok && r2.newCount).toBe(0);
    expect(r2.ok && r2.aiCalls).toBe(1);
    expect(r2.ok && r2.queued).toBe(0);
    expect(pagesFetched.map((u) => u.split("/").pop())).toEqual(["late"]);
    // さらに収集しても何も起きない
    pagesFetched = [];
    const r3 = await runCollection(deps({ list: () => ok("https://pokeso.jp/chusen", listHtml), onlySourceIds: [pokeso.id] }));
    expect(r3.ok && r3.aiCalls).toBe(0);
    expect(pagesFetched).toHaveLength(0);
    c = await cands();
    expect(c.filter((x) => (x.draft as { queued?: unknown } | null)?.queued && x.status === "pending")).toHaveLength(0);
    await setSettings({ max_ai_per_run: 8 });
  });

  it("世帯の分離: 他の世帯のユーザーは収集元・候補・履歴を読めず、変更できない", async () => {
    expect(((await u2.from("collection_sources").select("id")).data ?? []).length).toBe(0);
    expect(((await u2.from("collection_candidates").select("id")).data ?? []).length).toBe(0);
    expect(((await u2.from("collection_runs").select("id")).data ?? []).length).toBe(0);
    const mine = (await u1.from("collection_sources").select("id").limit(1)).data![0].id;
    const upd = await u2.from("collection_sources").update({ name: "乗っ取り" }).eq("id", mine).select("id");
    expect(upd.data ?? []).toHaveLength(0);
    const ins = await u2.from("collection_sources").insert({ household_id: hid, kind: "web", name: "x", url: "https://example.invalid/" } as never);
    expect(ins.error).not.toBeNull();
    expect(hid2).not.toBe(hid);
  });
});
