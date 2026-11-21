/**
 * 「全情報」タブ・「抽選候補」の一括再収集・再判定（整理）テストの計画部品（Stage 10F）。**純関数のみ。DB・ネットワーク・AIに接続しない。適用（更新・統合・削除）の関数は存在しない**。
 * 設計: `docs/AI_REDESIGN_10F_REFRESH_PLAN.md`。この部品が扱うのは、(1) 対象の選択と除外 (2) 履歴保護の分類 (3) 許される提案の種類 (4) 差分プレビューの形 (5) 上限と停止条件、まで。
 * 初回は常に差分プレビュー（dry-run）と人手確認。削除・統合・更新を実際に行うのは、別途のユーザーの明示承認と別の実装による（ここには入れない）。
 */

export type RefreshTab = "all_info" | "lottery_candidates";

/** 対象1件の事実（現在の画面の集合から、読み取り専用で作る。個人名義・メモの内容・通知の本文は含まない） */
export interface RefreshFacts {
  /** ローカルだけの識別子（外部へ出さない） */
  id: string;
  tab: RefreshTab;
  archived: boolean;
  /** 応募受付の状態（closed.ts と同じ判定の結果） */
  deadline: "open" | "unknown" | "closed";
  /** ★（要チェック）管理中 */
  managed: boolean;
  /** 応募・当選・購入の記録がある（応募済み・当選を含む） */
  hasApplicationHistory: boolean;
  /** 人が確定した項目（値の書き換え不可） */
  humanConfirmedFields: string[];
  /** DB関数 lottery_history_blockers の理由コード。空なら記録上の保護なし */
  protectedCodes: string[];
  /** 保護の確認ができなかった */
  protectionUnknown: boolean;
  /** 情報元の種類（取得可否の見込みに使う）。x=X投稿/短縮URL（取得不能が多い）、web=公開ページ、list_card=まとめサイトの一覧、none=情報元なし */
  sourceKind: "x" | "web" | "list_card" | "none";
  /** 9Zで保存した原文がある（再取得なしで再判定できる） */
  hasStoredEvidence: boolean;
}

export type ProtectionClass = "unknown" | "history_protected" | "human_confirmed" | "managed" | "none";

/** 保護の分類（強い順）。unknown は保護ありとして扱う（保護なしとみなさない） */
export function classifyProtection(f: RefreshFacts): { cls: ProtectionClass; reasons: string[] } {
  if (f.protectionUnknown) return { cls: "unknown", reasons: ["保護の状態を確認できません（保護ありとして扱う）"] };
  if (f.hasApplicationHistory || f.protectedCodes.length > 0) return { cls: "history_protected", reasons: [f.hasApplicationHistory ? "応募・当選・購入の記録あり" : "", ...f.protectedCodes].filter(Boolean) };
  if (f.humanConfirmedFields.length > 0) return { cls: "human_confirmed", reasons: [`人が確定した項目: ${f.humanConfirmedFields.length}件`] };
  if (f.managed) return { cls: "managed", reasons: ["★（要チェック）管理中"] };
  return { cls: "none", reasons: [] };
}

/** 提案の種類。**提案**であり、実行ではない。保護された対象は、関連づけ（link_only）・残置・保留・人への確認のみ */
export type ProposedAction = "keep" | "hold" | "ask_human" | "link_only" | "update_proposal" | "merge_proposal" | "delete_proposal";

export function allowedActions(cls: ProtectionClass): ProposedAction[] {
  if (cls === "none") return ["keep", "hold", "ask_human", "link_only", "update_proposal", "merge_proposal", "delete_proposal"];
  // 保護あり・不明: 値の更新・統合・削除の提案は出さない（食い違いは人に確認する）
  return ["keep", "hold", "ask_human", "link_only"];
}

export type ExcludeReason = "archived" | "closed" | "out_of_scope_tab";

export interface SelectOptions {
  /** 対象の最大件数（既定30。初回のパイロット） */
  maxTargets?: number;
  /** 保存原文がある対象を優先する（再取得なしで検証できるため、費用・Webアクセスが小さい） */
  preferStoredEvidence?: boolean;
  /** 情報元が取得不能になりやすい種類（x）を後回しにする */
  deprioritizeUnfetchable?: boolean;
}

export interface Selection {
  targets: RefreshFacts[];
  excluded: { id: string; reason: ExcludeReason }[];
  /** 上限で今回は対象にしなかった件数 */
  deferred: number;
}

/**
 * 対象の選択。決定的（同じ入力なら同じ結果）。除外: アーカイブ済み・応募受付が終了したもの。
 * 優先: 保護のないもの→保存原文があるもの→情報元が取得可能な種類（web / list_card）→識別子順。保護された対象も**調査は可能だが提案は限定**されるので、除外せず対象に含める（件数の枠は共有）。
 */
export function selectTargets(all: RefreshFacts[], opts: SelectOptions = {}): Selection {
  const max = Math.min(Math.max(1, opts.maxTargets ?? 30), 100);
  const excluded: Selection["excluded"] = [];
  const open: RefreshFacts[] = [];
  for (const f of all) {
    if (f.archived) excluded.push({ id: f.id, reason: "archived" });
    else if (f.deadline === "closed") excluded.push({ id: f.id, reason: "closed" });
    else open.push(f);
  }
  const prefStored = opts.preferStoredEvidence ?? true;
  const depri = opts.deprioritizeUnfetchable ?? true;
  const score = (f: RefreshFacts): number => {
    let s = 0;
    if (classifyProtection(f).cls !== "none") s += 4; // 保護ありは後回し（提案が限定され、情報価値が低いため）
    if (prefStored && !f.hasStoredEvidence) s += 2;
    if (depri && (f.sourceKind === "x" || f.sourceKind === "none")) s += 1;
    return s;
  };
  const sorted = [...open].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
  return { targets: sorted.slice(0, max), excluded, deferred: Math.max(0, sorted.length - max) };
}

/** 差分プレビュー（1件）。**実行可能な操作を含まない**（提案と理由、人の確認が必要かだけ） */
export interface PreviewItem {
  id: string;
  tab: RefreshTab;
  protection: ProtectionClass;
  proposed: ProposedAction;
  /** 人が確認するまで何も変更しない（常に true。保護ありは確認事項として提示） */
  needsHumanReview: true;
  reason: string;
}

export interface Preview {
  /** 常に false: このプレビューは適用できない。適用は別途の明示承認と別実装 */
  executable: false;
  items: PreviewItem[];
  counts: { byProtection: Record<ProtectionClass, number>; byAction: Record<ProposedAction, number> };
}

/** 提案の候補（新方式・固定ロジックの判断結果から作られる）。保護により許されない提案は、ask_human に落とす（黙って捨てず、人に見せる） */
export function buildPreview(items: { facts: RefreshFacts; proposal: ProposedAction; reason: string }[]): Preview {
  const out: PreviewItem[] = [];
  const byProtection: Record<ProtectionClass, number> = { unknown: 0, history_protected: 0, human_confirmed: 0, managed: 0, none: 0 };
  const byAction: Record<ProposedAction, number> = { keep: 0, hold: 0, ask_human: 0, link_only: 0, update_proposal: 0, merge_proposal: 0, delete_proposal: 0 };
  for (const { facts, proposal, reason } of items) {
    const p = classifyProtection(facts);
    const allowed = allowedActions(p.cls).includes(proposal);
    const action: ProposedAction = allowed ? proposal : "ask_human";
    out.push({ id: facts.id, tab: facts.tab, protection: p.cls, proposed: action, needsHumanReview: true, reason: allowed ? reason : `保護（${p.cls}）のため「${proposal}」は提案できません。人の確認事項として提示: ${reason}` });
    byProtection[p.cls]++;
    byAction[action]++;
  }
  return { executable: false, items: out, counts: { byProtection, byAction } };
}

// ---------------------------------------------------------------- 上限と停止条件
export interface RefreshLimits {
  maxTargets: number;
  /** AI（新方式・調査）の呼び出し回数の上限 */
  maxApiCalls: number;
  /** 外部ページの取得回数の上限 */
  maxWebFetches: number;
  maxCostJpy: number;
  perTargetCostJpy: number;
  /** 保護違反（保護された対象への変更の試み）が1件でも出たら停止 */
  stopOnProtectionViolation: true;
  /** 連続して取得不能・失敗が続いたら停止する件数 */
  stopOnConsecutiveFailures: number;
}

/** 初回パイロットの既定（案。実行前にユーザーが確定する）。Webアクセスは「回避しない」方針で、ロボット制限・ログイン必須は取得しない */
export const PILOT_LIMITS: RefreshLimits = { maxTargets: 30, maxApiCalls: 90, maxWebFetches: 60, maxCostJpy: 50, perTargetCostJpy: 3, stopOnProtectionViolation: true, stopOnConsecutiveFailures: 5 };

export interface RefreshCounters {
  targets: number;
  apiCalls: number;
  webFetches: number;
  costJpy: number;
  consecutiveFailures: number;
  protectionViolations: number;
}

/** 停止すべき理由（なければ null）。呼び出しの前に確認し、超える見込みなら呼ばない */
export function shouldStop(c: RefreshCounters, l: RefreshLimits): string | null {
  if (c.protectionViolations > 0) return "保護された対象への変更の試みが検出されたため停止";
  if (c.costJpy >= l.maxCostJpy) return "費用の上限に達したため停止";
  if (c.apiCalls >= l.maxApiCalls) return "AI呼び出し回数の上限に達したため停止";
  if (c.webFetches >= l.maxWebFetches) return "外部ページ取得回数の上限に達したため停止";
  if (c.targets >= l.maxTargets) return "対象件数の上限に達したため停止";
  if (c.consecutiveFailures >= l.stopOnConsecutiveFailures) return "連続した取得不能・失敗のため停止";
  return null;
}

/** 実施前の費用見積もり（過去の実績に基づく粗い値。実行前の予約が上限を保証する）。Web検索を伴う調査は約5.6円/件（9X実績: 494円/88件）、保存原文のみの新方式は約0.2〜1.0円/件（r3・r4実績） */
export function estimateRefreshCost(targets: RefreshFacts[], opts: { withWebInvestigation: boolean }): { typicalJpy: number; worstJpy: number } {
  const stored = targets.filter((t) => t.hasStoredEvidence).length;
  const other = targets.length - stored;
  const typical = stored * 0.4 + other * (opts.withWebInvestigation ? 5.6 : 0);
  const worst = stored * 1.65 + other * (opts.withWebInvestigation ? 10 : 0);
  return { typicalJpy: Math.round(typical * 100) / 100, worstJpy: Math.round(worst * 100) / 100 };
}
