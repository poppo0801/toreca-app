/**
 * ドメイン型。database-schema.md の設計草案を、docs/db-review.md の修正案を反映して型にしたもの。
 * Stage 1 で Supabase に接続する際も、この型を境界（services/）の入出力として使う。
 */

/** 日時の精度。「日付だけ判明」を0時のtimestampに偽変換しないために分離する。 */
export type DatePrecision = "unknown" | "date_only" | "date_time";

export type FlexibleDate =
  | { precision: "unknown" }
  /** date は JST の暦日 (YYYY-MM-DD) */
  | { precision: "date_only"; date: string }
  /** at は UTC の ISO 文字列 */
  | { precision: "date_time"; at: string };

/** 抽選イベント自体の状態。個別の当落とは分離する。 */
export type EventState = "before" | "open" | "closed" | "cancelled" | "postponed";

export type ReceiveMethod = "store" | "shipping" | "either" | "unknown";
export type ApplyMethod = "web" | "store" | "app" | "unknown";
export type ItemUnit = "box" | "pack" | "set";
export type SourceKind = "manual" | "x_parse" | "auto" | "import";

export type ProfileColor = "blue" | "green" | "purple" | "pink" | "teal";

export interface Profile {
  id: string;
  /** 無効化されたプロフィールは切替対象から外す（履歴表示には残す）。未指定=有効 */
  active?: boolean;
  label: string;
  color: ProfileColor;
  /** 丸アイコン内に表示する1文字（色だけに依存しない） */
  initial: string;
  /** null = すべての系列が対象。配列 = 許可リスト方式（Cなど） */
  allowedChainIds: string[] | null;
  /** 許可リストとは別の除外設定（A/B向け） */
  blockedChainIds: string[];
}

export interface Chain {
  id: string;
  name: string;
  /** アーカイブ済み（新規登録の選択肢から外す。履歴表示には残す） */
  archived?: boolean;
}

export interface Store {
  id: string;
  chainId: string;
  name: string;
  prefecture: string;
  archived?: boolean;
}

export interface Product {
  id: string;
  officialName: string;
  aliases: string[];
  code: string;
  /** 商品ごとの入数。固定30Pと決めつけない */
  packsPerBox: number;
  archived?: boolean;
}

export interface FamilyGroup {
  id: string;
  label: string;
}

/** 応募名義（実際の人物）。プロフィール・サービスアカウントとは別概念。 */
export interface Identity {
  id: string;
  label: string;
  familyGroupId: string;
  addressGroupId: string;
}

export type MembershipState = "eligible" | "ineligible" | "unknown";

/** 系列ごとの応募アカウント。内部プロフィール(Profile)とは別。 */
export interface ServiceAccount {
  id: string;
  profileId: string;
  identityId: string;
  chainId: string;
  label: string;
  membership: MembershipState;
  active: boolean;
}

export type LimitBasis = "account" | "person" | "family" | "address" | "unknown";

export interface ApplicationLimit {
  basis: LimitBasis;
  maxCount: number;
}

export interface Campaign {
  id: string;
  name: string;
  chainId: string;
  /** one_store: 同時開催キャンペーンにつき1店舗まで / multi: 複数店舗可 */
  storeRule: "one_store" | "multi";
}

export interface LotteryItem {
  productId: string;
  quantity: number;
  unit: ItemUnit;
}

export interface Lottery {
  id: string;
  campaignId?: string;
  chainId: string;
  storeId: string;
  items: LotteryItem[];
  applyStart: FlexibleDate;
  applyDeadline: FlexibleDate;
  resultDate: FlexibleDate;
  /** 購入手続き／受取期限 */
  procedureDeadline: FlexibleDate;
  receiveMethod: ReceiveMethod;
  applyMethod: ApplyMethod;
  conditionsText: string;
  verificationText: string;
  announcementMethod: string;
  announcementUrl?: string;
  sourceUrls: string[];
  eventState: EventState;
  limit: ApplicationLimit;
  sourceKind: SourceKind;
  /** AI/自動登録の確認済みフラグ。NEWバッジに使う */
  isNew: boolean;
  memo: string;
  createdAt: string;
}

export interface Management {
  lotteryId: string;
  isManaged: boolean;
  managedSource: "manual" | "ai";
  managedAt?: string;
}

export type ResultStatus = "pending" | "won" | "lost" | "unknown";
export type FulfillmentStatus = "none" | "procedure_done" | "purchased";

/** 応募記録 = 抽選 × サービスアカウント（一意） */
export interface Application {
  id: string;
  lotteryId: string;
  accountId: string;
  /** 実際に応募した日時。不明は null（登録日時 createdAt とは別） */
  appliedAt: string | null;
  state: "applied" | "cancelled";
  result: ResultStatus;
  resultConfirmedAt: string | null;
  fulfillment: FulfillmentStatus;
  createdAt: string;
}

export type PurchaseChannel = "store" | "shipping" | "online" | "other";

export interface PurchaseItem {
  productId: string | null;
  quantity: number;
  unit: ItemUnit;
  /** 不明は null（捏造しない） */
  amountPaid: number | null;
}

/** 購入履歴。当選からの購入は applicationId で一意（二重生成禁止）。抽選外の購入は applicationId = null。 */
export interface Purchase {
  id: string;
  applicationId: string | null;
  storeId: string | null;
  /** 購入日時。日付のみ・不明を区別する（捏造しない） */
  purchasedOn: FlexibleDate;
  channel: PurchaseChannel;
  source: "lottery" | "manual" | "import";
  items: PurchaseItem[];
  note: string;
}

export type SkipScope = "lottery" | "store" | "chain";

/** プロフィール別スルー。他プロフィールへ伝播しない。 */
export interface SkipRule {
  id: string;
  profileId: string;
  scope: SkipScope;
  scopeId: string;
  /** 常時スルーに対する今回だけの例外 */
  exceptionLotteryIds: string[];
}

export interface AuditEntry {
  id: string;
  actorProfileId: string;
  at: string;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
}

/** 状態判定の結果。バッジ・マトリクス・通知・完了率で共通利用する。 */
export type AccountStatus =
  | "applied"
  | "eligible_unapplied"
  | "covered_by_limit"
  | "skipped"
  | "ineligible"
  | "needs_review";

export interface AppData {
  profiles: Profile[];
  chains: Chain[];
  stores: Store[];
  products: Product[];
  familyGroups: FamilyGroup[];
  identities: Identity[];
  accounts: ServiceAccount[];
  campaigns: Campaign[];
  lotteries: Lottery[];
  management: Management[];
  applications: Application[];
  purchases: Purchase[];
  skipRules: SkipRule[];
  audit: AuditEntry[];
}
