"use client";

import { useActionState } from "react";
import { signIn, type LoginState } from "@/app/login/actions";
import { Button } from "@/components/ui/button";

const initial: LoginState = { error: null };

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, initial);
  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm">
        メールアドレス
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="mt-1 min-h-11 w-full rounded-md border bg-input px-3"
        />
      </label>
      <label className="block text-sm">
        パスワード
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 min-h-11 w-full rounded-md border bg-input px-3"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "ログイン中…" : "ログイン"}
      </Button>
    </form>
  );
}
