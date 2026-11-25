// @vitest-environment node
/**
 * 有料試験の出力の耐障害的な保存（ジャーナル）と、破壊的操作の前の保全検査の回帰（無課金・架空データ・一時フォルダのみ。実データ・DB・ネットワークに触れない）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendUnit, closeJournal, doneUnits, findUnfinished, journalPath, journalRows, readJournal, scrub, startJournal, statusOf, unitKey } from "./run-journal";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tm-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const U = (caseId: string, arm = "links-baseline") => ({ experiment: "links", caseId, arm, role: "baseline" as const });

describe("ジャーナル: 取得できた時点ごとに追記し、上書き・二重実行・途中停止で失わない", () => {
  it("実行IDごとに別ファイル。同じ実行IDの開始は失敗（既存の結果を上書きしない）", () => {
    expect(startJournal(dir, "run-1", { stageKey: "s" }).ok).toBe(true);
    expect(startJournal(dir, "run-1", { stageKey: "s" })).toMatchObject({ ok: false });
    expect(startJournal(dir, "../evil", {})).toMatchObject({ ok: false, reason: "invalid_run_id" });
    expect(readJournal(journalPath(dir, "run-1")).entries).toHaveLength(1);
  });
  it("単位（案件×アーム）の結果を即時に追記。同じ単位は二重に書かず、保存済みの内容を変えない", () => {
    const p = (startJournal(dir, "run-2", {}) as { path: string }).path;
    expect(appendUnit(p, { runId: "run-2", unit: U("c1"), state: "done", costJpy: 2.5, proposals: [{ proposal_key: "k1", decision: "register", fields: { store: { quote: "原文の引用" } } }] })).toEqual({ written: true });
    expect(appendUnit(p, { runId: "run-2", unit: U("c1"), state: "done", costJpy: 99, proposals: [{ proposal_key: "OVERWRITE" }] })).toEqual({ written: false, reason: "duplicate_unit" });
    const { entries } = readJournal(p);
    expect(entries.filter((e) => e.kind === "unit")).toHaveLength(1);
    expect(entries[1].costJpy).toBe(2.5);
    expect(JSON.stringify(entries[1].proposals)).not.toContain("OVERWRITE");
  });
  it("途中停止・異常終了: 書き終えた単位は残り、終了していない実行として検出される。末尾の書きかけの行は無視して件数を報告", () => {
    const p = (startJournal(dir, "run-3", {}) as { path: string }).path;
    appendUnit(p, { runId: "run-3", unit: U("c1"), state: "done", costJpy: 1, proposals: [{ proposal_key: "a" }] });
    appendUnit(p, { runId: "run-3", unit: U("c2"), state: "done", costJpy: 1, proposals: [{ proposal_key: "b" }] });
    appendFileSync(p, '{"v":1,"runId":"run-3","seq":3,"kind":"unit","unit":{"experi'); // 強制終了で途中までしか書けなかった行
    const r = readJournal(p);
    expect(r.entries.filter((e) => e.kind === "unit")).toHaveLength(2);
    expect(r.torn).toBe(1);
    expect(statusOf(r.entries)).toBe("running_or_interrupted");
    expect(findUnfinished(dir).map((u) => u.runId)).toEqual(["run-3"]);
    expect([...doneUnits(r.entries)].sort()).toEqual([unitKey(U("c1")), unitKey(U("c2"))].sort());
  });
  it("終了後は追記できない（閉じた実行の結果を変えない）。閉じた実行は『終了していない実行』に数えない", () => {
    const p = (startJournal(dir, "run-4", {}) as { path: string }).path;
    appendUnit(p, { runId: "run-4", unit: U("c1"), state: "done", costJpy: 1 });
    expect(closeJournal(p, "run-4", "run_end", { stopReason: "completed" })).toEqual({ written: true });
    expect(closeJournal(p, "run-4", "run_abort", {})).toEqual({ written: false });
    expect(appendUnit(p, { runId: "run-4", unit: U("c2"), state: "done", costJpy: 1 })).toEqual({ written: false, reason: "run_closed" });
    expect(statusOf(readJournal(p).entries)).toBe("finished");
    expect(findUnfinished(dir)).toEqual([]);
  });
  it("秘密情報は書かない（キー名・トークンの形を除外）。原文の全文ではなく判断・引用・検証だけ", () => {
    const x = scrub({ proposal_key: "k", apiKey: "sk-ant-api03-ABCDEFGHIJKLMNOP", note: "Bearer abcdefghijklmnop12345 を使った", nested: { Authorization: "x", ok: "keep" } });
    expect(JSON.stringify(x)).not.toMatch(/sk-ant|abcdefghijklmnop|Authorization|apiKey/);
    expect(x).toMatchObject({ proposal_key: "k", nested: { ok: "keep" } });
    const p = (startJournal(dir, "run-5", {}) as { path: string }).path;
    appendUnit(p, { runId: "run-5", unit: U("c1"), state: "done", costJpy: 1, proposals: [{ proposal_key: "k", token: "secret-token-value", decision: "register" }] });
    expect(readFileSync(p, "utf8")).not.toContain("secret-token-value");
  });
  it("保存済みの出力だけから、DBなしで再採点用の行を取り出せる（復元・再採点可能性）。失敗した単位は含めない", () => {
    const p = (startJournal(dir, "run-6", {}) as { path: string }).path;
    appendUnit(p, { runId: "run-6", unit: U("c1"), state: "done", costJpy: 1, proposals: [{ proposal_key: "a", decision: "exclude" }] });
    appendUnit(p, { runId: "run-6", unit: U("c2"), state: "failed", costJpy: 0, reason: "judge_failed" });
    const rows = journalRows(readJournal(p).entries);
    expect(rows.get(unitKey(U("c1")))).toEqual([{ proposal_key: "a", decision: "exclude" }]);
    expect(rows.has(unitKey(U("c2")))).toBe(false);
  });
});

// ---- 破壊的操作の前の保全検査（scripts/lib/eval-preservation.mjs）
type Fn = (...a: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = async (): Promise<Record<string, Fn>> => (await import(/* @vite-ignore */ pathToFileURL(resolve("scripts/lib/eval-preservation.mjs")).href)) as Record<string, Fn>;
const put = (root: string, rel: string, body: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
};

describe("保全検査: 欠落・破損・不意の変更・未保存の登録案があれば破壊的操作を中止する", () => {
  it("manifest が無ければ中止。保存後は通り、gold の変更・欠落・台帳の巻き戻しを検出する", async () => {
    const m = await load();
    const root = join(dir, "eval");
    const man = join(dir, "manifest.json");
    put(root, "gold.synthetic.local.json", JSON.stringify([{ caseId: "c1" }]));
    put(root, "spend-ledger.local.json", JSON.stringify({ runs: [{ id: "run-a", finishedAt: "2026-11-24T00:00:00Z", costJpy: 8.76 }] }));
    put(root, "audit.local.jsonl", '{"a":1}\n{"a":2}\n');
    expect(m.verifyCritical(root, man).ok).toBe(false); // 記録が無い
    expect(m.saveManifest(root, man)).toMatchObject({ ok: true });
    expect(m.verifyCritical(root, man).ok).toBe(true);
    put(root, "gold.synthetic.local.json", JSON.stringify([{ caseId: "c1-changed" }])); // gold の不意の変更
    expect(m.verifyCritical(root, man).errors.join("")).toContain("変更されている");
    expect(m.saveManifest(root, man)).toMatchObject({ ok: false, conflicts: ["gold.synthetic.local.json"] }); // 変更の検出を無効化しない
    put(root, "gold.synthetic.local.json", JSON.stringify([{ caseId: "c1" }]));
    put(root, "spend-ledger.local.json", JSON.stringify({ runs: [{ id: "run-a", finishedAt: null, costJpy: null }] })); // 台帳が未完了へ巻き戻った
    expect(m.verifyCritical(root, man).errors.join("")).toContain("未完了");
    put(root, "spend-ledger.local.json", JSON.stringify({ runs: [] }));
    expect(m.verifyCritical(root, man).errors.join("")).toContain("消えている");
    rmSync(join(root, "audit.local.jsonl"));
    expect(m.verifyCritical(root, man).errors.join("")).toContain("欠落");
    put(root, "audit.local.jsonl", '{"a":1}\n{"a":2}\n');
    put(root, "spend-ledger.local.json", JSON.stringify({ runs: [{ id: "run-a", finishedAt: "x", costJpy: 8.76 }] }));
    expect(m.verifyCritical(root, man).ok).toBe(true);
    put(root, "gold.synthetic.local.json", "{ broken");
    expect(m.verifyCritical(root, man).ok).toBe(false);
  });
  it("ローカルDBにだけある登録案は、別の保存先（run-exports・ジャーナル・保全スナップショット）に無ければ未保存。あれば保存済み。壊れた保存は保存とみなさない", async () => {
    const m = await load();
    const root = join(dir, "eval2");
    const rows = [
      { candidate_id: "c1", proposal_key: "k1", input_hash: "h1" },
      { candidate_id: "c2", proposal_key: "k2", input_hash: "h2" },
      { candidate_id: "c3", proposal_key: "k3", input_hash: "h3" },
    ];
    expect(m.unsavedProposals(rows, root)).toHaveLength(3);
    put(root, "run-exports/run-1.local.json", JSON.stringify({ runs: [{ proposals: [rows[0]] }] }));
    put(root, "run-9.journal.local.jsonl", JSON.stringify({ kind: "unit", proposals: [rows[1]] }) + "\n" + '{"kind":"unit","propos'); // 途中で切れた行があっても、完全な行は有効
    put(root, "preserved/proposals-x.json", "{ broken");
    expect(m.unsavedProposals(rows, root).map((r: { candidate_id: string }) => r.candidate_id)).toEqual(["c3"]);
    put(root, "preserved/proposals-y.json", JSON.stringify({ proposals: [rows[2]] }));
    expect(m.unsavedProposals(rows, root)).toEqual([]);
  });
  it("ログ出力を保存した .json（先頭に見出し）は読み取り可、本当に壊れたものは不可", async () => {
    const m = await load();
    expect(m.parsesLoosely('RESCORE {"a":1}')).toBe(true);
    expect(m.parsesLoosely('{"a":1}')).toBe(true);
    expect(m.parsesLoosely("RESCORE {broken")).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("静的確認: 破壊的なローカルDB操作は保全検査を通る。保全データはGit管理外", () => {
  it("test:db・test:e2e:supabase・db:reset は、実行前に guardEvalData を呼ぶ（迂回する環境変数は無い）", () => {
    for (const f of ["scripts/run-db-tests.mjs", "scripts/run-e2e-supabase.mjs", "scripts/dev-db.mjs"]) expect(readFileSync(f, "utf8"), f).toMatch(/guardEvalData\(/);
    expect(readFileSync("scripts/lib/eval-guard.mjs", "utf8")).not.toMatch(/process\.env\.[A-Z_]*(SKIP|BYPASS|FORCE)/);
  });
  it("ジャーナル・保全コピー・保全の記録・実行ごとの保全は .gitignore で除外される", () => {
    const gi = readFileSync(".gitignore", "utf8");
    for (const x of ["eval/phase2-compare/*.local.json", "eval/phase2-compare/*.local.jsonl", "eval/phase2-compare/preserved/", "eval/phase2-compare/run-exports/"]) expect(gi, x).toContain(x);
  });
});
