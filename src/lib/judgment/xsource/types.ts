/**
 * Stage 10N: 複数の情報源に現れる**同一の抽選（応募機会）**の照合・根拠つき補完のための型。**純関数のみ（DB・ネットワーク・AIには接続しない）**。
 * 方針: 重複として捨てるのではなく、同じ応募機会に関連付けたうえで、**項目（フィールド）ごとに出典・取得日時・原文の範囲・信頼性を保持**して補完・矛盾検出を行う。
 * 補完・訂正は**提案（プレビュー）まで**で、既存の登録（特に保護された抽選）を自動で変更しない。
 */

/** 情報源の種類（信頼性の目安）。official_* は「その店舗・販売元本人」の発信で、判別できないものは unknown（公式とみなさない） */
export type SourceKind =
  | "apply_form" // 応募フォーム・応募ページ（応募先そのもの）
  | "official_site" // 店舗・販売元の公式サイトの告知
  | "official_x" // 店舗・販売元本人のXの投稿
  | "registration" // 既存の登録（抽選）。登録時の出典に由来する
  | "list_item" // まとめ投稿の一覧の1項目
  | "aggregator" // まとめサイトの一覧・転載
  | "legacy_extraction" // 旧方式のAI抽出（候補の draft）
  | "unknown";

export const SOURCE_RELIABILITY: Record<SourceKind, number> = { apply_form: 5, official_site: 4, official_x: 3, registration: 3, list_item: 2, aggregator: 2, legacy_extraction: 2, unknown: 1 };

export type FieldName = "chain" | "store" | "prefecture" | "products" | "applyStart" | "applyDeadline" | "resultDate" | "applyUnit" | "method" | "applyUrl";
export const FIELD_NAMES: FieldName[] = ["chain", "store", "prefecture", "products", "applyStart", "applyDeadline", "resultDate", "applyUnit", "method", "applyUrl"];
export type FieldValue = string | string[] | null;
export type ApplyUnitName = "one_form_one" | "store_select" | "per_store" | "per_product" | "per_round" | "unknown";

/** 項目の根拠: どの情報源の・どの範囲か・原文／照合済みの画像で確認できているか */
export interface FieldEvidence {
  /** 原文の範囲（親投稿内の文字位置）。無ければ null */
  range: { start: number; end: number } | null;
  /** 根拠の抜粋が原文（または照合済みの画像）に実在すると確認できているか。確認していなければ false（AIの申告だけ） */
  quoteVerified: boolean;
  /** 画像由来の場合の区別: verified=元画像との照合済み／reading=未照合の読み取り／null=画像ではない */
  image: "verified" | "reading" | null;
}

/** 1つの情報源が、ある応募機会について述べている内容（観測） */
export interface SourceFact {
  /** 情報源の識別（安定。例: 候補ID＋項目番号のハッシュ）。ログ・DBには原文でなくこれを使う */
  sourceId: string;
  kind: SourceKind;
  /** 取得（観測）の日時（ISO）。投稿・更新の日時が分かるときは postedAt */
  fetchedAt: string | null;
  postedAt?: string | null;
  fields: Partial<Record<FieldName, FieldValue>>;
  /** 項目ごとの根拠（無ければ空）。項目に根拠が無いものは、信頼性の低い申告として扱う */
  evidence?: Partial<Record<FieldName, FieldEvidence>>;
  /** 店舗選択式の選択肢（店舗名）。ある場合、その店舗の項目は同じ応募に属しうる */
  selectableStores?: string[];
  /** この情報源が指す応募先・告知のURL（元のまま。照合には正規化して使う。保存・表示ではホストのみ） */
  urls?: string[];
  /** 既存の登録（抽選）の場合: 内部ID（自分自身を「別候補」として扱わないために使う）と保護の理由コード（空でなければ変更提案は関連づけ・確認のみ） */
  registration?: { id: string; protectedCodes: string[]; protectionUnknown?: boolean; humanConfirmed?: FieldName[] };
  /** この情報源の元になった候補（候補由来の登録・旧方式の抽出が同じ候補から来た場合の同一源の判定）。同じ値の情報源は互いに照合しない */
  originId?: string;
  /** 転載元の識別（同じ元の転載記事は独立した根拠と数えない）。元が同じ情報源は1つの根拠 */
  repostOf?: string;
  /** 判断の手掛かりの文脈（見出し・投稿の冒頭など。TCGの種類・地域の判定に使う。保存・表示しない） */
  texts?: string[];
}

export type RelationKind = "same_opportunity" | "same_campaign_different_opportunity" | "independent" | "unknown";
export interface Relation {
  kind: RelationKind;
  /** 0〜1。同一と判断する強さ（独立・不明のときは参考値） */
  score: number;
  /** 根拠のコード（確認画面・報告用。原文を含まない） */
  evidence: string[];
  /** 矛盾の種類（同一でも、項目に食い違いがある場合） */
  conflicts: string[];
}

export type FieldStatus = "agreed" | "single_source" | "enriched" | "conflict" | "missing";
export interface FieldCandidate {
  sourceId: string;
  kind: SourceKind;
  value: FieldValue;
  fetchedAt: string | null;
  quoteVerified: boolean;
  image: FieldEvidence["image"];
  range: FieldEvidence["range"];
}
export interface ResolvedField {
  field: FieldName;
  status: FieldStatus;
  /** 採用する値（矛盾・不足のときは null＝採用しない）。出典は adoptedFrom */
  adopted: FieldValue;
  adoptedFrom: string[];
  /** 全ての候補（採用しなかった値・出典も並べて残す） */
  candidates: FieldCandidate[];
  /** 採用・保留の理由のコード */
  reason: string;
}

export type ProposalOp = "fill_empty" | "ask_human" | "keep" | "link_only";
export interface Proposal {
  /** 対象（既存の登録の内部ID。無ければ null） */
  registrationId: string | null;
  field: FieldName;
  op: ProposalOp;
  value: FieldValue;
  from: string[];
  reason: string;
  /** 実行ではない（常に false）。プレビュー・確認用 */
  executable: false;
  /** 保護された登録に対する提案か（その場合 op は link_only／ask_human のみ） */
  protected: boolean;
}

export interface Cluster {
  clusterId: string;
  members: string[];
  /** 既存の登録に当たる情報源（あれば）。1つのクラスターに複数の登録がある場合は重複登録の疑い */
  registrations: string[];
  /** 項目ごとの採用・矛盾・補完 */
  fields: ResolvedField[];
  proposals: Proposal[];
  /** 同一と決められなかった情報源との関係（争い）: 同じクラスターに入れなかった理由 */
  contested: { a: string; b: string; reason: string }[];
  /** 応募単位の判定（情報源から確定できた場合） */
  applyUnit: { value: ApplyUnitName; basis: "stated" | "inferred" | "unknown"; from: string[] };
}
