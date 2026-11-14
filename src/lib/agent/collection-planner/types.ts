/**
 * 自律型の情報収集計画（Stage 9C）。AIが「何を調べるか」を選び、結果を見て次の調査を決める。
 * AIが使えるのは読み取り専用の調査ツールだけ（データの変更・投稿・外部への書き込みはできない）。費用・回数・アクセス頻度は独立した制限で管理する。
 * AIの提案は「調査計画・発見」であり、監視対象の追加・抽選の登録はしない（人または既存の登録処理が、検証を経て行う）。
 */

/** 調査の動機（AIが選ぶ入力）。固定の優先順位ではなく、AIが状況を見て選ぶ */
export type TaskKind = "release_followup" | "unmonitored_chain" | "missing_info" | "failed_source" | "discover_account" | "verify_candidate";

export interface ReleaseSignal {
  productId: string;
  name: string;
  /** 発売日（YYYY-MM-DD） */
  releaseDate: string;
  /** その商品の抽選が既に登録されている系列の数 */
  chainsWithLottery: number;
}
export interface ChainSignal {
  id: string;
  name: string;
  storeCount: number;
  lotteries30d: number;
  monitored: boolean;
  /** 公式サイトのURL（マスターにあるときだけ） */
  officialUrl?: string;
}
export interface MissingInfoSignal {
  lotteryId: string;
  chainName: string;
  storeName: string;
  missing: string[];
  sourceUrl: string;
}
export interface FailedSourceSignal {
  sourceId: string;
  name: string;
  url: string;
  failKind: string;
  failures: number;
}
export interface MonitorSignal {
  sourceId: string;
  name: string;
  kind: "x" | "web";
  lastNewCount: number | null;
  lastSuccessAt: string | null;
  /** 監視しているURL（Webのみ。Xはアカウントページ） */
  url?: string;
}
/** 前回までの調査の成果（情報源ごと）。次回の調査対象・方法の調整に使う（情報であり、制限は変えられない） */
export interface PreviousRunSignal {
  host: string;
  attempts: number;
  failures: number;
  /** 直近の失敗の種類（robots など。回避せず、しばらく避ける判断に使う） */
  lastFailKind?: string;
  /** その情報源から見つかった抽選候補の累計 */
  yielded: number;
}
export interface InvestigationSignals {
  today: string;
  releases: ReleaseSignal[];
  chains: ChainSignal[];
  missing: MissingInfoSignal[];
  failed: FailedSourceSignal[];
  monitors: MonitorSignal[];
  /** 前回までの調査の成果（情報源のホストごと） */
  previous?: PreviousRunSignal[];
  /** 直近の抽選の発見状況（件数） */
  discovery: { found7d: number; registered7d: number; held7d: number };
}

/** AIが提出する調査計画の1項目（検証層が許可された範囲かを確認する） */
export interface PlannedTask {
  kind: TaskKind;
  targetId: string;
  /** 調べる情報源（http/https の公開URL。ログイン不要のものだけ） */
  url?: string;
  tool: string;
  reason: string;
}

/** 調査で見つけたもの（提案）。監視対象の追加・登録は行わない */
export interface Finding {
  kind: "monitor_candidate" | "source_url" | "lottery_info" | "stop_retry";
  targetId: string;
  title: string;
  url?: string;
  /** 根拠（取得した文面の抜粋・一致した名称など）。AIの自己評価は含めない */
  evidence: string;
  official: boolean;
  /** AIが読み取ったページの種類（Stage 9E。検証層は固定ロジックの判定と照合する。食い違いは記録する） */
  pageKind?: "lottery_announcement" | "announcement_index" | "lottery_explainer" | "past_lottery" | "general";
  /** AIの判断: 新規・補完・更新・重複・追加調査・抽選ではない（AIの自己申告。登録の可否は検証層が決める） */
  action?: "new" | "complete" | "update" | "duplicate" | "investigate" | "not_lottery";
}

export interface PlanOutput {
  tasks: PlannedTask[];
  findings: Finding[];
  summary: string;
}

/** 取得したページ（調査の根拠・解析の入力。全文は保存せず、要点だけを記録に残す） */
export interface PageData {
  url: string;
  title: string;
  text: string;
  links: { url: string; text: string }[];
}

/** 取得したページの解析のプレビュー（登録しない読み取りだけの判定）。新規・補完・更新・重複・追加調査のどれになるかを示す */
export interface AnalysisPreview {
  url: string;
  /** ページの主題の判定（固定ロジック。Stage 9E）。抽選の告知でなければ登録の対象にならない */
  pageKind?: "lottery_announcement" | "announcement_index" | "lottery_explainer" | "past_lottery" | "general";
  pageKindReason?: string;
  /** 解析エンジン（AI）が抽選の告知と判断したか。pageKind と食い違う場合は、登録せず追加調査にする */
  aiJudgedLottery?: boolean;
  recognized: boolean;
  chainName: string;
  storeName: string;
  products: string[];
  /** 応募締切（YYYY-MM-DD。不明なら null。推測しない） */
  applyDeadline: string | null;
  /** 不足している項目（調べても分からなければ、不明のまま保持する） */
  missing: string[];
  disposition: { kind: "new" | "complete" | "update" | "duplicate" | "investigate"; targetLotteryId: string | null; reason: string };
  /** 登録の安全条件を満たすか（開発環境の自動登録の可否）。満たさない理由は blockers */
  registrable: boolean;
  blockers: string[];
  /** 解析の費用（円。モックは0） */
  costJpy: number;
}

/** 調査の外部アクセスを担う部品（読み取りのみ）。テストでは架空の世界、本番相当では制限つきの実装を差し込む */
export interface PlannerWorld {
  signals(): Promise<InvestigationSignals>;
  /** 公開ページの取得。許可されない（robots・ログイン・頻度制限）ときは ok=false と理由 */
  fetchPage(url: string): Promise<{ ok: boolean; title?: string; text?: string; links?: { url: string; text: string }[]; reason?: string; /** 告知日時・更新日時（取得できたとき。Stage 9H） */ publishedAt?: string }>;
  /** 公開検索（有料API・未承認のときは未設定にする）。未設定なら検索ツールは登録されない */
  search?(query: string): Promise<{ title: string; url: string; snippet: string }[]>;
  /** 直前の検索の費用（円。実検索のときだけ。Stage 9H-2。調査の費用の上限に数える） */
  lastSearchCostJpy?(): number;
  /** 投稿画像の読み取り（画像の文字起こし。外部AIを使う場合は費用が発生するため承認制） */
  readImage?(url: string): Promise<{ text: string }>;
  /** 取得したページの解析プレビュー（読み取りのみ。解析エンジンが設定されているときだけ登録される） */
  analyze?(page: PageData): Promise<AnalysisPreview>;
  /** 登録済みの抽選との照合（読み取りのみ） */
  matchExisting(q: { chainName?: string; productName?: string; url?: string }): Promise<{ lotteryId: string; chainName: string; storeName: string; products: string[]; sourceUrls: string[] }[]>;
}
