"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AlertTriangle, Loader2, Share2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { useAiJobs } from "@/components/ai-jobs-provider";
import { Button } from "@/components/ui/button";
import { xPostId } from "@/lib/ai-job";
import type { SharedPost } from "@/lib/share-intake";

/**
 * iPhoneの共有から開いたとき: 共有されたX投稿のURLを確認し、「読み取る」で既存のX URL解析（まとめて登録のジョブ）に渡す。
 * 自動では登録しない（解析結果は確認待ちとして残り、確認・修正してから保存する）。
 * 開いただけでは解析を始めない（リンクを開くだけで費用が発生しないように、必ず1回の操作を挟む）。
 */
export function ShareIntakeView({ result }: { result: SharedPost }) {
  const { data, profile } = useApp();
  const { refresh } = useAiJobs();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; duplicate?: boolean } | null>(null);
  const started = useRef(false); // 二重実行の防止（連打・再描画）

  if (!result.ok) {
    return (
      <div className="space-y-3" data-testid="share-intake">
        <h1 className="text-lg font-bold">共有から登録</h1>
        <p role="alert" className="flex items-start gap-1.5 rounded-md border border-warn p-3 text-sm text-warn" data-testid="share-invalid">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {result.message}
        </p>
        <Button asChild variant="outline">
          <Link href="/lotteries">抽選管理へ</Link>
        </Button>
      </div>
    );
  }

  // 登録済みの抽選に同じ投稿のURLがあれば知らせる（読み取りは止めない）
  const registered = data.lotteries.some((l) => l.sourceUrls.some((u) => xPostId(u) === result.postId));

  const start = async () => {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/ai-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: profile.id, label: "共有", items: [{ source: "x_url", url: result.url }] }),
      });
      const j = (await res.json().catch(() => null)) as { ok: boolean; jobId?: string; error?: string } | null;
      if (j?.ok && j.jobId) {
        await refresh();
        router.replace(`/lotteries/bulk?job=${j.jobId}`);
        return;
      }
      const dup = !!j?.error && /重複/.test(j.error);
      setMsg(dup ? { text: "この投稿は、解析中か確認待ちです。結果は「まとめて登録」で確認できます", duplicate: true } : { text: j?.error ?? "開始できませんでした。もう一度お試しください" });
      started.current = false;
    } catch {
      setMsg({ text: "通信に失敗しました。接続を確認してもう一度お試しください" });
      started.current = false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="share-intake">
      <h1 className="flex items-center gap-2 text-lg font-bold">
        <Share2 className="size-4 text-primary" aria-hidden="true" /> 共有から登録
      </h1>
      <section className="space-y-1 rounded-xl border bg-card p-3 shadow-card" aria-label="共有されたX投稿">
        <p className="text-xs text-muted-foreground">X投稿{result.handle ? `（@${result.handle}）` : ""}</p>
        <p className="break-all text-sm" data-testid="share-url">
          {result.url}
        </p>
      </section>
      {registered && (
        <p className="text-xs text-warn" data-testid="share-registered">
          この投稿のURLは、登録済みの抽選にあります。
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={start} disabled={busy} data-testid="share-start">
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> 開始中…
            </>
          ) : (
            "読み取る"
          )}
        </Button>
        <Button asChild variant="outline">
          <Link href="/lotteries">キャンセル</Link>
        </Button>
      </div>
      {msg && (
        <p role="alert" className="text-xs text-danger" data-testid="share-msg">
          {msg.text}
          {msg.duplicate && (
            <>
              {" "}
              <Link href="/lotteries/bulk" className="underline">
                開く
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
