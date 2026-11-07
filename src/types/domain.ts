/**
 * ドメイン型。database-schema.md の設計草案を、docs/db-review.md の修正案を反映して型にしたもの。
 * Stage 1 で Supabase に接続する際も、この型を境界（services/）の入出力として使う。
 */
import type { CardDisplay } from "@/lib/card-display";
import type { AnnounceMethod, AnnounceTarget, RequirementDetails, RequirementLogic, RequirementTag, StoreKind } from "@/lib/lottery-taxonomy";

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

/** normal=通常抽選 / ongoing=継続抽選（応募後も継続。ノジマオンライン等） / invite=招待制販売（商品別リクエスト。Amazon等） */
export type LotteryKind = "normal" | "ongoing" | "invite";

export type ReceiveMethod = "store" | "shipping" | "either" | "unknown";
export type ApplyMethod = "web" | "store" | "app" | "unknown";
/** 数量の単位。box/pack は拡張パック、piece(個) は構築済みデッキ・プレミアムセット・その他。set(セット)は旧データの単位で、変換せずそのまま扱う */
export type ItemUnit = "box" | "pack" | "set" | "piece";
/** 購入・売却の数量単位（抽選の商品明細と同じ） */
export type PurchaseUnit = ItemUnit;
/** 商品区分。未分類(null)は推測で分類しない */
export type ProductKind = "expansion_pack" | "deck" | "premium_set" | "other";
/** BOXの販売形態の目安（抽選に応募するかの参考。実際の受取状態ではない）。未設定・unknown は「不明・未設定」 */
export type BoxShrinkHint = "shrink" | "no_shrink" | "pack_only" | "unknown";
/** 受取時の実際のシュリンク状態 */
export type ShrinkState = "shrink" | "no_shrink" | "unknown";
export type SourceKind = "manual" | "x_parse" | "auto" | "import";

export type ProfileColor = "blue" | "green" | "purple" | "pink" | "teal";

export interface Profile {
  id: string;
  /** 無効化されたプロフィールは切替対象から外す（履歴表示には残す）。未指定=有効 */
  active?: boolean;
  label: string;
  /** メイン=全系列を表示・操作 / サブ=対象系列（allowedChainIds）の抽選だけ。未指定=メイン */
  kind?: "main" | "sub";
  /** サブの紐づけ先メインユーザーのID（Stage 6J）。メインの応募済み・当選タブに、紐づくサブの履歴も表示する。未紐づけ・メインは null */
  linkedMainId?: string | null;
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
  /** 別表記（「Joshin」「ジョーシン」など）。照合に使う。一致しても利用者が確認する */
  aliases?: string[];
  /** 抽選登録時に自動作成された仮登録（後からマスター管理で補完） */
  provisional?: boolean;
  /** アーカイブ済み（新規登録の選択肢から外す。履歴表示には残す） */
  archived?: boolean;
  /** 系列ロゴの表示URL（正方形の画像。未登録は null/未設定）。所属する全店舗で共通に使う */
  logoSrc?: string | null;
  /** 共通ブランド（例: カードボックス）。直営/その他で系列を分けても、同じブランドとして関係を保持する */
  brandGroup?: string | null;
  /** 運営区分: direct=直営 / other=その他 / unconfirmed=所属未確認 / 未設定=区分なし */
  operationKind?: "direct" | "other" | "unconfirmed" | null;
  /** BOX販売形態の目安（系列ごと。抽選に応募するかの参考で、実際の受取状態ではない）。未設定は null */
  boxShrinkHint?: BoxShrinkHint | null;
}

export interface Store {
  id: string;
  chainId: string;
  name: string;
  aliases?: string[];
  prefecture: string;
  provisional?: boolean;
  archived?: boolean;
  /** 店舗の住所・位置（緯度経度は内部情報で画面には出さない）。不明は null/未設定 */
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** 往復交通費（円）。手動登録のみ。未設定は null（0円とはみなさない） */
  roundTripFare?: number | null;
  memo?: string | null;
  /** 営業形態。未設定は実店舗。オンライン専用店舗には都道府県・距離を出さない */
  salesKind?: StoreKind;
}

/** 世帯共通の設定。自宅の位置は内部情報（住所の文字列はこの型に含めず、設定画面でだけ読む） */
export interface HouseholdSettings {
  homeLat: number | null;
  homeLng: number | null;
  /** 抽選カードに表示する項目 */
  cardDisplay: CardDisplay;
  /** 距離区分の上限（km, 昇順4つ） */
  distanceBandsKm: number[];
  /** AIの月間予算（円） */
  aiMonthlyBudgetJpy: number;
  /** 自動AI解析（Stage 4C）を許可するか。予算超過時に止めるための構造 */
  autoAiEnabled: boolean;
  /** 自宅の位置が変わったため、店舗の往復交通費の見直しが必要 */
  travelReviewNeeded: boolean;
}

export interface Product {
  id: string;
  officialName: string;
  aliases: string[];
  code: string;
  /** 商品ごとの入数。固定30Pと決めつけない（仮登録・単品/セット商品では未設定=null） */
  packsPerBox: number | null;
  /** 単品・セット定価（円） */
  listPriceUnit?: number | null;
  memo?: string | null;
  sourceUrl?: string | null;
  /** pack_box=パック/BOX販売 / single_set=単品・セット等 / null=未判定 */
  salesForm?: "pack_box" | "single_set" | null;
  /** 商品区分。未分類は null（数量の単位は拡張パック扱いのパック/BOXから選べる） */
  productKind?: ProductKind | null;
  /** 商品画像（表示用の期限付きURL）。無い種類は未設定 → プレースホルダー */
  images?: Partial<Record<ProductImageKind, ProductImage>>;
  provisional?: boolean;
  /** 定価（円）。収支入力の金額仮計算に使う。未設定は null */
  listPriceBox?: number | null;
  listPricePack?: number | null;
  /** 公式番号か独自コードか */
  codeKind?: "official" | "custom" | null;
  archived?: boolean;
}

export type ProductImageKind = "box" | "pack" | "unit";

export interface ProductImage {
  /** 元画像の表示用URL。Storageは非公開のため、ログイン中の本人だけが取得できるアプリのURL（内容ハッシュ入りで長期キャッシュされる） */
  url: string;
  /** 一覧・カード用の軽量サムネイル（WebP）のURL。未作成なら省略（urlを使う） */
  thumbUrl?: string;
  width: number | null;
  height: number | null;
  /** import=Excel/画像の一括取り込み / manual=アプリで手動アップロード（再取り込みで上書きしない） */
  source: "import" | "manual";
  /** 表示の倍率（1=等倍）と位置のずれ（%、-50〜50）。元画像は変えず、表示時だけ適用する */
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  /** 透明な余白を除いた表示範囲（元画像のピクセル座標）。未計算・余白なしは省略 */
  contentBox?: { x: number; y: number; w: number; h: number } | null;
}

/** セット商品と構成商品（構造のみ。購入の数量・金額には加算しない） */
export interface ProductSetItem {
  id: string;
  setProductId: string;
  componentProductId: string;
  quantity: number;
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
  /** この抽選のBOX販売形態（確定している場合のみ。あれば系列の目安より優先） */
  boxShrinkHint?: BoxShrinkHint | null;
  /** 店舗の指定方式（Stage 6N）。未設定は店舗固定 */
  storeMode?: "fixed" | "select_on_apply" | "none";
  /** 応募時に選べる店舗（取得できたときだけ） */
  selectableStores?: { name: string; prefecture: string }[];
  campaignId?: string;
  chainId: string;
  storeId: string | null;
  items: LotteryItem[];
  multiMode: MultiMode;
  applyStart: FlexibleDate;
  applyDeadline: FlexibleDate;
  /** 当選発表の開始（単一日の発表はこれだけ）。時刻つきの場合も保持する */
  resultDate: FlexibleDate;
  /** 当選発表の最終日（YYYY-MM-DD、JST）。期間指定でなければ未設定。開始日以降 */
  resultEndDate?: string;
  /** 購入手続き／受取期限 */
  /** 購入・受取の開始（不明なら unknown）。終了は procedureDeadline */
  procedureStart: FlexibleDate;
  procedureDeadline: FlexibleDate;
  /** 購入期間と受取期間を分けるか。true のとき procedure* は購入手続きの期間、receive* が店舗受取の期間。false/未設定は従来どおり購入・受取が同じ期間 */
  procedureSplit?: boolean;
  receiveStart?: FlexibleDate;
  receiveDeadline?: FlexibleDate;
  /** 抽選方式。未設定は通常抽選 */
  kind?: LotteryKind;
  /** 継続・招待の有効期限（YYYY-MM-DD）。告知にあるときだけ。無期限とは仮定しない */
  validUntil?: string;
  receiveMethod: ReceiveMethod;
  applyMethod: ApplyMethod;
  conditionsText: string;
  verificationText: string;
  /** 当落発表方法の補足・原文（標準分類は announcementMethods） */
  announcementMethod: string;
  /** 当落発表方法（標準分類・複数）。未設定の既存データは空 */
  announcementMethods?: AnnounceMethod[];
  announcementTarget?: AnnounceTarget;
  /** サービス標準ルール（LivePocketなど）による推定。告知に明記された内容ではない */
  announcementInferred?: boolean;
  announcementUrl?: string;
  /** 応募条件の標準分類（複数）。補足・原文は conditionsText */
  requirementTags?: RequirementTag[];
  requirementLogic?: RequirementLogic;
  requirementDetails?: RequirementDetails;
  sourceUrls: string[];
  eventState: EventState;
  limit: ApplicationLimit;
  sourceKind: SourceKind;
  /** 登録経路: manual=手動 / manual_ai=AIを利用した手動 / auto=自動収集（未確認） / auto_confirmed=自動収集後にユーザーが確認 */
  registrationPath?: "manual" | "manual_ai" | "auto" | "auto_confirmed";
  /** 利用者が内容を確認した日時（確認した履歴であり、内容の正確性を保証するものではない） */
  confirmedAt?: string | null;
  /** AI/自動登録の確認済みフラグ。NEWバッジに使う */
  isNew: boolean;
  memo: string;
  createdAt: string;
  /** 初期値のまま保存された（確認していない）項目名。ユーザーが選び直すと外れる */
  unconfirmedFields?: string[];
  /** 最終更新（他端末での更新を検出するため）。モックでは未設定 */
  updatedAt?: string;
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
  /** 応募した店舗（店舗選択式の抽選・Stage 6N）。プロフィール（応募アカウント）ごとに独立。未設定は null */
  appliedStore?: { id: string | null; name: string; prefecture: string } | null;
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
  unit: PurchaseUnit;
  /** 不明は null（捏造しない） */
  amountPaid: number | null;
}

/** 購入履歴。当選からの購入は applicationId で一意（二重生成禁止）。抽選外の購入は applicationId = null。 */
export interface Purchase {
  id: string;
  applicationId: string | null;
  /** 系列（Stage 6N）。店舗なしの購入は系列のみ。未設定の旧データは店舗の系列から判断する */
  chainId?: string | null;
  storeId: string | null;
  /** マスター未登録の店舗名（自由入力） */
  storeLabel?: string | null;
  /** 購入日時。日付のみ・不明を区別する（捏造しない） */
  purchasedOn: FlexibleDate;
  channel: PurchaseChannel;
  source: "lottery" | "manual" | "import";
  /** 抽選外の購入を記録したプロフィール（資格判定の購入者。抽選からの購入は応募アカウントのプロフィール） */
  buyerProfileId?: string | null;
  /** 品目区分（pokemon_card / goods / expense …。未設定はポケモンカード。Stage 6K） */
  category?: string;
  items: PurchaseItem[];
  note: string;
}

/** 売却(収入)。原価 costAmount=null は未設定で、0円とはみなさない。 */
export interface Sale {
  id: string;
  /** BOXの売却で減らす在庫の状態（Stage 6M）。null/未設定は在庫に反映しない */
  boxState?: ShrinkState | null;
  soldOn: string;
  platform: string;
  productId: string | null;
  productLabel: string | null;
  quantity: number;
  unit: PurchaseUnit;
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
  /** セット商品の構成（未設定のデータ・モックでは省略） */
  productSetItems?: ProductSetItem[];
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
  /** プロフィール別の設定（下部メニュー・カード表示など）。プロフィールID → 設定。未設定は省略 */
  profileSettings?: Record<string, import("@/lib/profile-settings").ProfileSettings>;
  /** 世帯設定（カード表示項目・自宅の位置など）。未設定のデータ・モックでは省略 */
  settings?: HouseholdSettings;
  /** 対戦記録（Stage 5A）。モックでは省略 */
  battles?: BattleRecord[];
  /** 系列別の抽選条件（Stage 5R）と、プロフィール別の達成状況。未適用の環境・モックでは省略 */
  chainConditions?: import("@/lib/chain-conditions").ChainCondition[];
  chainConditionStates?: import("@/lib/chain-conditions").ConditionState[];
}

export type BattleResult = "win" | "lose" | "draw";

/** 対戦記録。収支・抽選とは独立した記録 */
export interface BattleRecord {
  id: string;
  playedOn: string;
  /** 使用した人（任意） */
  profileId: string | null;
  myDeck: string;
  opponent: string;
  opponentDeck: string;
  result: BattleResult;
  /** 先攻・後攻など。不明は空 */
  turnOrder: "first" | "second" | "";
  format: string;
  memo: string;
}
