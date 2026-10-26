import { z } from "zod";

/**
 * マスター管理の定義（フォーム・検証・保存先の単一の正）。
 * サーバーは定義にあるテーブル/列だけを書き込む（任意テーブルへの書き込み不可）。
 */
export type FieldType = "text" | "textarea" | "number" | "date" | "select";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  max?: number;
  min?: number;
  step?: number;
  /** 参照先エンティティ（選択肢をそのマスターから作る） */
  ref?: EntityKey;
  /** 参照が任意（未選択=NULL） */
  optionalRef?: boolean;
  options?: { value: string; label: string }[];
  default?: string | number;
}

export const ENTITY_KEYS = [
  "profiles",
  "chains",
  "stores",
  "products",
  "product_aliases",
  "family_groups",
  "address_groups",
  "identities",
  "service_accounts",
  "chain_requirements",
  "account_eligibilities",
  "eligibility_purchases",
] as const;
export type EntityKey = (typeof ENTITY_KEYS)[number];

export interface Entity {
  key: EntityKey;
  label: string;
  fields: Field[];
  /** 退避方式。archived_at=アーカイブ列 / active=有効フラグ / delete=設定行の削除（監査ログに残る） */
  retire: "archived_at" | "active" | "delete";
  /** 一覧の主表示に使う列 */
  titleField: string;
  /** 主表示を複数列の組み合わせにする場合（参照列は参照先の名前で表示） */
  titleFields?: string[];
  /** 一覧のサブ表示に使う列（参照列は参照先の名前で表示） */
  subFields?: string[];
}

const COLORS = [
  { value: "blue", label: "青" },
  { value: "green", label: "緑" },
  { value: "purple", label: "紫" },
  { value: "pink", label: "ピンク" },
  { value: "teal", label: "青緑" },
];

export const ENTITIES: Record<EntityKey, Entity> = {
  profiles: {
    key: "profiles",
    label: "プロフィール",
    retire: "active",
    titleField: "label",
    subFields: ["initial", "color"],
    fields: [
      { name: "label", label: "名前", type: "text", required: true, max: 20 },
      { name: "initial", label: "アイコン文字（1〜2字）", type: "text", required: true, max: 2 },
      { name: "color", label: "色", type: "select", required: true, options: COLORS, default: "blue" },
      { name: "sort_order", label: "表示順", type: "number", required: true, min: 0, max: 999, step: 1, default: 0 },
    ],
  },
  chains: {
    key: "chains",
    label: "系列",
    retire: "archived_at",
    titleField: "name",
    subFields: ["memo"],
    fields: [
      { name: "name", label: "系列名", type: "text", required: true, max: 80 },
      { name: "default_application_rule", label: "標準の応募ルール", type: "textarea", max: 1000 },
      { name: "memo", label: "メモ", type: "textarea", max: 2000 },
    ],
  },
  stores: {
    key: "stores",
    label: "店舗",
    retire: "archived_at",
    titleField: "name",
    subFields: ["chain_id", "prefecture"],
    fields: [
      { name: "chain_id", label: "系列", type: "select", required: true, ref: "chains" },
      { name: "name", label: "店舗名", type: "text", required: true, max: 80 },
      { name: "prefecture", label: "都道府県", type: "text", max: 10 },
      { name: "nearest_station", label: "最寄駅", type: "text", max: 60 },
      { name: "address_optional", label: "住所（任意）", type: "text", max: 200 },
      { name: "parking_memo", label: "駐車場メモ", type: "text", max: 500 },
      { name: "latitude", label: "緯度（任意）", type: "number", min: -90, max: 90, step: 0.000001 },
      { name: "longitude", label: "経度（任意）", type: "number", min: -180, max: 180, step: 0.000001 },
    ],
  },
  products: {
    key: "products",
    label: "商品",
    retire: "archived_at",
    titleField: "official_name",
    subFields: ["product_code", "packs_per_box"],
    fields: [
      { name: "official_name", label: "正式名称", type: "text", required: true, max: 120 },
      { name: "product_code", label: "商品コード（任意）", type: "text", max: 30 },
      { name: "category", label: "カテゴリ", type: "text", required: true, max: 40, default: "pokemon_card" },
      { name: "release_date", label: "発売日（任意）", type: "date" },
      { name: "packs_per_box", label: "1BOXのパック数", type: "number", required: true, min: 1, max: 500, step: 1, default: 30 },
    ],
  },
  product_aliases: {
    key: "product_aliases",
    label: "商品の略称",
    retire: "delete",
    titleField: "alias",
    subFields: ["product_id"],
    fields: [
      { name: "product_id", label: "商品", type: "select", required: true, ref: "products" },
      { name: "alias", label: "略称", type: "text", required: true, max: 80 },
    ],
  },
  family_groups: {
    key: "family_groups",
    label: "家族グループ",
    retire: "archived_at",
    titleField: "label",
    fields: [{ name: "label", label: "名称", type: "text", required: true, max: 60 }],
  },
  address_groups: {
    key: "address_groups",
    label: "住所グループ",
    retire: "archived_at",
    titleField: "label",
    fields: [{ name: "label", label: "名称（具体的な住所は入力しない）", type: "text", required: true, max: 60 }],
  },
  identities: {
    key: "identities",
    label: "応募名義",
    retire: "archived_at",
    titleField: "display_label",
    subFields: ["family_group_id", "address_group_id"],
    fields: [
      { name: "display_label", label: "名義の表示名", type: "text", required: true, max: 60 },
      { name: "family_group_id", label: "家族グループ", type: "select", required: true, ref: "family_groups" },
      { name: "address_group_id", label: "住所グループ", type: "select", required: true, ref: "address_groups" },
    ],
  },
  service_accounts: {
    key: "service_accounts",
    label: "応募アカウント",
    retire: "active",
    titleField: "account_label",
    subFields: ["chain_id", "identity_id", "managed_by_profile_id", "membership_state"],
    fields: [
      { name: "chain_id", label: "系列", type: "select", required: true, ref: "chains" },
      { name: "identity_id", label: "応募名義", type: "select", required: true, ref: "identities" },
      { name: "managed_by_profile_id", label: "担当プロフィール", type: "select", required: true, ref: "profiles" },
      { name: "account_label", label: "アカウント名（ID/パスワードは入力しない）", type: "text", required: true, max: 60 },
      {
        name: "membership_state",
        label: "会員資格",
        type: "select",
        required: true,
        default: "unknown",
        options: [
          { value: "eligible", label: "あり" },
          { value: "ineligible", label: "なし" },
          { value: "unknown", label: "未確認" },
        ],
      },
    ],
  },
  chain_requirements: {
    key: "chain_requirements",
    label: "系列の応募条件",
    retire: "archived_at",
    titleField: "label",
    titleFields: ["chain_id", "label"],
    subFields: ["kind", "valid_months"],
    fields: [
      { name: "chain_id", label: "系列", type: "select", required: true, ref: "chains" },
      {
        name: "kind",
        label: "種類",
        type: "select",
        required: true,
        default: "membership",
        options: [
          { value: "membership", label: "会員登録" },
          { value: "point_card", label: "ポイントカード" },
          { value: "purchase_history", label: "購入履歴" },
          { value: "id_verification", label: "本人確認" },
          { value: "other", label: "その他" },
        ],
      },
      { name: "label", label: "条件名（例: 会員登録）", type: "text", required: true, max: 80 },
      { name: "description", label: "内容・メモ", type: "textarea", max: 1000 },
      { name: "valid_months", label: "有効月数（任意）", type: "number", min: 1, max: 240, step: 1 },
      { name: "min_purchase_count", label: "必要な購入回数（任意）", type: "number", min: 0, max: 100000, step: 1 },
      { name: "min_purchase_amount_yen", label: "必要な購入金額・円（任意）", type: "number", min: 0, max: 100000000, step: 1 },
    ],
  },
  account_eligibilities: {
    key: "account_eligibilities",
    label: "アカウントの資格",
    retire: "archived_at",
    titleField: "service_account_id",
    titleFields: ["service_account_id", "requirement_id"],
    subFields: ["state", "valid_until"],
    fields: [
      { name: "service_account_id", label: "応募アカウント", type: "select", required: true, ref: "service_accounts" },
      { name: "requirement_id", label: "応募条件（同じ系列のもの）", type: "select", required: true, ref: "chain_requirements" },
      {
        name: "state",
        label: "資格の状態",
        type: "select",
        required: true,
        default: "unknown",
        options: [
          { value: "eligible", label: "満たしている" },
          { value: "ineligible", label: "満たしていない" },
          { value: "unknown", label: "未確認" },
        ],
      },
      { name: "verified_on", label: "確認日（任意）", type: "date" },
      { name: "valid_from", label: "有効開始日（任意）", type: "date" },
      { name: "valid_until", label: "有効期限（任意。過ぎると要確認になります）", type: "date" },
      { name: "memo", label: "メモ", type: "text", max: 1000 },
    ],
  },
  eligibility_purchases: {
    key: "eligibility_purchases",
    label: "購入実績（資格用）",
    retire: "archived_at",
    titleField: "service_account_id",
    titleFields: ["service_account_id", "purchased_on"],
    subFields: ["store_id", "amount_yen", "counts_until"],
    fields: [
      { name: "service_account_id", label: "応募アカウント", type: "select", required: true, ref: "service_accounts" },
      { name: "store_id", label: "店舗（任意）", type: "select", ref: "stores", optionalRef: true },
      { name: "purchased_on", label: "購入日（不明なら空欄）", type: "date" },
      { name: "amount_yen", label: "金額・円（不明なら空欄）", type: "number", min: 0, max: 100000000, step: 1 },
      { name: "quantity", label: "数量（任意）", type: "number", min: 1, max: 9999, step: 1 },
      { name: "counts_until", label: "この実績が有効な期限（任意）", type: "date" },
      { name: "note", label: "メモ", type: "text", max: 500 },
    ],
  },
};

/** 略称の正規化（全角半角・大小文字・空白の揺れを吸収）。一致しても自動確定には使わない。 */
export function normalizeAlias(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);

/** フィールド定義から入力検証スキーマを作る。任意項目の空欄は text=空文字 / number・date=null。 */
export function buildSchema(entity: Entity) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of entity.fields) {
    let s: z.ZodType;
    switch (f.type) {
      case "number": {
        let n = z.number({ error: `${f.label}は数値で入力してください` });
        if (f.step === 1) n = n.int();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        s = f.required ? z.preprocess((v) => (v === "" ? undefined : Number(v)), n) : z.preprocess((v) => (v === "" || v == null ? null : Number(v)), n.nullable());
        break;
      }
      case "date":
        s = z.preprocess(emptyToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が正しくありません").nullable());
        break;
      case "select":
        s = f.ref
          ? f.optionalRef
            ? z.preprocess(emptyToNull, z.uuid("選択してください").nullable())
            : z.uuid("選択してください")
          : z.enum(f.options!.map((o) => o.value) as [string, ...string[]], "選択してください");
        break;
      default: {
        const t = z.string().trim().max(f.max ?? 200, `${f.label}は${f.max ?? 200}文字以内で入力してください`);
        s = f.required ? t.min(1, `${f.label}を入力してください`) : t;
      }
    }
    shape[f.name] = s;
  }
  return z.object(shape).strict();
}

/** 商品コードのみ「空欄=NULL」（一意制約のため空文字を避ける） */
export function toDbValues(entity: Entity, values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values };
  if (entity.key === "products" && out.product_code === "") out.product_code = null;
  if (entity.key === "product_aliases") out.normalized_alias = normalizeAlias(String(out.alias));
  return out;
}
