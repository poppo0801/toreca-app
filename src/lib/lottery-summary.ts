import { isResultFinished, isResultInPeriod } from "@/lib/datetime";
import { accountsForLottery, judgeAccount } from "@/lib/eligibility";
import { formatQuantity } from "@/lib/lottery-view";
import type { AccountStatus, AppData, Application, Lottery, ResultStatus } from "@/types/domain";

/**
 * 抽選カード（一覧）の表示用に、複数商品・応募状況・当落を抽選単位へ集約する純粋な関数。
 * 表示を簡略化するだけで、商品別の応募・当落（Application.itemResults / selectedItemId）は変更しない。
 */

export interface ItemsSummary {
  /** 先頭の商品の正式名称（未登録は「商品未登録」） */
  name: string;
  /** 先頭の商品の数量（例: 1BOX(30P)）。商品が無いときは空 */
  quantity: string;
  /** 先頭以外の商品の種類数（BOX数・パック数ではない）。単一商品は 0 */
  extraKinds: number;
  firstProductId: string | null;
}

export function summarizeItems(lottery: Lottery, data: Pick<AppData, "products">): ItemsSummary {
  const first = lottery.items[0];
  if (!first) return { name: "商品未登録", quantity: "", extraKinds: 0, firstProductId: null };
  const product = data.products.find((p) => p.id === first.productId);
  return {
    name: product?.officialName ?? "商品未登録",
    quantity: formatQuantity(first, product),
    extraKinds: Math.max(0, lottery.items.length - 1),
    firstProductId: first.productId,
  };
}

/** 「＋他8種」。単一商品は null（「＋他0種」を出さない） */
export function extraKindsLabel(extraKinds: number): string | null {
  return extraKinds > 0 ? `＋他${extraKinds}種` : null;
}

/** 応募した記録のうち、このアカウントのもの */
export function applicationOf(data: AppData, lotteryId: string, accountId: string): Application | undefined {
  return data.applications.find((a) => a.lotteryId === lotteryId && a.accountId === accountId && a.state === "applied");
}

export type ResultPhase = "none" | "waiting" | "won" | "lost" | "unknown";

/** 応募済みの記録の当落。応募していなければ none。発表前の pending は waiting（「未確認」とは表示しない） */
export function resultPhaseOf(app: Application | undefined): ResultPhase {
  if (!app) return "none";
  const r: ResultStatus = app.result;
  return r === "pending" ? "waiting" : r;
}

export interface ProfileMark {
  accountId: string;
  profileId: string;
  status: AccountStatus;
  reason: string;
  result: ResultPhase;
  /** 複数商品のうち、選んだ商品だけに応募している（希望商品を1つ選ぶ方式） */
  partial: boolean;
}

/** 抽選に関係する全プロフィールの応募状況（表示専用） */
export function profileMarks(data: AppData, lottery: Lottery, now: Date): ProfileMark[] {
  return accountsForLottery(data, lottery).map((acc) => {
    const j = judgeAccount(data, lottery, acc, now);
    const app = applicationOf(data, lottery.id, acc.id);
    return {
      accountId: acc.id,
      profileId: acc.profileId,
      status: j.status,
      reason: j.reason,
      result: resultPhaseOf(app),
      partial: !!app && lottery.multiMode === "choose_one" && !!app.selectedItemId,
    };
  });
}

/** 画面に出す状態名（色だけに頼らず文字でも区別できるように） */
export function markLabel(m: Pick<ProfileMark, "status" | "result" | "partial">): string {
  if (m.status === "applied") {
    if (m.result === "won") return "当選";
    if (m.result === "lost") return "落選";
    return m.partial ? "応募済み（選んだ商品のみ）" : "応募済み";
  }
  return { eligible_unapplied: "未応募", covered_by_limit: "枠充足", skipped: "スルー", ineligible: "対象外", unavailable: "応募不可", needs_review: "要確認", applied: "応募済み" }[m.status];
}

export type ResultNotice = "unconfirmed" | "in_period" | null;

/**
 * 結果の確認を促す状態。発表前・発表期間中は促さない（in_period は穏やかな表示）。
 * 発表日（期間なら最終日）を過ぎても結果が未登録のときだけ unconfirmed。
 */
export function resultNotice(data: AppData, lottery: Lottery, now: Date): ResultNotice {
  const pending = data.applications.some((a) => a.lotteryId === lottery.id && a.state === "applied" && a.result === "pending");
  if (!pending) return null;
  if (isResultFinished(lottery, now) === true) return "unconfirmed";
  if (isResultInPeriod(lottery, now)) return "in_period";
  return null;
}

export type ApplyControl =
  | { kind: "none" }
  /** 応募していない。押すと現在のプロフィールだけが応募済みになる（choose_one は商品を選ぶ） */
  | { kind: "apply"; accountId: string; needsChoice: boolean }
  /** 応募済み。解除は確認つき。当落が確定していれば解除できない */
  | { kind: "applied"; accountId: string; canUndo: boolean }
  /** 応募できない状態（スルー・受付終了など）。状態名だけ見せる */
  | { kind: "blocked"; accountId: string; label: string };

/** 現在のプロフィール専用の応募操作。他のプロフィールのアカウントは対象にしない */
export function applyControlFor(data: AppData, lottery: Lottery, profileId: string, now: Date): ApplyControl {
  const acc = accountsForLottery(data, lottery).find((a) => a.profileId === profileId);
  if (!acc) return { kind: "none" };
  const j = judgeAccount(data, lottery, acc, now);
  if (j.status === "applied") {
    const app = applicationOf(data, lottery.id, acc.id);
    return { kind: "applied", accountId: acc.id, canUndo: !app || (app.result === "pending" && app.fulfillment === "none") };
  }
  if (j.status === "eligible_unapplied" || j.status === "needs_review") {
    return { kind: "apply", accountId: acc.id, needsChoice: lottery.multiMode === "choose_one" };
  }
  return { kind: "blocked", accountId: acc.id, label: markLabel({ status: j.status, result: "none", partial: false }) };
}
