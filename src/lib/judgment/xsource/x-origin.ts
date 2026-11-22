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
}

const STATUS_LINE: Record<ItemUrlStatus, string> = {
  url_from_item: "この項目自身のリンク（出所を確認済み）から応募先が分かっている",
  short_unexpanded: "この項目には短縮URLがあるが展開結果が無く、追跡していない（応募先は未確認）",
  shared_only_unverified: "この項目自身のリンクは無く、親投稿に共通のリンクだけがある（この項目への対応は未確認。別の店舗のページかもしれない）",
  url_missing: "URLなし（応募先は不明）。応募単位は未確認",
};

/** 保存済みの公開投稿を項目に分け、各項目の応募先リンクの出所と状態を決める（意味判断はしない） */
export function planXPost(post: StoredXPost): { isList: boolean; header: string; items: ItemPlan[] } {
  const parsed = parseListItems(post.text);
  const items: ListItem[] = parsed.isList
    ? parsed.items
    : [{ no: 1, groupNo: 1, groupLabel: "", text: post.text, start: 0, end: post.text.length, links: post.text.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? [], deadlineHint: null }];
  const linkMap = buildItemLinks({ items, linkMap: post.linkMap, parentLinks: post.links, recordedAt: post.recordedAt });
  const plans = items.map((it): ItemPlan => {
    const links = linkMap.get(it.no) ?? [];
    const scoped = itemScopedUrls(links);
    const status: ItemUrlStatus = scoped.length ? "url_from_item" : links.some((l) => l.origin === "item_text_short_unexpanded") ? "short_unexpanded" : links.some((l) => l.origin === "parent_shared" || l.origin === "parent_card") ? "shared_only_unverified" : "url_missing";
    const lines = [`【この項目の原文】${it.text}`, `【リンクの出所】${STATUS_LINE[status]}`];
    for (const l of links) {
      const host = canonUrl(l.url).host;
      lines.push(l.origin === "item_entity" ? `- この項目自身のリンク: ${l.url}` : l.origin === "item_text_short_unexpanded" ? `- 短縮URL（未展開・追跡しない）: ${host}` : `- 親投稿に共通のリンク（対応未確認）: ${l.url}`);
    }
    return { itemNo: it.no, groupLabel: it.groupLabel, itemText: it.text, links, scopedUrls: scoped, status, seedText: lines.join("\n") };
  });
  return { isList: parsed.isList, header: parsed.header, items: plans };
}

/** 同じ投稿内で、同じURLを重複して取得しない（キャッシュ）。ヒット数を数える */
export function cachedTools(tools: ResearchTools): ResearchTools & { hits: number; fetched: string[] } {
  const cache = new Map<string, Promise<FetchOutcome>>();
  const wrapped = {
    hits: 0,
    fetched: [] as string[],
    now: () => tools.now(),
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
    return { origin, verdict: origin === "discovered" && v.verdict === "confirmed" ? "candidate" : v.verdict, refutes: v.refutes };
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
}): Promise<{ plans: ItemPlan[]; results: { plan: ItemPlan; result: ResearchResult }[]; trace: XTraceRow[]; cacheHits: number }> {
  const { items } = planXPost(a.post);
  const tools = cachedTools(a.tools);
  const results: { plan: ItemPlan; result: ResearchResult }[] = [];
  for (const plan of items) {
    const scoper = makeScoper(plan, items, storeFromGroupLabel);
    const result = await runResearch({ caseId: `${a.post.postId}#${plan.itemNo}`, seed: seedEvidence(`s${plan.itemNo}`, plan.seedText, a.now), agent: a.agent, judge: a.judge, tools, budget: a.budget, limits: a.limits, scoper: (u, p) => scoper(u, { text: p.text, structure: p.structure }) });
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
  return { plans: items, results, trace, cacheHits: tools.hits };
}
