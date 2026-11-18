/**
 * 自律探索のツール（Stage 9H-3P）。すべて読み取り専用（外部のWeb／既存データの読み取り／この実行の中のメモ）。
 * 固定の巡回手順・店舗名・検索語は持たない。AIが会話の中の結果から、次に何をするかを選ぶ。
 * 取得してよいURLは「起点・公式サイト・検索結果・取得済みページのリンク」だけ（任意のURLへは広がらない）。アクセス頻度・内部アドレスの拒否は HostThrottle。
 * 収穫が逓減したら、固定ロジックが継続を断る（費用に見合わない探索を続けない）。
 */
import { ToolRegistry, type AgentTool } from "@/lib/agent/core";
import { HostThrottle } from "@/lib/agent/collection-planner/throttle";
import { judgeRegion } from "@/lib/collector/region";
import type { MissionBudget } from "./controls";
import type { DiscoveryMission, DiscoveryWorld, FocusDeclaration, FollowUp, RecordedLead, SourceUse } from "./types";
import { classifyCaseSource, type CaseSourceKind } from "@/lib/agent/case-investigator/source-class";
import { sameStore, urlKeyOf, verifyLead, type VerifyContext } from "./verify";

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const SOURCE_LABEL: Record<CaseSourceKind, string> = { organizer_official: "公式サイト", store_official: "店舗の公式ページ", official_social: "公式SNS", platform: "応募サービス", aggregator: "まとめサイト", social_other: "SNS投稿", unknown: "種類不明の情報源" };
const lotteryWord = /抽選|応募|エントリー|予約受付|当選/;
/** 個人情報・認証情報らしき検索語は送らない */
const UNSAFE_QUERY = /[\w.+-]+@[\w-]+\.[\w.]+|0\d{1,4}-?\d{1,4}-?\d{3,4}|password|パスワード|api[_ -]?key|秘密鍵/i;

export interface DiscoveryState {
  focus: FocusDeclaration[];
  sources: SourceUse[];
  follow: FollowUp[];
  leads: RecordedLead[];
  pages: Map<string, { title: string; text: string; links: { url: string; text: string }[] }>;
  searchHits: Map<string, { title: string; snippet: string; query: string }>;
  /** 検索した語（記録用） */
  queries: string[];
  /** 新しい情報が増えない取得・検索の連続回数 */
  stagnant: number;
  /** 費用・価値の判断で継続を断った回数と理由 */
  declined: { atStep: number; reason: string }[];
  /** 確認できなかった対象（開催なしとは断定しない） */
  unconfirmed: string[];
  seen: Set<string>;
  /** 取得してよい起点のURL（起点・公式サイト） */
  allowed: Set<string>;
}
export const newState = (m: DiscoveryMission): DiscoveryState => ({ focus: [], sources: [], follow: [], leads: [], pages: new Map(), searchHits: new Map(), queries: [], stagnant: 0, declined: [], unconfirmed: [], seen: new Set(), allowed: new Set(m.trigger.sourceUrl ? [urlKeyOf(m.trigger.sourceUrl)] : []) });

const because = (i: Record<string, unknown>): string => String(i.because ?? "").slice(0, 200);
const becauseProp = { because: { type: "string", description: "なぜ今これを調べるのか（直前の結果を踏まえた理由。調査履歴に残る）" } };
const norm = (s: unknown): string => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export interface BuildToolsOptions {
  mission: DiscoveryMission;
  world: DiscoveryWorld;
  budget: MissionBudget;
  state: DiscoveryState;
  throttle?: HostThrottle;
  sleep?: (ms: number) => Promise<void>;
}

export function buildDiscoveryTools(o: BuildToolsOptions): ToolRegistry {
  const { mission, world, state } = o;
  const reg = new ToolRegistry();
  const throttle = o.throttle ?? new HostThrottle(o.budget.throttle);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stepOf = (ctx: { budget: { usage: { steps: number } } }) => ctx.budget.usage.steps;
  const vctx = (): VerifyContext => ({ pages: new Map([...state.pages].map(([u, p]) => [u, { title: p.title, text: p.text }])), targetPrefectures: mission.targetPrefectures, knownStores: knownStoresCache, world, seen: state.seen, classify: (u) => { const c = classifyCaseSource(u, { officialHosts: [...state.allowed].map(hostOf).filter(Boolean), officialAccounts: [], aggregatorHosts: [], aggregatorAccounts: [] }); return { label: SOURCE_LABEL[c.kind], secondary: c.tier === "secondary" }; } });
  let knownStoresCache: Awaited<ReturnType<DiscoveryWorld["knownStores"]>> = [];
  const chainOf = (i: Record<string, unknown>): string => String(i.chain ?? mission.trigger.chain ?? "");

  /** 収穫逓減・費用に見合わない探索の継続を断る（固定ロジック。AIは変更できない）。断ったら理由を返し、AIは結論を出す */
  const declineReason = (ctx: { budget: { snapshot(): { costJpy: number }; limits: { maxCostJpy: number } } }, step: number): string | null => {
    if (state.stagnant >= o.budget.stagnantLimit) return `新しい情報が${state.stagnant}回続けて得られていません。調査の価値が費用に見合わないため、これ以上は続けられません。確認できた範囲と、確認できなかった対象を整理して終了してください（確認できなかったことは「開催なし」ではなく「未確認」です）`;
    const cost = ctx.budget.snapshot().costJpy;
    if (state.leads.length === 0 && cost >= ctx.budget.limits.maxCostJpy * o.budget.noLeadCostShare) return "費用の大半を使っても手がかりがありません。これ以上の探索は費用に見合わないため、未確認のまま終了してください";
    void step;
    return null;
  };
  const decline = (ctx: Parameters<typeof declineReason>[0], step: number) => {
    const r = declineReason(ctx, step);
    if (r) state.declined.push({ atStep: step, reason: r.slice(0, 120) });
    return r;
  };

  reg.register({
    name: "declare_focus",
    description: "いま調べる対象（系列・店舗群・商品・情報源）と、それを選んだ理由を宣言する。調査の方針を変えるたびに使う。宣言は調査履歴に残り、評価に使われる。",
    inputSchema: { type: "object", properties: { target: { type: "string" }, reason: { type: "string" } }, required: ["target", "reason"], additionalProperties: false },
    access: "read_internal",
    async run(i, ctx) {
      state.focus.push({ target: String(i.target ?? "").slice(0, 120), reason: String(i.reason ?? "").slice(0, 300), atStep: stepOf(ctx) });
      return { content: "記録しました" };
    },
  } satisfies AgentTool);

  if (world.search) {
    const search = world.search.bind(world);
    reg.register({
      name: "search_public_web",
      description: "公開検索で、関連する店舗・告知・公式サイト・店舗一覧・代替の情報源を探す。検索語はあなたが作る（直前の結果に合わせて変える）。同じ検索語は使えない。個人情報・認証情報を含めてはいけない。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, ...becauseProp }, required: ["query"], additionalProperties: false },
      access: "read_external",
      consumes: "search",
      dedupeKey: (i) => norm(i.query),
      async run(i, ctx) {
        const q = String(i.query ?? "").trim();
        const step = stepOf(ctx);
        if (!q || UNSAFE_QUERY.test(q)) throw new Error("個人情報・認証情報らしき内容を含む検索語は使えません");
        const dr = decline(ctx, step);
        if (dr) throw new Error(dr);
        state.queries.push(q);
        const rs = await search(q);
        ctx.budget.addCost(world.lastSearchCostJpy?.() ?? 0);
        let fresh = 0;
        for (const r of rs.slice(0, 8)) {
          if (!/^https?:\/\//.test(r.url)) continue;
          const k = urlKeyOf(r.url);
          if (!state.searchHits.has(k)) fresh += 1;
          state.searchHits.set(k, { title: r.title, snippet: r.snippet, query: q });
        }
        state.stagnant = fresh > 0 ? 0 : state.stagnant + 1;
        state.follow.push({ atStep: step, action: "search", input: q, because: because(i), outcome: `${rs.length}件（新しいURL ${fresh}件）` });
        return { content: rs.slice(0, 8).map((r) => `${r.title} ${r.url}\n${r.snippet}`).join("\n\n") || "（結果なし）", untrusted: true };
      },
    } satisfies AgentTool);
  }

  reg.register({
    name: "fetch_source_page",
    description: "ページを取得する。対象にできるのは、調査の起点のURL・系列の公式サイト・検索結果に出たURL・取得済みページに載っているリンクだけ。ロボット制限・ログインが必要なページは取得できない（回避しない）。取得できなければ、代替の情報源を探す。店舗一覧ページは、未知の店舗を見つける手がかりになる。",
    inputSchema: { type: "object", properties: { url: { type: "string" }, ...becauseProp }, required: ["url"], additionalProperties: false },
    access: "read_external",
    consumes: "fetch",
    dedupeKey: (i) => urlKeyOf(String(i.url ?? "")),
    async run(i, ctx) {
      const url = urlKeyOf(String(i.url ?? ""));
      const step = stepOf(ctx);
      const fromSearch = state.searchHits.has(url);
      const fromLink = [...state.pages.values()].some((p) => p.links.some((l) => urlKeyOf(l.url) === url));
      const provenance: SourceUse["provenance"] = url === urlKeyOf(mission.trigger.sourceUrl ?? "\u0000") ? "seed" : fromSearch ? "search" : fromLink ? "link" : state.allowed.has(url) ? "official_site" : "unknown";
      if (provenance === "unknown") throw new Error("起点・公式サイト・検索結果・取得済みページのリンクのいずれにも載っていないURLです（任意のURLへは広がりません）");
      const dr = decline(ctx, step);
      if (dr) throw new Error(dr);
      const d = throttle.admit(url);
      if (!d.ok) throw new Error(d.reason);
      if (d.waitMs > 0) await sleep(d.waitMs);
      const r = await world.fetchPage(url);
      if (!r.ok) {
        state.sources.push({ url, host: hostOf(url), ok: false, provenance, failReason: (r.reason ?? "取得できませんでした").slice(0, 100), atStep: step });
        state.stagnant += 1;
        state.follow.push({ atStep: step, action: "fetch", input: url, because: because(i), outcome: `取得できません（${(r.reason ?? "").slice(0, 60)}）` });
        throw new Error(`${r.reason ?? "ページを取得できませんでした"}。回避せず、代替の情報源（別のページ・検索）を探してください`);
      }
      const text = (r.text ?? "").slice(0, 20_000);
      const isNew = lotteryWord.test(`${r.title ?? ""}${text}`);
      state.pages.set(url, { title: r.title ?? "", text, links: r.links ?? [] });
      state.sources.push({ url, host: hostOf(url), ok: true, provenance, atStep: step });
      state.stagnant = isNew ? 0 : state.stagnant + 1;
      state.follow.push({ atStep: step, action: "fetch", input: url, because: because(i), outcome: `取得 ${text.length}字${isNew ? "（抽選・応募の記載あり）" : ""}` });
      const links = (r.links ?? []).slice(0, 40).map((l) => `- ${l.text.slice(0, 60)} ${l.url}`).join("\n");
      return { content: `${r.title ?? ""}\n${text.slice(0, 6000)}${links ? `\n\n[リンク]\n${links}` : ""}`, untrusted: true };
    },
  } satisfies AgentTool);

  reg.register({
    name: "list_known_stores",
    description: "登録済みの系列の店舗一覧（店舗マスター）を見る。公式の店舗一覧と突き合わせて、まだ抽選の情報がない店舗（未知の店舗）を探す手がかりにする。",
    inputSchema: { type: "object", properties: { chain: { type: "string" }, ...becauseProp }, required: [], additionalProperties: false },
    access: "read_internal",
    async run(i, ctx) {
      const chain = chainOf(i);
      knownStoresCache = await world.knownStores(chain);
      state.follow.push({ atStep: stepOf(ctx), action: "list_stores", input: chain, because: because(i), outcome: `${knownStoresCache.length}店舗` });
      const lines = knownStoresCache.slice(0, 80).map((s) => `- ${s.name}${s.prefecture ? `（${s.prefecture}）` : "（所在地不明）"}`);
      return { content: lines.length ? `${chain}の登録済みの店舗（${knownStoresCache.length}件。ここに無い店舗もあります）:\n${lines.join("\n")}` : `${chain}の登録済みの店舗はありません` };
    },
  } satisfies AgentTool);

  reg.register({
    name: "lookup_existing_lottery",
    description: "すでに登録・収集されている抽選を探す（読み取りのみ）。見つけた店舗の抽選が既にあるかを確認し、重複した調査・報告を避ける。出どころ（従来の収集／手動登録）と、人間が確認済みかも分かる。",
    inputSchema: { type: "object", properties: { chain: { type: "string" }, store: { type: "string" }, product: { type: "string" }, ...becauseProp }, required: [], additionalProperties: false },
    access: "read_internal",
    async run(i, ctx) {
      const hits = await world.existing({ chain: chainOf(i), store: i.store ? String(i.store) : undefined, product: i.product ? String(i.product) : undefined });
      state.follow.push({ atStep: stepOf(ctx), action: "lookup", input: `${chainOf(i)} ${i.store ?? ""} ${i.product ?? ""}`.trim(), because: because(i), outcome: `${hits.length}件` });
      return { content: hits.length ? hits.slice(0, 20).map((h) => `- ${h.chain} ${h.store} / ${h.products.join("・")}（出どころ: ${h.origin}${h.humanConfirmed ? "／人間確認済み" : ""}）`).join("\n") : "該当する登録済みの抽選はありません" };
    },
  } satisfies AgentTool);

  reg.register({
    name: "check_store_region",
    description: "店舗が収集の対象地域の内か外かを、店舗マスター・店舗名・告知の都道府県から判定する。外と確定したものだけが除外される。不明・食い違いは除外されず、要確認になる。",
    inputSchema: { type: "object", properties: { store: { type: "string" }, statedPrefecture: { type: "string" }, ...becauseProp }, required: ["store"], additionalProperties: false },
    access: "read_internal",
    async run(i, ctx) {
      const store = String(i.store ?? "");
      const m = knownStoresCache.find((s) => sameStore(s.name, chainOf(i), store, chainOf(i)));
      const j = judgeRegion({ masterPrefecture: m?.prefecture ?? null, address: m?.address ?? null, storeName: store, statedPrefecture: i.statedPrefecture ? String(i.statedPrefecture) : null });
      const t = mission.targetPrefectures;
      const verdict = t.length === 0 ? "対象（地域の制限なし）" : j.basis === "none" || j.basis === "conflict" || !j.prefecture ? "不明（除外されません）" : t.includes(j.prefecture) ? `対象地域の内（${j.prefecture}）` : `対象地域の外（${j.prefecture}）`;
      state.follow.push({ atStep: stepOf(ctx), action: "region_check", input: store, because: because(i), outcome: verdict });
      return { content: `${store}: ${verdict}／根拠: ${j.note}` };
    },
  } satisfies AgentTool);

  reg.register({
    name: "note_lead",
    description: "抽選の手がかりを記録する。取得したページの原文（quote）を必ず添える。系列共通の告知／店舗固有／店舗選択式（応募時に店舗を選ぶ）を scope で区別する。記録すると、固定の検証が根拠・重複・地域を確認して、採用・保留・除外とその理由を返す。確定した事実としては扱われない。",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string" },
        store: { type: "string" },
        scope: { type: "string", enum: ["store_specific", "chain_common", "store_select"] },
        products: { type: "array", items: { type: "string" } },
        applyStart: { type: "string", description: "YYYY-MM-DD（原文にあるときだけ）" },
        applyDeadline: { type: "string", description: "YYYY-MM-DD（原文にあるときだけ）" },
        url: { type: "string", description: "根拠のページ（取得したもの）" },
        quote: { type: "string", description: "そのページにある原文の抜粋" },
        statedPrefecture: { type: "string" },
        reason: { type: "string", description: "この手がかりを見つけた経緯" },
      },
      required: ["chain", "scope", "products", "url", "quote"],
      additionalProperties: false,
    },
    access: "read_internal",
    async run(i, ctx) {
      const lead = {
        chain: String(i.chain ?? ""),
        store: i.store ? String(i.store) : undefined,
        scope: (["store_specific", "chain_common", "store_select"].includes(String(i.scope)) ? i.scope : "store_specific") as RecordedLead["lead"]["scope"],
        products: Array.isArray(i.products) ? i.products.map(String).filter(Boolean) : [],
        applyStart: i.applyStart ? String(i.applyStart) : undefined,
        applyDeadline: i.applyDeadline ? String(i.applyDeadline) : undefined,
        url: String(i.url ?? ""),
        quote: String(i.quote ?? ""),
        statedPrefecture: i.statedPrefecture ? String(i.statedPrefecture) : undefined,
        reason: i.reason ? String(i.reason).slice(0, 300) : undefined,
      };
      if (knownStoresCache.length === 0) knownStoresCache = await world.knownStores(lead.chain).catch(() => []);
      const decision = await verifyLead(lead, vctx());
      state.leads.push({ lead, decision, atStep: stepOf(ctx) });
      if (decision.status !== "exclude" && decision.credit === "ai_new") state.stagnant = 0;
      return { content: `${decision.status === "adopt" ? "採用候補" : decision.status === "hold" ? "保留" : "除外"}: ${decision.reason}${decision.attention.length ? `／要確認: ${decision.attention.join("；")}` : ""}` };
    },
  } satisfies AgentTool);

  reg.register({
    name: "get_progress",
    description: "ここまでの成果（記録した手がかりの採用・保留・除外の数）、新しい情報が増えていない回数、残りの余力を見る。調査を続けるか、終了するかの判断に使う。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    access: "read_internal",
    async run(_i, ctx) {
      const u = ctx.budget.snapshot();
      const l = ctx.budget.limits;
      const n = (s: string) => state.leads.filter((x) => x.decision.status === s).length;
      const fresh = state.leads.filter((x) => x.decision.credit === "ai_new").length;
      return { content: `手がかり: 採用候補${n("adopt")}・保留${n("hold")}・除外${n("exclude")}（うち既存に無い新規 ${fresh}）／新しい情報が増えない連続回数: ${state.stagnant}（${o.budget.stagnantLimit}で継続不可）／残り: 検索${Math.max(0, l.maxSearches - u.searches)}・取得${Math.max(0, l.maxFetches - u.fetches)}・ステップ${Math.max(0, l.maxSteps - u.steps)}・費用${Math.max(0, l.maxCostJpy - u.costJpy).toFixed(1)}円` };
    },
  } satisfies AgentTool);

  return reg;
}
