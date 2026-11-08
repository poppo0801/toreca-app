"use client";

import { RecoverableError } from "@/components/recoverable-error";

/** ログイン後の画面のエラー。ヘッダー・下部メニュー・データはそのまま、画面の中身だけを再取得する */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RecoverableError error={error} reset={reset} scope="app" />;
}
