/**
 * Phase 2（画像の実運用・安全化）: 画像の取得 → 検査 → 解析入力 → 根拠/未確認 → 保存 → AI調査 → 登録案 の通し（ローカルのSupabase・モック・費用0。実AI・Web・X APIは呼ばない）。
 * 画像は全てテスト内で生成した架空の画像。取得は fetchBytes の差し替え（ネットワークに出ない）で、**実際の検証コード（形式判定・sharp・サイズ/ピクセル・robots・失敗分類）は通る**。
 *  ①画像だけに条件がある: 黙って排除せず「画像のみ・原本未照合」として観察に残り、登録案の引用の根拠にはならない
 *  ②失敗の分類と再試行: 期限切れ・robots・偽装は保存して再取得しない／タイムアウトは保存せず次回再試行
 *  ③鮮度・差し替え: 期間を過ぎた結果は画像を取り直し、内容が同じなら再利用・違えば再解析。モックの結果は実解析（real）として使わない
 *  ④権限・追記専用
 */
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { makeFetchingMockVision } from "@/lib/judgment/xsource/vision-mock";
import { mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import { clearRobotsCache, fetchPublicImage } from "@/lib/server/images/image-fetch";
import type { Db } from "@/lib/server/lottery-service";
import { generateProposalsForCandidate, mockDeps, type CandidateRow } from "@/lib/server/proposals/generate";
import { loadImageObservation } from "@/lib/server/proposals/experience-store";
import type { SafeBytesResult } from "@/lib/server/safe-fetch";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const BASE = "https://p2vis.example.invalid";
const SHOP = "https://shop-a.example.invalid/e/1";
const IMG = (n: number) => `https://img.p2vis.example.invalid/${n}.png`;
const PAGE = "【新宿本店】拡張パック 抽選受付\n受付期間は告知をご確認ください。お一人様1回まで。店頭受取のみ。";
const POST = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 詳細は画像をご覧ください https://t.co/aaa111";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!dbTestsEnabled)("Phase 2: 画像の取得→解析入力→保存→調査→登録案", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;
  let u1: Db;
  let u2: Db;
  let n = 0;
  const files = new Map<string, Buffer | { fail: "timeout" | "404" | "type"; body?: Buffer }>();
  const fetched: string[] = [];
  const fetchBytes = async (url: string): Promise<SafeBytesResult> => {
    fetched.push(url);
    const v = files.get(url);
    if (!v) return { ok: false, code: "http_error", status: 404, message: "nf" };
    if (Buffer.isBuffer(v)) return { ok: true, finalUrl: url, status: 200, contentType: "image/png", bytes: v, truncated: false };
    if (v.fail === "timeout") return { ok: false, code: "timeout", message: "t" };
    if (v.fail === "404") return { ok: false, code: "http_error", status: 404, message: "nf" };
    return { ok: true, finalUrl: url, status: 200, contentType: "image/png", bytes: v.body ?? Buffer.from("<html></html>"), truncated: false }; // 申告PNG・中身HTML
  };
  const fetchImage = (u: string, extra: { fetchRobots?: (x: string) => Promise<string | null> } = {}) => fetchPublicImage(u, { fetchBytes, fetchRobots: extra.fetchRobots ?? (async () => null), sleep: async () => undefined });
  const png = (c: string, w = 60) => sharp({ create: { width: w, height: 40, channels: 3, background: c } }).png().toBuffer();

  const add = async (text: string, extra: Record<string, unknown>): Promise<CandidateRow> => {
    n++;
    const url = `${BASE}/${n}`;
    const ev = buildEvidence({ url, kind: "x_post", post: { text, links: [], linkMap: [{ short: "https://t.co/aaa111", url: SHOP }] }, linkedPages: [{ url: SHOP, text: PAGE }], ...extra } as never, new Date().toISOString());
    const { data, error } = await admin.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(970000000 + n), title: `p2v-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: ev } as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const seenBy = () => {
    const seen: string[] = [];
    const agent: typeof mockResearchAgent = async (i) => {
      seen.push(JSON.stringify(i.evidence.map((e) => e.observations)));
      return mockResearchAgent(i);
    };
    return { seen, agent };
  };
  const rowsOf = async (id: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", id).is("superseded_at", null).order("item_no")).data ?? []) as Record<string, any>[];
  const obsOf = async (id: string) => ((await admin.from("evidence_image_observations").select("*").eq("candidate_id", id).order("image_index")).data ?? []) as Record<string, any>[];
  const run = (c: CandidateRow, deps: Parameters<typeof mockDeps>[0]) => generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c, env: ENV, deps: mockDeps(deps) });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p2vis", 1);
    const b = await signInTestUser(admin, "p2vis", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    files.set(IMG(1), await png("#fff"));
    files.set(IMG(2), await png("#eee", 80));
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${BASE}/%`);
    await cleanupTestUsers(admin, userIds);
  });

  it("①条件が画像だけにある: 黙って排除せず『画像のみ・原本未照合』として観察に残る。登録案の引用の根拠にはならず、読み取りは仮説のまま", async () => {
    const c = await add(POST, { imageRefs: [IMG(1)], imageReadings: [] });
    const calls: unknown[] = [];
    const vision = makeFetchingMockVision({ fetchImage, table: { [IMG(1)]: [{ field: "応募期間", text: "12/20 23:59まで", region: "画像の上部", uncertainty: "low" }, { field: "応募単位（店舗選択・商品ごと）", text: "お一人様1店舗のみ応募可", region: "右下の注意書き" }] }, calls: calls as never });
    const { seen, agent } = seenBy();
    const r = await run(c, { agent, vision });
    expect(r.ok).toBe(true);
    const all = seen.join("\n");
    expect(all).toMatch(/画像1枚目\(IMG1-[0-9a-f]{8}\)・応募期間「12\/20 23:59まで」は画像のみの情報/);
    expect(all).toContain("原本と未照合・事実として確定しない");
    expect(all).toContain("お一人様1店舗のみ応募可");
    const rows = await rowsOf(c.id);
    expect(rows.length).toBeGreaterThan(0); // 画像の情報があっても、登録案から排除されない
    // 画像の読み取りは引用の根拠にならない（原文の引用として登録されない）
    for (const row of rows) for (const f of Object.values(row.fields ?? {}) as any[]) expect(String(f?.quote ?? "")).not.toContain("12/20 23:59まで");
    const obs = await obsOf(c.id);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ status: "analyzed", mode: "mock", width: 60, height: 40, tiles: 1 });
    expect(obs[0].content_sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(obs[0].image_url).not.toContain("base64");
    expect(JSON.stringify(obs[0])).not.toContain("iVBOR"); // 画像データ（PNGのbase64）は保存しない
  });

  it("②失敗の分類と再試行: 期限切れ・偽装・robots は保存して再取得しない／タイムアウトは保存せず次回再試行。『無い』ではなく『確認できていない』理由が残る", async () => {
    files.set(IMG(10), { fail: "404" });
    files.set(IMG(11), { fail: "type" });
    files.set(IMG(12), { fail: "timeout" });
    files.set(IMG(13), await png("#ddd"));
    const c = await add(POST, { imageRefs: [IMG(10), IMG(11), IMG(12), IMG(13)], imageReadings: [] });
    clearRobotsCache();
    const robots = async (u: string) => (u.includes("/robots.txt") && u.includes("img.p2vis") ? "User-agent: *\nDisallow: /13.png\n" : null);
    const vision = makeFetchingMockVision({ fetchImage: (u) => fetchImage(u, { fetchRobots: robots }), table: {} });
    const { seen, agent } = seenBy();
    await run(c, { agent, vision });
    const obs = await obsOf(c.id);
    expect(obs.map((o) => [o.image_index, o.status, o.failure_reason])).toEqual([
      [1, "failed", "not_found"],
      [2, "failed", "spoofed_type"],
      [4, "failed", "robots"],
    ]); // 3（タイムアウト）は保存しない
    const text = seen.join("\n");
    expect(text).toContain("画像が見つからない");
    expect(text).toContain("申告と中身の形式が一致しない");
    expect(text).toContain("サイトが取得を許可していない");
    expect(text).toContain("取得がタイムアウト");
    expect(text).toContain("「無い」ではなく未確認");
    // 再実行: 保存済みの失敗は再取得しない／タイムアウトだけ再取得
    fetched.length = 0;
    await run(c, { agent, vision });
    expect(fetched.filter((u) => u === IMG(10) || u === IMG(11))).toHaveLength(0);
    expect(fetched.filter((u) => u === IMG(12)).length).toBeGreaterThan(0);
  });

  it("③鮮度・差し替え・モード分離: 期間を過ぎた結果は画像を取り直し、内容が同じなら再利用・違えば再解析。モックの結果は real として使わない。同じURLの重複は1回だけ解析", async () => {
    const c = await add(POST, { imageRefs: [IMG(2), IMG(2)], imageReadings: [] });
    const calls: { imageUrl: string }[] = [];
    const vision = makeFetchingMockVision({ fetchImage, table: { [IMG(2)]: [{ field: "対象店舗", text: "新宿本店のみ" }] }, calls: calls as never });
    await run(c, { vision });
    expect(calls).toHaveLength(1); // 同じURLが2回あっても解析は1回
    expect(await obsOf(c.id)).toHaveLength(1);
    // モックの結果は実解析（real）では見えない・mock では見える
    expect(await loadImageObservation(admin as unknown as Db, hid, c.id, IMG(2), "real")).toBeNull();
    expect((await loadImageObservation(admin as unknown as Db, hid, c.id, IMG(2), "mock"))?.stale).toBe(false);
    // 期間内の再実行: 取得も解析もしない（保存済みを再利用）
    fetched.length = 0;
    calls.length = 0;
    await run(c, { vision });
    expect(fetched).toHaveLength(0);
    expect(calls).toHaveLength(0);
    // 期間（7日）を過ぎた行を作る（追記専用なので、古い観察日時の行を別の内容ハッシュで直接追加し、現在の行を「古い」ものとして扱うため日時を比較する）
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const cur = (await obsOf(c.id))[0];
    const c2 = await add(POST, { imageRefs: [IMG(2)], imageReadings: [] });
    await admin.from("evidence_image_observations").insert({ household_id: hid, candidate_id: c2.id, image_url: IMG(2), url_key: cur.url_key, image_index: 1, status: "analyzed", content_sha256: cur.content_sha256, readings: [{ field: "対象店舗", text: "古い読み取り" }], mode: "mock", observed_at: old });
    fetched.length = 0;
    calls.length = 0;
    await run(c2, { vision });
    expect(fetched).toEqual([IMG(2)]); // 期間を過ぎたので画像を取り直した
    expect(calls).toHaveLength(0); // 内容（ハッシュ）が同じなので、解析は重ねない
    // 内容が差し替えられた（同じURLで別の画像）: 再解析し、別の行として追記される
    const c3 = await add(POST, { imageRefs: [IMG(2)], imageReadings: [] });
    await admin.from("evidence_image_observations").insert({ household_id: hid, candidate_id: c3.id, image_url: IMG(2), url_key: cur.url_key, image_index: 1, status: "analyzed", content_sha256: "0123456789abcdef", readings: [{ field: "対象店舗", text: "差し替え前の読み取り" }], mode: "mock", observed_at: old });
    calls.length = 0;
    await run(c3, { vision });
    expect(calls).toHaveLength(1);
    expect((await obsOf(c3.id)).length).toBe(2);
  });

  it("④権限・追記専用: 構成員だけが読める・他世帯は読めない・利用者は書けない・更新できない", async () => {
    const from = (db: Db, t: string) => (db as unknown as { from: (t: string) => any }).from(t);
    expect(((await from(u1, "evidence_image_observations").select("id").eq("household_id", hid)).data ?? []).length).toBeGreaterThan(0);
    expect(((await from(u2, "evidence_image_observations").select("id").eq("household_id", hid)).data ?? []).length).toBe(0);
    const one = (await admin.from("evidence_image_observations").select("*").eq("household_id", hid).limit(1)).data![0];
    const rest: Record<string, unknown> = { ...one };
    delete rest.id;
    delete rest.created_at;
    expect((await from(u1, "evidence_image_observations").insert({ ...rest, url_key: "x" })).error).not.toBeNull();
    expect((await admin.from("evidence_image_observations").update({ status: "unreadable" }).eq("id", one.id)).error).not.toBeNull();
    expect((await admin.from("evidence_image_observations").delete().eq("id", one.id)).error).toBeNull(); // 候補の削除に伴う削除は cascade（直接の削除は管理者権限のみ）
  });
});
