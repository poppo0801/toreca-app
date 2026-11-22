/**
 * 条件B（Stage 10W）の評価基盤。**入力既知の評価（B1）と、自律発見の評価（B2）を混同しない**:
 *  - B1（展開・項目スコープ）: 投稿から項目別の展開済みリンクを取り出し、公開ページに対応づけられるか。**展開結果を入力として与えている**ので、AIの発見力の評価ではない（AIを使わない）。
 *  - B2（AI自律発見）: 応募URLを**与えず**（種からURL・短縮URLを除く）、AIが公開情報から応募先に到達し、項目と対応づけられるか。**成功は「独立した正解の店舗のページに到達し、対応の検査で mismatch でない」こと**。
 *      現在の読み取り専用ツールは「公開ページの取得」だけで、検索のツールは無い。そのため B2 は、AIが自分で提案したURLを取得できる範囲の評価（検索機能が必要なら別途の設計・承認）。
 * 正解（gold: 項目の正しい店舗。独立した原文・公開ページで人が確認したもの）は採点側だけが持ち、AIの入力に含めない。例が無いときは評価を実施せず「評価不能」と報告する（テストの失敗にしない）。
 */
import { CaseBudget, type CallBudget } from "../call-budget";
import { parseApplyPage } from "./page-structure";
import { canonUrl } from "./normalize";
import { pageText } from "./html-text";
import type { QuoteAuditRow } from "./research-loop";
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

/** 事例ごとの記録（原文・URLは含めず、ホスト名と件数だけ） */
export interface B2CaseRow {
  id: string;
  gold: boolean;
  /** 検索ごとの結果。hits は後で無課金で再生するための資産（ローカル限定・Git管理外の出力にだけ書く。検索結果の題名とURL） */
  searches: { query: string; hitCount: number; hitHosts: string[]; hits: { title: string; url: string }[] }[];
  fetched: { host: string; outcome: string }[];
  end: string;
  decision: string;
  held: string[] | null;
  /** 調査の経路（検索の成否・取得の成否。URLはホスト名に置き換える） */
  trace: string[];
  /** 検索結果に、正解の店舗ページ（保存ページ）が含まれたか（gold のある項目のみ） */
  goldPageInHits: boolean | null;
  /** AIが正解の店舗ページを取得したか／そのときの応募先照合の結果 */
  goldPageFetched: { fetched: boolean; scope: string | null } | null;
  quoteAudit: { round: number; rows: QuoteAuditRow[] }[];
  result: "success" | "reachedWithoutSearch" | "wrongPage" | "noPage" | "noGold";
}

export interface B2Result {
  /** 事例ごとの記録（失敗層の分類用） */
  rows?: B2CaseRow[];
  /** 取得モード（保存HTMLの再生か、実ページの安全な取得か） */
  fetchMode?: B2FetchMode;
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
export async function evaluateB2(a: { examples: BExample[]; agent: ResearchAgent; judge: RegistrationJudge; budget: CallBudget; limits?: Partial<ResearchLimits>; now: Date; /** 1件あたりの費用の上限（円）。指定すると、全体の上限とは別に1件ごとに止める */ perCaseCapJpy?: number; /** 事例の開始時（失敗の記録を事例に紐づける用） */ onCase?: (id: string) => void; /** 取得モード（既定は保存HTMLの再生。live_public は開発限定の実ページ取得で liveFetch が必要） */ fetchMode?: B2FetchMode; liveFetch?: (u: string) => Promise<FetchOutcome>; /** 実際の検索ツール（承認後の実評価で注入）。無ければ例の searchIndex（mock）。どちらも無ければ検索できない */ search?: ResearchTools["search"] }): Promise<B2Result> {
  const out: B2Result = { fetchMode: a.fetchMode ?? "replay_saved", rows: [], items: 0, attempted: 0, reachedPage: 0, success: 0, reachedWithoutSearch: 0, wrongPage: 0, turns: 0, noGold: 0 };
  for (const ex of a.examples) {
    const { items } = planXPost(ex.post);
    const search: ResearchTools["search"] | undefined = a.search ?? (ex.searchIndex ? async (q) => ({ ok: true, hits: ex.searchIndex!.filter((s) => s.keywords.every((k) => q.includes(k))).flatMap((s) => s.hits), costJpy: 2 }) : undefined);
    // 保存済みページの照会は、URLの表記ゆれ（末尾の/・追跡パラメータ）を正規化して一致させる（検索が返した表記が保存時と違うだけで取得不能にしない）
    const pageKey = new Map(Object.keys(ex.pages).map((u) => [canonUrl(u).key, u]));
    const stored = (u: string): string | undefined => (ex.pages[u] !== undefined ? u : pageKey.get(canonUrl(u).key));
    if ((a.fetchMode ?? "replay_saved") === "live_public" && !a.liveFetch) throw new Error("live_public には liveFetch が必要です");
    const live = (a.fetchMode ?? "replay_saved") === "live_public" ? a.liveFetch : undefined;
    const tools: ResearchTools = { now: () => a.now, ...(search ? { search } : {}), fetchPage: live ? live : async (u): Promise<FetchOutcome> => { const k = stored(u); return k ? { ok: true, finalUrl: k, html: ex.pages[k], text: pageText(ex.pages[k]) } : { ok: false, reason: "not_public" }; } };
    for (const plan of items) {
      out.items++;
      const gold = ex.gold?.find((g) => g.itemNo === plan.itemNo);
      const seed = seedEvidence(`s${plan.itemNo}`, buildB2Seed(plan), a.now);
      const scoper = makeScoper({ ...plan, links: [] }, items, storeFromGroupLabel);
      a.onCase?.(`${ex.id}#${plan.itemNo}`);
      const budget = a.perCaseCapJpy ? new CaseBudget(a.budget, a.perCaseCapJpy) : a.budget;
      const r = await runResearch({ caseId: `${ex.id}#${plan.itemNo}`, seed, agent: a.agent, judge: a.judge, tools, budget, limits: a.limits, scoper: (u, p) => scoper(u, { text: p.text, structure: p.structure }) });
      out.turns += r.investigation.turns;
      if (r.history.length) out.attempted++;
      const pages = r.evidence.filter((e) => e.kind === "page");
      if (pages.length) out.reachedPage++;
      const row: B2CaseRow = { id: `${ex.id}#${plan.itemNo}`, gold: !!gold, searches: [...new Set(r.searches.map((x) => x.query))].map((q) => { const hs = r.searches.filter((x) => x.query === q); return { query: q, hitCount: hs.length, hits: hs.map((h) => ({ title: h.title.slice(0, 120), url: h.url })), hitHosts: [...new Set(hs.map((h) => canonUrl(h.url).host))].slice(0, 6) }; }), fetched: r.history.map((h) => ({ host: h.host, outcome: h.outcome })), end: r.investigation.reason, decision: r.registration.decision, held: r.registration.held?.reasons ?? null, trace: r.trace.map((t) => `${t.kind}:${t.detail.replace(/https?:\/\/\S+/g, (u) => canonUrl(u).host)}`), goldPageInHits: null, goldPageFetched: null, quoteAudit: r.quoteAudit, result: pages.length ? "wrongPage" : "noPage" };
      out.rows!.push(row);
      if (!gold) {
        out.noGold++;
        row.result = "noGold";
        continue;
      }
      const found = new Set(r.searches.map((s) => canonUrl(s.url).key));
      const goldKeys = Object.keys(ex.pages).filter((u) => pageMentions(ex.pages[u], gold.store)).map((u) => canonUrl(u).key);
      row.goldPageInHits = goldKeys.some((k) => found.has(k));
      const gp = pages.find((p) => p.url && goldKeys.includes(canonUrl(p.url).key));
      row.goldPageFetched = { fetched: !!gp, scope: gp?.scope ? `${gp.scope.origin}/${gp.scope.verdict}` : null };
      // 保存モード: 保存ページ自身が正解の店舗を名指ししていること。実ページモード: 取得したページ（または保存ページとURLが一致するもの）の題名・受付枠が正解の店舗を名指しし、対応の検査が mismatch でないこと
      const headMentions = (p: (typeof pages)[number]) => { const k = norm(gold.store).replace(/店$/, ""); return k.length >= 2 && norm([p.structure?.title ?? "", ...(p.structure?.slots.map((x) => x.title) ?? [])].join(" ")).includes(k); };
      const rightPage = (p: (typeof pages)[number]) => !!(p.url && p.scope?.verdict !== "mismatch" && (live ? headMentions(p) || goldKeys.includes(canonUrl(p.url).key) : ex.pages[p.url] && pageMentions(ex.pages[p.url], gold.store)));
      if (pages.some((p) => rightPage(p) && found.has(canonUrl(p.url ?? "").key))) {
        out.success++;
        row.result = "success";
      } else if (pages.some(rightPage)) {
        out.reachedWithoutSearch++;
        row.result = "reachedWithoutSearch";
      } else if (pages.length) out.wrongPage++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ Stage 10Y: 実世界の公開ページの扱い（取得モードを明示する）
/**
 * B2の取得モード（混ぜない）:
 *  - `replay_saved`（厳密な旧基準）: 保存済みHTMLだけを再生。保存に無いURLは取得不能（能力の失敗ではなく**評価の制約**）。
 *  - `live_public`（開発限定）: 実際の公開ページを、既存の安全な取得（robots・SSRF・間隔・サイズ・時間）で取得する。**取得の経路が裏付けられたときだけ**同じページと数える（URLの正規化一致、
 *    または取得したページの題名・受付枠が正解の店舗を名指ししていること）。
 */
export type B2FetchMode = "replay_saved" | "live_public";

/** 保存ページに対する、実ページ（現在の公開状態）の分類。**終了イベントの404やロボット制限は、モデル能力の失敗として数えない** */
export type CandidateClass = "current_page_matches" | "ended_event_page" | "gone_404" | "blocked_robots" | "blocked_auth" | "transient_network" | "page_changed" | "denied_or_other";

export interface CandidateRow {
  id: string;
  candidate: "saved_url（候補として与えた。検索による発見ではない）";
  host: string;
  class: CandidateClass;
  endedPage: boolean | null;
  storeMentioned: boolean | null;
  sameTitleAsSaved: boolean | null;
  slots: number | null;
  scope: string | null;
}

/** AIも検索も使わない（無課金）。保存済みの応募ページのURLを「候補」として与え、実際の公開ページを安全に取得して、現行か・終了か・取得できないかを分類する */
export async function replayCandidatesLive(a: { examples: BExample[]; fetchPage: (u: string) => Promise<FetchOutcome>; lastLog: () => { outcome: string; endedPage?: boolean } | undefined }): Promise<{ rows: CandidateRow[]; counts: Record<CandidateClass, number> }> {
  const rows: CandidateRow[] = [];
  for (const ex of a.examples) {
    const { items } = planXPost(ex.post);
    for (const plan of items) {
      const gold = ex.gold?.find((g) => g.itemNo === plan.itemNo);
      for (const [url, savedHtml] of Object.entries(ex.pages)) {
        const host = canonUrl(url).host;
        const r = await a.fetchPage(url);
        const rec = a.lastLog();
        const saved = parseApplyPage(savedHtml);
        let cls: CandidateClass = "denied_or_other";
        let row: Omit<CandidateRow, "class"> = { id: `${ex.id}#${plan.itemNo}`, candidate: "saved_url（候補として与えた。検索による発見ではない）", host, endedPage: null, storeMentioned: null, sameTitleAsSaved: null, slots: null, scope: null };
        if (r.ok) {
          const live = parseApplyPage(r.html);
          const scoper = makeScoper({ ...plan, links: [] }, items, storeFromGroupLabel);
          const sc = scoper(r.finalUrl, { text: r.text, structure: live });
          const mentioned = gold ? pageMentions(r.html, gold.store) : null;
          const sameTitle = norm(live.title ?? "") === norm(saved.title ?? "") && !!live.title;
          row = { ...row, endedPage: rec?.endedPage ?? null, storeMentioned: mentioned, sameTitleAsSaved: sameTitle, slots: live.slots.length, scope: `${sc.origin}/${sc.verdict}` };
          cls = rec?.endedPage ? "ended_event_page" : sameTitle || mentioned ? "current_page_matches" : "page_changed";
        } else if (rec?.outcome === "ended_http") cls = (rec as { status?: number }).status === 404 || (rec as { status?: number }).status === 410 ? "gone_404" : "denied_or_other";
        else if (rec?.outcome === "robots") cls = "blocked_robots";
        else if (rec?.outcome === "auth_required" || rec?.outcome === "login_page") cls = "blocked_auth";
        else if (rec?.outcome === "timeout" || rec?.outcome === "network") cls = "transient_network";
        rows.push({ ...row, class: cls });
      }
    }
  }
  const counts = { current_page_matches: 0, ended_event_page: 0, gone_404: 0, blocked_robots: 0, blocked_auth: 0, transient_network: 0, page_changed: 0, denied_or_other: 0 } as Record<CandidateClass, number>;
  for (const r of rows) counts[r.class]++;
  return { rows, counts };
}

/** B2 の失敗した層の分類（事例ごと）。終了イベント・取得制限は能力の失敗に数えない */
export type B2Layer = "success" | "no_search_used" | "search_missed_gold_page" | "model_did_not_select_gold_page" | "fetch_blocked_or_ended" | "reached_without_search" | "wrong_page" | "no_gold";
export function classifyB2Layer(row: B2CaseRow): B2Layer {
  if (row.result === "success") return "success";
  if (row.result === "noGold") return "no_gold";
  if (row.result === "reachedWithoutSearch") return "reached_without_search";
  if (row.result === "wrongPage") return "wrong_page";
  if (!row.searches.length) return "no_search_used";
  if (row.goldPageInHits === false) return row.fetched.some((f) => f.outcome !== "ok") ? "fetch_blocked_or_ended" : "search_missed_gold_page";
  if (row.goldPageInHits === true && !row.goldPageFetched?.fetched) return row.fetched.some((f) => f.outcome !== "ok") ? "fetch_blocked_or_ended" : "model_did_not_select_gold_page";
  return "no_search_used";
}
