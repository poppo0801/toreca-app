"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { addSkipRuleAction, removeSkipRuleAction, setChainRulesAction } from "@/app/(app)/settings/rules/actions";
import type { ChainRuleInput } from "@/lib/server/rules-service";

const field = "min-h-10 rounded-md border bg-background px-2 text-sm";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-3">
      <h2 className="mb-2 text-sm font-bold">{title}</h2>
      {children}
    </section>
  );
}

const BASIS_OPTIONS = [
  { value: "account", label: "1アカウント" },
  { value: "person", label: "1人（名義）" },
  { value: "family", label: "1家族" },
  { value: "address", label: "1住所" },
] as const;

/** 応募ルール: プロフィール別のスルー（店舗・系列）と、系列の標準応募制限。 */
export function RulesView() {
  const { data, profile, reload } = useApp();
  const [message, setMessage] = useState<string | null>(null);
  const [scope, setScope] = useState<"store" | "chain">("store");
  const [target, setTarget] = useState("");

  const mySkips = data.skipRules.filter((r) => r.profileId === profile.id);
  const nameOf = (scopeType: string, id: string) => {
    if (scopeType === "chain") return data.chains.find((c) => c.id === id)?.name ?? "（不明）";
    if (scopeType === "store") {
      const s = data.stores.find((x) => x.id === id);
      return s ? `${data.chains.find((c) => c.id === s.chainId)?.name ?? ""} ${s.name}` : "（不明）";
    }
    const l = data.lotteries.find((x) => x.id === id);
    const s = data.stores.find((x) => x.id === l?.storeId);
    return l ? `${data.chains.find((c) => c.id === l.chainId)?.name ?? ""} ${s?.name ?? ""}` : "（取り下げ済みの抽選）";
  };

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    const res = await fn();
    setMessage(res.ok ? done : (res.error ?? "失敗しました"));
    if (res.ok) await reload();
  };

  const targets =
    scope === "store"
      ? data.stores.filter((s) => !s.archived).map((s) => ({ id: s.id, label: `${data.chains.find((c) => c.id === s.chainId)?.name ?? ""} ${s.name}` }))
      : data.chains.filter((c) => !c.archived).map((c) => ({ id: c.id, label: c.name }));

  return (
    <div className="space-y-4">
      <Section title="スルー">
        <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <ProfileAvatar profile={profile} size="sm" />
          プロフィール「{profile.label}」のスルーです。他のプロフィールには影響せず、★管理対象とも別です。常時スルーにした抽選も、抽選ごとに「今回だけ解除」できます。
        </p>
        <ul className="space-y-1" aria-label="スルー一覧">
          {mySkips.length === 0 && <li className="text-sm text-muted-foreground">スルーの設定はありません。</li>}
          {mySkips.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm" data-testid="skip-row">
              <span>
                <span className="mr-2 rounded border px-1 text-xs">{{ lottery: "今回だけ", store: "店舗", chain: "系列" }[r.scope]}</span>
                {nameOf(r.scope, r.scopeId)}
                {r.exceptionLotteryIds.length > 0 && <span className="ml-2 text-xs text-muted-foreground">（例外 {r.exceptionLotteryIds.length}件）</span>}
              </span>
              <Button size="sm" variant="outline" onClick={() => run(() => removeSkipRuleAction(r.id), "スルーを解除しました")}>
                解除
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="スルーの単位" value={scope} onChange={(e) => { setScope(e.target.value as "store" | "chain"); setTarget(""); }} className={field}>
            <option value="store">店舗単位</option>
            <option value="chain">系列単位</option>
          </select>
          <select aria-label="スルーする対象" value={target} onChange={(e) => setTarget(e.target.value)} className={`${field} min-w-0 flex-1`}>
            <option value="">選択してください</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={!target} onClick={() => run(() => addSkipRuleAction(profile.id, scope, target, profile.id), "スルーを追加しました").then(() => setTarget(""))}>
            スルーに追加
          </Button>
        </div>
      </Section>

      <Section title="系列の標準応募制限">
        <p className="mb-2 text-xs text-muted-foreground">
          系列ごとの初期ルールです。抽選に固有の制限（抽選の登録画面で設定）がある場合は、そちらが優先され系列標準は適用されません。同時開催キャンペーンの「1店舗まで」は常に併用されます。規約が未確認のルールは「未確認」にすると、応募可能と断定せず「要確認」と表示します。
        </p>
        <ul className="space-y-3">
          {data.chains
            .filter((c) => !c.archived)
            .map((c) => (
              <ChainRules key={c.id} chainId={c.id} name={c.name} onSaved={setMessage} />
            ))}
        </ul>
        {data.chains.length === 0 && <p className="text-sm text-muted-foreground">先に系列を登録してください。</p>}
      </Section>

      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
    </div>
  );
}

function ChainRules({ chainId, name, onSaved }: { chainId: string; name: string; onSaved: (m: string) => void }) {
  const { data, profile, reload } = useApp();
  const initial = (): ChainRuleInput[] =>
    data.applicationRules
      .filter((r) => r.scope === "chain" && r.scopeId === chainId)
      .map((r) => ({ basis: r.basis, maxCount: r.maxCount, across: r.across, confidence: r.confidence }));
  const [rules, setRules] = useState<ChainRuleInput[]>(initial);
  const [busy, setBusy] = useState(false);
  const patch = (i: number, p: Partial<ChainRuleInput>) => setRules((s) => s.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const save = async () => {
    setBusy(true);
    const res = await setChainRulesAction(chainId, rules, profile.id);
    onSaved(res.ok ? `「${name}」の標準応募制限を保存しました` : res.error);
    if (res.ok) await reload();
    setBusy(false);
  };

  return (
    <li className="rounded-md border p-2" data-testid="chain-rules">
      <p className="mb-1 text-sm font-medium">{name}</p>
      {rules.length === 0 && <p className="text-xs text-muted-foreground">標準ルールなし（抽選ごとに制限を設定します）</p>}
      <ul className="space-y-1">
        {rules.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <select aria-label={`${name}のルール${i + 1}の基準`} value={r.basis} onChange={(e) => patch(i, { basis: e.target.value as ChainRuleInput["basis"] })} className={field}>
              {BASIS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input type="number" min={1} max={99} aria-label={`${name}のルール${i + 1}の上限回数`} value={r.maxCount} onChange={(e) => patch(i, { maxCount: Number(e.target.value) })} className={`${field} w-16`} />
            <span className="text-xs">回まで</span>
            <select aria-label={`${name}のルール${i + 1}の通算範囲`} value={r.across} onChange={(e) => patch(i, { across: e.target.value as ChainRuleInput["across"] })} className={field}>
              <option value="lottery">この抽選内</option>
              <option value="campaign">キャンペーン通算</option>
            </select>
            <select aria-label={`${name}のルール${i + 1}の確認状態`} value={r.confidence} onChange={(e) => patch(i, { confidence: e.target.value as ChainRuleInput["confidence"] })} className={field}>
              <option value="confirmed">規約確認済み</option>
              <option value="unconfirmed">未確認</option>
            </select>
            <Button size="icon" variant="ghost" className="size-10" aria-label={`ルール${i + 1}を削除`} onClick={() => setRules((s) => s.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setRules((s) => [...s, { basis: "person", maxCount: 1, across: "lottery", confidence: "confirmed" }])} disabled={rules.length >= 8}>
          ルールを追加
        </Button>
        <Button size="sm" onClick={save} disabled={busy}>
          保存
        </Button>
      </div>
    </li>
  );
}
