// 本番バックアップ・本番読み取りの「接続先の検証」（Stage 10F）。純関数のみ（ネットワークに接続しない）。
// 背景: Supabase CLI 3.x の `db query` は既定でローカルを対象にし、本番は `--remote[=<ref>]` で指定する。従来のスクリプトが使う `--linked` は3.xのヘルプに無い。
//       推測で本番に向くと仮定せず、(1) 接続先を `--remote=<ref>` で明示し (2) CLIが表示する接続先（Target: 行）が、その ref であってローカルでないことを確認し
//       (3) ダンプとクエリの件数が大きく食い違えば（別のDBを見ている疑い）中止する。確認できなければ実行しない（fail-closed）。

/** `db query` の標準エラー/標準出力から接続先の表示行を取り出す（無ければ null） */
export function targetLine(text) {
  const m = /^\s*Target:\s*(.+)$/m.exec(String(text ?? ""));
  return m ? m[1].trim() : null;
}

/**
 * 接続先の検証。表示行が存在し、ローカルを示さず、期待する ref（20文字の英数字）を含むこと。
 * 表示行が無い場合は「検証不能」として false（fail-closed）。
 */
export function verifyQueryTarget(text, expectedRef) {
  if (!/^[a-z0-9]{20}$/.test(String(expectedRef))) return { ok: false, reason: "期待するプロジェクトref の形式が不正です", line: null };
  const line = targetLine(text);
  if (!line) return { ok: false, reason: "接続先の表示（Target: 行）が確認できません（検証不能のため中止）", line: null };
  if (/local|127\.0\.0\.1|localhost|\[::1\]/i.test(line)) return { ok: false, reason: "接続先がローカルを示しています", line };
  if (!line.includes(expectedRef)) return { ok: false, reason: "接続先の表示に、期待するプロジェクトref が含まれません", line };
  return { ok: true, reason: "", line };
}

/** 本番読み取りクエリのCLI引数（`--remote=<ref>` を明示。`--linked` は使わない。読み取り専用） */
export function remoteQueryArgs(ref, file) {
  if (!/^[a-z0-9]{20}$/.test(String(ref))) throw new Error("プロジェクトref の形式が不正です");
  if (!/^[\w./\\:-]+$/.test(String(file))) throw new Error("SQLファイルのパスが不正です");
  return ["supabase", "db", "query", `--remote=${ref}`, "--read-only", "--output-format", "json", "-f", file];
}

/**
 * ダンプとクエリの件数の食い違い（別のDBを見ている疑い）の検査。取得中も収集が書き込むため少しの差は許容する。
 * 許容: 合計の差が max(100, 全体の2%) 以内。超えたら例外相当（ok=false）。
 */
export function checkCountDrift(liveCounts, dumpCounts) {
  let diff = 0;
  let total = 0;
  const tables = new Set([...Object.keys(liveCounts), ...Object.keys(dumpCounts)]);
  for (const t of tables) {
    const a = Number(liveCounts[t] ?? 0);
    const b = Number(dumpCounts[t] ?? 0);
    diff += Math.abs(a - b);
    total += Math.max(a, b);
  }
  const limit = Math.max(100, Math.floor(total * 0.02));
  return { ok: diff <= limit, diff, total, limit };
}
