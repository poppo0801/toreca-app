"use client";

import { RecoverableError } from "@/components/recoverable-error";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RecoverableError error={error} reset={reset} scope="root" />;
}
