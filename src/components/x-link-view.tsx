"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { disconnectAction, setAutoSyncAction, syncNowAction, type XLinkResult } from "@/app/(app)/settings/x-link/actions";
import { cn } from "@/lib/utils";

export interface XLinkInfo {
  /** サーバーの環境変数（Client ID / Secret / 暗号化キー）がそろっているか */
  configured: boolean;
  /** 未設定・不正な環境変数の名前（値は含めない） */
  missing: string[];
  link: { username: string; status: "active" | "needs_reauth"; autoSync: boolean; lastSyncedAt: string | null; lastResult: string; lastError: string; initialDone: boolean } | null;
  /** 収集設定の「X APIを使う」 */
  xEnabled: boolean;
  budgetJpy: number;
  bookmarkPosts: number;
  bookmarkCostJpy: number;
  totalCostJpy: number;
}

const RESULT_TEXT: Record<string, { tone: "ok" | "warn"; text: string }> = {
  ok: { tone: "ok", text: "Xアカウントを連携しました。自動収集はOFFのままです" },
  denied: { tone: "warn", text: "連携がキャンセルされました" },
  invalid: { tone: "warn", text: "認証の確認に失敗しました。もう一度お試しください" },
  config: { tone: "warn", text: "サーバーの環境変数が未設定です" },
  failed: { tone: "warn", text: "連携に失敗しました" },
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未同期");

/**
 * 設定「Xアカウント連携」。初期は連携OFF・自動収集OFF（有料のX API取得を勝手に始めない）。
 * 画面に出すのは連携の状態だけで、トークンは含まない。
 */
export function XLinkView({ info, result, message }: { info: XLinkInfo; result: string | null; message: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(() => {
    const r = result ? RESULT_TEXT[result] : null;
    return r ? { tone: r.tone, text: result === "failed" && message ? `連携に失敗しました: ${message.slice(0, 80)}` : r.text } : null;
  });
  const [confirmOff, setConfirmOff] = useState(false);
  const l = info.link;

  const run = (fn: () => Promise<XLinkResult>) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? { tone: "ok", text: r.message } : { tone: "warn", text: r.error });
      setConfirmOff(false);
      router.refresh();
    });

  const budgetLine = info.xEnabled && info.budgetJpy > 0 ? `月額予算 ¥${info.budgetJpy.toLocaleString("ja-JP")}（今月の取得 約¥${info.totalCostJpy.toLocaleString("ja-JP")}）` : "X APIの利用が未設定（「抽選情報の自動収集」で有効にして月額予算を設定すると同期できます）";

  return (
    <div className="space-y-3" data-testid="x-link">
      {note && (
        <p role="status" data-testid="x-link-note" className={cn("rounded-md border px-3 py-2 text-sm", note.tone === "ok" ? "border-teal-600/40 bg-teal-600/5" : "border-warn/40 bg-warn/5")}>
          {note.text}
        </p>
      )}

      {!l ? (
        <section className="space-y-3 rounded-lg border p-3" data-testid="x-link-off">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Xアカウント</h2>
            <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">未連携</span>
          </div>
          <p className="text-xs text-muted-foreground">ブックマークの読み取りだけを許可します（投稿・フォロー・削除はできません）。連携しても自動収集はOFFです。</p>
          {info.configured ? (
            <Button asChild className="min-h-11 w-full">
              <a href="/api/x/oauth/start" data-testid="x-link-connect">
                Xアカウントを連携
              </a>
            </Button>
          ) : (
            <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs" data-testid="x-link-unconfigured">
              次の環境変数が未設定または不正のため、連携できません: {info.missing.join(" / ")}
            </p>
          )}
        </section>
      ) : (
        <section className="space-y-3 rounded-lg border p-3" data-testid="x-link-on">
          <div className="flex items-center justify-between gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold" data-testid="x-link-user">
              @{l.username}
            </h2>
            <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[11px]", l.status === "active" ? "border-teal-600/50 text-teal-700 dark:text-teal-300" : "border-warn/60 text-warn")} data-testid="x-link-status">
              {l.status === "active" ? "連携中" : "再連携が必要"}
            </span>
          </div>

          {l.status === "needs_reauth" && (
            <div className="space-y-2">
              <p className="text-xs text-warn" role="alert">
                {l.lastError || "認証が切れています"}。自動収集は停止中です。
              </p>
              {info.configured && (
                <Button asChild variant="outline" className="min-h-11 w-full">
                  <a href="/api/x/oauth/start" data-testid="x-link-reconnect">
                    再連携する
                  </a>
                </Button>
              )}
            </div>
          )}

          <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border px-3">
            <span className="text-sm">ブックマークの自動収集</span>
            <input type="checkbox" className="size-5" checked={l.autoSync} disabled={pending || l.status !== "active"} onChange={(e) => run(() => setAutoSyncAction(e.target.checked))} data-testid="x-link-auto" />
          </label>
          <p className="text-xs text-muted-foreground" data-testid="x-link-budget">
            {budgetLine}
          </p>

          <div className="space-y-1 text-xs" data-testid="x-link-last">
            <p>
              最終同期: <span className="font-medium">{fmt(l.lastSyncedAt)}</span>
            </p>
            {l.lastResult && <p className="text-muted-foreground">{l.lastResult}</p>}
            {l.status === "active" && l.lastError && <p className="text-warn">{l.lastError}</p>}
            <p className="text-muted-foreground">ブックマーク由来の取得（今月）: {info.bookmarkPosts.toLocaleString("ja-JP")}件・約¥{info.bookmarkCostJpy.toLocaleString("ja-JP")}</p>
          </div>

          <div className="flex gap-2">
            <Button className="min-h-11 flex-1" disabled={pending || l.status !== "active"} onClick={() => run(syncNowAction)} data-testid="x-link-sync">
              {pending ? "処理中…" : "今すぐ同期"}
            </Button>
            {!confirmOff ? (
              <Button variant="outline" className="min-h-11" disabled={pending} onClick={() => setConfirmOff(true)} data-testid="x-link-disconnect">
                連携解除
              </Button>
            ) : (
              <Button variant="danger" className="min-h-11" disabled={pending} onClick={() => run(disconnectAction)} data-testid="x-link-disconnect-confirm">
                解除する
              </Button>
            )}
          </div>
          {confirmOff && <p className="text-xs text-muted-foreground">解除しても、収集済みの候補・抽選・応募・購入・メモは残ります。</p>}
          {!l.initialDone && l.status === "active" && <p className="text-xs text-muted-foreground">初回の同期は直近14日・最大20件に制限します。</p>}
        </section>
      )}
    </div>
  );
}
