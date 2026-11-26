/**
 * X起点の接続（Stage 10V・開発用アダプタ）。**取得した元投稿 → 各抽選項目 → 各項目の応募先URLと出所 → 公開ページの受付構造 → AIに渡す証拠 → AI判断 → 登録案**を、対応が切れない形でつなぐ。
 * 既存資産を再利用し、意味判断は重複実装しない: 項目の分割（list-items）、項目ごとのリンクの出所（10S item-links / link-scope）、ページ構造（10T page-structure）、調査と登録判断（10U research-loop）。
 *
 * 原則（固定処理の範囲＝出所の記録・取得の抑制・対応の検査）:
 *  - **親投稿の一括リンクを別店舗の応募先へ流用しない**。項目自身のリンク（item_entity）だけを「この項目の応募先」として渡し、親投稿共通のリンクは「対応が未確認」と明示して渡す。
 *  - **URLが無い／短縮URLが展開できない項目は「URLなし・応募単位未確認」**として追跡できるようにし、確定させない（AIへ渡す証拠にもその旨を書く）。
 *  - 取得できなかった場合は、取得状況と理由を残す。同じURLは投稿内で1回だけ取得する（キャッシュ）。X・短縮URLは追跡しない。
 *  - 実X APIは使わない。保存済みの公開投稿・展開結果（linkMap）の再生で入口を通す（X本番接続は未検証）。
 */
import { parseListItems, type ListItem } from "../list-items";
import type { CallBudget } from "../call-budget";
import { judgeLinkScope, type ItemLink } from "./link-scope";
import { buildItemLinks, itemScopedUrls, sameUrlCounts } from "./item-links";
import { buildLinkEvidence, deriveLinkMap, type LinkEvidenceRecord } from "./link-evidence";
import { canonUrl } from "./normalize";
import { runResearch, seedEvidence, type EvidenceScope, type FetchOutcome, type RegistrationJudge, type ResearchAgent, type ResearchLimits, type ResearchResult, type ResearchTools } from "./research-loop";

/** 保存済みの公開投稿（再生用）。linkMap は収集時に保存された「短縮URL→展開URL」 */
export interface StoredXPost {
  postId: string;
  text: string;
  /** 親投稿に付いていた展開済みリンク（全項目に共通） */
  links: string[];
  linkMap?: { short: string; url: string }[];
  recordedAt: string | null;
  /**
   * 収集時にこの投稿・カードを取得した元のページ（source_url／evidence.url）。**応募先URLとは別の意味**: 応募先とは限らず、これだけで応募機会・応募単位を確定しない。
   * AIには出所つき（「収集時の取得元ページ」）で渡し、ページ内の記載を読んで判断させる。無ければ従来どおり。
   */
  sourcePage?: { url: string; via?: string; fetchedAt?: string | null };
  /** 収集時の文脈の注記（本文の切り詰め・画像から読み取った情報など）。全項目の観察として渡す（引用の根拠にはしない） */
  notes?: string[];
}

export type ItemUrlStatus = "url_from_item" | "short_unexpanded" | "shared_only_unverified" | "url_missing";
export interface ItemPlan {
  itemNo: number;
  groupLabel: string;
  itemText: string;
  links: ItemLink[];
  /** この項目の応募先として確定的に渡せるURL（項目自身の展開済みリンクのみ） */
  scopedUrls: string[];
  status: ItemUrlStatus;
  /** AIへ渡す種（原文＋リンクの出所の明示）。別店舗へ流用していないことが読める */
  seedText: string;
  /** この項目の応募先URLの根拠（展開方式・本文中の位置・項目の範囲・未展開の理由）。URLなしの項目も1件残る */
  linkEvidence: LinkEvidenceRecord[];
  /** 投稿全体の注記（StoredXPost.notes）。調査・判断の入力に観察として届く */
  notes: string[];
}

const STATUS_LINE: Record<ItemUrlStatus, string> = {
  url_from_item: "この項目自身のリンク（出所を確認済み）から応募先が分かっている",
  short_unexpanded: "この項目には短縮URLがあるが展開結果が無く、追跡していない（応募先は未確認）。検索が使えるなら、原文の店舗名・商品名・日時で公開ページを探してよい（見つけたページが、この項目の店舗・商品と一致するか確認する）",
  shared_only_unverified: "この項目自身のリンクは無く、親投稿に共通のリンクだけがある（この項目への対応は未確認。別の店舗のページかもしれない）",
  url_missing: "URLなし（応募先は不明）。応募単位は未確認。検索が使えるなら、原文の店舗名・商品名・日時で公開ページを探してよい（見つけたページが、この項目の店舗・商品と一致するか確認する）",
};

/** 保存済みの公開投稿を項目に分け、各項目の応募先リンクの出所と状態を決める（意味判断はしない） */
export function planXPost(post: StoredXPost): { isList: boolean; header: string; items: ItemPlan[] } {
  const parsed = parseListItems(post.text);
  const items: ListItem[] = parsed.isList
    ? parsed.items
    : [{ no: 1, groupNo: 1, groupLabel: "", text: post.text, start: 0, end: post.text.length, links: post.text.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? [], deadlineHint: null }];
  // 展開結果: 保存された linkMap（X APIのentity）を第一候補。無いときは、一意に決まる対応だけを復元する（推測で埋めない）
  const derived = deriveLinkMap(post);
  const linkMap = buildItemLinks({ items, linkMap: derived.linkMap.length ? derived.linkMap : undefined, parentLinks: post.links, recordedAt: post.recordedAt });
  const evidence = buildLinkEvidence(post, items, derived.methods, derived.linkMap);
  const plans = items.map((it): ItemPlan => {
    const links = linkMap.get(it.no) ?? [];
    const scoped = itemScopedUrls(links);
    const status: ItemUrlStatus = scoped.length ? "url_from_item" : links.some((l) => l.origin === "item_text_short_unexpanded") ? "short_unexpanded" : links.some((l) => l.origin === "parent_shared" || l.origin === "parent_card") ? "shared_only_unverified" : "url_missing";
    const lines = [`【この項目の原文】${it.text}`, `【リンクの出所】${STATUS_LINE[status]}`];
    // 収集時の取得元ページ: 応募先URLとは別の意味で渡す（応募先とは限らない・これだけで応募機会や応募単位を確定しない。ページ内の記載を読んで判断する）
    if (post.sourcePage) lines.push(`【収集時の取得元ページ（応募先とは限らない。応募先URLとは別）${parsed.isList ? "・投稿全体の取得元で、この項目との対応は未確認" : ""}${post.sourcePage.via ? `・取得方法: ${post.sourcePage.via}` : ""}】 ${post.sourcePage.url}`);
    for (const l of links) {
      const host = canonUrl(l.url).host;
      lines.push(l.origin === "item_entity" ? `- この項目自身のリンク: ${l.url}` : l.origin === "item_text_short_unexpanded" ? `- 短縮URL（未展開・追跡しない）: ${host}` : `- 親投稿に共通のリンク（対応未確認）: ${l.url}`);
    }
    return { itemNo: it.no, groupLabel: it.groupLabel, itemText: it.text, links, scopedUrls: scoped, status, seedText: lines.join("\n"), linkEvidence: evidence.filter((e) => e.itemNo === it.no), notes: post.notes ?? [] };
  });
  return { isList: parsed.isList, header: parsed.header, items: plans };
}

/**
 * 同じ投稿内で、同じURLを重複して取得しない／同じ検索語を重複して実行しない（キャッシュ）。ヒット数を数える。
 * **検索ツール（search）も引き継ぐ**（Phase 2 P2 の不具合: 以前は fetchPage と now しか返さず、注入した検索ツールが消えていた。調査AIには「検索は使えない」と通知され、URLなしの3件で検索が0回だった）。
 * 検索の上限・予算の予約・重複の禁止・結果の安全化（makeSearchTool）は調査ループとツール側が担う。ここは「同じ投稿内の同じ検索語」を有料検索で2回実行しないためのキャッシュだけ（2回目は費用0）。
 */
export function cachedTools(tools: ResearchTools): ResearchTools & { hits: number; fetched: string[]; searchHits: number; searched: string[] } {
  const cache = new Map<string, Promise<FetchOutcome>>();
  const searchCache = new Map<string, ReturnType<NonNullable<ResearchTools["search"]>>>();
  const nq = (q: string): string => q.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
  const wrapped = {
    hits: 0,
    fetched: [] as string[],
    searchHits: 0,
    searched: [] as string[],
    now: () => tools.now(),
    ...(tools.readHints ? { readHints: (url: string, text: string) => tools.readHints!(url, text) } : {}),
    fetchPage: (url: string): Promise<FetchOutcome> => {
      const k = canonUrl(url).key;
      const hit = cache.get(k);
      if (hit) {
        wrapped.hits++;
        return hit;
      }
      wrapped.fetched.push(url);
      const p = tools.fetchPage(url);
      cache.set(k, p);
      return p;
    },
    ...(tools.search
      ? {
          search: (query: string) => {
            const k = nq(query);
            const hit = searchCache.get(k);
            if (hit) {
              wrapped.searchHits++;
              return hit.then((r) => (r.ok ? { ...r, costJpy: 0 } : r)); // 同じ検索語の2回目は実行しない（費用0）
            }
            wrapped.searched.push(query);
            const p = tools.search!(query);
            searchCache.set(k, p);
            return p;
          },
        }
      : {}),
  };
  return wrapped;
}

/** 取得したページが、この項目の応募先として対応するか（10S link-scope）。リンクの出所は、そのURLがこの項目へ割り当てられた出所を使う（無い=AIが自ら見つけたURL） */
export function makeScoper(plan: ItemPlan, siblings: ItemPlan[], storeOf: (groupLabel: string) => string | null): (url: string, page: { text: string; structure: { slots: { title: string }[]; title: string | null } | null }) => EvidenceScope {
  const counts = sameUrlCounts(new Map(siblings.map((s) => [s.itemNo, s.links])));
  const otherStores = [...new Set(siblings.filter((s) => s.itemNo !== plan.itemNo).map((s) => storeOf(s.groupLabel) ?? "").filter((n) => n.length >= 3))];
  return (url, page) => {
    const key = canonUrl(url).key;
    const link = plan.links.find((l) => canonUrl(l.url).key === key);
    const origin = link?.origin ?? "discovered";
    const head = [page.structure?.title ?? "", ...(page.structure?.slots.map((s) => s.title) ?? [])].join("\n");
    const v = judgeLinkScope({ link: { origin: origin === "discovered" ? "item_entity" : origin }, item: { chain: null, store: storeOf(plan.groupLabel), products: [] }, page: { head, lines: page.text.split(/\n+/).slice(0, 60) }, otherStores, otherProducts: [], sameUrlItems: counts.get(key) ?? 1 });
    // AI自身が見つけたURL（discovered）は、項目への割り当てが無い。店舗・商品の反証が無ければ candidate、あれば mismatch
    // 既存の保存情報から復元した対応（stored_unique_pair）は、X APIの展開結果ではないため、ページが項目の店舗を名指ししていない限り candidate 止まり（確定にしない）
    const method = plan.linkEvidence.find((e) => e.expandedUrl && canonUrl(e.expandedUrl).key === key)?.method;
    const weak = method === "stored_unique_pair" && v.verdict === "confirmed" && !v.supports.includes("page_names_item_store");
    return { origin, verdict: origin === "discovered" && v.verdict === "confirmed" ? "candidate" : weak ? "candidate" : v.verdict, refutes: v.refutes };
  };
}

/** 見出し（《店舗名（県）- n件》・🏬店舗）から店舗名の手掛かりを取り出す（表示・反証用。判断ではない） */
export const storeFromGroupLabel = (label: string): string | null => {
  const m = /《([^（》-]{2,40})/.exec(label) ?? /🏬\s*([^\s（]{2,40})/.exec(label);
  return m ? m[1].trim() : null;
};

export interface XTraceRow {
  postId: string;
  itemNo: number;
  urlStatus: ItemUrlStatus;
  links: { host: string; origin: string }[];
  fetches: { host: string; outcome: string }[];
  pages: { host: string; slots: number; related: number; scope: string | null }[];
  investigationEnd: string;
  decision: string;
  verified: boolean;
  held: string[] | null;
  fieldBasis: Record<string, string>;
  turns: number;
}

/** 保存済みの投稿1件を、項目ごとに 調査→登録判断 まで通す（開発用の再生）。項目ごとに独立した案件として扱い、結果を追跡表の行にする */
export async function runXPostReplay(a: {
  post: StoredXPost;
  agent: ResearchAgent;
  judge: RegistrationJudge;
  tools: ResearchTools;
  budget: CallBudget;
  limits?: Partial<ResearchLimits>;
  now: Date;
  /** 協調的な中止（Phase 2）。項目の処理の前に確認し、true なら以降の項目を処理せずに終える（中止した項目は結果に含めない。実行中のAI呼び出しは完了まで待つ）。 */
  shouldStop?: () => boolean;
  /** 人が確定した値（項目ごと。レビューの修正）。調査・判断はこれを変更せず、食い違いは人への確認に回る（検証層が保護）。モデルが学習したのではなく、保存した人の判断を次回の入力に使うだけ */
  protectedFor?: (itemNo: number, plan: ItemPlan) => Record<string, string> | undefined;
  /** 項目ごとの予算（1件上限）。未指定なら budget をそのまま使う */
  budgetFor?: (itemNo: number) => CallBudget;
  /** 登録案の経路: 応募単位が未確定の本登録案を検証の指摘にする */
  registerRequiresUnit?: boolean;
  /** 利用者の対象地域（既存の収集設定）。検証層が、地域外を理由とする除外の事実を確認する */
  userRegion?: import("./claim-semantics").UserRegion;
}): Promise<{ plans: ItemPlan[]; results: { plan: ItemPlan; result: ResearchResult }[]; trace: XTraceRow[]; cacheHits: number; stopped: boolean }> {
  const { items } = planXPost(a.post);
  const tools = cachedTools(a.tools);
  const results: { plan: ItemPlan; result: ResearchResult }[] = [];
  let stopped = false;
  for (const plan of items) {
    if (a.shouldStop?.()) {
      stopped = true;
      break;
    }
    const scoper = makeScoper(plan, items, storeFromGroupLabel);
    const result = await runResearch({ caseId: `${a.post.postId}#${plan.itemNo}`, seed: seedEvidence(`s${plan.itemNo}`, plan.seedText, a.now, null, plan.notes), agent: a.agent, judge: a.judge, tools, budget: a.budgetFor?.(plan.itemNo) ?? a.budget, limits: a.limits, protectedFields: a.protectedFor?.(plan.itemNo, plan), registerRequiresUnit: a.registerRequiresUnit, ...(a.userRegion ? { userRegion: a.userRegion } : {}), ...(a.post.sourcePage && plan.scopedUrls.length === 0 ? { autoFetch: [a.post.sourcePage.url] } : {}), scoper: (u, p) => scoper(u, { text: p.text, structure: p.structure }) });
    results.push({ plan, result });
  }
  const trace: XTraceRow[] = results.map(({ plan, result }) => ({
    postId: a.post.postId,
    itemNo: plan.itemNo,
    urlStatus: plan.status,
    links: plan.links.map((l) => ({ host: canonUrl(l.url).host, origin: l.origin })),
    fetches: result.history.map((h) => ({ host: h.host, outcome: h.outcome })),
    pages: result.evidence.filter((e) => e.kind === "page").map((e) => ({ host: e.url ? canonUrl(e.url).host : "", slots: e.structure?.slots.length ?? 0, related: e.structure?.relatedEvents.length ?? 0, scope: e.scope ? `${e.scope.origin}/${e.scope.verdict}` : null })),
    investigationEnd: result.investigation.reason,
    decision: result.registration.decision,
    verified: result.registration.verified,
    held: result.registration.held?.reasons ?? null,
    fieldBasis: Object.fromEntries(Object.entries(result.registration.output?.fields ?? {}).map(([k, f]) => [k, f.basis])),
    turns: result.investigation.turns,
  }));
  return { plans: items, results, trace, cacheHits: tools.hits, stopped };
}
