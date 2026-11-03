"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Plus, Search } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ChainLogo } from "@/components/chain-logo";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { addMemberNumber, deleteMemberNumber, updateMemberNumber } from "@/app/(app)/settings/member-numbers/actions";
import { listFor, type MemberNumber } from "@/lib/member-number";
import { useBusy } from "@/lib/use-busy";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-2 text-sm";

/** クリップボードへコピー（会員番号だけ）。古いブラウザ向けに execCommand へフォールバック */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 会員番号管理: 選択中のプロフィールの、系列ごとの会員番号。ロゴ｜系列名｜番号｜コピー。番号タップで編集・削除 */
export function MemberNumbersView({ rows }: { rows: MemberNumber[] }) {
  const { data, profile } = useApp();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemberNumber | "new" | null>(null);
  const chainById = useMemo(() => new Map(data.chains.map((c) => [c.id, c])), [data.chains]);
  const chainName = (id: string) => chainById.get(id)?.name ?? "（不明な系列）";
  const list = listFor(rows, profile.id, chainName, query);
  const used = new Set(rows.filter((r) => r.profileId === profile.id).map((r) => r.chainId));
  const candidates = data.chains.filter((c) => !c.archived && !used.has(c.id)).sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const copy = async (r: MemberNumber) => {
    if (await copyText(r.memberNo)) {
      setCopied(r.id);
      window.setTimeout(() => setCopied((c) => (c === r.id ? null : c)), 1500);
    }
  };

  return (
    <div className="space-y-3" data-testid="member-numbers">
      <div className="flex items-center gap-2">
        <ProfileAvatar profile={profile} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{profile.label}の会員番号</span>
        <InfoTip text="プロフィールごとに系列の会員番号を保管し、応募時にコピーできます。AI解析や自動収集には送られません。パスワードや決済情報は保存しないでください。" label="会員番号について" />
        <Button size="sm" onClick={() => setEditing("new")} data-testid="mn-add">
          <Plus className="size-4" aria-hidden="true" />
          追加
        </Button>
      </div>

      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input type="search" aria-label="系列名で検索" placeholder="系列名で検索" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-10 w-full rounded-md border bg-input pl-8 pr-2 text-sm" />
      </label>

      {list.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-center text-sm text-muted-foreground">{rows.some((r) => r.profileId === profile.id) ? "該当する系列がありません" : "会員番号はまだ登録されていません"}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card" data-testid="mn-list">
          {list.map((r) => {
            const chain = chainById.get(r.chainId);
            return (
              <li key={r.id} className="flex min-h-12 items-center gap-2 px-2.5 py-1.5">
                {chain?.logoSrc ? (
                  <ChainLogo src={chain.logoSrc} name={chainName(r.chainId)} className="!m-0 size-7" />
                ) : (
                  <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-[5px] border bg-muted text-[11px] font-bold text-muted-foreground">
                    {chainName(r.chainId).slice(0, 1)}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{chainName(r.chainId)}</span>
                <button type="button" onClick={() => setEditing(r)} className="min-h-10 max-w-[45%] truncate rounded px-1 text-right font-mono text-sm tabular-nums" aria-label={`${chainName(r.chainId)}の会員番号を編集`} data-testid="mn-number">
                  {r.memberNo}
                </button>
                <button
                  type="button"
                  onClick={() => void copy(r)}
                  aria-label={`${chainName(r.chainId)}の会員番号をコピー`}
                  data-testid="mn-copy"
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border bg-input hover:bg-muted active:bg-muted"
                >
                  {copied === r.id ? <Check className="size-4 text-success" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                </button>
                {copied === r.id && (
                  <span role="status" className="sr-only">
                    コピーしました
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {copied && (
        <p className="fixed inset-x-0 top-[max(env(safe-area-inset-top),0.75rem)] z-50 mx-auto w-fit rounded-full bg-foreground px-3 py-1 text-xs text-background shadow-lg" data-testid="mn-copied">
          ✓ コピーしました
        </p>
      )}

      {editing && (
        <EditDialog
          key={editing === "new" ? "new" : editing.id}
          target={editing}
          profileId={profile.id}
          candidates={candidates}
          chainName={chainName}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EditDialog({
  target,
  profileId,
  candidates,
  chainName,
  onClose,
  onSaved,
}: {
  target: MemberNumber | "new";
  profileId: string;
  candidates: { id: string; name: string }[];
  chainName: (id: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = target === "new";
  const [chainId, setChainId] = useState(isNew ? (candidates[0]?.id ?? "") : target.chainId);
  const [memberNo, setMemberNo] = useState(isNew ? "" : target.memberNo);
  const [note, setNote] = useState(isNew ? "" : target.note);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, run] = useBusy();

  const save = () =>
    run(async () => {
      setError(null);
      const res = isNew ? await addMemberNumber({ profileId, chainId, memberNo, note }) : await updateMemberNumber({ id: target.id, memberNo, note });
      if (res.ok) onSaved();
      else setError(res.error);
    });
  const remove = () =>
    run(async () => {
      if (isNew) return;
      const res = await deleteMemberNumber(target.id);
      if (res.ok) onSaved();
      else setError(res.error);
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle>{isNew ? "会員番号を追加" : `${chainName(target.chainId)}の会員番号`}</DialogTitle>
        <DialogDescription className="sr-only">会員番号は文字列として保存され、先頭のゼロも保持されます</DialogDescription>
        <div className="space-y-3 text-sm">
          {isNew && (
            <label className="block">
              <span className="text-[13px] font-medium">系列</span>
              <select aria-label="系列" value={chainId} onChange={(e) => setChainId(e.target.value)} className={field}>
                {candidates.length === 0 && <option value="">（登録できる系列がありません）</option>}
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="text-[13px] font-medium">会員番号</span>
            <input aria-label="会員番号" value={memberNo} onChange={(e) => setMemberNo(e.target.value)} inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false} className={`${field} font-mono`} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">補足（任意）</span>
            <input aria-label="補足" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} className={field} />
          </label>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            {!isNew &&
              (confirmDelete ? (
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()} data-testid="mn-delete-confirm">
                  本当に削除
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)} data-testid="mn-delete">
                  削除
                </Button>
              ))}
            <span className="flex-1" />
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                キャンセル
              </Button>
            </DialogClose>
            <Button disabled={busy || (isNew && !chainId)} onClick={() => void save()} data-testid="mn-save">
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
