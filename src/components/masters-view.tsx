"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useApp } from "@/components/app-provider";
import { ProductImagesButton, ProductThumbById } from "@/components/product-image";
import { SetCompositionButton } from "@/components/product-set-dialog";
import { normName } from "@/lib/norm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ENTITIES, ENTITY_KEYS, type Entity, type EntityKey, type Field } from "@/lib/masters";
import { saveRecord, setRetired, type ActionResult } from "@/app/(app)/settings/masters/actions";
import { geocodeAddress, type GeoCandidate } from "@/app/(app)/settings/household-actions";
import { BAND_CLASS, formatKm } from "@/lib/geo";
import { storeDistance } from "@/lib/store-distance";
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

  // 商品の検索・絞り込み（名称・コード・略称 / シリーズ・区分 / コード種別）
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [codeKind, setCodeKind] = useState("");
  const aliasByProduct = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of rows.product_aliases) m.set(String(a.product_id), [...(m.get(String(a.product_id)) ?? []), String(a.alias)]);
    return m;
  }, [rows.product_aliases]);
  const categories = useMemo(() => [...new Set(rows.products.map((r) => String(r.category ?? "")).filter(Boolean))].sort(), [rows.products]);
  const isProducts = key === "products";
  const nq = normName(q);

  const visible = rows[key]
    .filter((r) => showRetired || !isRetired(entity, r))
    .filter((r) => {
      if (!isProducts) return true;
      if (category && r.category !== category) return false;
      if (codeKind === "none" ? r.product_code != null : codeKind ? r.product_code_kind !== codeKind : false) return false;
      if (!nq) return true;
      return [String(r.official_name ?? ""), String(r.product_code ?? ""), ...(aliasByProduct.get(r.id) ?? [])].some((t) => normName(t).includes(nq));
    });

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

      {isProducts && (
        <div className="grid grid-cols-2 gap-2" role="search" aria-label="商品の検索">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="名称・コード・略称で検索"
            aria-label="商品を検索"
            className="col-span-2 min-h-11 w-full rounded-md border bg-input px-3 text-sm"
          />
          <select aria-label="シリーズ・区分で絞り込み" value={category} onChange={(e) => setCategory(e.target.value)} className="min-h-11 rounded-md border bg-input px-2 text-sm">
            <option value="">すべての区分</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select aria-label="コード種別で絞り込み" value={codeKind} onChange={(e) => setCodeKind(e.target.value)} className="min-h-11 rounded-md border bg-input px-2 text-sm">
            <option value="">すべてのコード種別</option>
            <option value="official">公式番号</option>
            <option value="custom">独自コード</option>
            <option value="none">コードなし</option>
          </select>
          <p className="col-span-2 text-xs text-muted-foreground" data-testid="product-count">
            {visible.length}件 / 全{rows.products.filter((r) => showRetired || !isRetired(entity, r)).length}件
          </p>
        </div>
      )}

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
  const { profile, data } = useApp();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const retired = isRetired(entity, row);
  const dist = entity.key === "stores" ? storeDistance(data, { lat: row.latitude as number | null, lng: row.longitude as number | null }) : null;
  const hasPos = entity.key === "stores" && row.latitude != null && row.longitude != null;

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
        {entity.key === "products" && <ProductThumbById productId={row.id} heightClass="h-16" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">
            {(entity.titleFields ?? [entity.titleField]).map((f) => (f.endsWith("_id") ? names[String(row[f])] : String(row[f] ?? "日付不明"))).join(" / ")}
            {row.is_provisional === true && (
              <span className="ml-2 rounded border border-info px-1 text-xs font-normal text-info" data-testid="provisional-badge">
                仮登録（情報を補完してください）
              </span>
            )}
            {retired && <span className="ml-2 text-xs font-normal text-muted-foreground">（{entity.retire === "active" ? "無効" : "アーカイブ済み"}）</span>}
          </p>
          {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
          {entity.key === "stores" && (
            <p className="flex flex-wrap items-center gap-x-2 text-xs" data-testid="store-place">
              {dist ? (
                <span className={cn("font-medium", BAND_CLASS[dist.band].split(" ")[1])}>自宅から直線 {formatKm(dist.km)}</span>
              ) : (
                <span className="text-muted-foreground">{hasPos ? "自宅の位置が未設定（距離なし）" : "位置未設定（距離なし）"}</span>
              )}
              <span className="text-muted-foreground">{row.round_trip_fare != null ? `往復交通費 ${Number(row.round_trip_fare).toLocaleString("ja-JP")}円` : "交通費 未設定"}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {entity.key === "products" && <ProductImagesButton productId={row.id} name={String(row.official_name)} />}
          {entity.key === "products" && <SetCompositionButton productId={row.id} name={String(row.official_name)} />}
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
  const common = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
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
  const [geo, setGeo] = useState<{ busy: boolean; candidates: GeoCandidate[]; error: string | null }>({ busy: false, candidates: [], error: null });

  const lookup = async () => {
    setGeo({ busy: true, candidates: [], error: null });
    const r = await geocodeAddress(values.address_optional ?? "");
    setGeo(r.ok ? { busy: false, candidates: r.candidates, error: null } : { busy: false, candidates: [], error: r.error });
  };

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
            {entity.key === "stores" && (
              <div className="space-y-1.5 rounded-md border p-2" data-testid="store-geocode">
                <p className="text-[11px] text-muted-foreground">「住所から位置を取得」を押すと、上の店舗の住所を国土地理院の住所検索（無料）に送り、緯度経度の候補を調べます（押さない限り送信しません）。取得できない場合は緯度・経度を手入力できます。</p>
                <Button type="button" size="sm" variant="outline" onClick={lookup} disabled={geo.busy || (values.address_optional ?? "").trim().length < 3}>
                  {geo.busy ? "検索中…" : "住所から位置を取得"}
                </Button>
                {geo.error && (
                  <p role="alert" className="text-xs text-danger">
                    {geo.error}
                  </p>
                )}
                {geo.candidates.length > 0 && (
                  <ul className="space-y-1" aria-label="位置の候補">
                    {geo.candidates.map((c, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          className="min-h-10 w-full rounded-md border px-2 text-left text-xs hover:bg-muted"
                          onClick={() => {
                            setValues((s) => ({ ...s, latitude: String(c.lat), longitude: String(c.lng), prefecture: s.prefecture || c.prefecture || "" }));
                            setGeo({ busy: false, candidates: [], error: null });
                          }}
                        >
                          {c.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
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
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Mode)} className="min-h-10 rounded-md border bg-input px-2">
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
