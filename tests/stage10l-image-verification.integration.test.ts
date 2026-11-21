/**
 * Stage 10L: 画像根拠の検証（元画像の独立した書き起こしとの照合）の統合テスト（ローカルのSupabase・RLS適用下。画像取得・書き起こし・判断のAIはすべて台本のモック。架空データのみ。実AI・課金なし）
 *   npm run test:db
 * 確認すること: ①照合できた画像の記載だけが fact の根拠になる（画像にしか書かれていない締切） ②誤った申告（日付違い等）・画像が取得できない・不鮮明は照合されず fact にならない
 * ③画像を毎回再解析しない（同じ画像ハッシュはキャッシュ）／画像が更新されたら再検証 ④費用は予算に含まれ、超えない ⑤RLS・追記専用・保持期限 ⑥書き込みは shadow_* のみ
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence, imageReadingsFromExtraction } from "@/lib/collector/evidence";
import type { JudgmentInput } from "@/lib/judgment/contract";
import type { Transcriber } from "@/lib/judgment/image-transcriber";
import { ScriptedModel } from "@/lib/judgment/model";
import { fetchXImage } from "@/lib/server/collector/x-client";
import type { Db } from "@/lib/server/lottery-service";
import { verifyImageReadings } from "@/lib/server/shadow/image-verifier";
import { runShadowWorker } from "@/lib/server/shadow/worker";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { rpc: (n: string, a?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>; from: (t: string) => any };
const L = (db: unknown): Loose => db as Loose;
const ENV_ON = { SHADOW_WORKER: "on" };
const NOW = new Date();
const TEXT = "ポケモンカード 拡張パック 抽選販売のお知らせ。応募方法・締切は画像をご確認ください";
const REF = (n: number) => `https://pbs.twimg.com/media/test${n}.jpg`;
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe.skipIf(!dbTestsEnabled)("Stage 10L: 画像根拠の検証（照合できた記載だけが fact の根拠）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hidA: string;
  const mk = (n: string) => `https://shadow10l.example.invalid/${n}`;

  const setSettings = async (over: Record<string, unknown> = {}) => {
    const { error } = await admin.from("shadow_settings").upsert({ household_id: hidA, enabled: true, enqueue_enabled: true, daily_budget_jpy: 10, monthly_budget_jpy: 100, per_case_cap_jpy: 3, max_jobs_per_run: 3, retention_days: 30, ...over });
    expect(error).toBeNull();
  };
  /** 画像の読み取り（申告）つきの候補を作る。claims: [項目, 抜粋]（出所は 画像1枚目） */
  const addCandidate = async (n: string, claims: [string, string][]) => {
    const ex = { evidence: Object.fromEntries(claims.map(([f, q]) => [f, { quote: q, source: "画像1枚目" }])), confidence: Object.fromEntries(claims.map(([f]) => [f, "high"])) as Record<string, string> };
    const stored = buildEvidence({ url: mk(n), kind: "x_post", post: { text: `${TEXT} (${n})`, links: [], images: [REF(1)] }, imageReadings: imageReadingsFromExtraction(ex, NOW.toISOString()), imageRefs: [REF(1)], imageStatus: "fetched" } as never, NOW.toISOString())!;
    const draft = { input: { chain: { name: "サンプル電機" }, store: { name: "三宮店" }, items: [{ product: { name: "拡張パック" } }], storeMode: "fixed" } };
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hidA, dedupe_key: mk(n), source_url: mk(n), title: n, status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: draft as never }).select("id").single();
    expect(error).toBeNull();
    return { id: data!.id as string, hash: stored.hash.slice(0, 32) };
  };
  const enqueue = async (c: { id: string; hash: string }) => (await L(u1).rpc("shadow_enqueue", { p_household: hidA, p_candidate: c.id, p_hash: c.hash })).data as boolean;
  const clean = async () => {
    for (const t of ["shadow_judgments", "shadow_image_verifications", "shadow_jobs"]) await admin.from(t).delete().eq("household_id", hidA);
    await admin.from("collection_candidates").delete().like("dedupe_key", "https://shadow10l.example.invalid/%");
  };
  /** 画像の取得・書き起こしのモック。lines: 書き起こす行。bytes: 画像の中身（ハッシュの元） */
  const rig = (opts: { lines: [string, "clear" | "unclear"][]; bytes?: () => string | null; cost?: number | null }) => {
    const calls = { fetch: 0, transcribe: 0 };
    const transcribe: Transcriber = async () => {
      calls.transcribe++;
      return { lines: opts.lines.map(([text, certainty]) => ({ text, certainty })), costJpy: opts.cost === undefined ? 0.4 : opts.cost, model: "scripted", promptVersion: "t" };
    };
    const fetchImage = async () => {
      calls.fetch++;
      const bytes = opts.bytes ? opts.bytes() : "image-bytes-v1";
      return bytes == null ? null : { mediaType: "image/png" as const, base64: b64(bytes), bytes: bytes.length };
    };
    const imageVerify = (a: Parameters<typeof verifyImageReadings>[1]) => verifyImageReadings({ db: admin as unknown as Db, fetchImage, transcribe }, a);
    return { calls, imageVerify };
  };
  /** 判断のモデル: 画像の記載から締切を fact として答える（引用先は、画像の根拠（kind）の evidenceId） */
  const modelCiting = (kind: "image_verified" | "image_reading", quote: string, seen: JudgmentInput[] = []) =>
    new ScriptedModel((i) => {
      seen.push(i);
      const ev = i.evidence.find((e) => e.kind === kind);
      return {
        raw: {
          version: "10e.2",
          caseType: { value: "lottery_announcement", basis: "fact", citations: [{ evidenceId: "E1", quote: "抽選販売のお知らせ" }] },
          structure: { kind: "one_form_one", basis: "inference", rationale: "テスト", citations: [] },
          opportunities: [{ key: "O1", label: "テスト", applyDeadline: { value: "2099-11-30 23:59", basis: "fact", citations: ev ? [{ evidenceId: ev.id, quote }] : [] } }],
          relations: [], plannedChanges: [], unresolved: [], nextActions: [{ kind: "none", reason: "テスト" }],
        },
        costJpy: 0.2,
      };
    }, undefined, 0.5);

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10l", 1);
    const b = await signInTestUser(admin, "s10l", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hidA = (await u1.rpc("bootstrap_household")).data as string;
    await (b.db as unknown as { rpc: (n: string) => Promise<unknown> }).rpc("bootstrap_household");
  });
  afterAll(async () => {
    await clean();
    await cleanupTestUsers(admin, userIds);
  });

  it("①照合できた画像の記載は fact の根拠になる（締切が画像にしか無い告知）。記録は画像ハッシュ・取得日時つきで残り、画像そのものは保存されない", async () => {
    await setSettings();
    const c = await addCandidate("v1", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    expect(await enqueue(c)).toBe(true);
    const { calls, imageVerify } = rig({ lines: [["抽選販売のご案内", "clear"], ["応募締切 11/30(月) 23:59", "clear"]] });
    const seen: JudgmentInput[] = [];
    const r = await runShadowWorker({ db: admin as unknown as Db, model: modelCiting("image_verified", "応募締切 11/30(月) 23:59", seen), env: ENV_ON, workerId: "w", imageVerify });
    expect(r).toMatchObject({ done: 1 });
    expect(r.byReason.image_verified).toBe(1);
    expect(calls).toEqual({ fetch: 1, transcribe: 1 });
    expect(seen[0].evidence.map((e) => e.kind ?? "post")).toEqual(["post", "image_verified"]);
    const rec = (await admin.from("shadow_judgments").select("status,record").eq("household_id", hidA)).data![0];
    expect(rec.status).toBe("accepted"); // 照合済みの画像の記載への引用の fact は検証を通る
    const v = (await admin.from("shadow_image_verifications").select("*").eq("household_id", hidA)).data!;
    expect(v).toHaveLength(1);
    expect(v[0].image_hash).toBe(createHash("sha256").update("image-bytes-v1").digest("hex"));
    expect(v[0]).toMatchObject({ image_index: 1, method: "blind_transcription", model_id: "scripted" });
    expect(JSON.stringify(v[0])).not.toContain("image-bytes-v1"); // 画像の中身は保存しない
    expect(JSON.stringify(v[0])).not.toContain("pbs.twimg.com"); // 取得元URLも記録しない（ハッシュと番号のみ）
    await clean();
  });

  it("②誤った申告（日付違い）・不鮮明・画像が取得できない場合は照合されず、これだけを根拠にした fact は検証層に拒否される", async () => {
    await setSettings();
    const wrong = await addCandidate("w1", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    const fuzzy = await addCandidate("w2", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    const none = await addCandidate("w3", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    for (const c of [wrong, fuzzy, none]) await enqueue(c);
    const results: Record<string, { reasons: Record<string, number>; status: string; codes: string[]; kinds: string[] }> = {};
    const scenarios: [string, ReturnType<typeof rig>][] = [
      ["w1", rig({ lines: [["応募締切 12/1(火) 23:59", "clear"]] })], // 画像の記載は別の日付＝申告は誤り
      ["w2", rig({ lines: [["応募締切 11/30(月) 23:59", "unclear"]] })], // 不鮮明
      ["w3", rig({ lines: [], bytes: () => null })], // 取得できない（期限切れ等）
    ];
    const byCand = new Map([["w1", wrong], ["w2", fuzzy], ["w3", none]]);
    for (const [n, rg] of scenarios) {
      // 1件ずつ処理するため、他の候補のジョブは一時的に確保されないよう後回しにする
      for (const [k, c] of byCand) await admin.from("shadow_jobs").update({ next_run_at: new Date(Date.now() + (k === n ? -1000 : 3_600_000)).toISOString() }).eq("candidate_id", c.id);
      const seen: JudgmentInput[] = [];
      const r = await runShadowWorker({ db: admin as unknown as Db, model: modelCiting("image_reading", "応募締切 11/30(月) 23:59", seen), env: ENV_ON, workerId: "w", imageVerify: rg.imageVerify, limit: 1 });
      const rec = (await admin.from("shadow_judgments").select("status,record").eq("household_id", hidA).order("created_at", { ascending: false }).limit(1)).data![0];
      results[n] = { reasons: r.byReason, status: rec.status, codes: (rec.record as { next: { violationCodes: string[] } }).next.violationCodes, kinds: seen[0].evidence.map((e) => e.kind ?? "post") };
    }
    expect(results.w1.reasons).toMatchObject({ image_not_found: 1 });
    expect(results.w2.reasons).toMatchObject({ image_illegible: 1 });
    expect(results.w3.reasons).toMatchObject({ image_no_image: 1 });
    for (const n of ["w1", "w2", "w3"]) {
      expect(results[n].kinds).toEqual(["post", "image_reading"]); // 照合済みの根拠は無い
      expect(results[n].codes).toContain("citation_image_only"); // 未照合の画像読み取りだけを根拠にした fact は検証層に拒否される
      expect(results[n].status).not.toBe("accepted"); // 拒否された主張は採用されず、判断は完全には確定しない
    }
    await clean();
  });

  it("③画像を毎回再解析しない: 同じ画像（同じハッシュ）の書き起こしは再利用。画像が更新されたら（ハッシュが変われば）再検証", async () => {
    await setSettings();
    const c = await addCandidate("c1", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    await enqueue(c);
    let ver = "v1";
    const { calls, imageVerify } = rig({ lines: [["応募締切 11/30(月) 23:59", "clear"]], bytes: () => `image-${ver}` });
    const run = () => runShadowWorker({ db: admin as unknown as Db, model: modelCiting("image_verified", "応募締切 11/30(月) 23:59"), env: ENV_ON, workerId: "w", imageVerify });
    expect((await run()).done).toBe(1);
    expect(calls.transcribe).toBe(1);
    // 同じ画像で、原文が変わった（新しいジョブ）: 書き起こしは再利用（AI呼び出しなし）
    const lg = (await admin.from("collection_candidates").select("last_good").eq("id", c.id).single()).data!.last_good as { evidence: { text: string; hash: string } };
    const text2 = `${lg.evidence.text} 追記`;
    const hash2 = createHash("sha256").update(text2).digest("hex").slice(0, 32);
    await admin.from("collection_candidates").update({ last_good: { evidence: { ...lg.evidence, text: text2, hash: hash2 } } }).eq("id", c.id);
    expect(await enqueue({ id: c.id, hash: hash2 })).toBe(true);
    const r2 = await run();
    expect(r2.byReason.image_verified).toBe(1);
    expect(calls.transcribe).toBe(1); // 再解析していない
    expect((await admin.from("shadow_image_verifications").select("id").eq("household_id", hidA)).data).toHaveLength(1);
    // 画像が更新された: ハッシュが変わるので再検証（新しい記録）
    ver = "v2";
    const text3 = `${text2} 再追記`;
    const hash3 = createHash("sha256").update(text3).digest("hex").slice(0, 32);
    await admin.from("collection_candidates").update({ last_good: { evidence: { ...lg.evidence, text: text3, hash: hash3 } } }).eq("id", c.id);
    expect(await enqueue({ id: c.id, hash: hash3 })).toBe(true);
    await run();
    expect(calls.transcribe).toBe(2);
    expect((await admin.from("shadow_image_verifications").select("image_hash").eq("household_id", hidA)).data).toHaveLength(2);
    await clean();
  });

  it("④画像の書き起こしの費用は予算（判断との合計）に含まれ、上限を超えない。予算が足りなければ書き起こさず、未照合のまま", async () => {
    await setSettings({ daily_budget_jpy: 0.5, per_case_cap_jpy: 3 });
    const c = await addCandidate("b1", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    await enqueue(c);
    const { calls, imageVerify } = rig({ lines: [["応募締切 11/30(月) 23:59", "clear"]], cost: 0.4 });
    // 予算0.5円: 画像の検証（見込み0.8円）は予約額が残額を超えるため書き起こさない
    const r = await runShadowWorker({ db: admin as unknown as Db, model: modelCiting("image_verified", "応募締切 11/30(月) 23:59"), env: ENV_ON, workerId: "w", imageVerify });
    expect(calls.transcribe).toBe(0);
    expect(r.done + r.requeued).toBe(1);
    await clean();
    await setSettings({ daily_budget_jpy: 3, per_case_cap_jpy: 3 });
    const c2 = await addCandidate("b2", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    await enqueue(c2);
    const rg = rig({ lines: [["応募締切 11/30(月) 23:59", "clear"]], cost: 0.4 });
    await runShadowWorker({ db: admin as unknown as Db, model: modelCiting("image_verified", "応募締切 11/30(月) 23:59"), env: ENV_ON, workerId: "w", imageVerify: rg.imageVerify });
    const spent = Number((await admin.rpc("shadow_spent", { p_household: hidA, p_since: new Date(Date.now() - 86_400_000).toISOString() })).data);
    expect(spent).toBeCloseTo(0.4 + 0.2, 3); // 画像の書き起こし（0.4）＋判断（0.2）が、日次の集計に入る
    expect(spent).toBeLessThanOrEqual(3);
    await clean();
  });

  it("⑤RLS・追記専用・保持期限: 世帯の構成員だけが読める。利用者は書き込み・更新できず、期限を過ぎた記録だけが掃除される", async () => {
    await setSettings({ retention_days: 7 });
    const c = await addCandidate("r1", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    await enqueue(c);
    const { imageVerify } = rig({ lines: [["応募締切 11/30(月) 23:59", "clear"]] });
    await runShadowWorker({ db: admin as unknown as Db, model: modelCiting("image_verified", "応募締切 11/30(月) 23:59"), env: ENV_ON, workerId: "w", imageVerify });
    expect((await L(u1).from("shadow_image_verifications").select("id")).data).toHaveLength(1);
    expect((await L(u2).from("shadow_image_verifications").select("id")).data ?? []).toEqual([]);
    expect((await L(anonClient()).from("shadow_image_verifications").select("id")).data ?? []).toEqual([]);
    expect((await L(u1).from("shadow_image_verifications").insert({ household_id: hidA, candidate_id: c.id, image_index: 1, image_hash: "f".repeat(64), fetched_at: NOW.toISOString(), transcript: [], model_id: "x", prompt_version: "x" })).error).not.toBeNull();
    const row = (await admin.from("shadow_image_verifications").select("id").eq("household_id", hidA)).data![0];
    expect((await admin.from("shadow_image_verifications").update({ model_id: "y" }).eq("id", row.id)).error).not.toBeNull(); // 追記専用
    const old = await admin.from("shadow_image_verifications").insert({ household_id: hidA, candidate_id: c.id, image_index: 2, image_hash: "e".repeat(64), fetched_at: NOW.toISOString(), transcript: [], model_id: "x", prompt_version: "x", created_at: new Date(Date.now() - 30 * 86_400_000).toISOString() }).select("id").single();
    expect(old.error).toBeNull();
    expect((await admin.rpc("shadow_purge")).error).toBeNull();
    const left = (await admin.from("shadow_image_verifications").select("id").eq("household_id", hidA)).data!.map((x) => x.id);
    expect(left).toContain(row.id);
    expect(left).not.toContain(old.data!.id);
    await clean();
  });

  it("⑥画像の取得は既存の部品の境界を守る: pbs.twimg.com 以外・http・認証情報つきURLは取得しない（SSRF・認証回避なし）。画像を扱わない設定では、検証を呼ばない", async () => {
    for (const bad of ["https://evil.example.com/a.png", "http://pbs.twimg.com/media/a.jpg", "https://user:pw@pbs.twimg.com/media/a.jpg", "https://169.254.169.254/x.png", "not a url"]) expect(await fetchXImage(bad), bad).toBeNull();
    await setSettings();
    const c = await addCandidate("n1", [["applyDeadline", "応募締切 11/30(月) 23:59"]]);
    await enqueue(c);
    const seen: JudgmentInput[] = [];
    const r = await runShadowWorker({ db: admin as unknown as Db, model: modelCiting("image_reading", "応募締切 11/30(月) 23:59", seen), env: ENV_ON, workerId: "w" }); // imageVerify なし
    expect(r.byReason).not.toHaveProperty("image_verified");
    expect(seen[0].evidence.map((e) => e.kind ?? "post")).toEqual(["post", "image_reading"]);
    expect((await admin.from("shadow_image_verifications").select("id").eq("household_id", hidA)).data).toHaveLength(0);
    await clean();
  });
});
