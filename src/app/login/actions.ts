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

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  // 詳細な理由（存在しないユーザー等）は返さない
  if (error) return { error: "メールアドレスまたはパスワードが正しくありません" };

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
