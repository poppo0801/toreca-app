/**
 * 自律探索エンジン（Stage 9H-3P）の型。AIが「何を・どこで・どう調べるか」を選び、固定ロジックは検証・上限・保存だけを担う。
 * このモジュールはDBに書き込まない（読み取りの部品 DiscoveryWorld を通して世界を見るだけ）。登録・更新は、結果を受け取る別の層が既存の登録経路で行う。
 */

/** 調査の起点（ミッション）。「何を調べるか」の入口であり、店舗名・検索語・調査順序は含まない（それはAIが選ぶ） */
export interface DiscoveryMission {
  id: string;
  trigger: {
    /** product=新商品の発売／lottery=見つかった抽選の周辺／chain=系列の網羅確認 */
    kind: "product" | "lottery" | "chain";
    product?: string;
    chain?: string;
    /** 起点の抽選の店舗（lottery のとき。参考情報。ここ以外の店舗も探索対象） */
    store?: string;
    /** 起点の告知URL（取得できないことがある。その場合はAIが別の情報源を探す） */
    sourceUrl?: string;
    note?: string;
  };
  /** 収集の対象地域（都道府県。空なら制限なし） */
  targetPrefectures: string[];
  today: string;
  /** 参考情報（過去の傾向・人間の判断など。事実の確定ではない） */
  context: string[];
}

/** 既存の収集・手動登録がすでに持っている抽選（読み取り）。AI自身の発見実績とは区別する */
export interface ExistingLottery {
  lotteryId: string;
  chain: string;
  store: string;
  products: string[];
  sourceUrls: string[];
  /** 出どころ。legacy_collection=従来の収集／manual=手動登録／ai_discovery=過去の自律探索 */
  origin: "legacy_collection" | "manual" | "ai_discovery" | "unknown";
  /** 人間が確認・修正した情報を含む（自動で上書きしない） */
  humanConfirmed: boolean;
  applyStart?: string | null;
  applyDeadline?: string | null;
}

export interface KnownStore {
  name: string;
  prefecture?: string | null;
  address?: string | null;
}

/** 探索が外の世界・既存データを見るための部品（読み取りのみ）。テストでは架空の世界を差し込む */
export interface DiscoveryWorld {
  fetchPage(url: string): Promise<{ ok: boolean; title?: string; text?: string; links?: { url: string; text: string }[]; reason?: string }>;
  /** 公開検索（有料。未承認なら未設定。未設定なら検索ツールは登録されない） */
  search?(query: string): Promise<{ title: string; url: string; snippet: string }[]>;
  lastSearchCostJpy?(): number;
  existing(q: { chain?: string; store?: string; product?: string; url?: string }): Promise<ExistingLottery[]>;
  /** 店舗マスターの店舗（系列ごと）。公式の店舗一覧との突き合わせに使う */
  knownStores(chain: string): Promise<KnownStore[]>;
  chainOfficialUrl?(chain: string): Promise<string | null>;
}

/** AIが報告する「抽選の手がかり」。決めるのは検証層（verify.ts） */
export interface LeadInput {
  chain: string;
  /** 店舗名。店舗選択式（応募時に選ぶ）や店舗不明なら省略 */
  store?: string;
  /** store_specific=その店舗だけの抽選／chain_common=系列共通の告知／store_select=応募時に店舗を選ぶ形式 */
  scope: "store_specific" | "chain_common" | "store_select";
  products: string[];
  applyStart?: string;
  applyDeadline?: string;
  /** 根拠になったページのURL（取得したものだけ）と、そのページにある原文の抜粋 */
  url: string;
  quote: string;
  /** 店舗の都道府県（ページに書かれているとき） */
  statedPrefecture?: string;
  /** 他店舗にも広げた理由・この手がかりを見つけた経緯（調査履歴に残る） */
  reason?: string;
}

export type LeadStatus = "adopt" | "hold" | "exclude";
export type ExclusionKind = "evidence_missing" | "region_out" | "duplicate_in_run" | "already_collected" | "not_a_lottery" | "protected_human";
export interface LeadDecision {
  status: LeadStatus;
  /** 採用・保留・除外の理由（人間が読める。検証層が書く） */
  reason: string;
  exclusion?: ExclusionKind;
  /** 要確認の項目（不確実な情報は確定しない） */
  attention: string[];
  /** 既存の収集・手動登録との重複・差分 */
  overlap: { kind: "none" | "same_lottery" | "same_chain_product_other_store"; existing: { lotteryId: string; origin: ExistingLottery["origin"]; humanConfirmed: boolean }[] };
  /** AI自身の新規発見として数えるか（既存が先に持っていたものは数えない） */
  credit: "ai_new" | "already_known" | "none";
  region: { verdict: "in" | "out" | "unknown"; prefecture: string; basis: string };
  /** 系列共通の情報と、店舗固有の情報を分けて保持する（混同しない） */
  fields: { chainCommon: { products: string[]; applyStart?: string; applyDeadline?: string }; storeSpecific: { store?: string; url: string; selectMode: boolean } };
}
export interface RecordedLead {
  lead: LeadInput;
  decision: LeadDecision;
  /** 何番目の調査ステップで見つけたか */
  atStep: number;
}

export type FinishReason = "sufficient" | "no_improvement" | "cannot_continue";
export type StopReason = FinishReason | "step_limit" | "fetch_limit" | "search_limit" | "cost_limit" | "time_limit" | "duplicates" | "llm_failure" | "no_finish" | "diminishing_returns" | "session_budget";

export interface FocusDeclaration {
  /** 調べる対象の種類（系列・店舗群・商品・情報源）と、それを選んだ理由 */
  target: string;
  reason: string;
  atStep: number;
}
export interface SourceUse {
  url: string;
  host: string;
  ok: boolean;
  /** 取得の経緯: seed=起点／search=検索結果／link=ページ内のリンク／registered=登録済み／official_site=系列の公式 */
  provenance: "seed" | "search" | "link" | "registered" | "official_site" | "unknown";
  failReason?: string;
  atStep: number;
}
export interface FollowUp {
  atStep: number;
  action: "search" | "fetch" | "list_stores" | "lookup" | "region_check";
  input: string;
  /** なぜ次にそれをしたか（AIが宣言した理由。無ければ空） */
  because: string;
  outcome: string;
}
