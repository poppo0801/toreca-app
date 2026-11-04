"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createMemoAction, listMemosAction, recheckMemoAction, setMemoStateAction } from "@/app/(app)/lotteries/memo-actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isMemoOpen, MEMO_STATE_LABEL, type MemoInput, type MemoRow } from "@/lib/collector/memos";
import { cn } from "@/lib/utils";

/** ＋登録の入口: 抽選情報の登録／優先収集メモ（既存の抽選タブは増やさない） */
export function RegisterChooser({ open, onOpenChange, onLottery, onMemo, onMemoList }: { open: boolean; onOpenChange: (v: boolean) => void; onLottery: () => void; onMemo: () => void; onMemoList: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs space-y-2" data-testid="register-chooser">
        <DialogTitle>登録</DialogTitle>
        <DialogDescription className="sr-only">登録する内容を選びます</DialogDescription>
        <Button className="w-full justify-start" onClick={onLottery} data-testid="register-lottery">
          抽選情報を登録
        </Button>
        <Button variant="outline" className="w-full justify-start" onClick={onMemo} data-testid="register-memo">
          優先収集メモ
        </Button>
        <button type="button" className="w-full pt-1 text-left text-xs text-muted-foreground underline" onClick={onMemoList} data-testid="open-memo-list">
          優先収集メモの一覧
        </button>
      </DialogContent>
    </Dialog>
  );
}

const EMPTY: MemoInput = { chainId: null, chainName: "", storeId: null, storeName: "", productIds: [], productNames: [], referenceUrl: "", note: "", announcedStart: "", priority: "normal" };

/** 優先収集メモの登録。系列＋商品だけでも保存できる。未登録の名称は仮名称として保存する */
export function MemoFormDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, profile } = useApp();
  const router = useRouter();
  const [v, setV] = useState<MemoInput>(EMPTY);
  const [pq, setPq] = useState("");
  const [temp, setTemp] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chains = data.chains.filter((c) => !c.archived);
  const stores = data.stores.filter((s) => !s.archived && (!v.chainId || s.chainId === v.chainId));
  const products = useMemo(() => data.products.filter((p) => !p.archived && (!pq || p.officialName.toLowerCase().includes(pq.toLowerCase()) || p.aliases.some((a) => a.toLowerCase().includes(pq.toLowerCase())))).slice(0, 30), [data.products, pq]);
  const toggle = (id: string) => setV((x) => ({ ...x, productIds: x.productIds.includes(id) ? x.productIds.filter((p) => p !== id) : [...x.productIds, id] }));

  const save = async () => {
    setBusy(true);
    setErr("");
    const names = temp.trim() ? [...v.productNames, temp.trim()] : v.productNames;
    const res = await createMemoAction({ ...v, productNames: names }, profile.id);
    setBusy(false);
    if (!res.ok) return setErr(res.error);
    setV(EMPTY);
    setTemp("");
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="space-y-3 text-sm" data-testid="memo-form">
        <DialogTitle>優先収集メモ</DialogTitle>
        <DialogDescription className="sr-only">告知の予告を見つけたとき、系列と商品だけでも登録できます。次回の収集で優先して調べます</DialogDescription>
        <label className="block space-y-1">
          <span className="text-xs font-medium">系列</span>
          <select className="h-9 w-full rounded-md border bg-background px-2" value={v.chainId ?? ""} onChange={(e) => setV({ ...v, chainId: e.target.value || null, storeId: null })} data-testid="memo-chain">
            <option value="">未選択（名称を入力）</option>
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {!v.chainId && <input className="h-9 w-full rounded-md border bg-background px-2" placeholder="未登録の系列名（仮名称）" value={v.chainName} onChange={(e) => setV({ ...v, chainName: e.target.value })} data-testid="memo-chain-name" />}
        </label>
        <div className="space-y-1">
          <span className="text-xs font-medium">商品（複数可）</span>
          <input className="h-9 w-full rounded-md border bg-background px-2" placeholder="商品を検索" value={pq} onChange={(e) => setPq(e.target.value)} data-testid="memo-product-search" />
          <ul className="max-h-32 divide-y overflow-y-auto rounded-md border" data-testid="memo-products">
            {products.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5">
                  <input type="checkbox" checked={v.productIds.includes(p.id)} onChange={() => toggle(p.id)} />
                  <span className="min-w-0 truncate">{p.officialName}</span>
                </label>
              </li>
            ))}
          </ul>
          <input className="h-9 w-full rounded-md border bg-background px-2" placeholder="未登録の商品名（仮名称）" value={temp} onChange={(e) => setTemp(e.target.value)} data-testid="memo-product-name" />
        </div>
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setMore((m) => !m)} aria-expanded={more}>
          {more ? "詳細を閉じる" : "店舗・URL・開始日・優先度"}
        </button>
        {more && (
          <div className="space-y-2" data-testid="memo-more">
            <select className="h-9 w-full rounded-md border bg-background px-2" value={v.storeId ?? ""} onChange={(e) => setV({ ...v, storeId: e.target.value || null })} aria-label="店舗" data-testid="memo-store">
              <option value="">店舗：指定なし</option>
              {stores.slice(0, 200).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input className="h-9 w-full rounded-md border bg-background px-2" placeholder="参考URL（任意）" inputMode="url" value={v.referenceUrl} onChange={(e) => setV({ ...v, referenceUrl: e.target.value })} data-testid="memo-url" />
            <input type="date" className="h-9 w-full rounded-md border bg-background px-2" aria-label="予告された開始日" value={v.announcedStart} onChange={(e) => setV({ ...v, announcedStart: e.target.value })} data-testid="memo-start" />
            <textarea className="min-h-16 w-full rounded-md border bg-background p-2" placeholder="メモ（任意）" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} data-testid="memo-note" />
            <div className="flex gap-1" role="radiogroup" aria-label="優先度">
              {(["normal", "high"] as const).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={v.priority === p} onClick={() => setV({ ...v, priority: p })} className={cn("h-8 flex-1 rounded-md border text-xs", v.priority === p ? "bg-primary text-primary-foreground" : "bg-background")} data-testid={`memo-priority-${p}`}>
                  {p === "high" ? "高" : "通常"}
                </button>
              ))}
            </div>
          </div>
        )}
        {err && (
          <p role="alert" className="text-xs text-danger" data-testid="memo-error">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy} data-testid="memo-save">
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const STATE_TONE: Record<string, string> = {
  unsurveyed: "bg-muted text-muted-foreground", surveying: "bg-info/15 text-info", found: "bg-teal-600/15 text-teal-700 dark:text-teal-300", insufficient: "bg-warn/15 text-warn",
  registered: "bg-success/15 text-success", expired: "bg-muted text-muted-foreground", withdrawn: "bg-muted text-muted-foreground",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未確認");

/** 優先収集メモの一覧（系列・商品・参考URL・調査状態・最終確認日時）。履歴として、終了したメモも残る */
export function MemoListDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data } = useApp();
  const [memos, setMemos] = useState<MemoRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => setMemos(await listMemosAction()), []);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void listMemosAction().then((m) => live && setMemos(m));
    return () => {
      live = false;
    };
  }, [open]);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    await fn();
    await load();
    setBusy(null);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="space-y-2 text-sm" data-testid="memo-list">
        <DialogTitle>優先収集メモ</DialogTitle>
        <DialogDescription className="sr-only">登録した優先収集メモと調査状態の一覧</DialogDescription>
        {memos === null ? (
          <p className="text-xs text-muted-foreground">読み込み中…</p>
        ) : memos.length === 0 ? (
          <p className="text-xs text-muted-foreground">メモはありません</p>
        ) : (
          <ul className="divide-y">
            {memos.map((m) => {
              const chain = m.chainId ? (data.chains.find((c) => c.id === m.chainId)?.name ?? m.chainName) : m.chainName;
              const prods = [...m.productIds.map((id) => data.products.find((p) => p.id === id)?.officialName ?? ""), ...m.productNames].filter(Boolean);
              return (
                <li key={m.id} className="space-y-1 py-2" data-testid="memo-row" data-state={m.state}>
                  <div className="flex items-center gap-1.5">
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", STATE_TONE[m.state])} data-testid="memo-state">
                      {MEMO_STATE_LABEL[m.state]}
                    </span>
                    {m.priority === "high" && <span className="text-[11px] font-medium text-accent-strong">優先高</span>}
                    <span className="min-w-0 truncate font-medium">{chain || "（系列未指定）"}</span>
                  </div>
                  <p className="text-xs">{prods.join("、") || "（商品未指定）"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {m.referenceUrl ? "参考URLあり" : "参考URLなし"}・最終確認 {when(m.lastCheckedAt)}
                  </p>
                  {m.stateDetail && <p className="text-[11px] text-muted-foreground" data-testid="memo-detail">{m.stateDetail}</p>}
                  <div className="flex gap-1.5">
                    {isMemoOpen(m.state) && (
                      <>
                        <Button size="sm" variant="outline" disabled={busy === m.id} onClick={() => void act(m.id, () => recheckMemoAction(m.id))} data-testid="memo-recheck">
                          {busy === m.id ? "調査中…" : "今すぐ再調査"}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy === m.id} onClick={() => void act(m.id, () => setMemoStateAction(m.id, "withdrawn"))} data-testid="memo-withdraw">
                          取り下げ
                        </Button>
                      </>
                    )}
                    {(m.state === "withdrawn" || m.state === "expired") && (
                      <Button size="sm" variant="outline" disabled={busy === m.id} onClick={() => void act(m.id, () => setMemoStateAction(m.id, "unsurveyed"))} data-testid="memo-reopen">
                        再開
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
