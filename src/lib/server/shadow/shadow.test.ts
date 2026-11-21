// @vitest-environment node
/** Stage 10K: シャドーワーカーの許可判定・書き込み先・日時計算（純関数・静的検査）。DB・ネットワーク・AIには触れない。 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { shadowEnqueueAllowed, shadowWorkerPermission } from "./allow";
import { currentCaseFromDraft, legacySummaryFromDraft, prepareShadowEvidence } from "./input";
import { jstDayStart, jstMonthStart } from "./worker";

vi.mock("server-only", () => ({}));

describe("許可判定: 既定OFF・独立・本番では2つ目のスイッチが要る", () => {
  it("環境変数が無ければ何もしない。9H系のローカル限定フラグ（TOREMANE_ENV）には依存しない・解除もしない", () => {
    expect(shadowWorkerPermission({})).toMatchObject({ allowed: false, reason: "off" });
    expect(shadowWorkerPermission({ TOREMANE_ENV: "local" }).allowed).toBe(false); // ローカルフラグだけでは動かない
    expect(shadowWorkerPermission({ SHADOW_WORKER: "on" })).toMatchObject({ allowed: true, hasKey: false });
    expect(shadowWorkerPermission({ SHADOW_WORKER: "on", SHADOW_WORKER_KILL: "1" })).toMatchObject({ allowed: false, reason: "killed" });
  });
  it("本番（NODE_ENV=production・VERCEL）では、SHADOW_WORKER_PRODUCTION_APPROVED=yes が無ければ動かない", () => {
    for (const prod of [{ NODE_ENV: "production" }, { VERCEL: "1" }, { VERCEL_ENV: "production" }]) {
      expect(shadowWorkerPermission({ SHADOW_WORKER: "on", ...prod }).reason).toBe("production_not_approved");
      expect(shadowEnqueueAllowed({ SHADOW_ENQUEUE: "on", ...prod })).toBe(false);
      expect(shadowWorkerPermission({ SHADOW_WORKER: "on", SHADOW_WORKER_PRODUCTION_APPROVED: "yes", ...prod }).allowed).toBe(true);
    }
  });
  it("シャドー専用のキーだけを見る。開発用・評価用のキーは、あっても使えるとは判定しない", () => {
    expect(shadowWorkerPermission({ SHADOW_WORKER: "on", AGENT_ANTHROPIC_API_KEY: "x".repeat(40), JUDGMENT_EVAL_API_KEY: "y".repeat(40), ANTHROPIC_API_KEY: "z".repeat(40) }).hasKey).toBe(false);
    expect(shadowWorkerPermission({ SHADOW_WORKER: "on", SHADOW_ANTHROPIC_API_KEY: "k".repeat(40) }).hasKey).toBe(true);
    expect(shadowEnqueueAllowed({})).toBe(false);
    expect(shadowEnqueueAllowed({ SHADOW_ENQUEUE: "on" })).toBe(true);
  });
});

describe("書き込み先・配線の静的検査", () => {
  const worker = readFileSync("src/lib/server/shadow/worker.ts", "utf8");
  it("ワーカーが書き込む表は shadow_* の3表だけ（候補は読み取りのみ）。他の表への update/insert/delete・rpc を持たない", () => {
    const writes = [...worker.matchAll(/table\(db, "([a-z_]+)"\)\s*\.(insert|update|upsert|delete)/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes)).toEqual(new Set(["shadow_jobs", "shadow_judgments"]));
    const reads = [...worker.matchAll(/table\(db, "([a-z_]+)"\)\s*\.select/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(["shadow_settings", "collection_candidates"]));
    const rpcs = [...worker.matchAll(/rpc\(db\)\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(rpcs)).toEqual(new Set(["shadow_lease", "shadow_spent"]));
    expect(worker).not.toMatch(/process\.env\.(AGENT_|JUDGMENT_)|TOREMANE_ENV/);
  });
  it("通常収集の投入は、AIを呼ばず・1.5秒を超えて待たず・失敗を握りつぶす。cronの入口は認証を要求し、既定では何もしない", () => {
    const run = readFileSync("src/lib/server/collector/run.ts", "utf8");
    expect(run).toContain("deps.shadowEnqueue");
    expect(run).toContain("setTimeout(res, 1500)");
    const route = readFileSync("src/app/api/cron/shadow/route.ts", "utf8");
    expect(route).toContain("isAuthorizedCron(");
    expect(route).toContain("shadowWorkerPermission()");
    expect(route).toContain("SHADOW_ANTHROPIC_API_KEY");
    expect(route).not.toMatch(/AGENT_ANTHROPIC|JUDGMENT_EVAL/);
  });
  it("マイグレーションは追加のみ（既存の表への変更・削除なし）で、利用者に書き込み権限を与えず、記録は更新不可", () => {
    const sql = readFileSync("supabase/migrations/20261227000109_stage10k_shadow_queue.sql", "utf8").split(/[\r][\n]|[\n]/).filter((l) => !l.trim().startsWith("--")).join(" "); // コメント（逆戻しの参考）は除く
    expect(sql).not.toMatch(/alter table public\.(lotteries|collection_candidates|applications|collection_settings|cases)/i);
    expect(sql).not.toMatch(/drop table|truncate/i);
    expect(sql).toContain("shadow_judgments_append_only");
    expect(sql).toMatch(/grant select on public\.%I to authenticated/);
    expect(sql).toContain("revoke update on public.shadow_judgments from service_role");
  });
});

describe("入力の組み立て・日時", () => {
  it("日本時間の日・月の開始（UTC）", () => {
    expect(jstDayStart(new Date("2099-03-31T16:30:00Z")).toISOString()).toBe("2099-03-31T15:00:00.000Z"); // JSTでは4/1 01:30
    expect(jstMonthStart(new Date("2099-03-31T16:30:00Z")).toISOString()).toBe("2099-03-31T15:00:00.000Z");
    expect(jstMonthStart(new Date("2099-04-15T00:00:00Z")).toISOString()).toBe("2099-03-31T15:00:00.000Z");
  });
  it("登録値は currentCase として公開項目だけ。画像を使った可能性があれば印を付ける。旧方式の要約は実値のみ（不明は null）", () => {
    const draft = { input: { chain: { name: "サンプル系列" }, store: { name: "サンプル店" }, items: [{ product: { name: "商品A" } }], applyDeadline: { date: "2099-04-08T00:00" }, storeMode: "select_on_apply", household_id: "x" } };
    const c = currentCaseFromDraft(draft, { imageCount: 1, imageStatus: "fetched" } as never);
    expect(c).toMatchObject({ chain: "サンプル系列", store: "サンプル店", products: ["商品A"], applyDeadline: "2099-04-08", storeMode: "select_on_apply", fromImages: true });
    expect(JSON.stringify(c)).not.toContain("household");
    expect(currentCaseFromDraft(draft, null)).not.toHaveProperty("fromImages");
    expect(currentCaseFromDraft(null, null)).toBeUndefined();
    expect(legacySummaryFromDraft(draft)).toMatchObject({ structure: "store_select", opportunityCount: null, itemCount: 1 });
    expect(legacySummaryFromDraft(null)).toMatchObject({ structure: null, itemCount: null });
  });
  it("送信前の検査: 原文なし・非公開の取得方法は不可。URLはプレースホルダーに置き換わる", () => {
    expect(prepareShadowEvidence(null)).toEqual({ ok: false, reason: "no_evidence" });
    const base = { v: 1, url: "https://x.example.com/1", fetchedAt: "2099-01-01T00:00:00Z", via: "x_api", origin: "unknown", text: "架空TCG 抽選のお知らせ 2099-04-08まで", truncated: false, links: [], imageCount: 0, imageStatus: "none", hash: "a".repeat(32), sent: 0 };
    expect(prepareShadowEvidence({ ...base, via: "list_card" } as never)).toEqual({ ok: false, reason: "not_public" });
    const r = prepareShadowEvidence(base as never);
    expect(r.ok && r.seeds.every((s) => s.url.startsWith("https://evidence.invalid/"))).toBe(true);
  });
});

describe("Stage 10L: 画像検証の書き込み先・境界・追記専用（静的検査）", () => {
  const ver = readFileSync("src/lib/server/shadow/image-verifier.ts", "utf8");
  it("画像検証が書き込む表は shadow_image_verifications のみ。画像そのもの・取得元URLは保存しない。取得・書き起こしは注入（直接ネットワークを使わない）", () => {
    const writes = [...ver.matchAll(/table\(deps\.db, "([a-z_]+)"\)\s*\.(insert|update|upsert|delete)/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(["shadow_image_verifications"]));
    expect(ver).not.toMatch(/\bfetch\(|safeFetch|https?\.request/);
    expect(ver).not.toMatch(/image_ref|image_url|base64:\s*img\.base64[^)]*insert/);
    expect(ver).toContain("image_hash");
  });
  it("ルートは画像の取得に既存の部品（fetchXImage）だけを使う。マイグレーション110は追加のみ・利用者に書き込みを与えない・追記専用", () => {
    expect(readFileSync("src/app/api/cron/shadow/route.ts", "utf8")).toContain("fetchXImage");
    const sql = readFileSync("supabase/migrations/20261227000110_stage10l_image_verification.sql", "utf8").split(/[\r][\n]|[\n]/).filter((l) => !l.trim().startsWith("--")).join(" ");
    expect(sql).not.toMatch(/alter table public\.(lotteries|collection_candidates|applications|collection_settings|cases)/i);
    expect(sql).not.toMatch(/drop table|truncate/i);
    expect(sql).toContain("shadow_image_verifications_append_only");
    expect(sql).toContain("revoke update on public.shadow_image_verifications from service_role");
    expect(sql).toMatch(/grant select on public\.shadow_image_verifications to authenticated/);
  });
});
