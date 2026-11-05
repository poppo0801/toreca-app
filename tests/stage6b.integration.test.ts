/**
 * Stage 6B: X投稿の収集・画像解析・保存情報の再利用・公式アカウントの対応づけ・取得制限の代替・保留判定（実Supabase・RLS適用下。AI・X API・外部サイトはモック）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import { rebuildQueued } from "@/lib/collector/queued";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, runCollection, type CollectDeps } from "@/lib/server/collector/run";
import { runHoldPass } from "@/lib/server/collector/hold";
import { altPlanFor, recordHardSource } from "@/lib/server/collector/sources-health";
import type { XClient } from "@/lib/server/collector/x-client";
import type { XPost } from "@/lib/collector/x-posts";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const png = { mediaType: "image/png" as const, base64: "iVBORw0KGgo=", bytes: 8 };

describe.skipIf(!dbTestsEnabled)("Stage 6B", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let aiInputs: { text?: string; images?: number }[] = [];
  let chainId: string;
  let storeId: string;

  const mock = () => ({
    engine: "mock" as const,
    extract: async (r: { text?: string; images?: unknown[] }) => {
      aiInputs.push({ text: r.text, images: r.images?.length ?? 0 });
      return getExtractor({ AI_PROVIDER: "mock" })!.extract(r as never);
    },
  });
  const mkPost = (id: string, o: Partial<XPost> = {}): XPost => ({ id, text: "", createdAt: NOW.toISOString(), authorId: "u1", url: `https://x.com/q6b_agg/status/${id}`, username: "q6b_agg", images: [], links: [], refs: [], ...o });
  const xClient = (posts: XPost[]): XClient => ({
    lookupUser: async () => ({ ok: true, id: "1", username: "q6b_agg" }),
    userPosts: async () => ({ ok: true, posts, newestId: posts[0]?.id ?? null }),
    getPost: async (id, username) => ({ ok: true, post: mkPost(id, { username, url: `https://x.com/${username}/status/${id}`, text: "【ポケカ抽選情報】 テスト玩具 本店 応募期間 11/20 21:00まで", images: ["https://pbs.twimg.com/q6b-refetched.png"] }) }),
  });
  const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: NOW, actor: null, canRegister: false, serviceRegister: true, extractor: mock() as never, xClient: null,
    fetchPage: async () => ({ ok: false, code: "network", message: "x" }), fetchOembed: async () => ({ ok: false, message: "x" }), fetchImage: (async () => png) as never, ...over,
  });
  const run = async (d: CollectDeps) => processQueue(d, { settings: { auto_register: false }, cond: DEFAULT_CONDITIONS, data: await loadAppData(sys, hid), aiLeft: 20, timeLeft: () => 50_000, perBatch: 4 });
  const cand = async (key: string) => (await sys.from("collection_candidates").select("id,status,job_state,reasons,draft,fail_kind,triage,hold_count,memo_id").eq("household_id", hid).eq("dedupe_key", key).maybeSingle()).data!;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6b", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false, x_enabled: true, x_monthly_budget_jpy: 2000, x_max_posts_per_run: 50 });
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "テスト玩具" }).select("id").single()).data!.id;
    storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "本店", prefecture: "東京都" }).select("id").single()).data!.id;
    await u1.from("collection_sources").insert({ household_id: hid, kind: "x", name: "q6b_agg", x_username: "q6b_agg", adapter: "x" });
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "x:q6b%");
    await sys.from("collection_candidates").delete().like("dedupe_key", "x:910%");
    await cleanupTestUsers(admin, userIds);
  });

  // ------------------------------------------------------------ 原因の再現: 絵文字の途中で切った題名が一括保存を全滅させる
  it("原因の再現: 孤立サロゲートを含む行が1件あると、一括保存はバッチ全体が失敗する（修正前の挙動）", async () => {
    const bad = "x".repeat(79) + "🎯当選".slice(0, 1);
    expect(bad.charCodeAt(79)).toBeGreaterThanOrEqual(0xd800);
    const mk = (n: string, title: string) => ({ household_id: hid, dedupe_key: `x:q6b-raw-${n}`, source_url: `https://x.com/a/status/${n}`, title, status: "pending", job_state: "pending", reasons: ["解析待ち"] });
    const batch = await sys.from("collection_candidates").upsert([mk("1", "ok"), mk("2", bad)] as never, { onConflict: "household_id,dedupe_key", ignoreDuplicates: true }).select("id");
    expect(batch.error).not.toBeNull(); // 1件の不正な文字列のために、正常な行も保存されない
    expect((await sys.from("collection_candidates").select("id").eq("household_id", hid).eq("dedupe_key", "x:q6b-raw-1")).data ?? []).toHaveLength(0);
  });

  // ------------------------------------------------------------ 収集: 画像中心の投稿を候補化し、各段階の件数を記録する
  it("X収集: 絵文字を含む題名でも全件保存され、画像だけの投稿・引用投稿を候補化し、対象外を数える。各段階の件数が記録される", async () => {
    const emojiText = "【ポケカ抽選情報】" + "あ".repeat(66) + "🎯当選発表 11月23日";
    const posts: XPost[] = [
      mkPost("910100", { text: emojiText, images: ["https://pbs.twimg.com/q6b-1.png", "https://pbs.twimg.com/q6b-2.png"] }),
      mkPost("910101", { text: "⚡🎯 https://t.co/abc", images: ["https://pbs.twimg.com/q6b-3.png"] }),
      mkPost("910102", { text: "こちら注目⚡", quoted: { id: "9", username: "shop_official", text: "ポケモンカード 拡張パックの抽選販売を実施します 11/8 10:00〜", createdAt: NOW.toISOString(), images: ["https://pbs.twimg.com/q6b-q.png"], links: [] } }),
      mkPost("910103", { text: "遊戯王の新弾が発売", images: ["https://pbs.twimg.com/q6b-4.png"] }),
      mkPost("910104", { text: "今日は天気が良くて散歩に行きました。公園でたくさんの花を見て、とても気持ちの良い一日でした。夕飯は何にしようか考え中です。", images: ["https://pbs.twimg.com/q6b-5.png"] }),
    ];
    const r = await runCollection(deps({ extractor: null, xClient: xClient(posts), onlySourceIds: undefined }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rep = r.sources.find((s) => s.name === "q6b_agg")!;
    expect(rep.status, rep.message).toBe("ok");
    expect(rep.funnel).toMatchObject({ fetched: 5, saved: 3, saveFailed: 0, withImages: 5, withQuote: 1 });
    expect(rep.funnel?.passed).toEqual({ text: 1, image: 1, quote: 1, link: 0 });
    expect(rep.funnel?.skipped).toMatchObject({ other_tcg: 1, no_signal: 1 });
    for (const id of ["910100", "910101", "910102"]) expect(await cand(`x:${id}`)).toBeTruthy();
    const att = (await sys.from("collection_source_attempts").select("message,status,items,new_count").eq("household_id", hid)).data!;
    expect(att[0].message).toContain("解析対象3件");
    expect(att[0].new_count).toBe(3);
  });

  // ------------------------------------------------------------ 解析: 画像・引用元をAIへ渡し、取得状況と抽出結果を草稿に保持する
  it("X解析: 複数画像と引用元の本文・画像がAIに渡り、投稿の情報（画像の扱い・画像から読み取れた項目）が解析後の草稿に残る", async () => {
    aiInputs = [];
    await run(deps());
    const a = await cand("x:910100");
    const x = (a.draft as { xpost?: Record<string, unknown> }).xpost as { id: string; images: string[]; imageStats: { found: number; fetched: number; sent: number }; basis: string; text: string };
    expect(x).toMatchObject({ id: "910100", imageStats: { found: 2, fetched: 2 }, basis: "text" });
    expect(x.images).toHaveLength(2);
    expect(x.text).toContain("🎯当選発表");
    const q = await cand("x:910102");
    const xq = (q.draft as { xpost?: { quoted?: { username: string; images: string[] }; imageStats: { found: number } } }).xpost!;
    expect(xq.quoted).toMatchObject({ username: "shop_official" });
    expect(xq.imageStats.found).toBe(1); // 引用元の画像
    // AIに渡った入力: 引用元の本文を含む、画像が付く
    const sentQuote = aiInputs.find((i) => (i.text ?? "").includes("【引用元の投稿（@shop_official）】"));
    expect(sentQuote?.images).toBe(1);
    expect(aiInputs.some((i) => i.images === 2)).toBe(true);
    // 解析の実行理由が記録される
    const reasons = (await sys.from("ai_extraction_logs").select("trigger_reason,actor_kind").eq("household_id", hid)).data!;
    expect(reasons.length).toBeGreaterThan(2);
    expect(reasons.every((r) => r.actor_kind === "system" && r.trigger_reason === "initial")).toBe(true);
  });

  it("画像が情報の中心の投稿で画像を1枚も取得できないときは、本文だけで有料のAI解析をしない（再試行待ちにする）", async () => {
    aiInputs = [];
    await sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: "x:910200", source_url: "https://x.com/q6b_agg/status/910200", x_post_id: "200", title: "t", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "x_post", url: "https://x.com/q6b_agg/status/910200", title: "t", context: "", sourceName: "q6b_agg", attempts: 0, relevanceBasis: "image", post: { id: "200", text: "⚡", images: ["https://pbs.twimg.com/q6b-gone.png"], links: [], createdAt: NOW.toISOString(), username: "q6b_agg" } } } as never });
    await run(deps({ fetchImage: (async () => null) as never, xClient: null }));
    expect(aiInputs).toHaveLength(0);
    const c = await cand("x:910200");
    expect(c.fail_kind).toBe("image");
    expect(c.job_state).toBe("retry");
  });

  it("保存済みの画像URLが使えないときは、1回だけX APIで投稿を取り直して解析する（取り直した画像で情報を読み取る）", async () => {
    aiInputs = [];
    await sys.from("collection_candidates").update({ job_state: "pending", next_run_at: null, attempts: 0, status: "pending" }).eq("dedupe_key", "x:910200");
    let calls = 0;
    const fetchImage = (async (u: string) => (u.includes("q6b-refetched") ? png : (calls++, null))) as never;
    await run(deps({ fetchImage, xClient: xClient([]) }));
    expect(calls).toBeGreaterThan(0);
    const c = await cand("x:910200");
    const x = (c.draft as { xpost?: { imageStats: { found: number; fetched: number }; via: string } }).xpost;
    expect(x?.imageStats).toMatchObject({ found: 1, fetched: 1 });
    expect(x?.via).toBe("api");
  });

  // ------------------------------------------------------------ 再解析: 保存済みの投稿情報を再利用する
  it("再解析: 保存済みの投稿（本文・画像URL・引用元）を使い、X APIで再取得しない", async () => {
    const c = await cand("x:910100");
    const queued = rebuildQueued(c.draft, { kind: "x_oembed", url: "https://x.com/q6b_agg/status/910100", sourceName: "再解析", reason: "manual_reanalyze", changed: true, fallbackTitle: "t" });
    expect(queued.kind).toBe("x_post");
    await sys.from("collection_candidates").update({ job_state: "pending", status: "pending", attempts: 0, next_run_at: null, draft: { ...(c.draft as object), queued } as never }).eq("id", c.id);
    let apiCalls = 0;
    const client: XClient = { ...xClient([]), getPost: async () => { apiCalls++; return { ok: false, code: "unknown", message: "呼ばれてはいけない" }; } };
    aiInputs = [];
    await run(deps({ xClient: client }));
    expect(apiCalls).toBe(0);
    expect(aiInputs.some((i) => i.images === 2)).toBe(true);
    const after = await cand("x:910100");
    expect((after.draft as { xpost?: unknown }).xpost).toBeTruthy();
  });

  // ------------------------------------------------------------ 公式アカウントの対応づけ
  it("公式Xアカウントの対応づけ: 世帯内のみ・まとめアカウントは登録できない。店舗が読み取れなかった投稿だけ補い、二次情報として残す", async () => {
    const ins = await u1.from("x_account_links").insert({ household_id: hid, username: "q6b_official", role: "official_store", store_id: storeId, chain_id: null });
    expect(ins.error).toBeNull();
    // 店舗の公式アカウントは店舗が必須／系列の公式アカウントは店舗を持てない
    expect((await u1.from("x_account_links").insert({ household_id: hid, username: "q6b_bad1", role: "official_store" })).error).not.toBeNull();
    expect((await u1.from("x_account_links").insert({ household_id: hid, username: "q6b_bad2", role: "official_chain", chain_id: chainId, store_id: storeId })).error).not.toBeNull();
    // 他の世帯からは見えない
    const other = await signInTestUser(admin, "s6b", 2);
    userIds.push(other.userId);
    await other.db.rpc("bootstrap_household");
    expect((await other.db.from("x_account_links").select("id")).data ?? []).toHaveLength(0);

    // 公式アカウント（q6b_official）の投稿。モックのAIが店舗名を返しても、対応先の店舗と食い違えば注意が残る
    await sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: "x:910300", source_url: "https://x.com/q6b_official/status/910300", x_post_id: "300", title: "t", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "x_oembed", url: "https://x.com/q6b_official/status/910300", title: "t", context: "", sourceName: "pokeso", attempts: 0 } } as never });
    await run(deps({ xClient: xClient([]), extractor: { engine: "mock", extract: async (r: never) => { const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r); const raw = JSON.parse(JSON.stringify(o.raw)) as { chain_name?: string; store_name?: string }; raw.chain_name = ""; raw.store_name = ""; return { ...o, raw }; } } as never }));
    const c = await cand("x:910300");
    const d = c.draft as { secondary?: string[]; input?: { chain: { name: string }; store: { name: string } } };
    expect(d.input?.store.name).toBe("本店");
    expect(d.input?.chain.name).toBe("テスト玩具");
    expect((d.secondary ?? []).join()).toContain("@q6b_official");
  });

  // ------------------------------------------------------------ 取得制限の代替
  it("取得制限が確定している応募サービスは、同じURLへ再アクセスせず最初から一覧の文章で読み取る。条件を満たさないときは従来どおり取得する", async () => {
    const host = "q6b-limited.example.invalid";
    const url = `https://${host}/a`;
    // 条件: 取得制限(robots)＋一覧文章による代替の成功2回以上＋直近の失敗
    expect((await altPlanFor(sys, hid, url, NOW)).skipFetch).toBe(false);
    for (let i = 0; i < 2; i++) await recordHardSource(sys, hid, NOW, { url, failKind: "robots", alt: { source: "list_text", ok: true } });
    expect((await altPlanFor(sys, hid, url, NOW)).skipFetch).toBe(true);
    expect((await altPlanFor(sys, hid, url, new Date(NOW.getTime() + 8 * 86_400_000))).skipFetch).toBe(false); // 7日後は取得を試し直す

    let fetched = 0;
    const card = "テスト商品 テスト玩具 本店 販売価格 ¥7,200 11/28(土) 21:00まで 東京都・店頭受取";
    await sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, title: "【抽選】テスト商品", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url, title: "【抽選】テスト商品", context: "テスト玩具 本店", card, fields: { store: "本店", product: "テスト商品" }, sourceName: "pokeso", attempts: 0 } } as never });
    await run(deps({ fetchPage: async () => { fetched++; return { ok: false, code: "robots", message: "robots" }; } }));
    expect(fetched).toBe(0); // 制限のURLへ再アクセスしない
    const c = await cand(url);
    expect((c.draft as { viaList?: boolean }).viaList).toBe(true);
    const rec = (await sys.from("collection_hard_sources").select("fail_count,alt_success,last_failed_at").eq("household_id", hid).eq("key", host).maybeSingle()).data!;
    expect(rec.alt_success).toBe(3); // 代替の成功だけを数え、失敗日時は更新しない
    expect(rec.fail_count).toBe(2);
  });

  // ------------------------------------------------------------ 保留判定
  it("保留判定: 取得失敗の原因・代替済み・優先収集メモが判定に渡る（代替でも得られない取得制限は、締切に余裕があっても手動確認へ）", async () => {
    const mk = (n: string, extra: Record<string, unknown>) =>
      sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: `x:q6b-hold-${n}`, source_url: `https://q6b-hold.example.invalid/${n}`, title: n, status: "pending", job_state: "review", kind: "new", reasons: ["店舗を確実に特定できません"], due_at: new Date(NOW.getTime() + 20 * 86_400_000).toISOString(), triage: "auto_retry", hold_count: 1, next_run_at: new Date(NOW.getTime() - 60_000).toISOString(), ...extra } as never);
    await mk("plain", {});
    await mk("alt", { fail_kind: "robots", draft: { viaList: true } });
    await runHoldPass(deps({ fetchPage: async () => ({ ok: false, code: "network", message: "x" }) }), { max: 10, timeLeft: () => 30_000 });
    const plain = await cand("x:q6b-hold-plain");
    const alt = await cand("x:q6b-hold-alt");
    expect(plain.triage).toBe("auto_retry"); // 締切に余裕があり、取得の問題でもない → 保留を続ける
    expect(alt.triage).toBe("manual"); // 取得制限＋代替でも不足 → 待っても変わらないので要手動確認
  });
});
