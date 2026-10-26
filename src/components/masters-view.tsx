"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ENTITIES, ENTITY_KEYS, type Entity, type EntityKey, type Field } from "@/lib/masters";
import { saveRecord, setRetired, type ActionResult } from "@/app/(app)/settings/masters/actions";
import { setProfileTargetsAction } from "@/app/(app)/settings/rules/actions";
import { cn } from "@/lib/utils";

export type Row = Record<string, unknown> & { id: string };
export type MasterRows = Record<EntityKey, Row[]>;
export interface RuleRow {
  id: string;
  profile_id: string;
  chain_id: string;
  store_id: string | null;
  mode: "allow" | "block";
}

const isRetired = (e: Entity, r: Row) =>
  e.retire === "archived_at" ? r.archived_at != null : e.retire === "active" ? r.active === false : false;

export function MastersView({ rows, rules }: { rows: MasterRows; rules: RuleRow[] }) {
  const [key, setKey] = useState<EntityKey>("chains");
  const [showRetired, setShowRetired] = useState(false);
  const entity = ENTITIES[key];

  // 参照列の表示名を引く辞書
  const names = useMemo(() => {
    const m: Record<string, string> = {};
    for (const k of ENTITY_KEYS) {
      for (const r of rows[k]) m[r.id] = String(r[ENTITIES[k].titleField] ?? "");
    }
    return m;
  }, [rows]);

  const visible = rows[key].filter((r) => showRetired || !isRetired(entity, r));

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="マスターの種類" className="flex flex-wrap gap-1">
        {ENTITY_KEYS.map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={k === key}
            onClick={() => setKey(k)}
            className={cn(
              "min-h-10 rounded-md border px-3 text-sm",
              k === key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {ENTITIES[k].label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} className="size-4" />
          {entity.retire === "active" ? "無効も表示" : entity.retire === "archived_at" ? "アーカイブも表示" : ""}
        </label>
        <RecordDialog entity={entity} rows={rows} record={null} trigger={<Button size="sm">＋ 追加</Button>} />
      </div>

      <ul className="space-y-2" aria-label={`${entity.label}一覧`}>
        {visible.map((r) => (
          <MasterItem key={r.id} entity={entity} row={r} rows={rows} names={names} rules={rules} />
        ))}
      </ul>
      {visible.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {entity.label}はまだ登録されていません。「＋ 追加」から登録してください。
        </p>
      )}
    </div>
  );
}

function MasterItem({
  entity,
  row,
  rows,
  names,
  rules,
}: {
  entity: Entity;
  row: Row;
  rows: MasterRows;
  names: Record<string, string>;
  rules: RuleRow[];
}) {
  const { profile } = useApp();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const retired = isRetired(entity, row);

  const sub = (entity.subFields ?? [])
    .map((f) => {
      const v = row[f];
      if (v == null || v === "") return null;
      const field = entity.fields.find((x) => x.name === f);
      const opt = field?.options?.find((o) => o.value === v);
      return opt?.label ?? names[String(v)] ?? String(v);
    })
    .filter(Boolean)
    .join(" ・ ");

  const toggle = () =>
    start(async () => {
      const res = await setRetired(entity.key, row.id, !retired, profile.id);
      if (res.ok) router.refresh();
      else setError(res.error);
    });

  return (
    <li className={cn("rounded-lg border bg-card p-3", retired && "opacity-60")} data-testid="master-row">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold">
            {(entity.titleFields ?? [entity.titleField]).map((f) => (f.endsWith("_id") ? names[String(row[f])] : String(row[f] ?? "日付不明"))).join(" / ")}
            {retired && <span className="ml-2 text-xs font-normal text-muted-foreground">（{entity.retire === "active" ? "無効" : "アーカイブ済み"}）</span>}
          </p>
          {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {entity.key === "profiles" && <RulesDialog profile={row} chains={rows.chains} stores={rows.stores} rules={rules} />}
          <RecordDialog entity={entity} rows={rows} record={row} trigger={<Button size="sm" variant="outline">編集</Button>} />
          <Button size="sm" variant="outline" onClick={toggle} disabled={pending}>
            {entity.retire === "delete" ? "削除" : retired ? "復元" : entity.retire === "active" ? "無効化" : "アーカイブ"}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

function FieldInput({ field, rows, value, onChange }: { field: Field; rows: MasterRows; value: string; onChange: (v: string) => void }) {
  const common = "mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm";
  if (field.type === "select") {
    const options = field.ref
      ? rows[field.ref]
          .filter((r) => !isRetired(ENTITIES[field.ref!], r) || r.id === value)
          .map((r) => ({ value: r.id, label: String(r[ENTITIES[field.ref!].titleField]) }))
      : (field.options ?? []);
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={common} required={field.required}>
        <option value="">{field.optionalRef ? "指定なし" : "選択してください"}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "textarea") {
    return <textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={field.max} rows={2} className={cn(common, "py-2")} />;
  }
  return (
    <input
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required={field.required}
      maxLength={field.max}
      min={field.min}
      max={field.type === "number" ? field.max : undefined}
      step={field.step}
      className={common}
    />
  );
}

function RecordDialog({ entity, rows, record, trigger }: { entity: Entity; rows: MasterRows; record: Row | null; trigger: React.ReactNode }) {
  const { profile } = useApp();
  const router = useRouter();
  const initial = () =>
    Object.fromEntries(entity.fields.map((f) => [f.name, record?.[f.name] != null ? String(record[f.name]) : String(f.default ?? "")]));
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res: ActionResult = await saveRecord(entity.key, record?.id ?? null, profile.id, values);
      if (res.ok) {
        setOpen(false);
        if (!record) setValues(initial());
        router.refresh();
      } else setError(res.error);
    });
  };

  return (
    <>
      <span
        onClick={() => {
          setValues(initial());
          setError(null);
          setOpen(true);
        }}
      >
        {trigger}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogTitle>
            {entity.label}を{record ? "編集" : "追加"}
          </DialogTitle>
          <DialogDescription>操作プロフィール「{profile.label}」として記録されます。</DialogDescription>
          <form onSubmit={submit} className="mt-3 space-y-3">
            {entity.fields.map((f) => (
              <label key={f.name} className="block text-sm">
                {f.label}
                {f.required && <span className="text-danger"> *</span>}
                <FieldInput field={f} rows={rows} value={values[f.name] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
              </label>
            ))}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  キャンセル
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending ? "保存中…" : "保存"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Mode = "none" | "allow" | "block";

/** プロフィールの応募対象。許可を1つでも選ぶと許可リスト方式（許可した系列・店舗のみ対象）。除外は常に対象外。 */
function RulesDialog({ profile, chains, stores, rules }: { profile: Row; chains: Row[]; stores: Row[]; rules: RuleRow[] }) {
  const { profile: actor, reload } = useApp();
  const router = useRouter();
  const current = (chainId: string, storeId: string | null): Mode =>
    rules.find((r) => r.profile_id === profile.id && r.chain_id === chainId && r.store_id === storeId)?.mode ?? "none";
  const init = () => ({
    chains: Object.fromEntries(chains.map((c) => [c.id, current(c.id, null)])) as Record<string, Mode>,
    stores: Object.fromEntries(stores.map((s) => [s.id, current(String(s.chain_id), s.id)])) as Record<string, Mode>,
  });
  const [open, setOpen] = useState(false);
  const [modes, setModes] = useState(init);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const activeChains = chains.filter((c) => c.archived_at == null);
  const activeStores = stores.filter((s) => s.archived_at == null);
  const ids = (m: Record<string, Mode>, mode: Mode) => Object.entries(m).filter(([, v]) => v === mode).map(([id]) => id);

  const save = () =>
    start(async () => {
      const res = await setProfileTargetsAction(
        {
          profileId: profile.id,
          chainAllow: ids(modes.chains, "allow"),
          chainBlock: ids(modes.chains, "block"),
          storeAllow: ids(modes.stores, "allow"),
          storeBlock: ids(modes.stores, "block"),
        },
        actor.id,
      );
      if (res.ok) {
        setOpen(false);
        router.refresh();
        void reload();
      } else setError(res.error);
    });

  const select = (label: string, value: Mode, onChange: (v: Mode) => void) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Mode)} className="min-h-10 rounded-md border bg-background px-2">
      <option value="none">指定なし</option>
      <option value="allow">許可</option>
      <option value="block">除外</option>
    </select>
  );

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setModes(init());
          setError(null);
          setOpen(true);
        }}
      >
        応募対象
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogTitle>{String(profile.label)} の応募対象</DialogTitle>
          <DialogDescription>
            「許可」を1つでも選ぶと許可リスト方式（許可した系列・店舗のみが応募漏れの対象）になります。「除外」は常に対象外です。すべて「指定なし」なら全系列・全店舗が対象です。
          </DialogDescription>
          {activeChains.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">先に系列を登録してください。</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {activeChains.map((c) => (
                <li key={c.id} className="rounded-md border p-2">
                  <div className="flex items-center justify-between gap-2 text-sm font-medium">
                    <span>{String(c.name)}（系列全体）</span>
                    {select(`${String(c.name)}の対象設定`, modes.chains[c.id] ?? "none", (v) => setModes((s) => ({ ...s, chains: { ...s.chains, [c.id]: v } })))}
                  </div>
                  <ul className="mt-1 space-y-1 pl-3">
                    {activeStores
                      .filter((st) => st.chain_id === c.id)
                      .map((st) => (
                        <li key={st.id} className="flex items-center justify-between gap-2 text-sm">
                          <span>{String(st.name)}</span>
                          {select(`${String(c.name)} ${String(st.name)}の対象設定`, modes.stores[st.id] ?? "none", (v) => setModes((s) => ({ ...s, stores: { ...s.stores, [st.id]: v } })))}
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button onClick={save} disabled={pending}>
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
