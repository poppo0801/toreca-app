/**
 * 登録済み抽選の自動更新の判定（Stage 9B・純関数）。
 * 収集が、既存の抽選について内容の変更を検出したとき、十分な根拠のあるものは人の承認を待たずに反映し、それ以外は従来どおり「更新の提案」（人の承認）にする。
 *
 * 自動で反映してよいのは、次をすべて満たすとき:
 *  - 自動収集で登録された抽選で、手動編集されておらず、退避（アーカイブ）されていない
 *  - 根拠が信頼できる: 公式の情報源、または、登録時と同じ情報源のページの更新（同じ告知の更新）
 *  - 変更の種類が安全: 不明だった日時を埋める／応募締切・購入期限の「延長」／当選発表日の変更（応募機会を減らさない）
 *  - 1日の自動更新が上限（3回）に達していない（誤った往復の更新を防ぐ）
 *  - 利用者が元に戻した変更と同じ内容ではない（利用者の判断を尊重し、再び反映しない）
 * 応募機会に直接影響する変更（応募締切・購入期限の短縮、受取方法の変更、中止）は、自動では反映せず、人の確認に回す。
 * 応募・当選・購入・通知の記録には触れない（日時の列だけを更新する）。
 */
import type { FieldChange } from "@/lib/collector/queue";
import { lotteryFlex } from "@/lib/collector/queue";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Lottery } from "@/types/domain";

export interface UpdateEntry {
  id: string;
  at: string;
  keys: string[];
  labels: string[];
  /** 列名 → 更新前の値 */
  before: Record<string, unknown>;
  /** 列名 → 更新後の値 */
  after: Record<string, unknown>;
  /** 項目 → 更新後の日時の正規形（YYYY-MM-DDTHH:mm。元に戻された内容の再反映を防ぐ照合用） */
  afterKeys: Record<string, string>;
  /** 表示用（「11/12 → 11/15」） */
  summary: string[];
  sourceUrl: string;
  sourceKind: string;
  official: boolean;
  revertedAt?: string;
}

export const MAX_AUTO_UPDATES_PER_DAY = 3;
export const MAX_UPDATE_HISTORY = 30;

export interface AutoUpdateContext {
  lot: Pick<Lottery, "applyStart" | "applyDeadline" | "resultDate" | "procedureStart" | "procedureDeadline" | "receiveMethod">;
  autoRegistered: boolean;
  manuallyEdited: boolean;
  archived: boolean;
  /** 情報源が公式（公式サイト・店舗公式X） */
  official: boolean;
  /** 登録時と同じ情報源（URL）のページの更新か */
  sameSource: boolean;
  history: UpdateEntry[];
  /** 今日（JST。YYYY-MM-DD） */
  today: string;
  now: string;
}

export interface AutoUpdatePlan {
  apply: FieldChange[];
  propose: FieldChange[];
  /** 利用者が元に戻した内容と同じため、反映も提案もしない変更 */
  ignored: FieldChange[];
  /** 変更ごとの理由（記録・表示用） */
  reasons: Record<string, string>;
}

type Flex = { precision: string; date?: string | null; time?: string | null };
const flexKey = (f: Flex | undefined): string => (!f || f.precision === "unknown" || !f.date ? "" : `${f.date}T${f.precision === "date_time" ? (f.time || "00:00") : "23:59"}`);

const DATE_KEYS = ["applyStart", "applyDeadline", "resultDate", "procedureStart", "procedureDeadline"] as const;
type DateKey = (typeof DATE_KEYS)[number];

export function planAutoUpdate(changes: FieldChange[], input: LotteryInput, ctx: AutoUpdateContext): AutoUpdatePlan {
  const plan: AutoUpdatePlan = { apply: [], propose: [], ignored: [], reasons: {} };
  const dayAgo = Date.parse(ctx.now) - 86_400_000;
  const recent = ctx.history.filter((h) => !h.revertedAt && Date.parse(h.at) >= dayAgo).length;
  const gate = !ctx.autoRegistered ? "自動収集で登録された抽選ではないため、人の確認が必要です"
    : ctx.manuallyEdited ? "手動で編集された抽選のため、自動では更新しません"
    : ctx.archived ? "退避された抽選のため、自動では更新しません"
    : !(ctx.official || ctx.sameSource) ? "公式または登録時と同じ情報源の更新ではないため、人の確認が必要です"
    : recent >= MAX_AUTO_UPDATES_PER_DAY ? "1日の自動更新の上限に達したため、人の確認が必要です"
    : null;
  // 利用者が元に戻した変更と同じ内容（同じ列の同じ値）は、再び反映しない
  const reverted = ctx.history.filter((h) => h.revertedAt);
  const revertedBefore = (k: DateKey, newKey: string) => reverted.some((h) => h.keys.includes(k) && h.afterKeys?.[k] === newKey);
  let budget = MAX_AUTO_UPDATES_PER_DAY - recent;
  for (const ch of changes) {
    const k = ch.key as string;
    if (!(DATE_KEYS as readonly string[]).includes(k)) {
      plan.propose.push(ch);
      plan.reasons[k] = "日時以外の変更（受取方法など）は、人の確認が必要です";
      continue;
    }
    const dk = k as DateKey;
    const next = flexKey(input[dk] as Flex);
    const cur = flexKey(lotteryFlex(ctx.lot[dk] as never));
    if (!next) {
      // 新しい情報に値が無い（取得できなかった・記載がない）ことを理由に、確認済みの値を消さない
      plan.ignored.push(ch);
      plan.reasons[k] = "新しい情報に値が無いため、現在の値を保持します";
      continue;
    }
    if (revertedBefore(dk, next)) {
      plan.ignored.push(ch);
      plan.reasons[k] = "利用者が元に戻した内容のため、再び反映しません";
      continue;
    }
    if (gate) {
      plan.propose.push(ch);
      plan.reasons[k] = gate;
      continue;
    }
    // 安全な変更の種類
    let ok = false;
    let why = "";
    if (!cur) {
      ok = true;
      why = "不明だった日時を埋めます";
    } else if (dk === "applyDeadline" || dk === "procedureDeadline") {
      if (next > cur && next >= `${ctx.today}T00:00`) {
        ok = true;
        why = "期限の延長（応募機会を減らさない変更）";
      } else if (next < cur) why = "期限の短縮は、応募機会に直接影響するため人の確認が必要です";
      else why = "過去の日時への変更のため、人の確認が必要です";
    } else if (dk === "resultDate") {
      ok = true;
      why = "当選発表日の変更（応募機会に影響しない）";
    } else if (dk === "applyStart" || dk === "procedureStart") {
      why = "開始日の変更は、人の確認が必要です";
    }
    if (ok && budget <= 0) {
      ok = false;
      why = "1日の自動更新の上限に達したため、人の確認が必要です";
    }
    if (ok) {
      budget--;
      plan.apply.push(ch);
    } else plan.propose.push(ch);
    plan.reasons[k] = why;
  }
  return plan;
}

/** 更新履歴に追加する（古いものから落として上限を保つ） */
export function appendHistory(history: UpdateEntry[], entry: UpdateEntry): UpdateEntry[] {
  return [...history, entry].slice(-MAX_UPDATE_HISTORY);
}

/** 元に戻せる更新か（まだ戻していない）。現在の値が更新後の値のままであることは、呼び出し側（DB）で確認する */
export const revertable = (e: UpdateEntry): boolean => !e.revertedAt;
export { flexKey as updateFlexKey };

/** 項目 → 更新する列（更新の提案の反映・自動更新の共通） */
export const UPDATE_COLUMNS: Record<string, string[]> = {
  applyStart: ["apply_start_precision", "apply_start_date", "apply_start_at"],
  applyDeadline: ["apply_deadline_precision", "apply_deadline_date", "apply_deadline_at"],
  resultDate: ["result_precision", "result_date", "result_at"],
  procedureStart: ["procedure_start_precision", "procedure_start_date", "procedure_start_at"],
  procedureDeadline: ["procedure_deadline_precision", "procedure_deadline_date", "procedure_deadline_at"],
  receiveMethod: ["receive_method"],
  eventState: ["event_state"],
};
