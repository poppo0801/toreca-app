/**
 * 条件B（Stage 10W）の評価基盤。**入力既知の評価（B1）と、自律発見の評価（B2）を混同しない**:
 *  - B1（展開・項目スコープ）: 投稿から項目別の展開済みリンクを取り出し、公開ページに対応づけられるか。**展開結果を入力として与えている**ので、AIの発見力の評価ではない（AIを使わない）。
 *  - B2（AI自律発見）: 応募URLを**与えず**（種からURL・短縮URLを除く）、AIが公開情報から応募先に到達し、項目と対応づけられるか。**成功は「独立した正解の店舗のページに到達し、対応の検査で mismatch でない」こと**。
 *      現在の読み取り専用ツールは「公開ページの取得」だけで、検索のツールは無い。そのため B2 は、AIが自分で提案したURLを取得できる範囲の評価（検索機能が必要なら別途の設計・承認）。
 * 正解（gold: 項目の正しい店舗。独立した原文・公開ページで人が確認したもの）は採点側だけが持ち、AIの入力に含めない。例が無いときは評価を実施せず「評価不能」と報告する（テストの失敗にしない）。
 */
import type { CallBudget } from "../call-budget";
import { parseApplyPage } from "./page-structure";
import { makeScoper, planXPost, storeFromGroupLabel, type ItemPlan, type StoredXPost } from "./x-origin";
import { runResearch, seedEvidence, type FetchOutcome, type RegistrationJudge, type ResearchAgent, type ResearchLimits, type ResearchTools, type SearchHitLite } from "./research-loop";

export interface BExample {
  id: string;
  post: StoredXPost;
  /** URL → 保存済みのHTML（公開ページの再生元。取得できないURLは not_public） */
  pages: Record<string, string>;
  /** 独立した正解（採点側だけが持つ）: 項目番号 → 正しい店舗名。出典（人が確認した原文・公開ページ）を記録する */
  gold?: { itemNo: number; store: string; source: string }[];
  /** （mock用）検索の再生元: 検索語にすべてのキーワードが含まれるとき hits を返す。実評価では実際の検索ツールを注入する */
  searchIndex?: { keywords: string[]; hits: SearchHitLite[] }[];
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
const pageMentions = (html: string, store: string): boolean => {
  const st = parseApplyPage(html);
  const head = norm([st.title ?? "", ...st.slots.map((s) => s.title)].join(" "));
  const k = norm(store).replace(/店$/, "");
  return k.length >= 2 && head.includes(k);
};

export interface B1Result {
  examples: number;
  items: number;
  /** 項目自身の展開済みリンクを取り出せた */
  urlExtracted: number;
  /** そのうち、再生元の公開ページがある（取得できる） */
  pageAvailable: number;
  scope: { confirmed: number; candidate: number; mismatch: number; unknown: number };
  /** gold がある項目だけ: 対応の検査が正解と一致（正しいページを confirmed/candidate、別のページを mismatch/unknown）／不一致 */
  goldScored: number;
  goldAgree: number;
  goldDisagree: number;
  /** gold が無く採点できない項目（精度に含めない） */
  unscored: number;
}

/** B1: AIを使わない。保存された展開結果から項目別URLを取り出し、ページ構造・scope検査が正解と一致するかを数える */
export function evaluateB1(examples: BExample[]): B1Result {
  const r: B1Result = { examples: examples.length, items: 0, urlExtracted: 0, pageAvailable: 0, scope: { confirmed: 0, candidate: 0, mismatch: 0, unknown: 0 }, goldScored: 0, goldAgree: 0, goldDisagree: 0, unscored: 0 };
  for (const ex of examples) {
    const { items } = planXPost(ex.post);
    for (const plan of items) {
      r.items++;
      const url = plan.scopedUrls[0];
      if (!url) continue;
      r.urlExtracted++;
      const html = ex.pages[url];
      if (!html) continue;
      r.pageAvailable++;
      const st = parseApplyPage(html);
      const scoper = makeScoper(plan, items, storeFromGroupLabel);
      const v = scoper(url, { text: html.replace(/<[^>]+>/g, " "), structure: st });
      r.scope[v.verdict]++;
      const gold = ex.gold?.find((g) => g.itemNo === plan.itemNo);
      if (!gold) {
        r.unscored++;
        continue;
      }
      r.goldScored++;
      const right = pageMentions(html, gold.store);
      const accepted = v.verdict === "confirmed" || v.verdict === "candidate";
      if (right === accepted || (!right && v.verdict === "unknown")) r.goldAgree++;
      else r.goldDisagree++;
    }
  }
  return r;
}

/** B2の種: 応募URL・短縮URL・リンクの出所の行を**含めない**（URLが与えられない条件）。項目の原文からもURLを除く */
export function buildB2Seed(plan: ItemPlan): string {
  const text = plan.itemText.replace(/https?:\/\/\S+/g, "（URLは伏せられている）");
  return `【この項目の原文】${text}\n【応募先のURL】この項目には与えられていない。公開情報から探す必要がある`;
}

export interface B2Result {
  items: number;
  /** AIがページの取得を試みた */
  attempted: number;
  /** 取得できたページ */
  reachedPage: number;
  /** gold の店舗のページに**検索で見つけたURLから**到達し、対応の検査が mismatch でない（成功＝発見）。検索を使わずURLを知っていて取得できただけの項目は成功に数えない */
  success: number;
  /** gold の店舗のページに到達したが、検索で見つけたURLではない（URLを知っていた/推測した。発見成功とは数えない） */
  reachedWithoutSearch: number;
  /** 別の店舗などのページに到達した（対応の検査で mismatch。誤対応の提案を防げた） */
  wrongPage: number;
  /** 費用・調査の観測 */
  turns: number;
  noGold: number;
}

/** B2: 応募URLを与えず、AIが自律的に応募先へ到達・対応付けできるかを測る。gold のある項目だけ成功/失敗を数える */
export async function evaluateB2(a: { examples: BExample[]; agent: ResearchAgent; judge: RegistrationJudge; budget: CallBudget; limits?: Partial<ResearchLimits>; now: Date; /** 実際の検索ツール（承認後の実評価で注入）。無ければ例の searchIndex（mock）。どちらも無ければ検索できない */ search?: ResearchTools["search"] }): Promise<B2Result> {
  const out: B2Result = { items: 0, attempted: 0, reachedPage: 0, success: 0, reachedWithoutSearch: 0, wrongPage: 0, turns: 0, noGold: 0 };
  for (const ex of a.examples) {
    const { items } = planXPost(ex.post);
    const search: ResearchTools["search"] | undefined = a.search ?? (ex.searchIndex ? async (q) => ({ ok: true, hits: ex.searchIndex!.filter((s) => s.keywords.every((k) => q.includes(k))).flatMap((s) => s.hits), costJpy: 2 }) : undefined);
    const tools: ResearchTools = { now: () => a.now, ...(search ? { search } : {}), fetchPage: async (u): Promise<FetchOutcome> => (ex.pages[u] ? { ok: true, finalUrl: u, html: ex.pages[u], text: ex.pages[u].replace(/<[^>]+>/g, " ") } : { ok: false, reason: "not_public" }) };
    for (const plan of items) {
      out.items++;
      const gold = ex.gold?.find((g) => g.itemNo === plan.itemNo);
      const seed = seedEvidence(`s${plan.itemNo}`, buildB2Seed(plan), a.now);
      const scoper = makeScoper({ ...plan, links: [] }, items, storeFromGroupLabel);
      const r = await runResearch({ caseId: `${ex.id}#${plan.itemNo}`, seed, agent: a.agent, judge: a.judge, tools, budget: a.budget, limits: a.limits, scoper: (u, p) => scoper(u, { text: p.text, structure: p.structure }) });
      out.turns += r.investigation.turns;
      if (r.history.length) out.attempted++;
      const pages = r.evidence.filter((e) => e.kind === "page");
      if (pages.length) out.reachedPage++;
      if (!gold) {
        out.noGold++;
        continue;
      }
      const found = new Set(r.searches.map((s) => s.url));
      const rightPage = (p: (typeof pages)[number]) => !!(p.url && ex.pages[p.url] && pageMentions(ex.pages[p.url], gold.store) && p.scope?.verdict !== "mismatch");
      if (pages.some((p) => rightPage(p) && found.has(p.url ?? ""))) out.success++;
      else if (pages.some(rightPage)) out.reachedWithoutSearch++;
      else if (pages.length) out.wrongPage++;
    }
  }
  return out;
}
