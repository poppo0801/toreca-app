import { BrandLogo } from "@/components/brand-logo";
import { LoginForm } from "@/app/login/login-form";
import { APP_NAME } from "@/lib/brand";

export const metadata = { title: `ログイン | ${APP_NAME}` };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-4 pb-safe pt-safe">
      <h1 className="sr-only">{APP_NAME} ログイン</h1>
      <BrandLogo variant="stacked" />
      <p className="text-center text-sm text-muted-foreground">家族共通のログインです。ログイン後にプロフィール（A/B/C）を選べます。</p>
      <LoginForm />
    </main>
  );
}
