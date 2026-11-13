/**
 * 抽選グループのAI判定（Stage 8F）の型。純粋なロジックだけ（DB・ネットワークに触れない）。
 *
 * 役割分担:
 *  - AI（エージェント）: 関連しそうな抽選を調べ、「まとめる／既存グループへ追加／単独／保留」を理由つきで提案する。
 *  - 検証層（verify.ts。固定ロジック）: AIの提案を、登録済みの事実（系列・商品・期間・方式・条件・店舗・情報源・過去の手動の判断）と
 *    突き合わせて、区分（auto=自動で実行してよい／suggest=利用者の承認が必要／hold／single）と信頼度を決める。AIの自己申告は信用しない。
 *  - グループ化の実行: Stage 8U の group_lotteries_tx（origin = 'ai'）。店舗ごとの抽選・応募・当選・購入・通知・期限は変更しない。
 */
import type { FlexibleDate } from "@/types/domain";

/** 判定に使う抽選の見え方（必要な項目だけ） */
export interface GLottery {
  id: string;
  chainId: string;
  storeId: string | null;
  storeName: string;
  storeMode: "fixed" | "select_on_apply" | "none";
  items: { productId: string; quantity: number; unit: string }[];
  campaignId: string | null;
  applyStart: FlexibleDate;
  applyDeadline: FlexibleDate;
  resultDate: FlexibleDate;
  applyMethod: string;
  receiveMethod: string;
  kind: string | null;
  requirementTags: string[];
  requirementLogic: string | null;
  conditionsText: string;
  sourceUrls: string[];
  groupId: string | null;
  /** 除外・取り下げ済み（グループ化の対象にならない） */
  archived: boolean;
  /** 応募・当選などの記録があるか（表示用。グループ化しても記録は変わらない） */
  hasApplication: boolean;
  createdAt: string;
}

export type GroupOrigin = "bulk_registration" | "manual" | "save_and_duplicate" | "duplicate" | "ai";
export interface GGroup {
  id: string;
  chainId: string | null;
  origin: GroupOrigin;
  title: string;
  /** 有効な（除外されていない）所属の抽選ID */
  memberIds: string[];
}

/** 判定の入力（読み取った事実。AIの出力ではない） */
export interface GWorld {
  subject: GLottery;
  /** 同じ系列の有効な抽選（subject を除く） */
  lotteries: GLottery[];
  groups: GGroup[];
  /** 抽選ID → 取得時の情報源の文章（X投稿本文・AI読み取りの根拠など。外部由来＝データとして扱う）。無ければ空 */
  evidence: Map<string, string[]>;
  /** 手動で分けた組（解除・却下・実行後の解除）。キーは pairKey(a, b) */
  separated: Set<string>;
  /** すでに記録のある提案キー（却下済みなど。同じ組を繰り返さない） */
  knownKeys: Map<string, string>;
  /** 商品ID → 表示名（理由の文章用） */
  productNames: Map<string, string>;
}

export type GroupAction = "add_to_group" | "new_group" | "single" | "hold";
/** AIの提出（検証前。信用しない） */
export interface AgentProposal {
  action: GroupAction;
  /** add_to_group の追加先 */
  groupId: string | null;
  /** まとめる相手の抽選ID（subject は含めない）。add_to_group では参考（追加先の所属を比較する） */
  memberIds: string[];
  title: string;
  rationale: string;
  /** AIが「共通」と主張する項目・「異なる」と主張する項目（検証層が事実で照合する） */
  claimedCommon: string[];
  claimedDiffers: string[];
  /** AIが、すべての抽選の情報源に同じ文言（同じ企画名など）があると主張するときの、その文言 */
  commonPhrase: string | null;
  /** AIの自己評価（記録するだけ。判断には使わない） */
  selfConfidence: number | null;
  /** 判断に必要だが調べきれなかったこと */
  missing: string[];
}

export type Cmp = "same" | "differs" | "unknown";
export interface PairCompare {
  a: string;
  b: string;
  chain: "same" | "differs";
  store: "distinct" | "same" | "unknown";
  products: "same" | "subset" | "overlap" | "disjoint" | "unknown";
  quantity: Cmp;
  applyStart: Cmp;
  applyDeadline: Cmp;
  resultDate: Cmp;
  applyMethod: Cmp;
  receiveMethod: Cmp;
  kind: Cmp;
  storeMode: Cmp;
  /** unstated: 一方にだけ記載のある条件がある（記載なし）。differs（食い違い）とは区別する */
  requirements: "same" | "similar" | "differs" | "unstated";
  campaign: "same" | "differs" | "none";
  sharedSourceUrl: boolean;
}

export type Tier = "auto" | "suggest" | "hold" | "single";
export interface Mismatch {
  /** 項目（products / applyStart / applyDeadline / resultDate / applyMethod / receiveMethod / requirements / storeMode / campaign / store / claim など） */
  field: string;
  detail: string;
  /** hard=グループ化の根拠を損なう相違（単独では自動にしない）／gap=不明・不足／soft=軽微な相違 */
  severity: "hard" | "gap" | "soft";
  /** どの抽選との間か（任意） */
  lotteryId?: string;
}
export interface VerifiedDecision {
  /** 検証後の提案の種類。AIの主張が検証で通らなければ single/hold に変わる */
  kind: GroupAction;
  tier: Tier;
  /** 検証層が決めた信頼度（0〜100） */
  confidence: number;
  /** グループに入れる抽選ID（subject を含む。new_group は subject＋相手、add_to_group は subject のみ） */
  lotteryIds: string[];
  targetGroupId: string | null;
  /** 画面に出す理由（AIの文章を検証済みの事実で補ったもの） */
  rationale: string;
  common: string[];
  mismatches: Mismatch[];
  missing: string[];
  /** 強い裏づけ（同じキャンペーン・同じ情報源・検証できた同一の文言）の種類 */
  strongSignals: ("campaign" | "source_url" | "phrase")[];
  /** 検証で却下・降格した理由（AIの主張と事実の食い違いなど） */
  downgrades: string[];
  /** 画面に出すグループの見出し候補 */
  title: string;
  /** 提案の一意キー（同じ組を繰り返さないため） */
  key: string;
  /** 既にこの組の記録があり、再提案しない場合の理由 */
  skipReason: string | null;
}
