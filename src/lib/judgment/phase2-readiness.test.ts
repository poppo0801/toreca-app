// @vitest-environment node
/**
 * 第2段階（実データ評価）の承認前準備の検査。**架空データのみ。本番DB・実原文・外部AI・課金APIには触れない**。
 * 承認ゲートA〜Eが個別に承認されるまで、実データの取得・送信・課金が実行不能であることを確認する。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertMaySend, prepareForExternal, type StoredRow } from "./eval/phase2";
import { compareStructureOnly, legacyStructureFromTexts, phase2CostPlan, scoreLegacyFields } from "./eval/phase2-compare";
import { assertGoldFrozenBeforeRun, buildGold, draftFromProposal, freezeManifest, newReviewSheet, renderReviewMarkdown, validateHuman, verifyManifest, type ReviewItem } from "./eval/phase2-review";

// @ts-expect-error .mjs（型定義なし）
const ex = (await import("../../../scripts/lib/phase2-extract.mjs")) as {
  buildExtractSql: (o?: { limit?: number; sinceIso?: string }) => string;
  assertSafeExtractSql: (s: string) => boolean;
  readApprovals: (p?: string) => Record<string, { approved: boolean }>;
  checkGates: (a: string, ap: Record<string, { approved: boolean }>) => { ok: boolean; missing: string[] };
  planExtractRun: (o: Record<string, unknown>) => { mode: string; canConnect: boolean; reasons: string[] };
  buildQueryArgs: (o: { ref: string; file: string }) => string[];
  assertRefMatch: (o: { expectRef?: string; linkedRef: string | null; productionRefs: string[] }) => boolean;
  assertRecentBackup: (o: { list: () => { name: string; mtimeMs: number }[]; nowMs: number; maxAgeHours?: number }) => boolean;
  sanitizeRows: (r: unknown) => Record<string, string | null>[];
  wrapReadOnly: (s: string) => string;
  runExtraction: (o: Record<string, unknown>) => Promise<{ mode: string; executed: boolean; reasons: string[]; count?: number; noText?: number; log?: Record<string, unknown>[] }>;
  assertLocalOutputPath: (p: string, g: string) => boolean;
  safeLogRow: (r: Record<string, unknown>, seq: number) => Record<string, unknown>;
  buildDeletionRecord: (f: { name: string; bytes: number }[], at: string) => { count: number; files: { name: string }[] };
  MAX_ROWS: number;
};

const CLEAN = "サンプルゲーム 北店 抽選販売。応募期間 2099-04-01〜2099-04-08。";
const row = (id: string, text: string | null): StoredRow => ({ id, stratum: "x", text, fetchedAt: "2099-01-01T00:00:00Z" });

describe("抽出SQL: 読み取り専用・列ホワイトリスト・最大30件（静的検査）", () => {
  it("組み立てたSQLは検査を通り、対象は collection_candidates のみ・limit は30以下に丸められる", () => {
    const sql = ex.buildExtractSql({ limit: 999 });
    expect(ex.assertSafeExtractSql(sql)).toBe(true);
    expect(sql).toMatch(/limit 30$/);
    expect(sql).not.toMatch(/household_id|draft|applications|profiles/);
    expect(() => ex.buildExtractSql({ limit: 0 })).toThrow();
    expect(() => ex.buildExtractSql({ sinceIso: "2026-11-20'; drop table x;--" })).toThrow();
  });
  it("書き込み・複数文・他の表・禁止列・limit超過・コメントは拒否する", () => {
    const ok = ex.buildExtractSql({ limit: 5 });
    const bad = [
      "delete from public.collection_candidates",
      `${ok}; drop table public.lotteries`,
      ok.replace("collection_candidates cp", "lotteries cp"),
      ok.replace("cp.status,", "cp.household_id,"),
      ok.replace("cp.status,", "cp.draft,"),
      ok.replace(/limit 5$/, "limit 500"),
      ok.replace(/limit 5$/, ""),
      `${ok} -- x`,
      ok.replace("select", "update"),
      ok.replace("from public.collection_candidates cp", "from public.collection_candidates cp join public.applications a on true"),
      ok.replace("'evidence'->>'text'", "'evidence'->>'secret'"),
    ];
    for (const s of bad) expect(() => ex.assertSafeExtractSql(s), s.slice(0, 60)).toThrow();
  });
});

describe("承認ゲート: 未承認では抽出・送信・課金が実行不能", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2-"));
  let n = 0;
  const approve = (gates: string[], extra: Record<string, unknown> = {}) => {
    const p = join(dir, `a-${n++}.json`);
    writeFileSync(p, JSON.stringify({ gates: Object.fromEntries(gates.map((g) => [g, { approved: true, by: "利用者", at: "2099-01-01", scope: "テスト", ...extra }])) }));
    return p;
  };
  it("承認記録が無い・壊れている・形式不備（承認者なし・AI名義・日付なし・範囲なし・真偽値のみ）はすべて未承認", () => {
    expect(ex.readApprovals(join(dir, "none.json"))).toEqual({});
    const broken = join(dir, "b.json");
    writeFileSync(broken, "{not json");
    expect(ex.readApprovals(broken)).toEqual({});
    expect(ex.readApprovals(approve(["A"], { by: "" }))).toEqual({});
    expect(ex.readApprovals(approve(["A"], { by: "Claude" }))).toEqual({});
    expect(ex.readApprovals(approve(["A"], { at: "昨日" }))).toEqual({});
    expect(ex.readApprovals(approve(["A"], { scope: "" }))).toEqual({});
    const boolOnly = join(dir, "c.json");
    writeFileSync(boolOnly, JSON.stringify({ gates: { A: { approved: true } } }));
    expect(ex.readApprovals(boolOnly)).toEqual({});
    expect(ex.readApprovals(approve(["A"]))).toEqual({ A: { approved: true } });
  });
  it("行為ごとに必要なゲートが決まっている（抽出=A／送信=A・B・C／課金評価=A・B・C・E、正解率の断定=A〜E）。1つでも欠ければ不可", () => {
    expect(ex.checkGates("extract", {}).ok).toBe(false);
    expect(ex.checkGates("extract", { A: { approved: true } }).ok).toBe(true);
    expect(ex.checkGates("send_external", { A: { approved: true }, B: { approved: true } }).missing).toEqual(["C"]);
    expect(ex.checkGates("paid_eval", { A: { approved: true }, B: { approved: true }, C: { approved: true }, D: { approved: true } }).missing).toEqual(["E"]);
    // gold（D）は、新旧のシャドー比較（課金評価）の必須条件にしない。正解率を断定するときだけ必要
    expect(ex.checkGates("paid_eval", { A: { approved: true }, B: { approved: true }, C: { approved: true }, E: { approved: true } }).ok).toBe(true);
    expect(ex.checkGates("paid_eval_with_gold", { A: { approved: true }, B: { approved: true }, C: { approved: true }, E: { approved: true } }).missing).toEqual(["D"]);
    expect(() => ex.checkGates("unknown_action", {})).toThrow();
  });
  it("抽出の実行計画: dry-run は接続しない。--execute は、二重ゲート・承認A・バックアップ申告がすべて揃ったときだけ「接続可」（判定のみで、この関数は接続しない）", () => {
    expect(ex.planExtractRun({}).canConnect).toBe(false);
    const noGate = ex.planExtractRun({ execute: true });
    expect(noGate.reasons.length).toBeGreaterThanOrEqual(3);
    const all = ex.planExtractRun({ execute: true, yesProduction: true, approvals: { A: { approved: true } }, backupDone: true });
    expect(all.canConnect).toBe(true);
    expect(ex.planExtractRun({ execute: true, yesProduction: true, approvals: {}, backupDone: true }).canConnect).toBe(false);
    expect(ex.planExtractRun({ execute: true, yesProduction: false, approvals: { A: { approved: true } }, backupDone: true }).canConnect).toBe(false);
    expect(ex.planExtractRun({ execute: true, yesProduction: true, approvals: { A: { approved: true } }, backupDone: false }).canConnect).toBe(false);
  });
  it("抽出スクリプト: dry-run は SQL とゲート状態を表示して終了0、--execute は終了コード3で止まる（DB接続・環境変数不要）", () => {
    // 作業ディレクトリを空の一時フォルダにする（リポジトリにあるローカルの承認記録に左右されない＝承認記録が無い状態の検査）
    const cwd = mkdtempSync(join(tmpdir(), "p2cwd-"));
    const base = { cwd, encoding: "utf8" as const, env: { ...process.env, TOREMANE_TARGET: "", NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" } };
    const dry = spawnSync("node", [join(process.cwd(), "scripts/extract-judgment-phase2.mjs")], base);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("dry-run");
    expect(dry.stdout).toContain("未承認");
    const exec = spawnSync("node", [join(process.cwd(), "scripts/extract-judgment-phase2.mjs"), "--execute", "--yes-production", "--backup-done"], base);
    expect(exec.status).toBe(3);
    expect(exec.stderr).toContain("実行できません");
    expect(existsSync(join(cwd, "eval/real-data/approvals.json"))).toBe(false); // テストが承認記録を作らない
    rmSync(cwd, { recursive: true, force: true });
  });
  it("出力先は eval/real-data/ 配下の Git管理外のみ。ログは原文・URL・IDを出さない。削除記録は内容を含まない", () => {
    expect(ex.assertLocalOutputPath("eval/real-data/raw.json", "node_modules\neval/real-data/\n")).toBe(true);
    for (const p of ["eval/judgment-10e/raw.json", "../x.json", "eval/real-data/../x.json", "C:/x.json"]) expect(() => ex.assertLocalOutputPath(p, "eval/real-data/\n"), p).toThrow();
    expect(() => ex.assertLocalOutputPath("eval/real-data/a.json", "node_modules\n")).toThrow();
    const log = JSON.stringify(ex.safeLogRow({ evidence_text: "お名前: ダミー太郎", evidence_url: "https://example.invalid/x", id: "uuid-1", evidence_hash: "abcdef1234567890" }, 3));
    expect(log).not.toContain("ダミー");
    expect(log).not.toContain("example.invalid");
    expect(log).not.toContain("uuid-1");
    const d = ex.buildDeletionRecord([{ name: "eval/real-data/raw.json", bytes: 10 }], "2099-02-01T00:00:00Z");
    expect(d.count).toBe(1);
    expect(JSON.stringify(d)).not.toContain("eval/real-data");
    rmSync(dir, { recursive: true, force: true });
  });
  it(".gitignore に eval/real-data/ がある（原文・正解のコミット防止）", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(".gitignore", "utf8").split(/\r?\n/)).toContain("eval/real-data/");
  });
});

describe("外部送信の最終関門（assertMaySend）", () => {
  const prepared = (reviewed: string[]) => prepareForExternal([row("a", CLEAN), row("b", `${CLEAN} お名前: ダミー太郎`), row("c", null)], new Set(reviewed));
  const okGate = { ok: true, missing: [] as string[] };
  it("ゲート未承認・正解未固定・1件でも未確認/漏洩/原文なしがあれば、全体を送らない", () => {
    expect(() => assertMaySend({ ok: false, missing: ["C"] }, prepareForExternal([row("a", CLEAN)], new Set(["a"])), true)).toThrow(/未承認/);
    expect(() => assertMaySend(okGate, prepareForExternal([row("a", CLEAN)], new Set(["a"])), false)).toThrow(/固定/);
    expect(() => assertMaySend(okGate, prepareForExternal([row("a", CLEAN)], new Set()), true)).toThrow(/送信不可/);
    expect(() => assertMaySend(okGate, prepared(["a", "b"]), true)).toThrow(/送信不可/);
    expect(() => assertMaySend(okGate, [], true)).toThrow();
  });
  it("すべて確認済み・漏洩なし・ゲート承認・正解固定済みのときだけ送れる", () => {
    const p = prepareForExternal([row("a", CLEAN), row("d", `${CLEAN} (2)`)], new Set(["a", "d"]));
    expect(assertMaySend(okGate, p, true).length).toBe(2);
  });
});

describe("正解（gold）の作成と固定: 人の確認だけを正解にし、AIの提案は流用しない", () => {
  const base: ReviewItem[] = newReviewSheet([
    { seq: 1, stratum: "s1", text: "原文1" },
    { seq: 2, stratum: "s2", text: "原文2" },
    { seq: 3, stratum: "s3", text: "原文3" },
    { seq: 4, stratum: "s4", text: "原文4" },
    { seq: 5, stratum: "s5", text: null },
  ]);
  const human = (over: Record<string, unknown> = {}) => ({ reviewer: "利用者", reviewedAt: "2099-02-01", decision: "approved" as const, structure: "per_product", opportunityCount: 2, fields: { applyDeadline: "2099-05-05" }, ...over });
  it("確認シートに原文は含まれず（ハッシュのみ）、原文なしは対象外", () => {
    expect(base.length).toBe(4);
    expect(JSON.stringify(base)).not.toContain("原文1");
    expect(base[0].textHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("提案だけ・pending・AI名義・機会数なしは正解にならず、承認済みだけが正解になる。判断不能は検証不能として記録", () => {
    const items: ReviewItem[] = [
      { ...base[0], proposal: { source: "ai", structure: "per_product", opportunityCount: 2 } },
      { ...base[1], human: human({ decision: "pending" }) },
      { ...base[2], human: human({ reviewer: "Claude Haiku" }) },
      { ...base[3], human: human() },
    ];
    const g = buildGold(items);
    expect(Object.keys(g.gold)).toEqual(["R04"]);
    expect(g.gold.R04.structure).toBe("per_product");
    expect(g.notAdopted.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(g.notAdopted[0].reason).toContain("提案のみ");
    const u = buildGold([{ ...base[0], human: human({ decision: "unverifiable", structure: undefined, opportunityCount: undefined, note: "判断不能" }) }]);
    expect(u.gold.R01.verifiable).toBe(false);
    expect(validateHuman(human({ opportunityCount: 0 }))).toContain("応募機会の数（1以上）が必要です");
    expect(validateHuman(human({ reviewedAt: "昨日" })).length).toBeGreaterThan(0);
  });
  it("提案からの下書きは pending で、人が approved にするまで正解にならない（省力化と安全の両立）", () => {
    const it0: ReviewItem = { ...base[0], proposal: { source: "legacy", structure: "store_select", opportunityCount: 1 } };
    const d = draftFromProposal(it0)!;
    expect(d.decision).toBe("pending");
    expect(buildGold([{ ...it0, human: d }]).gold).toEqual({});
    expect(buildGold([{ ...it0, human: { ...d, reviewer: "利用者", reviewedAt: "2099-02-02", decision: "approved" } }]).gold.R01.structure).toBe("store_select");
    expect(draftFromProposal(base[1])).toBeNull();
    expect(renderReviewMarkdown(it0, "原文1")).toContain("正解ではありません");
  });
  it("固定: 原文または正解が変わると検知され、固定前・未固定・改変ありでは AI 実行できない", () => {
    const items: ReviewItem[] = [{ ...base[0], human: human() }, { ...base[3], human: human({ opportunityCount: 3 }) }];
    const built = buildGold(items);
    const m = freezeManifest(items, built, "2099-03-01T00:00:00Z");
    expect(verifyManifest(m, items, built)).toEqual({ ok: true, changed: [] });
    const changedGold = buildGold([{ ...items[0], human: human({ opportunityCount: 5 }) }, items[1]]);
    expect(verifyManifest(m, items, changedGold)).toEqual({ ok: false, changed: [1] });
    const changedText = items.map((i, k) => (k === 1 ? { ...i, textHash: "0".repeat(64) } : i));
    expect(verifyManifest(m, changedText, built).changed).toEqual([4]);
    expect(() => assertGoldFrozenBeforeRun(null, "2099-03-02T00:00:00Z", { ok: true })).toThrow(/固定されていません/);
    expect(() => assertGoldFrozenBeforeRun(m, "2099-02-28T00:00:00Z", { ok: true })).toThrow(/後/);
    expect(() => assertGoldFrozenBeforeRun(m, "2099-03-02T00:00:00Z", { ok: false })).toThrow(/変更/);
    expect(() => assertGoldFrozenBeforeRun(m, "2099-03-02T00:00:00Z", verifyManifest(m, items, built))).not.toThrow();
  });
});

describe("旧方式との比較（構造のみ＝無課金／項目抽出＝未実行）", () => {
  it("旧の構造判定は表現できない構造を誤りと混ぜず、別集計する", () => {
    const c = compareStructureOnly([
      { gold: { verifiable: true, structure: "store_select", issue: "" }, legacy: "store_select" },
      { gold: { verifiable: true, structure: "per_store", issue: "" }, legacy: "store_select" },
      { gold: { verifiable: true, structure: "per_product", issue: "" }, legacy: "unknown" },
      { gold: { verifiable: true, structure: "per_round", issue: "" }, legacy: "unknown" },
      { gold: { verifiable: false, issue: "" }, legacy: "unknown" },
    ]);
    expect(c).toEqual({ legacyCorrect: 1, legacyWrong: 1, legacyUnexpressible: 2, scored: 4 });
  });
  it("旧の固定判定を原文テキストに適用でき（課金なし）、項目抽出の採点は正解のある項目だけ", () => {
    expect(["store_select", "per_store", "unknown"]).toContain(legacyStructureFromTexts(["応募フォームで受取店舗を選択してください（北店・南店）"]));
    expect(scoreLegacyFields({ verifiable: true, issue: "", fields: { applyDeadline: "2099-05-05", resultDate: "2099-05-10" } }, { applyDeadline: "2099-05-05 23:59", resultDate: null })).toEqual({ scored: 2, correct: 1 });
  });
  it("費用見積もり: 30件・総額50円・1件3円。最悪（全件3回）は新方式の配分内に収まらない場合があり、予算停止で未実行になりうる", () => {
    const p = phase2CostPlan(30, true);
    expect([p.totalCapJpy, p.perCaseCapJpy, p.newBudgetJpy, p.legacyBudgetJpy]).toEqual([50, 3, 35, 15]);
    expect(p.newMaxJpy).toBeGreaterThan(p.newBudgetJpy);
    expect(p.worstCaseFits).toBe(false);
    expect(p.maxCasesWorstCase).toBe(21);
    expect(p.newTypicalJpy).toBeLessThan(p.newBudgetJpy);
    const noLegacy = phase2CostPlan(30, false);
    expect(noLegacy.legacyExtractEstJpy).toBe(0);
    expect(noLegacy.newBudgetJpy).toBe(50);
    expect(noLegacy.maxCasesWorstCase).toBe(30);
    expect(ex.MAX_ROWS).toBe(30);
  });
});

describe("抽出の実行（Stage 10F）: すべての確認が揃うまで接続しない。接続は注入された query だけ", () => {
  const REF = "abcdefghij0123456789";
  const NOW = Date.parse("2099-03-01T12:00:00Z");
  const base = () => {
    const calls: string[] = [];
    const written: { p: string; body: string }[] = [];
    return {
      calls,
      written,
      o: {
        execute: true, yesProduction: true, approvals: { A: { approved: true } }, backupDone: true,
        expectRef: REF, linkedRef: REF, productionRefs: [REF], nowMs: NOW, limit: 30, sinceIso: "2026-11-20T01:09:01Z",
        backupList: () => [{ name: "tcg-full-20990301-110000.tcgbak2", mtimeMs: NOW - 3_600_000, size: 170_000_000 }],
        outPath: "eval/real-data/extract-test.json", gitignoreText: "eval/real-data/\n",
        query: async (sql: string) => { calls.push(sql); return [{ id: "i1", status: "pending", created_at: "2099-01-01T00:00:00Z", evidence_text: "架空の原文", evidence_fetched_at: "2099-01-01T00:00:00Z", evidence_via: "web_fetch", evidence_origin: "primary", evidence_hash: "abcdef1234567890", evidence_url: "https://x.invalid/a", household_id: "SECRET", draft: "SECRET" }]; },
        write: (p: string, body: string) => { written.push({ p, body }); },
      } as Record<string, unknown>,
    };
  };
  it("dry-run は query を呼ばない。ゲートA未承認・二重ゲート欠け・バックアップ未申告は query を呼ばず、理由を返す", async () => {
    const t = base();
    expect((await ex.runExtraction({ ...t.o, execute: false })).executed).toBe(false);
    for (const over of [{ approvals: {} }, { yesProduction: false }, { backupDone: false }]) {
      const r = await ex.runExtraction({ ...t.o, ...over });
      expect(r.executed).toBe(false);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
    expect(t.calls).toEqual([]);
    expect(t.written).toEqual([]);
  });
  it("接続先の不一致（--expect-ref なし・本番以外・リンク先と不一致）・古いバックアップ・出力先違反は、query を呼ぶ前に例外", async () => {
    const t = base();
    for (const over of [{ expectRef: undefined }, { expectRef: "zzzzzzzzzzzzzzzzzzzz", linkedRef: "zzzzzzzzzzzzzzzzzzzz" }, { linkedRef: "yyyyyyyyyyyyyyyyyyyy" }, { linkedRef: null }, { backupList: () => [] }, { backupList: () => [{ name: "tcg-full-empty.tcgbak2", mtimeMs: NOW - 3_600_000, size: 10 }] }, { backupList: () => [{ name: "tcg-db-20990301.tcgbak2", mtimeMs: NOW - 3_600_000, size: 170_000_000 }] }, { backupList: () => [{ name: "tcg-full-old.tcgbak2", mtimeMs: NOW - 30 * 3_600_000, size: 170_000_000 }] }, { outPath: "eval/judgment-10e/x.json" }, { gitignoreText: "node_modules\n" }]) {
      await expect(ex.runExtraction({ ...t.o, ...over }), JSON.stringify(Object.keys(over))).rejects.toThrow();
    }
    expect(t.calls).toEqual([]);
  });
  it("すべて揃ったときだけ1回 query を呼び、許可された列だけを保存する（household_id・draft などは捨てる）。ログに原文・URL・IDを出さない", async () => {
    const t = base();
    const r = await ex.runExtraction(t.o);
    expect(r.executed).toBe(true);
    expect(t.calls.length).toBe(1);
    expect(ex.assertSafeExtractSql(t.calls[0])).toBe(true);
    expect(t.written.length).toBe(1);
    expect(t.written[0].body).not.toContain("SECRET");
    expect(t.written[0].body).toContain("架空の原文"); // 原文は Git管理外のローカルファイルにだけ保存
    const log = JSON.stringify(r.log);
    for (const bad of ["架空の原文", "x.invalid", "i1", "SECRET"]) expect(log).not.toContain(bad);
  });
  it("取得結果は30件・原文なし3件に制限し、形式が違えば拒否する。CLIの引数は --remote=<ref> と --read-only を含み、--linked・書き込み系の指定を含まない", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: String(i), evidence_text: i < 40 ? "t" : null }));
    const rows = ex.sanitizeRows(many);
    expect(rows.length).toBe(30);
    expect(ex.sanitizeRows(Array.from({ length: 10 }, () => ({ evidence_text: null }))).length).toBe(3);
    expect(() => ex.sanitizeRows({ rows: [] })).toThrow();
    const a = ex.buildQueryArgs({ ref: REF, file: "tmp/q.sql" });
    expect(a).toContain(`--remote=${REF}`);
    expect(a).toContain("--read-only");
    expect(a.join(" ")).not.toMatch(/--linked|--yes|--local/);
    expect(() => ex.buildQueryArgs({ ref: "bad", file: "q.sql" })).toThrow();
    expect(() => ex.buildQueryArgs({ ref: REF, file: "C:\\Users\\x\\AppData\\Local\\Temp\\tcg-p2-abc\\q.sql" })).not.toThrow(); // Windowsの一時パス
    expect(() => ex.buildQueryArgs({ ref: REF, file: "q.sql; rm" })).toThrow();
    expect(ex.wrapReadOnly("select 1;")).toBe("begin read only;\nselect 1;\nrollback;\n");
  });
});
