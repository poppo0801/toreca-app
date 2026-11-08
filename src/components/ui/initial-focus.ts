import { useRef } from "react";

/**
 * ダイアログ・ボトムシートのフォーカス管理（Stage 7D）。
 *  - 開いたとき: 入力欄・選択欄へは自動でフォーカスしない（iPhoneでキーボードや選択UIが勝手に出るのを防ぐ）。代わりにパネル自身（コンテナ）へフォーカスを移す。
 *    フォーカストラップ・Escで閉じる・スクリーンリーダーの読み上げ（タイトル）は維持される。利用者が入力欄を明示的にタップして初めてキーボードが出る
 *  - 閉じたとき: 開く前にフォーカスのあった操作ボタンへ戻す（トリガーを持たない制御型のダイアログでも）。直前が入力欄・選択欄だった場合は戻さない（キーボードが出るのを避ける）
 */
const editable = (el: Element | null): boolean => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);

export function usePanelFocus() {
  const previous = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (e: Event) => {
      previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      e.preventDefault();
      (e.currentTarget as HTMLElement | null)?.focus?.({ preventScroll: true });
    },
    onCloseAutoFocus: (e: Event) => {
      e.preventDefault();
      const el = previous.current;
      previous.current = null;
      if (el && el.isConnected && !editable(el)) el.focus({ preventScroll: true });
    },
  };
}
