import { LoginForm } from "@/app/login/login-form";

export const metadata = { title: "ログイン | トレカ抽選管理" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-lg font-bold">トレカ抽選管理</h1>
      <p className="text-sm text-muted-foreground">家族共通のログインです。ログイン後にプロフィール（A/B/C）を選べます。</p>
      <LoginForm />
    </main>
  );
}
