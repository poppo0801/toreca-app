"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { shareLinkPrefix } from "@/lib/share-intake";

/**
 * iPhoneの共有（Xの投稿 → 共有 → トレマネ）の設定手順。ショートカットアプリで作る（署名つきの配布ファイルは用意できないため、手順で案内する）。
 * 登録は自動ではなく、共有するとトレマネが開き、「読み取る」→ 確認待ちの結果を確認して保存する。
 */
export function ShareSetupSection() {
  const [prefix, setPrefix] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 表示中の画面のオリジンを使う（サーバー描画時は不明）
    setPrefix(shareLinkPrefix(window.location.origin));
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prefix);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* コピーできない環境では、表示した文字列を長押しでコピーする */
    }
  };
  return (
    <div className="space-y-3 text-sm" data-testid="share-setup">
      <ol className="list-decimal space-y-1.5 pl-5 text-[13px]">
        <li>「ショートカット」アプリで新しいショートカットを作り、名前を「トレマネに登録」にする。</li>
        <li>詳細（ⓘ）で「共有シートに表示」をオンにし、受け入れる入力を「URL」と「テキスト」にする。</li>
        <li>アクション「URLエンコード」を追加する（入力は「ショートカットの入力」）。</li>
        <li>アクション「URLを開く」を追加し、URLを下の文字列＋URLエンコードの結果にする。</li>
        <li>Xの投稿で共有 →「トレマネに登録」。トレマネが開くので「読み取る」を押す。</li>
      </ol>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">「URLを開く」の前半</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted px-2 py-1.5 text-xs" data-testid="share-prefix">
            {prefix || "…"}
          </code>
          <Button type="button" variant="outline" size="icon" className="size-10 shrink-0" aria-label="コピー" onClick={copy} data-testid="share-copy">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        自動では登録されません。読み取り結果は確認待ちとして残り、確認・修正して保存します。Safariでログインしていない場合は、ログイン後に続きへ戻ります。iPhone実機での動作は未確認です。
      </p>
    </div>
  );
}
