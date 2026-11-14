import "server-only";
import { extractPageText } from "@/lib/ai/page-text";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { estimateCostJpy } from "@/lib/ai-cost";
import { RuleExtractor } from "@/lib/ai/rule-extractor";
import { classifyPage } from "@/lib/ai/page-kind";
import type { LotteryExtractor } from "@/lib/ai/provider";
import { decideDisposition } from "@/lib/collector/disposition";
import { chainCanonicalKey, sameChainName } from "@/lib/chain-normalize";
import { buildDraft } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import type { AnalysisPreview, InvestigationSignals, PageData, PlannerWorld } from "@/lib/agent/collection-planner/types";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { loadPlannerSignals } from "@/lib/server/agent/collection-planner-world";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import type { AppData } from "@/types/domain";

/**
 * 調査エージェントの「世界」（Stage 9D）。実際の取得・解析・照合の部品を、読み取り専用で提供する。
 *   fetchPage : 既存の安全な取得（SSRF対策・robots.txt の尊重・サイズ/時間の上限・リダイレクト先の再検査・Cookie/認証なし）。ログイン・取得制限は回避しない
 *   analyze   : 取得したページを抽選として解析し、登録済みの抽選との照合で 新規/補完/更新/重複/追加調査 をプレビューする（登録しない）。
 *               解析エンジンは既定で無料の RuleExtractor（本文の記載とマスターの照合のみ）。実AI（費用が発生）は、承認された場合だけ呼び出し側が差し込む
 *   matchExisting : 登録済みの抽選との照合
 * 解析のために作った下書き（draft）は drafts に保持する（開発環境の自動登録・補完で、同じプロセス内でだけ使う。DBには保存しない）。
 */
export interface InvestigationWorld {
  world: PlannerWorld;
  drafts: Map<string, LotteryInput>;
}

const KIND_LABEL = { lottery_announcement: "抽選の告知", announcement_index: "告知の一覧", lottery_explainer: "抽選の説明", past_lottery: "終了した抽選", general: "抽選の告知ではないページ" } as const;
const flexDate = (f: { precision?: string; date?: string | null } | undefined): string | null => (f && f.precision !== "unknown" && f.date ? f.date : null);

export function createInvestigationWorld(o: {
  db: Db;
  householdId: string;
  now: Date;
  /** false: 外部へ取得しない（保存済みの情報だけで調査） */
  live: boolean;
  extractor?: LotteryExtractor | null;
  previous?: InvestigationSignals["previous"];
  /** テスト用: 取得の差し替え */
  fetcher?: PlannerWorld["fetchPage"];
}): InvestigationWorld {
  const drafts = new Map<string, LotteryInput>();
  let data: AppData | null = null;
  const load = async (): Promise<AppData> => (data ??= await loadAppData(o.db, o.householdId));

  const fetchPage: PlannerWorld["fetchPage"] =
    o.fetcher ??
    (async (url) => {
      if (!o.live) return { ok: false, reason: "外部アクセスは設定されていません（この調査は保存済みの情報だけを使います）" };
      const r = await fetchRespectingRobots(url, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"] });
      if (!r.ok) return { ok: false, reason: r.code === "robots" ? "robots.txt で取得が許可されていません（回避しません）" : `取得できませんでした（${r.code}）` };
      const page = extractPageText(r.body, r.finalUrl, 20_000, 200);
      return { ok: true, title: page.title, text: page.text, links: page.links.map((l) => ({ url: l.href, text: l.text })) };
    });

  const analyze = async (page: PageData): Promise<AnalysisPreview> => {
    const d = await load();
    const extractor =
      o.extractor ??
      new RuleExtractor({
        chains: d.chains.filter((c) => !c.archived).map((c) => ({ name: c.name, aliases: c.aliases })),
        stores: d.stores.map((s) => ({ chainName: d.chains.find((c) => c.id === s.chainId)?.name ?? "", name: s.name })),
        products: d.products.map((p) => p.officialName),
      });
    const out = await extractor.extract({ kind: "url", text: `${page.title}\n${page.text}`, sourceUrl: page.url, now: o.now });
    const ex = normalizeExtraction(out.raw, o.now);
    const draft = buildDraft(ex, d, { sourceUrl: page.url });
    const input = draft.input;
    const chainName = input.chain.name || ex.chainName;
    const products = input.items.map((i) => i.product.name).filter(Boolean);
    const deadline = flexDate(input.applyDeadline);
    const missing: string[] = [];
    if (!deadline) missing.push("応募締切");
    if (!flexDate(input.resultDate)) missing.push("当選発表日");
    if (products.length === 0) missing.push("商品");
    const isSelect = input.storeMode === "select_on_apply";
    if (!isSelect && !input.store.name) missing.push("店舗");
    if (input.applyMethod === "unknown") missing.push("応募方法");
    if (input.receiveMethod === "unknown") missing.push("受取方法");

    // ページの主題の確認（固定ロジック）: 解析エンジンが抽選と判断しても、ページの主題・応募の記載が抽選の告知と確認できなければ、登録の対象にしない（Stage 9E）
    const kind = classifyPage({ title: page.title, text: `${page.title}
${page.text}` });
    const recognized = ex.isLotteryAnnouncement && kind.actionable && (!!chainName || products.length > 0);
    const dup = draft.duplicates.filter((x) => x.level === "high" || x.level === "medium");
    const target = dup[0] ? d.lotteries.find((l) => l.id === dup[0].lotteryId) : undefined;
    const targetDeadline = target ? flexDate(target.applyDeadline) : null;
    const disposition = decideDisposition({
      dups: dup,
      recognized,
      changed: !!target && !!targetDeadline && !!deadline && targetDeadline !== deadline,
      fillsGap: !!target && !targetDeadline && !!deadline,
    });

    // 開発環境の自動登録の安全条件（満たさない理由は blockers に残す。情報が不足しているだけでは止めない＝日時が不明でも登録できる）
    const blockers: string[] = [];
    if (!kind.actionable) blockers.push(`ページの主題が抽選の告知と確認できません（${KIND_LABEL[kind.kind]}: ${kind.reasons[0] ?? ""}）`);
    if (!recognized) blockers.push("抽選として認識できません");
    if (draft.summary.chain !== "exact" && draft.summary.chain !== "alias") blockers.push("系列を確実に特定できません");
    if (!isSelect && draft.summary.store !== "exact" && draft.summary.store !== "alias") blockers.push("店舗を確実に特定できません（応募時に店舗を選ぶ抽選ではありません）");
    if (draft.summary.items.length === 0) blockers.push("商品が読み取れません");
    else if (draft.summary.items.some((i) => !["exact", "alias", "code"].includes(i.kind))) blockers.push("商品がマスターと確実に一致しません");
    if (dup.length > 0) blockers.push("登録済みの抽選と同じものの可能性があります");
    if (draft.modePending) blockers.push("複数商品の応募方式が確定できません");
    drafts.set(page.url, input);
    return { url: page.url, pageKind: kind.kind, pageKindReason: kind.reasons[0] ?? "", aiJudgedLottery: ex.isLotteryAnnouncement, recognized, chainName, storeName: isSelect ? "応募時に店舗を選択" : input.store.name, products, applyDeadline: deadline, missing, disposition, registrable: blockers.length === 0, blockers, costJpy: out.usage ? (estimateCostJpy(out.model, out.usage.input, out.usage.output) ?? 0) : 0 };
  };

  const world: PlannerWorld = {
    signals: () => loadPlannerSignals(o.db, o.householdId, o.now, o.previous ?? []),
    fetchPage,
    analyze,
    matchExisting: async (q) => {
      const d = await load();
      const chainOf = new Map(d.chains.map((c) => [c.id, c.name]));
      const productName = new Map(d.products.map((p) => [p.id, p.officialName]));
      const qKey = q.chainName ? chainCanonicalKey(q.chainName) : "";
      return d.lotteries
        .filter((l) => (q.url && (l.sourceUrls ?? []).includes(q.url)) || (qKey && sameChainName(chainOf.get(l.chainId) ?? "", q.chainName ?? "") && (!q.productName || l.items.some((i) => (productName.get(i.productId) ?? "").includes(q.productName ?? "")))))
        .slice(0, 8)
        .map((l) => ({ lotteryId: l.id, chainName: chainOf.get(l.chainId) ?? "", storeName: d.stores.find((s) => s.id === l.storeId)?.name ?? "", products: l.items.map((i) => productName.get(i.productId) ?? ""), sourceUrls: l.sourceUrls ?? [] }));
    },
  };
  return { world, drafts };
}
