// 本番DBのマイグレーション: 計画（plan・読み取り専用）と適用（apply・承認済みの計画のときだけ）。Stage 9H-3R-Release
//   npm run prod -- scripts/release-db.mjs plan  --yes-production
//   npm run prod -- scripts/release-db.mjs apply --plan-sha=<planで表示された値> --yes-production
// 入口は prod.mjs（本番作用の唯一の入口）。Claude Code の設定は `db push`・`--linked` の直接実行を禁止したままにし、
// 利用者が .claude/settings.local.json で `Bash(npm run prod -- scripts/release-db.mjs*)` を許可したときだけ、この入口が使える（docs/RELEASE_FLOW.md）。
//
// plan:  ①ローカルの全マイグレーションと本番の適用履歴の差（未適用の版）を求める ②各ファイルの危険な記述（drop・rename・型変更・NOT NULL追加 など）を検査
//        ③直近のバックアップの新しさを確認 ④`db push --dry-run` で、適用予定が未適用の版と一致することを確認 ⑤計画の指紋（plan-sha）を出力
// apply: 現在の状態から計画の指紋を再計算し、承認時と一致しなければ中止（承認後に状態が変わったとき）。バックアップが24時間以内でなければ中止。
//        `db push --include-all` を実行し、前後で既存の全表の件数が変わらないこと・未適用が残らないことを確認する。失敗したらそこで停止し、自動でのやり直し・巻き戻しはしない。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("release-db.mjs");
const mode = process.argv[2];
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
if (!["plan", "approve", "apply"].includes(mode)) {
  console.error("使い方: npm run prod -- scripts/release-db.mjs <plan|approve|apply> [--plan-sha=…] --yes-production");
  process.exit(2);
}
const sh = (args) => spawnSync("npx", ["supabase", ...args], { encoding: "utf8", shell: true, maxBuffer: 1 << 26 });
const scrub = (s) => String(s ?? "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***").replace(/(password|token|secret)=\S+/gi, "$1=***");
const fail = (m) => {
  console.error(`中止: ${m}`);
  process.exit(1);
};

// ---- ①本番の適用履歴（読み取り）と未適用の版
const linkedRef = readFileSync("supabase/.temp/project-ref", "utf8").trim();
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(linkedRef)) fail("リンク先と本番の設定の接続先が一致しません");
const list = sh(["migration", "list", "--linked"]);
if (list.status !== 0) fail(`migration list に失敗しました（Supabase CLI のログイン・リンクを確認）: ${scrub(list.stderr).slice(0, 300)}`);
// CLI 3.x は JSON（{"migrations":[{"local","remote",…}]}）、旧版は表形式。どちらも「リモート（本番）の適用済み」の版を集める
const remoteVersions = (out) => {
  const set = new Set();
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    for (const m of j.migrations ?? []) if (m.remote) set.add(String(m.remote));
    return set;
  } catch {
    /* 表形式へ */
  }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d{14})?\s*\|\s*(\d{14})?\s*\|/.exec(line);
    if (m?.[2]) set.add(m[2]); // 2列目＝リモート（本番）の適用済み
  }
  return set;
};
const applied = remoteVersions(list.stdout);
if (applied.size === 0) fail(`本番の適用履歴を読み取れませんでした（出力の先頭: ${JSON.stringify(scrub(list.stdout).slice(0, 300))} / stderr: ${JSON.stringify(scrub(list.stderr).slice(0, 200))}）`);
const files = readdirSync("supabase/migrations").filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
const pending = files.filter((f) => !applied.has(f.slice(0, 14)));
const unknownRemote = [...applied].filter((v) => !files.some((f) => f.startsWith(v)));
if (unknownRemote.length) fail(`本番にあってローカルに無い版があります（履歴の食い違い）: ${unknownRemote.join(",")}`);

// ---- ②危険な記述の検査（追加のみの移行だけを自動の対象にする）
const RISKY = [
  [/\bdrop\s+(table|column|schema|type|index|policy|trigger)\b/i, "drop（表・列・スキーマなど）"],
  [/\balter\s+table[^;]*\b(rename|drop\s+column|alter\s+column[^;]*\btype\b)/i, "表・列の名前変更/削除/型変更"],
  [/\balter\s+table[^;]*\badd\s+column[^;]*\bnot\s+null\b(?![^;]*\bdefault\b)/i, "既定値なしの NOT NULL 列の追加"],
  [/\btruncate\b/i, "truncate"],
  [/^\s*delete\s+from\b/im, "delete"],
];
// 人が内容を確認済みの検出（誤検知）。ファイルの内容のハッシュに固定するため、ファイルが少しでも変われば無効になり、再び要確認になる
const REVIEWED = {
  "20261218000100_stage8f4.sql": { sha: "55ff66c12dfe", labels: ["delete"], reason: "新規の空の表 lottery_source_snapshots の保持期間切れを消す関数の本文（既存の表・データには触れない）" },
  "20261226000108_stage10d_case_foundation.sql": { sha: "f8eb5634cddd", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: purge_test_households（case_judgments ほかを削除）" },
  "20261227000109_stage10k_shadow_queue.sql": { sha: "03566db4b2ca", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
  "20261227000110_stage10l_image_verification.sql": { sha: "13deb0a00489", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
  "20261227000111_stage10m_list_items.sql": { sha: "af975618923f", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
  "20261227000112_stage10n_shadow_opportunities.sql": { sha: "2f8a77972a44", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
  "20261230000116_market_shared_and_plan_marks.sql": { sha: "c37dbc6c9435", labels: ["drop（表・列・スキーマなど）", "delete"], reason: "相場管理データの共通化。drop は一意索引・外部キーの付け替えのみ（行は消えない）。delete は同一世帯の重複カード統合の1文（価格・購入は代表カードへ付け替え後に重複カードだけ削除）。本番の事前確認で重複カード群は0件（対象行なし）・既存データは全て1プロフィール分のみ" },
  "20261231000117_market_ranks_events_bulk_buy.sql": { sha: "bd035f8274f5", labels: ["delete"], reason: "関数 market_bulk_buy_tx の本体の delete のみ（移行の実行時には削除しない。一括購入のとき、購入した記録の購入予定マークを外す）。ランクの変換は update（全単射・復元演習の本番コピーで全行の対応を確認済み）" },
};
const review = pending.map((f) => {
  const sql = readFileSync(join("supabase/migrations", f), "utf8").replace(/--.*$/gm, "");
  // 内容のハッシュは改行コードを正規化して求める（Windowsの作業コピーは CRLF、リポジトリ・CI は LF。環境で変わると REVIEWED の固定が無効になる／誤一致する）
  const sha = createHash("sha256").update(readFileSync(join("supabase/migrations", f), "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);
  const found = RISKY.filter(([re]) => re.test(sql)).map(([, label]) => label);
  const ok = REVIEWED[f]?.sha === sha ? REVIEWED[f] : null;
  const risky = found.filter((l) => !ok?.labels.includes(l));
  return { file: f, sha, risky, reviewed: ok && found.length !== risky.length ? ok.reason : undefined };
});
// 関数の置き換え（drop function → create function）は、互換性を人が確認済みの前提で許容するため、別枠で注意として出す
const fnDrops = pending.filter((f) => /\bdrop\s+function\b/i.test(readFileSync(join("supabase/migrations", f), "utf8").replace(/--.*$/gm, "")));

// ---- ③バックアップの新しさ
const idx = join(homedir(), "TorecaBackups", "full", "INDEX.jsonl");
let lastBackup = null;
if (existsSync(idx)) {
  const rows = readFileSync(idx, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => String(r.file).startsWith("tcg-full-"));
  lastBackup = rows.at(-1) ?? null;
}
const ageH = lastBackup ? (Date.now() - new Date(lastBackup.at).getTime()) / 3600_000 : Infinity;

// ---- 計画の指紋: 未適用の版とファイルの内容・Gitの先頭・本番の適用履歴の末尾
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const planSha = createHash("sha256").update(JSON.stringify({ pending: review.map((r) => [r.file, r.sha]), head: process.env.RELEASE_HEAD ?? head, last: [...applied].sort().at(-1) })).digest("hex").slice(0, 16);

console.log(`本番の適用済み: ${applied.size}本（最後: ${[...applied].sort().at(-1)}）／ローカル: ${files.length}本／未適用: ${pending.length}本`);
for (const r of review) console.log(`  - ${r.file}${r.risky.length ? `  ⚠ 要確認: ${r.risky.join("、")}` : r.reviewed ? `  （追加のみ。確認済みの検出あり: ${r.reviewed}）` : "  （追加のみ）"}`);
if (fnDrops.length) console.log(`  注意: 関数の置き換え（drop function→create）を含む: ${fnDrops.join(", ")}（旧い呼び出しの互換性を確認済みか）`);
console.log(`バックアップ: ${lastBackup ? `${lastBackup.file}（${ageH.toFixed(1)}時間前）` : "なし"}`);
const older = pending.filter((f) => f.slice(0, 14) < [...applied].sort().at(-1));
console.log(`適用に --include-all が必要（本番の最新より古い版が未適用）: ${older.length ? `はい（${older.length}本）` : "いいえ"}`);

const dry = pending.length ? sh(["db", "push", "--linked", "--include-all", "--dry-run"]) : { status: 0, stdout: "" };
const dryOut = scrub(dry.stdout + dry.stderr);
const dryOk = dry.status === 0 && pending.every((f) => dryOut.includes(f));
console.log(`dry-run: ${pending.length === 0 ? "未適用なし" : dryOk ? "適用予定が未適用の版と一致" : `不一致または失敗\n${dryOut.slice(0, 600)}`}`);
console.log(`plan-sha: ${planSha}`);

const blockers = [];
if (review.some((r) => r.risky.length)) blockers.push("危険な記述を含む移行があります（自動適用の対象外。内容を確認して個別に判断）");
if (!dryOk) blockers.push("dry-run が未適用の版と一致しません");
if (ageH > 24) blockers.push("直近の完全バックアップが24時間より古いか、ありません（npm run backup:full）");

if (mode === "plan") {
  mkdirSync("backups/release", { recursive: true });
  writeFileSync("backups/release/db-plan.json", JSON.stringify({ at: new Date().toISOString(), planSha, pending: review, backup: lastBackup?.file ?? null, blockers }, null, 1));
  console.log(blockers.length ? `\n自動適用できない理由:\n${blockers.map((b) => `  - ${b}`).join("\n")}` : "\n自動適用の条件を満たしています");
  process.exit(blockers.length ? 3 : 0);
}

// ---- approve: 利用者が最終承認した計画の指紋を記録する（承認の発言を受けた後にだけ実行する。承認前は実行しない）。plan と一致しなければ記録しない
const APPROVAL = "backups/release/db-approval.json";
if (mode === "approve") {
  if (arg("plan-sha") !== planSha) fail(`計画の指紋が一致しません（指定: ${arg("plan-sha") ?? "なし"} / 現在: ${planSha}）`);
  if (blockers.length) fail(blockers.join(" / "));
  mkdirSync("backups/release", { recursive: true });
  writeFileSync(APPROVAL, JSON.stringify({ planSha, approvedAt: new Date().toISOString(), pending: review.map((r) => r.file) }, null, 1));
  console.log(`承認を記録しました（plan-sha: ${planSha}。有効期間12時間）`);
  process.exit(0);
}

// ---- apply: 承認の記録（同じ plan-sha・12時間以内）が無ければ実行しない
let approval = null;
try { approval = JSON.parse(readFileSync(APPROVAL, "utf8")); } catch { /* なし */ }
if (!approval || approval.planSha !== planSha || Date.now() - new Date(approval.approvedAt).getTime() > 12 * 3600_000) {
  fail("この計画の承認の記録がありません（承認前、または12時間を過ぎています）。利用者の最終承認の後に approve を実行してください");
}
if (arg("plan-sha") !== planSha) fail(`計画の指紋が承認時と一致しません（承認: ${arg("plan-sha") ?? "なし"} / 現在: ${planSha}）。状態が変わったため、計画を出し直して承認を取り直してください`);
if (pending.length === 0) fail("適用する移行がありません");
if (blockers.length) fail(blockers.join(" / "));

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const TABLES = ["households", "profiles", "lotteries", "lottery_items", "applications", "purchases", "purchase_items", "card_masters", "card_holdings", "chains", "stores", "products", "collection_candidates", "collection_settings", "zukan_cards", "market_cards", "box_lots", "profile_settings"];
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await db.from(t).select("*", { count: "exact", head: true })).count])));
const before = await counts();
console.log("\n本番へ適用します（db push --include-all）…");
// --yes: CLI がエージェント実行では確認を求めるため。ここに到達するのは、承認の記録・指紋の一致・バックアップ・dry-run の全てを満たしたときだけ
const push = sh(["db", "push", "--linked", "--include-all", "--yes"]);
console.log(scrub(push.stdout).split("\n").slice(-12).join("\n"));
if (push.status !== 0) fail(`適用に失敗しました。以降の処理は行いません（自動のやり直し・巻き戻しはしません。トランザクション単位で失敗した版は適用されていません）: ${scrub(push.stderr).slice(0, 500)}`);
const after = await counts();
const diff = TABLES.filter((t) => before[t] !== after[t]);
const list2 = sh(["migration", "list", "--linked"]);
const appliedAfter = remoteVersions(list2.stdout);
const stillPending = pending.filter((f) => !appliedAfter.has(f.slice(0, 14)));
console.log(`適用後: 既存表の件数の変化 ${diff.length}件${diff.length ? `（${diff.join(",")}。収集・利用者の操作による増減か確認）` : ""}／未適用の残り ${stillPending.length}本`);
if (stillPending.length) fail("適用後も未適用の版が残っています");
console.log("DBの適用: 完了");
