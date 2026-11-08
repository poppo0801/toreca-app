"use client";

import { useEffect } from "react";
import { recordClientError } from "@/lib/client-resilience";

/** ルートのレイアウト自体が壊れたときの最終的な画面（通常は表示されない）。自動の再読み込みはせず、操作で復旧する */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    recordClientError(error, "global");
  }, [error]);
  return (
    <html lang="ja">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", textAlign: "center" }}>
        <p style={{ fontWeight: 700 }}>画面を読み込めませんでした</p>
        <p style={{ fontSize: "0.875rem", color: "#666" }}>通信が不安定なようです。</p>
        <button type="button" onClick={reset} style={{ minHeight: 44, padding: "0 20px", marginRight: 8 }}>
          もう一度試す
        </button>
        <button type="button" onClick={() => window.location.reload()} style={{ minHeight: 44, padding: "0 20px" }}>
          アプリを再読み込み
        </button>
      </body>
    </html>
  );
}
