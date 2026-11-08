"use client";

import { useEffect, useState } from "react";
import { clearClientErrorLog, readClientErrorLog } from "@/lib/client-resilience";
import type { ClientErrorEntry } from "@/lib/resilience";

const KIND: Record<ClientErrorEntry["kind"], string> = { chunk: "古い画面", skew: "バージョン不整合", network: "通信", timeout: "時間切れ", auth: "認証", other: "その他" };

/** この端末の接続・画面エラーの記録（最大30件。Stage 7C）。原因の確認用で、認証情報・個人情報は含まれない */
export function ClientErrorLog() {
  const [rows, setRows] = useState<ClientErrorEntry[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末内の記録の読み込み（マウント後に1回）
    setRows(readClientErrorLog().reverse());
  }, []);
  return (
    <details className="rounded-lg border px-3 py-2 text-xs" data-testid="client-error-log">
      <summary className="min-h-8 cursor-pointer text-sm font-medium">接続の記録（{rows.length}件）</summary>
      {rows.length === 0 ? (
        <p className="mt-2 text-muted-foreground">エラーの記録はありません。</p>
      ) : (
        <>
          <ul className="mt-2 max-h-60 space-y-1.5 overflow-auto">
            {rows.map((r, i) => (
              <li key={`${r.at}-${i}`} className="border-b pb-1.5 last:border-0">
                <p>
                  <span className="font-medium">{KIND[r.kind]}</span> {new Date(r.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} {r.path}
                  {r.afterResume ? " ／復帰直後" : ""}
                  {r.online ? "" : " ／オフライン"}
                </p>
                <p className="break-all text-muted-foreground">
                  {r.where} ・ {r.message} ・ {r.build}
                </p>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 text-xs underline"
            onClick={() => {
              clearClientErrorLog();
              setRows([]);
            }}
          >
            記録を消去
          </button>
        </>
      )}
    </details>
  );
}
