"use client";

import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useApp } from "@/components/app-provider";
import { ChainLogo } from "@/components/chain-logo";
import { ChainLogoButton } from "@/components/chain-logo-manager";
import { ProductImagesButton, ProductThumbById } from "@/components/product-image";
import { ChainDeleteButton, ChainMergeButton } from "@/components/chain-merge-dialog";
import { ChainStoreSelectToggle } from "@/components/chain-store-select-toggle";
import { ProductDeleteButton, ProductMergeButton } from "@/components/product-merge-dialog";
import { SetCompositionButton } from "@/components/product-set-dialog";
import { normName } from "@/lib/norm";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ENTITIES, ENTITY_KEYS, type Entity, type EntityKey, type Field } from "@/lib/masters";
import { retryFailedGeocoding, saveRecord, setRetired, setRetiredBulk, type ActionResult } from "@/app/(app)/settings/masters/actions";
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

/** 一括の「表示管理」を使える種類（系列・店舗・商品）。非表示は削除ではなく、新規登録の選択候補から外すだけ（既存の抽選・応募履歴との紐付けは維持） */
const BULK_KEYS: EntityKey[] = ["chains", "stores", "products"];

/** 行末の「⋯」メニュー。使用頻度の低い操作をまとめる */
function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="relative" data-testid="row-menu">
      <summary
        aria-label={label}
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded-md border bg-input text-sm hover:bg-muted [&::-webkit-details-marker]:hidden"
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </summary>
      <div className="absolute right-0 top-10 z-20 flex min-w-32 flex-col gap-1 rounded-lg border bg-card p-1.5 shadow-lg">{children}</div>
    </details>
  );
}

const GEO_ERROR_TEXT: Record<string, string> = {
  no_match: "該当する位置が見つかりません",
  ambiguous: "住所が曖昧で位置を特定できません",
  temporary_limit: "一時的なエラーが続きました",
  service_error: "住所検索サービスのエラー",
  address_incomplete: "住所が不完全です（都道府県・市区町村・番地を補ってください）",
};

/** 店舗の位置情報の取得状態（取得済みは目立たせず、取得中・失敗・住所不完全だけ表示） */
function GeoStatusChip({ status, error }: { status: string; error: string | null }) {
  if (status === "ok" || status === "none") return null;
  const label = status === "pending" ? "位置を取得中" : status === "failed" ? "位置の取得に失敗" : "住所が不完全";
  const tone = status === "pending" ? "text-info" : "text-warn";
  return (
    <span className={cn("font-medium", tone)} data-testid="geo-status" data-status={status} title={error ? (GEO_ERROR_TEXT[error] ?? error) : undefined}>
      {label}
      {status !== "pending" && error && GEO_ERROR_TEXT[error] ? `（${GEO_ERROR_TEXT[error]}）` : ""}
    </span>
  );
}

/** 店舗一覧の上の1行: 取得中・失敗・住所不完全の件数。失敗した店舗だけをまとめて再取得できる（通常の登録・変更では操作不要） */
function GeoStatusBar({ stores }: { stores: Record<string, unknown>[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const count = (s: string) => stores.filter((r) => r.archived_at == null && r.geo_status === s).length;
  const [wait, failed, incomplete] = [count("pending"), count("failed"), count("incomplete")];
  if (wait + failed + incomplete === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-xs" data-testid="geo-bar">
      <span>位置情報:</span>
      {wait > 0 && <span className="text-info">取得中 {wait}件</span>}
      {failed > 0 && <span className="text-warn">取得失敗 {failed}件</span>}
      {incomplete > 0 && <span className="text-muted-foreground">住所不完全 {incomplete}件</span>}
      {failed > 0 && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          data-testid="geo-retry"
          onClick={() =>
            start(async () => {
              const r = await retryFailedGeocoding();
              setMsg(r.ok ? `${r.count}件を再取得します` : r.error);
              router.refresh();
            })
          }
        >
          取得失敗を再取得
        </Button>
      )}
      {msg && <span role="status">{msg}</span>}
    </div>
  );
}

/** 一覧を1回に描画する件数 */
const MASTER_PAGE = 40;

export function MastersView({ rows, rules }: { rows: MasterRows; rules: RuleRow[] }) {
  const { profile } = useApp();
  const router = useRouter();
  const [key, setKey] = useState<EntityKey>("chains");
  const [showRetired, setShowRetired] = useState(false);
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [logoFilter, setLogoFilter] = useState<"all" | "nologo">("all");
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkPending, startBulk] = useTransition();
  const entity = ENTITIES[key];
  // 一覧は40件ずつ描画する（画面のDOM・画像を増やしすぎない。Stage 7D）。表示する種類・検索・絞り込みを変えたら先頭の40件に戻る
  const [page, setPage] = useState<{ sig: string; n: number }>({ sig: "", n: MASTER_PAGE });
  const bulkable = BULK_KEYS.includes(key) && entity.retire === "archived_at";

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
    .filter((r) => (key === "chains" && logoFilter === "nologo" ? r.logo_sha256 == null : true))
    .filter((r) => {
      if (!isProducts) return true;
      if (category && r.category !== category) return false;
      if (codeKind === "none" ? r.product_code != null : codeKind ? r.product_code_kind !== codeKind : false) return false;
      if (!nq) return true;
      return [String(r.official_name ?? ""), String(r.product_code ?? ""), ...(aliasByProduct.get(r.id) ?? [])].some((t) => normName(t).includes(nq));
    });

  const pageSig = [key, q, category, codeKind, logoFilter, showRetired].join("|");
  const shownCount = page.sig === pageSig ? page.n : MASTER_PAGE;
  const pickedRows = visible.filter((r) => selected.has(r.id));
  const toHide = pickedRows.filter((r) => !isRetired(entity, r));
  const toShow = pickedRows.filter((r) => isRetired(entity, r));
  const noLogoCount = key === "chains" ? rows.chains.filter((r) => !isRetired(entity, r) && r.logo_sha256 == null).length : 0;

  const changeKey = (k: EntityKey) => {
    setKey(k);
    setManage(false);
    setSelected(new Set());
    setBulkMsg(null);
  };
  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const bulk = (ids: string[], retired: boolean) =>
    startBulk(async () => {
      setBulkMsg(null);
      const res = await setRetiredBulk(key, ids, retired, profile.id);
      if (res.ok) {
        setSelected(new Set());
        router.refresh();
      } else setBulkMsg(res.error);
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
            onClick={() => changeKey(k)}
            className={cn(
              "min-h-10 rounded-md border px-3 text-sm",
              k === key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {ENTITIES[k].label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} className="size-4" />
          {entity.retire === "active" ? "無効も表示" : entity.retire === "archived_at" ? "非表示を表示" : ""}
        </label>
        <div className="flex items-center gap-1.5">
          {bulkable && (
            <Button
              size="sm"
              variant={manage ? "default" : "outline"}
              aria-pressed={manage}
              onClick={() => {
                setManage((v) => !v);
                setSelected(new Set());
                setBulkMsg(null);
              }}
              data-testid="manage-toggle"
            >
              表示管理
            </Button>
          )}
          <RecordDialog entity={entity} rows={rows} record={null} trigger={<Button size="sm">＋ 追加</Button>} />
        </div>
      </div>

      {key === "chains" && (
        <div role="group" aria-label="ロゴの絞り込み" className="flex gap-1.5">
          {(
            [
              ["all", "すべて"],
              ["nologo", `ロゴ未登録${noLogoCount > 0 ? ` ${noLogoCount}` : ""}`],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={logoFilter === v}
              onClick={() => setLogoFilter(v)}
              data-testid={`logo-filter-${v}`}
              className={cn("min-h-9 rounded-full border px-3 text-xs", logoFilter === v ? "border-primary bg-primary text-primary-foreground" : "bg-input hover:bg-muted")}
            >
              {label}
            </button>
          ))}
        </div>
      )}

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

      {bulkable && manage && (
        <div className="sticky top-[var(--header-h)] z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm" data-testid="bulk-bar">
          <span className="flex-1">
            {selected.size > 0 ? `${pickedRows.length}件を選択中` : "項目を選んでください"}
            <InfoTip className="ml-1" text="非表示にした項目は、新規登録の選択候補に出なくなります。削除ではなく、既存の抽選・応募履歴との紐付けはそのまま残ります。「非表示を表示」で確認し、いつでも再表示できます。" label="非表示について" />
          </span>
          <Button size="sm" variant="outline" disabled={bulkPending || visible.length === 0} onClick={() => setSelected(new Set(selected.size === visible.length ? [] : visible.map((r) => r.id)))}>
            {selected.size === visible.length && visible.length > 0 ? "選択を解除" : "すべて選択"}
          </Button>
          <Button size="sm" disabled={bulkPending || toHide.length === 0} onClick={() => bulk(toHide.map((r) => r.id), true)} data-testid="bulk-hide">
            非表示にする{toHide.length > 0 ? ` (${toHide.length})` : ""}
          </Button>
          <Button size="sm" disabled={bulkPending || toShow.length === 0} onClick={() => bulk(toShow.map((r) => r.id), false)} data-testid="bulk-show">
            再表示する{toShow.length > 0 ? ` (${toShow.length})` : ""}
          </Button>
          {bulkMsg && (
            <p role="alert" className="w-full text-xs text-danger">
              {bulkMsg}
            </p>
          )}
        </div>
      )}

      {key === "stores" && <GeoStatusBar stores={rows.stores} />}

      <ul className="space-y-2" aria-label={`${entity.label}一覧`}>
        {visible.slice(0, shownCount).map((r) => (
          <MasterItem key={r.id} entity={entity} row={r} rows={rows} names={names} rules={rules} manage={bulkable && manage} selected={selected.has(r.id)} onSelect={() => toggleSel(r.id)} />
        ))}
      </ul>
      {visible.length > shownCount && (
        <Button variant="outline" className="w-full" onClick={() => setPage({ sig: pageSig, n: shownCount + MASTER_PAGE })} data-testid="masters-more">
          もっと見る（{shownCount}/{visible.length}）
        </Button>
      )}
      {visible.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {key === "chains" && logoFilter === "nologo" ? "ロゴ未登録の系列はありません。" : `${entity.label}はまだ登録されていません。「＋ 追加」から登録してください。`}
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
  manage,
  selected,
  onSelect,
}: {
  entity: Entity;
  row: Row;
  rows: MasterRows;
  names: Record<string, string>;
  rules: RuleRow[];
  /** 表示管理モード（チェックボックスを出す） */
  manage: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { profile, data } = useApp();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const retired = isRetired(entity, row);
  const bulkKey = BULK_KEYS.includes(entity.key) && entity.retire === "archived_at";
  const dist = entity.key === "stores" ? storeDistance(data, { lat: row.latitude as number | null, lng: row.longitude as number | null }) : null;
  const hasPos = entity.key === "stores" && row.latitude != null && row.longitude != null;
  const logoSrc = entity.key === "chains" ? (data.chains.find((c) => c.id === row.id)?.logoSrc ?? null) : null;

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

  const title = (entity.titleFields ?? [entity.titleField]).map((f) => (f.endsWith("_id") ? names[String(row[f])] : String(row[f] ?? "日付不明"))).join(" / ");
  const badges = (
    <>
      {row.is_provisional === true && (
        <span className="ml-1.5 inline-block rounded border border-info px-1 align-middle text-[10px] font-normal text-info" title="仮登録（情報を補完してください）" data-testid="provisional-badge">
          仮
        </span>
      )}
      {retired && <span className="ml-1.5 align-middle text-xs font-normal text-muted-foreground">（{entity.retire === "active" ? "無効" : "非表示"}）</span>}
    </>
  );

  return (
    <li className={cn("rounded-lg border bg-card p-3", retired && "opacity-60")} data-testid="master-row">
      <div className="flex items-center gap-2">
        {manage && (
          <input type="checkbox" className="size-5 shrink-0" checked={selected} onChange={onSelect} aria-label={`${title}を選択`} data-testid="master-select" />
        )}
        {entity.key === "products" && <ProductThumbById productId={row.id} heightClass="h-14" />}
        {entity.key === "chains" && <ChainLogoTile src={logoSrc} name={title} />}
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-bold", entity.key === "products" ? "line-clamp-2 break-words" : "break-words")}>
            {title}
            {badges}
          </p>
          {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
          {entity.key === "chains" && rows.chain_aliases.some((a) => a.chain_id === row.id) && (
            <p className="truncate text-xs text-muted-foreground" data-testid="chain-alias-list">
              別名: {rows.chain_aliases.filter((a) => a.chain_id === row.id).map((a) => String(a.alias)).join("・")}
            </p>
          )}
          {entity.key === "stores" && (
            <p className="flex flex-wrap items-center gap-x-2 text-xs" data-testid="store-place">
              {dist ? (
                <span className={cn("font-medium", BAND_CLASS[dist.band].split(" ")[1])}>自宅から直線 {formatKm(dist.km)}</span>
              ) : (
                <span className="text-muted-foreground">{hasPos ? "自宅の位置が未設定（距離なし）" : "位置未設定（距離なし）"}</span>
              )}
              <GeoStatusChip status={String(row.geo_status ?? "none")} error={typeof row.geo_error === "string" ? row.geo_error : null} />
              <span className="text-muted-foreground">{row.round_trip_fare != null ? `往復交通費 ${Number(row.round_trip_fare).toLocaleString("ja-JP")}円` : "交通費 未設定"}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {entity.key === "chains" && <ChainLogoButton chainId={row.id} name={String(row.name)} sha={typeof row.logo_sha256 === "string" ? row.logo_sha256 : null} />}
          {entity.key === "products" && <ProductImagesButton productId={row.id} name={String(row.official_name)} />}
          {entity.key === "profiles" && <RulesDialog profile={row} chains={rows.chains} stores={rows.stores} rules={rules} />}
          <RecordDialog entity={entity} rows={rows} record={row} trigger={<Button size="sm" variant="outline">編集</Button>} />
          {entity.key === "chains" && (
            <RowMenu label={`${title}のその他の操作`}>
              <ChainStoreSelectToggle chainId={row.id} name={String(row.name)} on={row.store_select_default === true} />
              <ChainMergeButton chainId={row.id} name={String(row.name)} />
              <ChainDeleteButton chainId={row.id} name={String(row.name)} />
            </RowMenu>
          )}
          {entity.key === "products" && (
            <RowMenu label={`${title}のその他の操作`}>
              <SetCompositionButton productId={row.id} name={String(row.official_name)} />
              <ProductMergeButton productId={row.id} name={String(row.official_name)} />
              <ProductDeleteButton productId={row.id} name={String(row.official_name)} />
            </RowMenu>
          )}
          {/* 系列・店舗・商品の非表示は「表示管理」から一括で行う（個別のボタンは出さない） */}
          {!bulkKey && (
            <Button size="sm" variant="outline" onClick={toggle} disabled={pending}>
              {entity.retire === "delete" ? "削除" : retired ? (entity.retire === "active" ? "復元" : "再表示") : entity.retire === "active" ? "無効化" : "非表示にする"}
            </Button>
          )}
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

/** 系列ロゴの表示枠（32〜36px四方）。未登録なら頭文字のプレースホルダー */
function ChainLogoTile({ src, name }: { src: string | null; name: string }) {
  if (src) return <ChainLogo src={src} name={name} className="!m-0 size-9 rounded-md p-0.5" />;
  return (
    <span aria-hidden="true" data-testid="logo-placeholder" className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed bg-muted text-sm font-bold text-muted-foreground">
      {name.slice(0, 1)}
    </span>
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
  // 系列の別名（例: 正式名称「晴れる屋2」・別名「ハレツー」）。同じ系列として照合・集計される
  const currentAliases = () => (entity.key === "chains" && record ? rows.chain_aliases.filter((a) => a.chain_id === record.id).map((a) => String(a.alias)) : []);
  const [aliases, setAliases] = useState<string[]>(currentAliases);
  const [aliasDraft, setAliasDraft] = useState("");
  const addAlias = () => {
    const v = aliasDraft.trim();
    if (!v) return;
    if (!aliases.some((a) => normName(a) === normName(v))) setAliases((l) => [...l, v]);
    setAliasDraft("");
  };

  const lookup = async () => {
    setGeo({ busy: true, candidates: [], error: null });
    const r = await geocodeAddress(values.address_optional ?? "");
    setGeo(r.ok ? { busy: false, candidates: r.candidates, error: null } : { busy: false, candidates: [], error: r.error });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res: ActionResult = await saveRecord(entity.key, record?.id ?? null, profile.id, values, entity.key === "chains" ? aliases : undefined);
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
          setAliases(currentAliases());
          setAliasDraft("");
          setError(null);
          setOpen(true);
        }}
      >
        {trigger}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-y-auto">
          <DialogTitle>
            {entity.label}を{record ? "編集" : "追加"}
          </DialogTitle>
          <DialogDescription className="sr-only">操作プロフィール「{profile.label}」として記録されます。</DialogDescription>
          <form onSubmit={submit} className="mt-3 space-y-3">
            {entity.fields.map((f) => (
              <label key={f.name} className="block text-sm">
                {f.label}
                {f.required && <span className="text-danger"> *</span>}
                <FieldInput field={f} rows={rows} value={values[f.name] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
              </label>
            ))}
            {entity.key === "chains" && (
              <div className="space-y-1.5 text-sm" data-testid="chain-aliases">
                <p>別名（略称・別表記。任意）</p>
                {aliases.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label="別名">
                    {aliases.map((a) => (
                      <li key={a} className="flex items-center gap-1 rounded-full border bg-input py-0.5 pl-2.5 pr-1 text-xs">
                        {a}
                        <button type="button" onClick={() => setAliases((l) => l.filter((x) => x !== a))} aria-label={`別名「${a}」を削除`} className="flex size-6 items-center justify-center rounded-full hover:bg-muted">
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-1.5">
                  <input
                    value={aliasDraft}
                    onChange={(e) => setAliasDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addAlias();
                      }
                    }}
                    maxLength={80}
                    aria-label="別名を入力"
                    placeholder="例: ハレツー"
                    className="h-10 min-w-0 flex-1 rounded-md border bg-input px-2 text-base"
                  />
                  <Button type="button" variant="outline" onClick={addAlias} disabled={!aliasDraft.trim()} data-testid="chain-alias-add">
                    追加
                  </Button>
                </div>
              </div>
            )}
            {entity.key === "stores" && (
              <div className="space-y-1.5 rounded-md border p-2" data-testid="store-geocode">
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  位置の取得
                  <InfoTip text="「住所から位置を取得」を押すと、上の店舗の住所を国土地理院の住所検索（無料）に送り、緯度経度の候補を調べます（押さない限り送信しません）。取得できない場合は緯度・経度を手入力できます。" label="位置の取得" />
                </p>
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
        <DialogContent className="overflow-y-auto">
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
