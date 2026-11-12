// 接続先（本番／開発）の判定と、誤接続の防止（Stage 8C）。
// 方針: 開発・テスト用の処理は「ローカルの Supabase」にしか繋がらないことを、実行前に機械的に確認する。
// 本番のプロジェクトID（公開情報。秘密ではない）または本番鍵（JWT の ref 要求）を検出したら止める。
// src/lib/supabase/target.ts と同じ判定（src/lib/supabase/target.test.ts が両者の一致を検査する）。
import { existsSync, readFileSync } from "node:fs";

/** 本番の Supabase プロジェクトID。増えたらここへ足す（supabase/.temp/project-ref のリンク先も本番として扱う） */
export const PRODUCTION_REFS = ["yofqgfarflrlhzufjhqs"];

const HOSTED = /^https:\/\/([a-z0-9-]+)\.supabase\.(co|in)\/?$/;
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

function linkedRefs() {
  try {
    if (existsSync("supabase/.temp/project-ref")) return [readFileSync("supabase/.temp/project-ref", "utf8").trim()];
  } catch {
    /* 読めなければ固定リストのみ */
  }
  return [];
}

/** JWT（anon / service_role 鍵）の ref 要求を返す。ローカルのデモ鍵には ref が無い。値そのものは返さない・出力しない */
export function jwtRef(key) {
  try {
    const part = String(key ?? "").split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

/** @returns {"production" | "hosted-other" | "local" | "unknown" | "unset"} */
export function classifyTarget(url, ...keys) {
  const refs = [...PRODUCTION_REFS, ...linkedRefs()];
  if (keys.some((k) => jwtRef(k) && refs.includes(jwtRef(k)))) return "production";
  const u = String(url ?? "").trim();
  if (!u) return "unset";
  const hosted = HOSTED.exec(u);
  if (hosted) return refs.includes(hosted[1]) ? "production" : "hosted-other";
  if (LOCAL.test(u)) return "local";
  return "unknown";
}

/** 開発・テスト用: ローカル以外（本番・ホスト版・不明・未設定）なら例外。環境変数 TOREMANE_ALLOW_NONLOCAL では解除できない */
export function assertLocalTarget(label, env = process.env) {
  const kind = classifyTarget(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  if (kind !== "local") {
    throw new Error(
      `[接続先ガード] ${label}: 接続先が開発用のローカルSupabaseではありません（判定: ${kind}）。中止しました。\n` +
        "  開発用DBを起動し .env.local をローカル値にしてください: npm run db:up && npm run db:env\n" +
        "  本番を対象にする作業は専用の入口を使います: npm run prod -- <script>（docs/DEV_ENVIRONMENT.md）",
    );
  }
  return kind;
}

/** 本番を明示的に対象にする入口専用（scripts/prod.mjs）。本番でなければ例外 */
export function assertProductionTarget(label, env = process.env) {
  const kind = classifyTarget(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  if (kind !== "production") throw new Error(`[接続先ガード] ${label}: 本番の設定（.env.production-ops）が読めません（判定: ${kind}）。`);
  return kind;
}

/** 表示用の接続先（URL のホスト部のみ。鍵は出さない） */
export function describeTarget(env = process.env) {
  const kind = classifyTarget(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  let host = "(未設定)";
  try {
    host = new URL(env.NEXT_PUBLIC_SUPABASE_URL).host;
  } catch {
    /* 未設定 */
  }
  return { kind, host };
}

/**
 * 開発・テスト・データ整理スクリプト用: 既定はローカルのみ許可。scripts/prod.mjs 経由（TOREMANE_TARGET=production）のときだけ本番を許可する。
 * 本番に作用させるには prod.mjs の --yes-production が必須なので、うっかり本番に向くことは無い。
 */
export function assertTargetForRun(label, env = process.env) {
  return env.TOREMANE_TARGET === "production" ? assertProductionTarget(label, env) : assertLocalTarget(label, env);
}
