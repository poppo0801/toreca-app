// 評価データの保全（破壊的な操作の前に必ず通す）。Stage A で、DBテストの実行により有料試験の生の登録案が失われた再発の防止。
// 方針:
//  - 失われて困るもの = ①評価用の重要ファイル（gold・費用台帳・結果・監査ログ・過去の診断）②ローカルDBにだけある有料試験の登録案。
//  - 破壊的な操作（test:db / db:reset / e2e の世帯削除）の前に、①が欠落・破損・不意に変更されていない／②が別の保存先にある、を検証する。満たさなければ中止（終了コード1）。
//  - 保存先は eval/phase2-compare/（Git管理外）。秘密情報は書かない。復元は docs/RESTORE.md ではなく、同フォルダの preserved/ と run-exports/・*.journal.local.jsonl から再採点できる。
//  - 費用台帳の不確定の費用（未完了の実行）は、ここで解放しない（読み取り・検証だけ）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const EVAL_DIR = "eval/phase2-compare";
export const MANIFEST = `${EVAL_DIR}/preserve-manifest.local.json`;

/** 変更されてはならない（人が確認した正解・過去の診断）ファイル。内容のハッシュが記録と一致すること */
const IMMUTABLE = [/^gold\.(real|synthetic)\.local\.json$/, /^gold-review(-real)?\.local\.json$/, /^r1-gold-pages\.local\.json$/, /^stage-a-backup\/.+\.local\.(json|jsonl)$/, /^diag2?\.local\.json$/];
/** 増えていくが減ってはならない（追記専用）ファイル */
const APPEND_ONLY = [/^spend-ledger\.local\.json$/, /^audit\.local\.jsonl$/];
/** 存在・読み取りだけを確認する（置き換わりうる）ファイル */
const PRESENT = [/^result\.local\.json$/];

/** JSON として読めるか。ログ出力の保存（先頭に "RESCORE " のような見出しが付いたもの）も、見出しを除けば読めれば可とする */
export function parsesLoosely(text) {
  for (const t of [text, text.replace(/^[A-Z_]{3,20}\s+(?=[\[{])/, "")]) {
    try { JSON.parse(t); return true; } catch { /* 次へ */ }
  }
  return false;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = `${dir}/${n}`;
    const st = statSync(p);
    if (st.isDirectory()) {
      if (/^(run-exports|preserved|sample|gold-review-backups|gold-review-real-backups)$/.test(n) && dir === base) continue;
      walk(p, base, out);
    } else out.push(p.slice(base.length + 1));
  }
  return out;
}

const kindOf = (rel) => (IMMUTABLE.some((r) => r.test(rel)) ? "immutable" : APPEND_ONLY.some((r) => r.test(rel)) ? "append_only" : PRESENT.some((r) => r.test(rel)) ? "present" : null);

function ledgerRunIds(buf) {
  try {
    const j = JSON.parse(buf.toString("utf8"));
    return (j.runs ?? []).map((r) => ({ id: r.id, finished: !!r.finishedAt, cost: r.costJpy ?? null }));
  } catch {
    return null;
  }
}

/** 重要ファイルの現状の記録（manifest の内容） */
export function snapshotCritical(dir = EVAL_DIR) {
  const files = {};
  for (const rel of walk(dir)) {
    const kind = kindOf(rel);
    if (!kind) continue;
    const buf = readFileSync(`${dir}/${rel}`);
    const e = { kind, bytes: buf.length, sha256: sha256(buf) };
    if (rel === "spend-ledger.local.json") e.runs = ledgerRunIds(buf);
    if (rel === "audit.local.jsonl") e.lines = buf.toString("utf8").split("\n").filter(Boolean).length;
    files[rel] = e;
  }
  return files;
}

/** 重要ファイルを manifest と照合する。欠落・読めない・不意の変更・追記専用の減少があれば errors */
export function verifyCritical(dir = EVAL_DIR, manifestPath = MANIFEST) {
  const errors = [];
  const notes = [];
  if (!existsSync(manifestPath)) return { ok: false, errors: ["保全の記録（preserve-manifest）がまだ無い。`npm run eval:preserve -- save` で作成してから実行する"], notes };
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, errors: ["保全の記録が壊れている（読み取れない）"], notes };
  }
  for (const [rel, e] of Object.entries(m.files ?? {})) {
    const p = `${dir}/${rel}`;
    if (!existsSync(p)) { errors.push(`欠落: ${rel}`); continue; }
    let buf;
    try { buf = readFileSync(p); } catch { errors.push(`読み取れない: ${rel}`); continue; }
    if (rel.endsWith(".json") && !parsesLoosely(buf.toString("utf8"))) { errors.push(`JSONとして読み取れない: ${rel}`); continue; }
    if (e.kind === "immutable" && sha256(buf) !== e.sha256) errors.push(`変更されている（変更不可）: ${rel}`);
    if (e.kind === "append_only") {
      if (rel === "spend-ledger.local.json") {
        const now = ledgerRunIds(buf) ?? [];
        for (const r of e.runs ?? []) {
          const cur = now.find((x) => x.id === r.id);
          if (!cur) errors.push(`費用台帳から実行が消えている: ${r.id}`);
          else if (r.finished && !cur.finished) errors.push(`費用台帳の実行が「未完了」に戻っている: ${r.id}`);
          else if (r.cost !== null && cur.cost !== null && cur.cost < r.cost) errors.push(`費用台帳の費用が減っている: ${r.id}`);
        }
      } else if (rel === "audit.local.jsonl" && buf.toString("utf8").split("\n").filter(Boolean).length < (e.lines ?? 0)) errors.push(`監査ログの行が減っている: ${rel}`);
    }
  }
  if (errors.length === 0) notes.push(`重要ファイル ${Object.keys(m.files ?? {}).length} 件を確認（欠落・破損・不意の変更なし）`);
  return { ok: errors.length === 0, errors, notes };
}

/** manifest を作る・更新する。変更不可のファイルが既に記録されていて内容が違えば、上書きしない（変更の検出を無効化しない）。追記専用・存在確認のものは現状に更新し、予備コピーを preserved/ に残す */
export function saveManifest(dir = EVAL_DIR, manifestPath = MANIFEST) {
  const cur = snapshotCritical(dir);
  let prev = { files: {} };
  try { prev = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { /* 初回 */ }
  const conflicts = [];
  const files = { ...(prev.files ?? {}) };
  for (const [rel, e] of Object.entries(cur)) {
    const old = files[rel];
    if (old && old.kind === "immutable" && old.sha256 !== e.sha256) { conflicts.push(rel); continue; }
    files[rel] = e;
  }
  if (conflicts.length) return { ok: false, conflicts };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const copyDir = `${dir}/preserved/${ts}`;
  mkdirSync(copyDir, { recursive: true });
  for (const [rel, e] of Object.entries(files)) {
    if (e.kind === "immutable" && prev.files?.[rel]) continue; // 変更不可で記録済みのものは、初回のコピーが残っている
    const src = `${dir}/${rel}`;
    if (!existsSync(src)) continue;
    mkdirSync(`${copyDir}/${rel.split("/").slice(0, -1).join("/")}`.replace(/\/$/, ""), { recursive: true });
    copyFileSync(src, `${copyDir}/${rel}`);
  }
  writeFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), files }, null, 1));
  return { ok: true, files: Object.keys(files).length, copyDir };
}

/** 別の保存先（実行ごとの保全・ジャーナル・保全スナップショット）に保存済みの登録案の鍵の集合 */
export function savedProposalKeys(dir = EVAL_DIR) {
  const keys = new Set();
  const add = (r) => { if (r && r.candidate_id && r.proposal_key) keys.add(`${r.candidate_id}|${r.proposal_key}|${r.input_hash ?? ""}`); };
  const eachFile = (sub, f) => { const d = `${dir}/${sub}`; if (existsSync(d)) for (const n of readdirSync(d)) if (n.endsWith(".json") || n.endsWith(".jsonl")) { try { f(`${d}/${n}`, n); } catch { /* 壊れたファイルは保存とみなさない */ } } };
  eachFile("run-exports", (p) => { for (const run of JSON.parse(readFileSync(p, "utf8")).runs ?? []) for (const r of run.proposals ?? []) add(r); });
  eachFile("preserved", (p, n) => { if (n.endsWith(".json")) for (const r of JSON.parse(readFileSync(p, "utf8")).proposals ?? []) add(r); });
  if (existsSync(dir)) for (const n of readdirSync(dir)) if (n.endsWith(".journal.local.jsonl")) for (const line of readFileSync(`${dir}/${n}`, "utf8").split("\n")) { try { for (const r of JSON.parse(line).proposals ?? []) add(r); } catch { /* 途中で切れた行は無視 */ } }
  return keys;
}

/** ローカルDBにある有料試験の登録案（モックの名前空間を除く）のうち、別の保存先に無いもの */
export function unsavedProposals(rows, dir = EVAL_DIR) {
  const saved = savedProposalKeys(dir);
  return rows.filter((r) => !saved.has(`${r.candidate_id}|${r.proposal_key}|${r.input_hash ?? ""}`));
}

/** ローカルのSupabaseから、評価用の候補の登録案を読む（読み取りのみ）。接続できなければ null（DBが無ければ失う物も無い） */
export async function readEvalProposals(env = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) return null;
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const cr = await fetch(`${url.replace(/\/$/, "")}/rest/v1/collection_candidates?select=id,source_url&source_url=like.${encodeURIComponent("https://eval-cmp.invalid/%")}`, { headers: h });
    if (!cr.ok) return null;
    const cands = (await cr.json()).filter((c) => !String(c.source_url).startsWith("https://eval-cmp.invalid/mock/"));
    const rows = [];
    for (let i = 0; i < cands.length; i += 40) {
      const ids = cands.slice(i, i + 40).map((c) => c.id).join(",");
      const pr = await fetch(`${url.replace(/\/$/, "")}/rest/v1/registration_proposals?select=*&candidate_id=in.(${ids})&order=candidate_id,item_no`, { headers: h });
      if (!pr.ok) return null;
      rows.push(...(await pr.json()));
    }
    return rows;
  } catch {
    return null;
  }
}

/** 全体の事前検査（破壊的な操作の前）。ok=false なら中止 */
export async function preDestructiveCheck(env = process.env, dir = EVAL_DIR) {
  const v = verifyCritical(dir);
  const errors = [...v.errors];
  const notes = [...v.notes];
  const rows = await readEvalProposals(env);
  if (rows === null) notes.push("ローカルDBに接続できない／評価用の候補を読めない（DBに失う物が無いか、未起動）。登録案の保全は確認できていない");
  else {
    const un = unsavedProposals(rows, dir);
    if (un.length) errors.push(`ローカルDBにだけある有料試験の登録案が ${un.length} 件ある（別の保存先に無い）。\`npm run eval:preserve -- save\` で保全してから実行する`);
    else notes.push(`ローカルDBの評価用の登録案 ${rows.length} 件は、別の保存先に保存済み`);
  }
  return { ok: errors.length === 0, errors, notes };
}

/** DBの評価用の登録案を preserved/ にスナップショット保存する（秘密は含まれない列のみ。原文の全文は登録案に含まれない） */
export async function snapshotProposals(env = process.env, dir = EVAL_DIR) {
  const rows = await readEvalProposals(env);
  if (rows === null) return { ok: false, reason: "ローカルDBを読めない" };
  mkdirSync(`${dir}/preserved`, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/preserved/proposals-${ts}.json`;
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), count: rows.length, proposals: rows }, null, 1));
  return { ok: true, count: rows.length, path };
}


