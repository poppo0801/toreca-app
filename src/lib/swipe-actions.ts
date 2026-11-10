import { isSkippedBy } from "@/lib/eligibility";
import { hasSeparateSteps, myApplication, needsResultConfirm, wonProgress } from "@/lib/lottery-flow";
import { applyControlFor } from "@/lib/lottery-summary";
import { isManaged, type Tab } from "@/lib/lottery-view";
import type { AppData, Lottery } from "@/types/domain";

/**
 * タブごとのスワイプ操作の割り当てと、実行前の判定（純関数）。
 *   全情報:       右 → 要チェックに追加   左 → 今回のみスルー
 *   要チェック:   右 → 応募済みに変更     左 → 要チェックから解除
 *   応募済み:     右 → 当選              左 → 落選
 *   当選:         右 → 受取済み          左 → 操作なし
 * 実際の更新は既存の状態管理(actions)をそのまま使う。ここでは「いまその操作をしてよいか」と確認の要否だけを決める。
 * 使ってみて誤操作が多い操作は、SWIPE_OPS_ENABLED で個別に無効化できる（false にすると、その向きは何も起きない）。
 */
export type SwipeOp = "add_managed" | "skip_once" | "mark_applied" | "unmanage" | "result_won" | "result_lost" | "receive";

/** 操作ごとの有効/無効。最重要は add_managed（全情報の右スワイプ）。他は副次的で、運用で外せる */
export const SWIPE_OPS_ENABLED: Record<SwipeOp, boolean> = {
  add_managed: true,
  skip_once: true,
  mark_applied: true,
  unmanage: true,
  result_won: true,
  result_lost: true,
  receive: true,
};

export const SWIPE_MAP: Record<Tab, { right?: SwipeOp; left?: SwipeOp }> = {
  all: { right: "add_managed", left: "skip_once" },
  managed: { right: "mark_applied", left: "unmanage" },
  applied: { right: "result_won", left: "result_lost" },
  won: { right: "receive" },
};

/**
 * 確定したあと、カードが今のタブから外れる操作（Stage 6L: 同じ抽選は1つのタブにだけ出るため、タブをまたぐ操作はほぼすべて）。
 * 指を離した位置から同じ向きへ画面外まで滑り、下のカードが詰まる。実際に外れなかった場合は元の位置へ戻る（退出アニメーション側で判定）。
 */
export function leavesTabOnCommit(op: SwipeOp, tab: Tab): boolean {
  switch (op) {
    case "add_managed": // 全情報 → 要チェック
    case "unmanage": // 要チェック → 全情報
    case "skip_once": // 今回のみスルー
    case "mark_applied": // 要チェック → 応募済み
      return true;
    case "result_won": // 応募済み → 当選
    case "result_lost": // 応募済み → （結果待ちでなくなる）
      return tab === "applied";
    case "receive":
      return tab === "won";
  }
}

export type SwipeTone = "primary" | "success" | "muted" | "warn";

export const OP_META: Record<SwipeOp, { hint: string; done: string; tone: SwipeTone }> = {
  add_managed: { hint: "★ 要チェックに追加", done: "要チェックに追加しました", tone: "primary" },
  skip_once: { hint: "今回はスルー", done: "今回はスルーしました", tone: "muted" },
  mark_applied: { hint: "応募済みにする", done: "応募済みにしました", tone: "primary" },
  unmanage: { hint: "★ 要チェックから解除", done: "要チェックから解除しました", tone: "muted" },
  result_won: { hint: "当選", done: "当選として記録しました", tone: "success" },
  result_lost: { hint: "落選", done: "落選として記録しました", tone: "muted" },
  receive: { hint: "受取済み", done: "受取済みとして記録しました", tone: "success" },
};

export type SwipePlan =
  /** この向きには操作がない／無効化されている */
  | { kind: "none" }
  /** 条件を満たさないため実行しない（理由だけ通知する。状態は変えない） */
  | { kind: "blocked"; message: string }
  | { kind: "run"; op: SwipeOp }
  /** 発表前の当落記録: 確認ダイアログを出してから実行する */
  | { kind: "confirm"; op: SwipeOp }
  /** 希望商品を選んで応募する抽選: 商品を選んでから応募済みにする */
  | { kind: "choose-item" }
  /** 複数商品（商品ごとに当落）の抽選: 応募した商品を選んでから応募済みにする（Stage 7M） */
  | { kind: "choose-items" }
  /** 応募時に店舗を選ぶ抽選: 応募先の店舗を選んでから応募済みにする（Stage 6N） */
  | { kind: "choose-store" }
  /** 購入と受取が分かれている抽選: 操作内容を選ぶダイアログ（Undoは使わず、確認してから確定） */
  | { kind: "choose-fulfillment" }
  /** 複数商品の当落など、詳細画面での入力が必要 */
  | { kind: "open-detail"; message: string };

export function opFor(tab: Tab, dir: "left" | "right", enabled: Record<SwipeOp, boolean> = SWIPE_OPS_ENABLED): SwipeOp | null {
  const op = SWIPE_MAP[tab][dir];
  return op && enabled[op] ? op : null;
}

export function planSwipe(
  data: AppData,
  lottery: Lottery,
  tab: Tab,
  dir: "left" | "right",
  profileId: string,
  now: Date,
  enabled: Record<SwipeOp, boolean> = SWIPE_OPS_ENABLED,
): SwipePlan {
  const op = opFor(tab, dir, enabled);
  if (!op) return { kind: "none" };

  switch (op) {
    case "add_managed":
      return isManaged(data, lottery.id) ? { kind: "blocked", message: "すでに要チェックです" } : { kind: "run", op };
    case "unmanage":
      return isManaged(data, lottery.id) ? { kind: "run", op } : { kind: "blocked", message: "要チェックではありません" };
    case "skip_once":
      return isSkippedBy(data, profileId, lottery) ? { kind: "blocked", message: "すでにスルー中です" } : { kind: "run", op };
    case "mark_applied": {
      const c = applyControlFor(data, lottery, profileId, now);
      if (c.kind === "apply") return c.needsChoice ? { kind: "choose-item" } : c.needsItems && !c.needsStore ? { kind: "choose-items" } : c.needsItems ? { kind: "open-detail", message: "応募した商品と店舗を、詳細から選んでください" } : c.needsStore ? { kind: "choose-store" } : { kind: "run", op };
      if (c.kind === "applied") return { kind: "blocked", message: "すでに応募済みです" };
      if (c.kind === "blocked") return { kind: "blocked", message: `応募できません（${c.label}）` };
      return { kind: "blocked", message: "このユーザーの応募アカウントがありません" };
    }
    case "result_won":
    case "result_lost": {
      const mine = myApplication(data, lottery.id, profileId);
      if (!mine) return { kind: "blocked", message: "このユーザーは応募していません" };
      if (mine.result !== "pending") return { kind: "blocked", message: "結果は記録済みです" };
      if (lottery.multiMode !== "single") return { kind: "open-detail", message: "複数商品の抽選は、商品ごとの結果を詳細で入力してください" };
      return needsResultConfirm(lottery, now) ? { kind: "confirm", op } : { kind: "run", op };
    }
    case "receive": {
      const mine = myApplication(data, lottery.id, profileId);
      if (!mine || mine.result !== "won") return { kind: "blocked", message: "このユーザーは当選していません" };
      const p = wonProgress(lottery, mine, now);
      if (p.stage === "done") return { kind: "blocked", message: "すでに受取済みです" };
      if (!p.swipeable) return { kind: "blocked", message: "購入・受取の期間前です（履歴の補正は詳細から行えます）" };
      return hasSeparateSteps(lottery) ? { kind: "choose-fulfillment" } : { kind: "run", op };
    }
  }
}
