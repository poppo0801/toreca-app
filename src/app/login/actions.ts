"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.email("メールアドレスの形式が正しくありません").max(254),
  password: z.string().min(1, "パスワードを入力してください").max(200),
});

export interface LoginState {
  error: string | null;
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    // 環境変数の設定ミスなど（利用者には詳細を出さない）
    console.error("login: supabase client configuration error");
    return { error: "ログインサービスに接続できません。管理者に設定の確認を依頼してください" };
  }
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // 認証情報の誤り(400)と、接続・設定の問題(それ以外)を区別する。詳細な理由（存在しないユーザー等）は返さない
    if (error.status === 400 || error.code === "invalid_credentials") return { error: "メールアドレスまたはパスワードが正しくありません" };
    console.error("login: auth service error", error.status ?? "no-status");
    return { error: "ログインサービスに接続できません。時間をおいて再度お試しください（続く場合は管理者に連絡）" };
  }

  // 初回ログインで世帯と既定プロフィール(A/B/C)を作成（冪等）
  const boot = await supabase.rpc("bootstrap_household");
  if (boot.error) return { error: "初期設定に失敗しました。時間をおいて再度お試しください" };
  redirect("/lotteries");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
