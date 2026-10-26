import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { isAuthorizedCron } from "@/lib/server/cron-auth";

export const dynamic = "force-dynamic";

/** 本番に必要な環境変数（値は返さず、設定の有無のみ確認する） */
const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "CRON_SECRET",
] as const;
const OPTIONAL_ENV = ["NEXT_PUBLIC_DATA_SOURCE", "VAPID_SUBJECT"] as const;

function safeHostLabel(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.split(".")[0];
  } catch {
    return null;
  }
}

/**
 * 運用確認用ヘルスチェック。CRON_SECRET による認証が必要（未認証は401。環境の構成を第三者に見せない）。
 * 返すのは設定の有無・疎通の可否・デプロイ情報のみで、秘密の値や個人情報は含まない。
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = Object.fromEntries([...REQUIRED_ENV, ...OPTIONAL_ENV].map((k) => [k, !!process.env[k]]));
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);

  let db: "ok" | "error" | "skipped" = "skipped";
  /** 未ログインのキーで世帯データが読めないこと。拒否(権限エラー)または0件ならOK、1件でも読めたら漏えい */
  let rls: "ok" | "leak" | "skipped" = "skipped";
  /** publishableキーがこのプロジェクトで有効か（無効だとログインできない） */
  let anonKey: "valid" | "invalid" | "skipped" = "skipped";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && service) {
    const { error } = await createClient(url, service, { auth: { persistSession: false } }).from("households").select("id", { head: true, count: "exact" });
    db = error ? "error" : "ok";
  }
  if (url && anon) {
    const { data } = await createClient(url, anon, { auth: { persistSession: false } }).from("households").select("id").limit(1);
    rls = (data ?? []).length === 0 ? "ok" : "leak";
    // 存在しない認証情報でログインを試す: 400(invalid_credentials)ならキーは有効、401/403ならキーが無効
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "healthcheck@example.invalid", password: "not-a-real-password" }),
    }).catch(() => null);
    anonKey = res && res.status === 400 ? "valid" : "invalid";
  }

  return NextResponse.json({
    ok: missing.length === 0 && db === "ok" && rls === "ok" && anonKey === "valid" && IS_SUPABASE_MODE,
    dataSource: IS_SUPABASE_MODE ? "supabase" : "mock",
    missingRequiredEnv: missing,
    env,
    vapidSubjectFallback: !process.env.VAPID_SUBJECT && !!process.env.VERCEL_PROJECT_PRODUCTION_URL,
    db,
    rlsAnonymous: rls,
    publishableKey: anonKey,
    // 設定ミスの切り分け用（値そのものは返さない）。キーの形式と、接続先プロジェクトの識別子（URLの先頭ラベル）のみ
    diagnostics: {
      supabaseProjectRef: url ? safeHostLabel(url) : null,
      publishableKeyShape: anon
        ? { kind: anon.startsWith("sb_publishable_") ? "sb_publishable" : anon.startsWith("eyJ") ? "jwt" : "unknown", length: anon.length, hasWhitespace: /s/.test(anon), hasQuotes: /^["']|["']$/.test(anon) }
        : null,
      urlHasWhitespaceOrSlash: url ? /s|/$/.test(url) : null,
    },
    deploy: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      region: process.env.VERCEL_REGION ?? null,
      environment: process.env.VERCEL_ENV ?? null,
      node: process.version,
    },
  });
}
