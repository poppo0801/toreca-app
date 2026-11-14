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
}
export interface InvestigationSignals {
  today: string;
  releases: ReleaseSignal[];
  chains: ChainSignal[];
  missing: MissingInfoSignal[];
  failed: FailedSourceSignal[];
  monitors: MonitorSignal[];
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
}

export interface PlanOutput {
  tasks: PlannedTask[];
  findings: Finding[];
  summary: string;
}

/** 調査の外部アクセスを担う部品（読み取りのみ）。テストでは架空の世界、本番相当では制限つきの実装を差し込む */
export interface PlannerWorld {
  signals(): Promise<InvestigationSignals>;
  /** 公開ページの取得。許可されない（robots・ログイン・頻度制限）ときは ok=false と理由 */
  fetchPage(url: string): Promise<{ ok: boolean; title?: string; text?: string; links?: { url: string; text: string }[]; reason?: string }>;
  /** 公開検索（有料API・未承認のときは未設定にする）。未設定なら検索ツールは登録されない */
  search?(query: string): Promise<{ title: string; url: string; snippet: string }[]>;
  /** 投稿画像の読み取り（画像の文字起こし。外部AIを使う場合は費用が発生するため承認制） */
  readImage?(url: string): Promise<{ text: string }>;
  /** 登録済みの抽選との照合（読み取りのみ） */
  matchExisting(q: { chainName?: string; productName?: string; url?: string }): Promise<{ lotteryId: string; chainName: string; storeName: string; products: string[]; sourceUrls: string[] }[]>;
}
