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
  /** 自由な色指定（#RRGGBB）。あれば color より優先 */
  colorHex?: string | null;
  /** 丸アイコン内に表示する1文字（色だけに依存しない） */
  initial: string;
  /** アイコンのマーク（"initial" = 頭文字。それ以外は ICON_MARKS のキー） */
  iconMark?: string;
  /** 通知の送り先プロフィールID。null/未指定=本人のみ、空配列=通知なし */
  notifyRecipientIds?: string[] | null;
  /**
   * 許可リスト方式（Cなど）。許可された系列(allowedChainIds)または店舗(allowedStoreIds)のみが対象。
   * どちらも空/nullなら全系列が対象。
   */
  allowedChainIds: string[] | null;
  allowedStoreIds: string[];
  /** 許可リストとは別の除外設定（A/B向け）。常に対象外 */
  blockedChainIds: string[];
  blockedStoreIds: string[];
}

export interface Chain {
  id: string;
  name: string;
  /** 抽選登録時に自動作成された仮登録（後からマスター管理で補完） */
  provisional?: boolean;
  /** アーカイブ済み（新規登録の選択肢から外す。履歴表示には残す） */
  archived?: boolean;
}

export interface Store {
  id: string;
  chainId: string;
  name: string;
  prefecture: string;
  provisional?: boolean;
  archived?: boolean;
}

export interface Product {
  id: string;
  officialName: string;
  aliases: string[];
  code: string;
  /** 商品ごとの入数。固定30Pと決めつけない（仮登録の商品では未確認） */
  packsPerBox: number;
  provisional?: boolean;
  /** 定価（円）。収支入力の金額仮計算に使う。未設定は null */
  listPriceBox?: number | null;
  listPricePack?: number | null;
  /** 公式番号か独自コードか */
  codeKind?: "official" | "custom" | null;
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

/** single=単一 / all=商品ごとに当落 / one_win=当選は最大1商品 / choose_one=希望商品を1つ選んで応募 */
export type MultiMode = "single" | "all" | "one_win" | "choose_one";

export interface LotteryItem {
  /** DB上の明細ID（新規入力中は未設定） */
  id?: string;
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
  multiMode: MultiMode;
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
  /** 集計値。複数商品では商品別の当落から導出（1つでも当選=won） */
  result: ResultStatus;
  /** 複数商品抽選の商品別当落（明細ID → 結果）。single では空 */
  itemResults: Record<string, ResultStatus>;
  /** choose_one で応募時に選んだ明細ID */
  selectedItemId: string | null;
  resultConfirmedAt: string | null;
  fulfillment: FulfillmentStatus;
  createdAt: string;
}

export type PurchaseChannel = "store" | "shipping" | "online" | "other";

export interface PurchaseItem {
  /** DB上の明細ID（新規入力中は未設定） */
  id?: string;
  productId: string | null;
  /** マスター未登録の商品名（自由入力） */
  productLabel?: string | null;
  lotteryItemId?: string | null;
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
  /** マスター未登録の店舗名（自由入力） */
  storeLabel?: string | null;
  /** 購入日時。日付のみ・不明を区別する（捏造しない） */
  purchasedOn: FlexibleDate;
  channel: PurchaseChannel;
  source: "lottery" | "manual" | "import";
  items: PurchaseItem[];
  note: string;
}

/** 売却(収入)。原価 costAmount=null は未設定で、0円とはみなさない。 */
export interface Sale {
  id: string;
  soldOn: string;
  platform: string;
  productId: string | null;
  productLabel: string | null;
  quantity: number;
  unit: "box" | "pack" | "set" | "piece";
  amount: number;
  /** 売却手続きを行った人（所得帰属ではない） */
  sellerProfileId: string;
  costAmount: number | null;
  costPurchaseItemId: string | null;
  costQuantity: number | null;
  fee: number;
  shipping: number;
  memo: string;
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
  /** 受付期間外（受付前・受付終了・中止）。対象外とは区別する */
  | "unavailable"
  | "needs_review";

export type LimitScope = "chain" | "campaign" | "lottery";

/** 応募制限ルール。同じ (basis, across) は 抽選固有 > キャンペーン > 系列標準 で上書き、異なるものは併用。 */
export interface ApplicationRule {
  id: string;
  scope: LimitScope;
  scopeId: string;
  basis: Exclude<LimitBasis, "unknown">;
  maxCount: number;
  /** campaign = 同時開催キャンペーン内の全店舗を通算 */
  across: "lottery" | "campaign";
  /** unconfirmed は規約未確認。枠が埋まっていなければ「要確認」にする */
  confidence: "confirmed" | "unconfirmed";
}

/** 規約確認済みの手動例外: 指定アカウントはその抽選の応募制限の対象外 */
export interface LimitExemption {
  lotteryId: string;
  accountId: string;
  reason: string;
}

export type RequirementKind = "membership" | "point_card" | "purchase_history" | "id_verification" | "other";

/** 系列の応募条件（会員登録・ポイントカード・購入履歴条件など） */
export interface ChainRequirement {
  id: string;
  chainId: string;
  kind: RequirementKind;
  label: string;
  validMonths: number | null;
}

/** 応募アカウントごとの資格状態。valid_until を過ぎたものは要確認扱い */
export interface AccountEligibility {
  id: string;
  accountId: string;
  requirementId: string;
  state: MembershipState;
  verifiedOn: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

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
  sales: Sale[];
  skipRules: SkipRule[];
  applicationRules: ApplicationRule[];
  limitExemptions: LimitExemption[];
  requirements: ChainRequirement[];
  eligibilities: AccountEligibility[];
  audit: AuditEntry[];
}
