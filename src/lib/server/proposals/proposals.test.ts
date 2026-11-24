// @vitest-environment node
/** Stage 10Z: 登録案の変換・フラグ・接続口の安全性（課金なし・DBなし）。 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { inputHash, markPossiblySame, proposalKey, toProposalRecords, unitOf, valueSupport, type ProposalField, type ProposalRecord } from "@/lib/judgment/xsource/proposal";
import { mockRegistrationJudge, mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import { CallBudget } from "@/lib/judgment/call-budget";
import { runXPostReplay } from "@/lib/judgment/xsource/x-origin";
import type { FetchOutcome } from "@/lib/judgment/xsource/research-loop";
import { proposalAfterCandidate } from "@/lib/server/collector/proposal-hook";
import { proposalAutoGenerateEnabled, proposalPreviewEnabled } from "./flag";
import { generateProposalsForCandidate, mockDeps, postFromCandidate } from "./generate";
import { recordReview } from "./review";

vi.mock("server-only", () => ({}));
const NOW = new Date("2026-11-22T03:00:00Z");

describe("フラグ: 既定OFF・本番では常に無効", () => {
  const LOCAL = "http://127.0.0.1:55321";
  const base = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: LOCAL };
  it("ローカル環境・個別フラグ・ローカルDBの接続先が揃うときだけ有効。VERCEL・ホスト型のSupabase・フラグ欠落では無効。自動生成はさらに別フラグ", () => {
    expect(proposalPreviewEnabled({})).toBe(false);
    expect(proposalPreviewEnabled({ TOREMANE_ENV: "local", NEXT_PUBLIC_SUPABASE_URL: LOCAL })).toBe(false);
    expect(proposalPreviewEnabled({ PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: LOCAL })).toBe(false);
    expect(proposalPreviewEnabled({ TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on" })).toBe(false); // 接続先が不明
    expect(proposalPreviewEnabled(base)).toBe(true);
    expect(proposalPreviewEnabled({ ...base, NODE_ENV: "production" })).toBe(true); // ローカルの本番ビルド（next start）でも、接続先がローカルなら動く
    expect(proposalPreviewEnabled({ ...base, VERCEL: "1" })).toBe(false);
    expect(proposalPreviewEnabled({ ...base, VERCEL_ENV: "production" })).toBe(false);
    expect(proposalPreviewEnabled({ ...base, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij.supabase.co" })).toBe(false); // 本番DBに繋がる環境では、フラグが立っていても無効
    expect(proposalPreviewEnabled({ ...base, TOREMANE_ENV: "production" })).toBe(false);
    expect(proposalAutoGenerateEnabled(base)).toBe(false);
    expect(proposalAutoGenerateEnabled({ ...base, PROPOSAL_AUTO: "on" })).toBe(true);
    expect(proposalAutoGenerateEnabled({ PROPOSAL_AUTO: "on" })).toBe(false);
  });
  it("収集の接続口/は、フラグが無いときDBに触れず待たない（旧方式に影響しない）。有効でも例外・遅延で収集を止めない", async () => {
    const from = vi.fn();
    const t0 = Date.now();
    await proposalAfterCandidate({ db: { from } as never, householdId: "h", candidateId: "c", env: {} });
    await proposalAfterCandidate({ db: { from } as never, householdId: "h", candidateId: "c", env: base });
    expect(from).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(200);
    const boom = vi.fn(() => { throw new Error("db down"); });
    await expect(proposalAfterCandidate({ db: { from: boom } as never, householdId: "h", candidateId: "c", env: { ...base, PROPOSAL_AUTO: "on" }, timeoutMs: 50 })).resolves.toBeUndefined();
    const hang = vi.fn(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => undefined) }) }) }) }));
    const t1 = Date.now();
    await proposalAfterCandidate({ db: { from: hang } as never, householdId: "h", candidateId: "c", env: { ...base, PROPOSAL_AUTO: "on" }, timeoutMs: 80 });
    expect(Date.now() - t1).toBeLessThan(500); // 待ち時間の上限
  });
  it("レビュー・生成は、無効のとき何も呼ばない", async () => {
    const from = vi.fn();
    expect(await recordReview({ db: { from } as never, householdId: "h", proposalId: "p", decision: "hold", env: {} })).toEqual({ ok: false, reason: "disabled" });
    expect(await generateProposalsForCandidate({ db: { from } as never, householdId: "h", candidate: { id: "c" }, env: {} })).toEqual({ ok: false, reason: "disabled" });
    expect(from).not.toHaveBeenCalled();
  });
  it("レビューの入力検証: 決定の種類・修正する項目名・長さ。AIの値は書き換えない", async () => {
    const env = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
    const db = { from: () => { throw new Error("must not reach db"); } } as never;
    expect(await recordReview({ db, householdId: "h", proposalId: "p", decision: "approve", env })).toEqual({ ok: false, reason: "invalid" });
    expect(await recordReview({ db, householdId: "h", proposalId: "p", decision: "approve_with_edits", edits: { "store; drop table": "x" }, env })).toEqual({ ok: false, reason: "invalid" });
    expect(await recordReview({ db, householdId: "h", proposalId: "p", decision: "approve_with_edits", edits: { store: "x".repeat(201) }, env })).toEqual({ ok: false, reason: "invalid" });
    expect(await recordReview({ db, householdId: "h", proposalId: "p", decision: "approve_with_edits", env })).toEqual({ ok: false, reason: "invalid" }); // 修正が無い承認は不可（edits 必須）
  });
});

describe("値の導出の確認（引用の実在とは別）", () => {
  const text = "【新宿本店】拡張パック 抽選 応募期間 11月30日(月)23:59まで";
  it("引用に逐語／本文に逐語／書式変換で一致／見つからない／値なし を分ける（正しさの判定ではない）", () => {
    expect(valueSupport("新宿本店", "【新宿本店】", text)).toBe("literal_in_quote");
    expect(valueSupport("拡張パック", "【新宿本店】", text)).toBe("literal_in_text");
    expect(valueSupport("11/30", "応募期間 11月30日", "別の本文")).toBe("normalized_match"); // 書式の違いを吸収
    expect(valueSupport("12/1", "応募期間 11月30日", text)).toBe("not_found"); // 引用・本文から導けない値
    expect(valueSupport("2025/11/30", "11月30日まで", text)).toBe("normalized_match"); // 年は引用に無いので月日で照合（年の一致は確認していない）
    expect(valueSupport(null, "x", text)).toBe("no_value");
    expect(valueSupport("  ", "x", text)).toBe("no_value");
  });
  it("応募単位は、列挙に完全一致するときだけ採用する（名前一致・推測の固定ルールは足さない）", () => {
    const f = (value: string | null, basis: ProposalField["basis"] = "inferred"): Record<string, ProposalField> => ({ apply_unit: { value, basis, quote: null, evidence: null, support: "no_value" } });
    expect(unitOf(f("store_select"))).toEqual({ unit: "store_select", basis: "inferred" });
    expect(unitOf(f("per_store", "observed"))).toEqual({ unit: "per_store", basis: "observed" });
    expect(unitOf(f("店舗選択式っぽい"))).toEqual({ unit: "unknown", basis: "unknown" });
    expect(unitOf({})).toEqual({ unit: "unknown", basis: "unknown" });
    expect(unitOf({ 応募単位: { value: "store_independent", basis: "inferred", quote: null, evidence: null, support: "no_value" } }).unit).toBe("per_store");
  });
});

describe("登録案の識別・重複防止（誤統合・誤分割・大量重複）", () => {
  it("proposal_key は 候補・投稿・項目番号で安定（再評価で変わらない）。項目が違えば別。入力のハッシュは、取得したページが変わると変わる", () => {
    expect(proposalKey("c1", "p1", 1)).toBe(proposalKey("c1", "p1", 1));
    expect(proposalKey("c1", "p1", 1)).not.toBe(proposalKey("c1", "p1", 2));
    expect(proposalKey("c1", "p1", 1)).not.toBe(proposalKey("c2", "p1", 1));
    expect(proposalKey("c1", "p1", 1)).toMatch(/^[0-9a-f]{24}$/);
    const plan = { seedText: "s" } as never;
    const ev = (h: string) => [{ id: "p1", kind: "page", contentHash: h }] as never;
    expect(inputHash(plan, ev("a"))).toBe(inputHash(plan, ev("a")));
    expect(inputHash(plan, ev("a"))).not.toBe(inputHash(plan, ev("b")));
  });
  it("同じ店舗・商品の別項目は『可能性』を示すだけで統合しない。値が不明のものは対象外", () => {
    const rec = (key: string, store: string | null, product: string | null, basis: "observed" | "unknown" = "observed"): ProposalRecord => ({ proposalKey: key, fields: { store: { value: store, basis: store ? basis : "unknown", quote: null, evidence: null, support: "no_value" }, product: { value: product, basis: product ? basis : "unknown", quote: null, evidence: null, support: "no_value" } }, possiblySame: [] }) as unknown as ProposalRecord;
    const r = markPossiblySame([rec("a", "新宿本店", "拡張 パック"), rec("b", "新宿 本店", "拡張パック"), rec("c", "渋谷店", "拡張パック"), rec("d", null, null), rec("e", null, null)]);
    expect(r.map((x) => x.possiblySame)).toEqual([["b"], ["a"], [], [], []]);
    expect(r.map((x) => x.proposalKey)).toEqual(["a", "b", "c", "d", "e"]); // 件数・識別は変わらない
  });
});

describe("収集の保存構造 → 新AIの入力（既存の linkMap を再実装せずに渡す）", () => {
  it("postFromCandidate: 保存済みの本文・親リンク・linkMap・取得時刻がそのまま渡る。原文が無い候補は null", () => {
    const evidence = { v: 1, url: "https://x.example.invalid/1", fetchedAt: "2026-11-22T00:00:00.000Z", via: "x_api", origin: "primary", text: "《A店》 ・拡張パック https://t.co/aaa111", truncated: false, links: ["https://shared.example.invalid/"], imageCount: 0, imageStatus: "none", hash: "h".repeat(64), linkMap: [{ short: "https://t.co/aaa111", url: "https://a.example.invalid/e/1" }] };
    const p = postFromCandidate({ id: "c", x_post_id: "123", last_good: { evidence } });
    expect(p).toMatchObject({ postId: "123", links: ["https://shared.example.invalid/"], linkMap: [{ short: "https://t.co/aaa111", url: "https://a.example.invalid/e/1" }], recordedAt: "2026-11-22T00:00:00.000Z" });
    expect(postFromCandidate({ id: "c", last_good: {} })).toBeNull();
    expect(postFromCandidate({ id: "c", last_good: { evidence: { ...evidence, text: "短" } } })).toBeNull();
  });
});

describe("モックの調査・判断（経路確認用の代役。実AIではない）→ 登録案", () => {
  const html = "<html><body>【新宿本店】拡張パック 抽選受付\n受付期間 11月30日まで</body></html>";
  const tools = (ok: boolean) => ({ now: () => NOW, fetchPage: async (): Promise<FetchOutcome> => (ok ? { ok: true, finalUrl: "https://a.example.invalid/e/1", html, text: "【新宿本店】拡張パック 抽選受付\n受付期間 11月30日まで" } : { ok: false, reason: "not_public" }) });
  const post = { postId: "p1", text: "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111", links: [], linkMap: [{ short: "https://t.co/aaa111", url: "https://a.example.invalid/e/1" }], recordedAt: NOW.toISOString() };
  const run = (ok: boolean) => runXPostReplay({ post, agent: mockResearchAgent, judge: mockRegistrationJudge, tools: tools(ok), budget: new CallBudget({ maxCalls: 20, maxCostJpy: 0.0001 }), limits: { agentReserveJpy: 0, judgeReserveJpy: 0, maxTurns: 3 }, now: NOW });
  it("項目自身のリンクを取得して引用つきの項目を作る。本登録案（register）は返さない。費用0・mode=mock", async () => {
    const recs = toProposalRecords({ candidateId: "c1", post, run: await run(true), mode: "mock", modelId: null, fetchedAt: NOW.toISOString() });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ urlStatus: "url_from_item", mode: "mock", costJpy: 0, decision: "tentative", sourceUrls: ["https://a.example.invalid/e/1"] });
    expect(recs[0].fields.store).toMatchObject({ value: "新宿本店", basis: "observed", support: "literal_in_quote" });
    expect(recs[0].fields.deadline).toMatchObject({ basis: "inferred" });
    expect(recs[0].applyUnit).toBe("unknown"); // 確証が無ければ不明（観察とは書かない）
  });
  it("ページが取得できなければ、根拠のある項目は作らず、未確認事項として保持する（項目を消さない）", async () => {
    const recs = toProposalRecords({ candidateId: "c1", post, run: await run(false), mode: "mock", modelId: null, fetchedAt: null });
    expect(recs).toHaveLength(1);
    expect(recs[0].fields.store.basis).toBe("unknown");
    expect(recs[0].pages).toEqual([]);
    expect(recs[0].endReason).toBe("unreachable");
  });
  it("mockDeps は実AIを使わない（mode=mock・modelId なし）", () => {
    expect(mockDeps()).toMatchObject({ mode: "mock", modelId: null });
  });
});

describe("静的確認: 登録案の機能は、抽選・応募・購入・通知に書かない。通常の画面・APIから無条件に呼ばれない", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  const files = ["generate.ts", "store.ts", "review.ts", "flag.ts"].map((f) => `src/lib/server/proposals/${f}`);
  it("登録案のコードは registration_proposals(_reviews) と読み取り用の collection_candidates 以外のテーブルに書かない", () => {
    for (const f of [...files, "src/lib/server/collector/proposal-hook.ts", "src/app/(app)/lotteries/candidates/proposal-actions.ts"]) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/\.from\("([a-z_]+)"\)\s*\.(insert|update|delete|upsert)/g)) expect(["registration_proposals", "registration_proposal_reviews"], `${f}: ${m[1]}`).toContain(m[1]);
      for (const m of s.matchAll(/t\(db, "([a-z_]+)"\)\s*\.(insert|update|delete|upsert)/g)) expect(["registration_proposals", "registration_proposal_reviews"], `${f}: ${m[1]}`).toContain(m[1]);
      expect(s, f).not.toMatch(/notification|web-push|sendNotification|lotteries["']\)\s*\.(insert|update)/);
    }
  });
  it("収集（run.ts）からの呼び出しは proposalAfterCandidate の1か所だけで、旧方式の処理の後。登録案のモジュールを直接 import しない", () => {
    const run = readFileSync("src/lib/server/collector/run.ts", "utf8");
    expect(run.match(/proposalAfterCandidate\(/g)).toHaveLength(1);
    expect(run).not.toMatch(/server\/proposals\//);
    expect(run.indexOf("proposalAfterCandidate(")).toBeGreaterThan(run.indexOf("shadow.schedule("));
  });
  it("登録案のコードを import する非テストのファイルは、想定した入口だけ（候補の画面・その操作・収集の接続口・登録案の部品）", () => {
    const allowed = new Set(["src/app/(app)/lotteries/candidates/page.tsx", "src/app/(app)/lotteries/candidates/proposal-actions.ts", "src/lib/server/collector/proposal-hook.ts", "src/components/proposal-preview.tsx", "src/components/candidates-view.tsx", "src/lib/judgment/xsource/vision-real.ts", "src/lib/server/collector/link-recheck.ts", "src/lib/server/collector/db-host-gate.ts", "src/lib/server/collector/image-intake.ts"]);
    const users = walk("src").filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith("src/lib/server/proposals/") && /server\/proposals\//.test(readFileSync(f, "utf8")));
    for (const f of users) expect(allowed.has(f.split("\\").join("/")), f).toBe(true);
  });
  it("実AIのクライアント・APIキーを、この機能のコードは扱わない", () => {
    for (const f of [...files, "src/lib/server/collector/proposal-hook.ts", "src/lib/judgment/xsource/proposal.ts", "src/lib/judgment/xsource/proposal-mock.ts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/@anthropic-ai\/sdk|new Anthropic\(|ANTHROPIC_API_KEY|AGENT_ANTHROPIC/);
    }
  });
});

describe("登録案の集計（引用の実在と値の導出を別に数える。正答率ではない）", () => {
  it("検証通過と、観察とされた項目の導出（逐語／書式変換／見つからない）を分けて集計する", async () => {
    const { proposalMetrics } = await import("@/lib/judgment/xsource/proposal");
    const f = (basis: ProposalField["basis"], support: ProposalField["support"]): ProposalField => ({ value: "v", basis, quote: "q", evidence: "p1", support });
    const rec = (verified: boolean, fields: Record<string, ProposalField>, urlStatus = "url_from_item", unknowns = 0): ProposalRecord => ({ verified, fields, urlStatus, unknowns: Array.from({ length: unknowns }, () => ({ what: "x", why: "y" })), decision: "tentative" }) as unknown as ProposalRecord;
    const m = proposalMetrics([rec(true, { a: f("observed", "literal_in_quote"), b: f("observed", "not_found"), c: f("unknown", "no_value") }), rec(false, { a: f("observed", "normalized_match") }, "url_missing", 2)]);
    expect(m).toMatchObject({ proposals: 2, quoteVerified: 1, quoteNotVerified: 1, observedFields: 3, unknownFields: 1, noUrl: 1, withUnknowns: 1, decisions: { tentative: 2 } });
    expect(m.support).toMatchObject({ literal_in_quote: 1, not_found: 1, normalized_match: 1 });
    // 検証を通過した案でも、導出できない値（not_found）が残ることが見える
    expect(m.quoteVerified).toBeGreaterThan(0);
    expect(m.support.not_found).toBeGreaterThan(0);
  });
});

describe("Phase 2 静的確認: 実AIの入口は評価だけ。画面・server action・cron・収集は実AIを動かせない", () => {
  const walk2 = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk2(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  const nonTest = walk2("src").filter((f) => !/\.test\.tsx?$/.test(f)).map((f) => f.split("\\").join("/"));
  const importers = (re: RegExp, self: string[]): string[] => nonTest.filter((f) => !self.includes(f) && re.test(readFileSync(f, "utf8")));
  it("許可証の発行（issueRealRunTicket）を使えるのは real-run.ts だけ。実AIの評価入口（real-run）・擬似クライアント・本番プレビューの判定は、非テストのコードから読み込まれない", () => {
    expect(importers(/issueRealRunTicket/, ["src/lib/server/proposals/real-gate.ts", "src/lib/server/proposals/real-run.ts"])).toEqual([]);
    expect(importers(/proposals\/real-run|\.\/real-run/, ["src/lib/server/proposals/real-run.ts"])).toEqual([]);
    expect(importers(/xsource\/scripted-client|\.\/scripted-client/, ["src/lib/judgment/xsource/scripted-client.ts"])).toEqual([]);
    expect(importers(/proposals\/prod-gate|\.\/prod-gate/, ["src/lib/server/proposals/prod-gate.ts"])).toEqual([]);
  });
  it("画面・server action・収集の接続口・候補の画面は、real-run・real-gate・AIクライアントを読み込まない（環境変数や画面操作だけで有料AIが動かない）", () => {
    for (const f of ["src/app/(app)/lotteries/candidates/proposal-actions.ts", "src/app/(app)/lotteries/candidates/page.tsx", "src/components/proposal-preview.tsx", "src/components/candidates-view.tsx", "src/lib/server/collector/proposal-hook.ts", "src/lib/server/collector/run.ts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/real-run|real-gate|issueRealRunTicket|@anthropic-ai\/sdk|new Anthropic\(|AnthropicWebSearch|makeAnthropic/);
    }
  });
  it("実AIのクライアントを作る・キーを読むのは評価入口（*.real.test.ts）だけ。登録案・収集・hook のコードはキーを扱わない", () => {
    const sdk = nonTest.filter((f) => /@anthropic-ai\/sdk/.test(readFileSync(f, "utf8")) && f.startsWith("src/lib/server/proposals/"));
    expect(sdk).toEqual([]);
    for (const f of ["src/lib/server/proposals/real-run.ts", "src/lib/server/proposals/real-gate.ts", "src/lib/server/proposals/generate.ts", "src/lib/server/proposals/eval-candidates.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/process\.env\.(ANTHROPIC|AGENT_ANTHROPIC|JUDGMENT_EVAL)_API_KEY|apiKey:/);
  });
  it("画像の実解析（vision-real）・比較試験の実行部（compare-run）は、評価入口（real-run・compare-real）以外の非テストのコードから読み込まれない。収集・画面・server action は画像取得の本体（image-fetch）も読み込まない", () => {
    expect(importers(/xsource\/vision-real|\.\/vision-real/, ["src/lib/judgment/xsource/vision-real.ts", "src/lib/server/proposals/real-run.ts"])).toEqual([]);
    expect(importers(/proposals\/compare-run|\.\/compare-run/, ["src/lib/server/proposals/compare-run.ts"])).toEqual([]);
    expect(importers(/compare-eval/, ["src/lib/judgment/xsource/compare-eval.ts", "src/lib/judgment/xsource/r1-worksheet.ts", "src/lib/server/proposals/compare-run.ts", "src/lib/server/proposals/real-post-capture.ts", "src/lib/server/gold-review/store.ts"])).toEqual([]);
    expect(importers(/images\/image-fetch|\.\/image-fetch/,["src/lib/server/images/image-fetch.ts", "src/lib/server/images/split-adapter.ts", "src/lib/judgment/xsource/vision-real.ts", "src/lib/judgment/xsource/vision-mock.ts", "src/lib/server/collector/image-intake.ts"])).toEqual([]);
    for (const f of ["src/lib/server/collector/run.ts", "src/lib/server/collector/x-rich.ts", "src/lib/server/collector/proposal-hook.ts", "src/lib/server/proposals/generate.ts", "src/app/(app)/lotteries/candidates/proposal-actions.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/vision-real|images\/image-fetch|makeRealVisionClient|fetchPublicImage/);
    }
  });
  it("実投稿の資料化（real-post-capture・実ネットワークを伴う）は評価入口以外から読み込まれない。独立gold確認（開発専用）は、ナビ・設定・他の画面から誘導されず、gold確認のコードは収集・AI・抽選のコードを読み込まない", () => {
    expect(importers(/proposals\/real-post-capture|\.\/real-post-capture/, ["src/lib/server/proposals/real-post-capture.ts"])).toEqual([]);
    const gold = nonTest.filter((f) => /gold-review/.test(f) && !/^src\/(app\/\(app\)\/dev\/gold-review|components\/gold-review-view|lib\/server\/gold-review|lib\/gold-review)/.test(f));
    expect(gold).toEqual([]);
    // gold確認のページ・部品を参照してよいのは、自分自身（ページ・actions・view・store）だけ
    expect(importers(/gold-review/, [...nonTest.filter((f) => /gold-review/.test(f))])).toEqual([]);
    // 収集・登録案・AIのコードを読み込まない（gold確認はAIの出力に触れない）
    for (const f of nonTest.filter((x) => /(gold-review)/.test(x))) expect(readFileSync(f, "utf8"), f).not.toMatch(/server\/collector\/|server\/proposals\/|@anthropic-ai\/sdk|judgment\/xsource\/(research|proposal|vision)/);
  });
  it("実AIの比較試験の入口は、承認文・独立goldの検証・計画の費用の検査・ローカルDBの確認を行い、サンプルでは実AIを実行しない", () => {
    const t = readFileSync("src/lib/server/proposals/compare-real.real.test.ts", "utf8");
    expect(t).toContain("checkJudgmentRealRun(");
    expect(t.indexOf("checkJudgmentRealRun(")).toBeLessThan(t.indexOf("new Anthropic("));
    expect(t.indexOf("validateGold(gold)")).toBeLessThan(t.indexOf("new Anthropic("));
    expect(t).toContain("ローカルのSupabase以外には接続しません");
    expect(t).toContain("架空のサンプルでは実AIを実行しない");
    const s = readFileSync("scripts/compare-phase2.mjs", "utf8");
    expect(s).toContain("既定値はありません");
    expect(s).toContain("APPROVE C ${total}JPY");
    expect(readFileSync(".gitignore", "utf8")).toContain("eval/phase2-compare/*.local.json");
  });
  it("実AIの評価入口は、事前検査の後でないとクライアントを作らず、ローカルDB以外に接続せず、承認なしでは起動しない", () => {
    const t = readFileSync("src/lib/server/proposals/proposal-real.real.test.ts", "utf8");
    expect(t).toContain("checkJudgmentRealRun(");
    expect(t.indexOf("checkJudgmentRealRun(")).toBeLessThan(t.indexOf("new Anthropic("));
    expect(t).toContain("ローカルのSupabase以外には接続しません");
    const r = readFileSync("src/lib/server/proposals/real-run.ts", "utf8");
    expect(r.indexOf("preflightRun(")).toBeLessThan(r.indexOf("generateProposalsForCandidate("));
    const s = readFileSync("scripts/proposal-real.mjs", "utf8");
    expect(s).toContain("既定値はありません");
    expect(s).toContain("APPROVE P ${total}JPY");
    expect(s).toContain("MIN_PER_CASE");
  });
});

describe("実AIの評価入力（保存済みの公開投稿・公開ページ → 収集と同じ構造の候補）", () => {
  it("r10s は短縮URL未展開のまま（URLなしで調べさせる）・lp は項目自身のリンクと保存ページを持つ。架空は対象外。goldや人の回答を含めない", async () => {
    const { buildEvalCandidates, estimateRunCost } = await import("./eval-candidates");
    const { planXPost } = await import("@/lib/judgment/xsource/x-origin");
    const html = `<html><body><h1 class="heading01">【テスト店】拡張パック 抽選</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">拡張パック 1BOX</h4><p class="event-detail-ticket-card__text">受付</p></section></body></html>`;
    const c = buildEvalCandidates({ review: [{ id: "r1", real: true, sourceText: ["・拡張パック抽選 https://t.co/abc123 11/30(月)23:59〆"] }, { id: "r2", real: false, sourceText: ["架空"] }], lp: [{ n: 1, url: "https://shop.example.invalid/e/1", html }], now: "2026-11-22T00:00:00.000Z" });
    expect(c.map((x) => [x.kind, x.ref])).toEqual([["r10s", "r1"], ["lp", "1"]]);
    const plan = (x: (typeof c)[number]) => planXPost(postFromCandidate({ id: "i", last_good: { evidence: x.evidence } })!).items;
    expect(plan(c[0]).map((i) => i.status)).toEqual(["short_unexpanded"]);
    expect(plan(c[1]).map((i) => i.status)).toEqual(["url_from_item"]);
    expect(c[1].evidence.linkedPages?.[0].url).toBe("https://shop.example.invalid/e/1");
    expect(JSON.stringify(c)).not.toMatch(/gold|correctUnit|verdict|aiUnit/);
    const e = estimateRunCost({ itemsWithUrl: 12, itemsWithoutUrl: 3, search: true, maxReservedPerItemJpy: 6.1 });
    expect(e.expectedJpy).toBeGreaterThan(10);
    expect(e.reservedWorstJpy).toBe(91.5);
    expect(estimateRunCost({ itemsWithUrl: 0, itemsWithoutUrl: 3, search: false, maxReservedPerItemJpy: 3.6 }).expectedJpy).toBeLessThan(e.expectedJpy);
  });
});

describe("P2 の結果を受けた無課金の修正（値の導出の近さ・列挙値・検索の促し・判断出力の許容）", () => {
  it("言い換え・括弧・空白の違いは near_match（数字は完全一致が条件）。数字が違えば not_found。列挙値は語の一致で確認しない", () => {
    const text = "ポケモンカードゲーム MEGA 拡張パック「ハドウシーカー」 1BOX 6,000円(税込)";
    expect(valueSupport("ポケモンカードゲーム MEGA拡張パック『ハドウシーカー』(1BOX, 6,000円税込)", "ポケモンカードゲーム MEGA 拡張パック", text)).toBe("near_match");
    expect(valueSupport("ポケモンカードゲーム MEGA拡張パック『ハドウシーカー』(1BOX, 5,000円税込)", "ポケモンカードゲーム MEGA 拡張パック", text)).toBe("not_found"); // 金額が違う
    expect(valueSupport("全く別の長い商品名の文字列です", "ポケモンカードゲーム", text)).toBe("not_found");
    expect(valueSupport("短い値", "x", text)).toBe("not_found"); // 8文字未満は近さを使わない
  });
  it("応募単位の列挙値（observed）は support=enum_value（人が確認）。引用の実在とは別", async () => {
    const { toProposalRecords } = await import("@/lib/judgment/xsource/proposal");
    const post = { postId: "p", text: "《A店（東京）- 1件》 ・拡張パック", links: [], recordedAt: null };
    const plan = { itemNo: 1, groupLabel: "《A店》", itemText: "x", links: [], scopedUrls: [], status: "url_missing", seedText: "s", linkEvidence: [] } as never;
    const result = { investigation: { reason: "sufficient", turns: 1 }, registration: { decision: "tentative", verified: true, held: null, output: { fields: { apply_unit: { value: "per_store", basis: "observed", evidenceId: "s1", quote: "各店舗につき1回" } }, decision: "tentative" } }, evidence: [{ id: "s1", kind: "seed", text: "各店舗につき1回", contentHash: "h" }], searches: [], searchOffered: false, budget: { costJpy: 0 } } as never;
    const r = toProposalRecords({ candidateId: "c", post, run: { results: [{ plan, result }] }, mode: "real", modelId: "m", fetchedAt: null });
    expect(r[0].fields.apply_unit).toMatchObject({ support: "enum_value", basis: "observed" });
    expect(r[0].applyUnit).toBe("per_store");
  });
  it("URLなし・短縮URL未展開の項目の入力に『検索が使えるなら探してよい』が入り、調査AIの指示は『到達不能ではない』と明記する", async () => {
    const { planXPost } = await import("@/lib/judgment/xsource/x-origin");
    const { RESEARCH_SYSTEM } = await import("@/lib/judgment/xsource/research-ai");
    const p = planXPost({ postId: "p", text: "・拡張パック抽選 https://t.co/abc123 11/30", links: [], recordedAt: null });
    expect(p.items[0].seedText).toContain("検索が使えるなら");
    expect(planXPost({ postId: "p", text: "・拡張パック抽選 11/30", links: [], recordedAt: null }).items[0].seedText).toContain("検索が使えるなら");
    expect(RESEARCH_SYSTEM).toContain("「到達不能」ではない");
  });
  it("登録判断の出力で fields が省略されても、判断は採用し（主張なし）、診断に記録する。判断の種類が不正なら不備のまま", async () => {
    const { makeAnthropicRegistrationJudge } = await import("@/lib/judgment/xsource/research-ai");
    const mk = (input: unknown) => ({ messages: { create: vi.fn(async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_registration_judgment", input }], usage: { input_tokens: 1000, output_tokens: 100 } })) } }) as never;
    const seen: string[] = [];
    const ji = { caseId: "c", evidence: [], lastTurn: null, investigationEnd: "unreachable" as const, protectedFields: {} };
    const ok = await makeAnthropicRegistrationJudge(mk({ decision: "tentative", rationale: "証拠なし", unresolvedImpact: "material", monitor: { continue: true, why: "" } }), { onDiagnostic: (d) => seen.push(d.reason) })(ji);
    expect(ok).toMatchObject({ decision: "tentative", fields: {} });
    expect(seen).toEqual(["fields_defaulted"]);
    const bad = await makeAnthropicRegistrationJudge(mk({ decision: "maybe", fields: {} }), { onDiagnostic: (d) => seen.push(d.reason) })(ji);
    expect(bad).toBeNull();
    expect(seen.at(-1)).toMatch(/^bad_output:/);
  });
});

describe("根拠のない除外は検証の指摘にする（P2: 取得できないまま exclude とした事例）", () => {
  it("観察（検証済みの引用つき）の項目が1つも無い exclude は exclude_without_evidence。観察があれば指摘しない。結論は書き換えない", async () => {
    const { verifyRegistration } = await import("@/lib/judgment/xsource/research-loop");
    const ev = [{ id: "s1", kind: "seed", url: null, fetchedAt: "x", contentHash: "h", text: "【A店】拡張パック 抽選 11/30まで", structure: null, independent: true }] as never;
    const out = (fields: Record<string, unknown>, decision = "exclude") => ({ decision, fields, rationale: "", unresolvedImpact: "none", monitor: { continue: false, why: "" }, costJpy: 0 }) as never;
    expect(verifyRegistration({ output: out({ product: { value: null, basis: "unknown" } }), evidence: ev, protectedFields: {} }).issues).toContain("exclude_without_evidence");
    expect(verifyRegistration({ output: out({}), evidence: ev, protectedFields: {} }).issues).toContain("exclude_without_evidence");
    // 除外には、応募できない・対象外を示す根拠（exclude_reason・引用つき）が要る。店舗を観察できただけでは除外できない（Stage A: 応募できる機会を除外した例）
    expect(verifyRegistration({ output: out({ store: { value: "A店", basis: "observed", evidenceId: "s1", quote: "【A店】拡張パック" } }), evidence: ev, protectedFields: {} }).issues).toEqual(["exclude_reason_missing"]);
    expect(verifyRegistration({ output: out({ store: { value: "A店", basis: "observed", evidenceId: "s1", quote: "【A店】拡張パック" }, exclude_reason: { value: "対象外", basis: "observed", evidenceId: "s1", quote: "11/30まで" } }), evidence: ev, protectedFields: {} }).issues).toEqual([]);
    expect(verifyRegistration({ output: out({}, "tentative"), evidence: ev, protectedFields: {} }).issues).toEqual([]); // 暫定は対象外
  });
});
