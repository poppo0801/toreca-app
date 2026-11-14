/**
 * 案件調査のツール（読み取り専用・Stage 9H-1）。AIが選べる調査行動:
 *   get_case_state        内部: いまの調査状況（項目ごとの採用値・根拠・矛盾、情報源の記録、不足、調査量の方針）を読む
 *   search_public_web     外部: 検索語をAIが作って公開検索する（検索語・調査順序はAIが選ぶ。個人情報を含む検索語は断る）
 *   fetch_source_page     外部: ページを取得する（登録済みの情報源・検索結果・取得済みページのリンクだけが対象）
 *   report_page_findings  内部: 取得したページから読み取った項目を、原文の根拠つきで台帳へ報告する（検証層が根拠・同一抽選を確認してから統合する。DBは変更しない）
 * 調査の終了は、AIの最終出力（finish）で選ぶ。調査量の方針（状況に応じた割り当て）と固定の天井は、ツールの外側で強制し、AIは変更できない。
 * 外部ページの文面はデータとして囲み、命令らしき文面は記録だけして従わない。書き込み・SQL・実行・投稿に当たるツールは登録できない（ToolRegistry）。
 */
import { detectInjection, ToolRegistry, wrapUntrusted, type AgentTool, type ToolOutput } from "@/lib/agent/core";
import { HostThrottle } from "@/lib/agent/collection-planner/throttle";
import type { PageData, PlannerWorld } from "@/lib/agent/collection-planner/types";
import { FIELD_LABEL, type FieldKey } from "@/lib/collector/fields";
import { assess, type Ceilings, type Sufficiency } from "./sufficiency";
import { CaseLedger, type FetchFailKind, type Observation } from "./ledger";
import { basisOfQuote, classifyCaseSource, detectOrigin, hostOf, squash, tierOfCase, type ClassifyContext } from "./source-class";
import type { IdentityFacts } from "./identity";

const norm = (u: string): string => u.trim().replace(/#.*$/, "");
const purposeProp = { purpose: { type: "string", description: "この調査の目的・理由（短く。記録に残る）" } };
const FIELD_ENUM: FieldKey[] = ["chain", "store", "items", "applyStart", "applyDeadline", "resultDate", "applyMethod", "conditions", "applyUrl", "receiveMethod"];

export interface CaseToolOptions {
  ledger: CaseLedger;
  world: PlannerWorld;
  throttle: HostThrottle;
  ceilings: Ceilings;
  classify: ClassifyContext;
  now: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** 検索語に含めてはいけない語（利用者の氏名・住所・会員番号・メールなど。呼び出し側が与える） */
  privateTerms?: string[];
  /** 状況の再評価の履歴（調査量の方針を途中で変えたことの記録） */
  onPolicy?: (s: Sufficiency, reason: string) => void;
}

/** 検索語の安全確認: 個人情報・認証情報らしきものを外部検索へ送らない */
export function queryIsSafe(q: string, privateTerms: string[] = []): { ok: true } | { ok: false; reason: string } {
  const t = q.normalize("NFKC");
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return { ok: false, reason: "メールアドレスを含む検索語は使えません" };
  if (/(?:\d[\s-]?){10,}/.test(t)) return { ok: false, reason: "電話番号・会員番号らしき数字列を含む検索語は使えません" };
  if (/(api[_ -]?key|パスワード|password|secret|トークン|token)/i.test(t)) return { ok: false, reason: "認証情報を含む検索語は使えません" };
  if (/〒\s*\d{3}-?\d{4}|(都|道|府|県).{1,10}(市|区|町|村).{0,10}\d+-\d+/.test(t)) return { ok: false, reason: "住所らしき文字列を含む検索語は使えません" };
  for (const p of privateTerms) if (p && p.length >= 2 && t.includes(p.normalize("NFKC"))) return { ok: false, reason: "利用者の個人情報を含む検索語は使えません" };
  if (t.length > 200) return { ok: false, reason: "検索語が長すぎます" };
  return { ok: true };
}

const failKindOf = (reason: string): FetchFailKind => (/robots|ロボット/i.test(reason) ? "robots_blocked" : /ログイン|login|認証/i.test(reason) ? "login_required" : /時間|timeout|タイムアウト/i.test(reason) ? "timeout" : /制限|断|回避|取得できません|許可/.test(reason) ? "refused" : "http_error");

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

export function buildCaseTools(o: CaseToolOptions): { registry: ToolRegistry; pages: Map<string, PageData>; searchResults: Map<string, { title: string; snippet: string; query: string }>; queries: string[]; counts: { fetches: number; searches: number }; current(): Sufficiency } {
  const reg = new ToolRegistry();
  const pages = new Map<string, PageData>();
  const searchResults = new Map<string, { title: string; snippet: string; query: string }>();
  const queries: string[] = [];
  const counts = { fetches: 0, searches: 0 };
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = assess(o.ledger, o.ceilings);
  const reassess = (reason: string): Sufficiency => {
    const prev = last;
    last = assess(o.ledger, o.ceilings);
    if (prev.situation !== last.situation || prev.policy.maxFetches !== last.policy.maxFetches || prev.policy.maxSearches !== last.policy.maxSearches) o.onPolicy?.(last, reason);
    return last;
  };
  const stateJson = (s: Sufficiency) => ({
    situation: s.situation,
    situations: s.situations,
    done: s.done,
    policy: { ...s.policy, fetchesLeft: Math.max(0, s.policy.maxFetches - counts.fetches), searchesLeft: Math.max(0, s.policy.maxSearches - counts.searches), note: "この割り当ては状況に応じて自動で増減します（取得に失敗した・不足や矛盾が見つかったときは増え、十分になれば減ります）。調査の結果ごとに最新の方針が返ります。現在の割り当てだけで諦めず、結果に付く最新の方針を確認してください" },
    missing: s.missing.map((f) => FIELD_LABEL[f]),
    conflicts: s.conflicts.map((f) => FIELD_LABEL[f]),
    gaps: s.gaps.slice(0, 10),
  });
  const untrusted = (text: string, source: string, tail = ""): ToolOutput => {
    const inj = detectInjection(text);
    return { content: wrapUntrusted(text.slice(0, 4000) + tail, source), untrusted: true, data: inj.length ? { injection: inj } : undefined };
  };
  // 拒否・失敗の結果にも、最新の状況と調査量の方針（残りの取得・検索回数）を付ける。失敗で状況が変わり割り当てが増えても、AIが読み直さずに「もう調べられない」と誤解しないため（9H-2の第1段階で判明）
  const refuse = (reason: string, extra: object = {}): ToolOutput => ({ content: `取得できません: ${reason}\n[最新の調査方針] ${JSON.stringify({ situation: last.situation, fetchesLeft: Math.max(0, last.policy.maxFetches - counts.fetches), searchesLeft: Math.max(0, last.policy.maxSearches - counts.searches), missing: last.missing.map((f) => FIELD_LABEL[f]), conflicts: last.conflicts.map((f) => FIELD_LABEL[f]), note: "状況が変わると割り当ては自動で増減します。代替の情報源を探すときは search_public_web を使えます" })}`, data: { failed: true, reason, ...extra } });

  reg.register({
    name: "get_case_state",
    description: "いまの調査状況を読む: 調べている抽選の識別情報、項目ごとの採用値・根拠・状態（確定/未確認/矛盾/手動）、情報源の記録、不足と矛盾、今の状況に応じた調査量の方針（残りの取得・検索回数）。調査方針を決め直すときにも使う。",
    inputSchema: { type: "object", properties: { ...purposeProp }, additionalProperties: false },
    access: "read_internal",
    async run() {
      const t = o.ledger.target;
      const s = reassess("状況の確認");
      return {
        content: JSON.stringify({
          target: { chain: t.chain, store: t.store ?? null, storeMode: t.storeMode ?? "unknown", products: t.products },
          registeredSources: t.knownSources,
          untriedSources: o.ledger.untriedSources(),
          fields: o.ledger.allFields().map((r) => ({ field: r.field, label: r.label, adopted: r.adopted, state: r.state, independentOrigins: r.independentOrigins, hasPrimary: r.hasPrimary, alternatives: r.alternatives, note: r.note })),
          sources: o.ledger.snapshotSources().map((x) => ({ url: x.url, kind: x.kind, tier: x.tier, status: x.status, failKind: x.failKind, publishedAt: x.publishedAt, derivedFrom: x.derivedFrom })),
          queriesUsed: queries,
          ...stateJson(s),
        }),
        data: { state: s },
      };
    },
  } satisfies AgentTool);

  if (o.world.search) {
    const search = o.world.search.bind(o.world);
    reg.register({
      name: "search_public_web",
      description: "公開検索で、代替の情報源・公式アカウント・告知の更新や訂正を探す。検索語はあなたが作る（不足している項目・矛盾している点に合わせて変える）。同じ検索語は使えない。個人情報・認証情報を含めてはいけない。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, ...purposeProp }, required: ["query"], additionalProperties: false },
      access: "read_external",
      consumes: "search",
      dedupeKey: (i) => String(i.query ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
      async run(input, ctx) {
        const q = String(input.query ?? "");
        const safe = queryIsSafe(q, o.privateTerms);
        if (!safe.ok) return refuse(safe.reason, { unsafeQuery: true });
        if (counts.searches >= last.policy.maxSearches) return refuse(`いまの状況（${last.situation}）に割り当てた検索回数（${last.policy.maxSearches}）に達しています。状況が変われば割り当ては増えます`, { policyLimit: "search" });
        counts.searches += 1;
        queries.push(q);
        const rs = await search(q);
        // 実検索の費用（外部検索の料金）は、この調査の費用の上限に数える
        ctx.budget.addCost(o.world.lastSearchCostJpy?.() ?? 0);
        for (const r of rs.slice(0, 8)) if (/^https?:\/\//.test(r.url)) searchResults.set(norm(r.url), { title: r.title, snippet: r.snippet, query: q });
        const out = untrusted(rs.slice(0, 8).map((r) => `${r.title} ${r.url}\n${r.snippet}`).join("\n\n") || "（結果なし）", "search");
        return { ...out, data: { ...(out.data as object | undefined), results: rs.slice(0, 8).map((r) => ({ title: r.title, url: r.url })) } };
      },
    } satisfies AgentTool);
  }

  reg.register({
    name: "fetch_source_page",
    description: "ページを取得する。対象にできるのは、登録済みの情報源・検索結果に出たURL・取得済みのページに載っているリンクだけ。ロボット制限・ログインが必要なページは取得できない（回避しない）。取得できなかった場合は、代替の情報源を探す。",
    inputSchema: { type: "object", properties: { url: { type: "string" }, ...purposeProp }, required: ["url"], additionalProperties: false },
    access: "read_external",
    consumes: "fetch",
    dedupeKey: (i) => norm(String(i.url ?? "")),
    async run(input) {
      const url = norm(String(input.url ?? ""));
      const registered = o.ledger.target.knownSources.some((s) => norm(s.url) === url);
      const fromSearch = searchResults.has(url);
      const fromLink = [...pages.values()].some((p) => p.links.some((l) => norm(l.url) === url));
      if (!registered && !fromSearch && !fromLink) return refuse("登録済みの情報源・検索結果・取得済みページのリンクのいずれにも載っていないURLです（任意のURLへは広がりません）");
      if (counts.fetches >= last.policy.maxFetches) return refuse(`いまの状況（${last.situation}）に割り当てた取得回数（${last.policy.maxFetches}）に達しています。状況が変われば割り当ては増えます`, { policyLimit: "fetch" });
      const d = o.throttle.admit(url);
      if (!d.ok) return refuse(d.reason);
      if (d.waitMs > 0) await sleep(d.waitMs);
      counts.fetches += 1;
      const regSrc = o.ledger.target.knownSources.find((s) => norm(s.url) === url);
      const cls = regSrc ? { kind: regSrc.kind, tier: tierOfCase(regSrc.kind), account: hostOf(url) } : classifyCaseSource(url, o.classify);
      const r = await o.world.fetchPage(url);
      if (!r.ok) {
        const reason = r.reason ?? "ページを取得できませんでした";
        o.ledger.recordFetchFail(url, cls.kind, cls.tier, failKindOf(reason), reason);
        reassess(`情報源の取得失敗（${hostOf(url)}）`);
        return refuse(reason, { failKind: failKindOf(reason), sourceKind: cls.kind });
      }
      const text = `${r.title ?? ""}\n${r.text ?? ""}`;
      pages.set(url, { url, title: r.title ?? "", text: r.text ?? "", links: r.links ?? [] });
      const origin = detectOrigin(url, text);
      const inj = detectInjection(text);
      o.ledger.recordFetchOk({ url, kind: cls.kind, tier: cls.tier, fetchedAt: o.now(), ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}), origin: origin.origin, derivedFrom: origin.derivedFrom, ...(cls.account ? { account: cls.account } : {}), injection: inj.length > 0 });
      const links = (r.links ?? []).slice(0, 15).map((l) => `- ${l.text.slice(0, 60)} ${l.url}`).join("\n");
      const head = `[情報源の分類] 種類=${cls.kind}／${cls.tier === "primary" ? "一次情報" : "二次情報"}${origin.derivedFrom ? `／転載元=${origin.derivedFrom}` : ""}${r.publishedAt ? `／告知日時=${r.publishedAt}` : ""}\n`;
      const out = untrusted(`${head}${text}`, url, links ? `\n\n[リンク]\n${links}` : "");
      return { ...out, data: { ...(out.data as object | undefined), url, sourceKind: cls.kind, links: r.links } };
    },
  } satisfies AgentTool);

  reg.register({
    name: "report_page_findings",
    description:
      "取得したページから読み取った項目を台帳へ報告する。各項目に原文の短い抜粋（そのページの本文にそのまま書かれている部分）を付ける。検証層が、抜粋の実在と、そのページが調べている抽選と同じ企画かを確認してから統合する（別の抽選は統合されない）。日時は YYYY-MM-DD または YYYY-MM-DD HH:MM。商品は ' / ' 区切り。書かれていない項目は報告しない（推測しない）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "取得済みのページのURL" },
        identity: { type: "object", properties: { chain: { type: "string" }, store: { type: "string" }, storeSelect: { type: "boolean" }, products: { type: "array", items: { type: "string" } }, applyStart: { type: "string" }, applyDeadline: { type: "string" } }, description: "そのページが扱っている抽選の系列・店舗・商品・応募期間（同一抽選の照合に使う）" },
        observations: { type: "array", items: { type: "object", properties: { field: { type: "string", enum: FIELD_ENUM }, value: { type: "string" }, quote: { type: "string" } }, required: ["field", "value", "quote"] } },
        ...purposeProp,
      },
      required: ["url", "observations"],
      additionalProperties: false,
    },
    access: "read_internal",
    async run(input) {
      const url = norm(String(input.url ?? ""));
      const page = pages.get(url);
      if (!page) return { content: "エラー: このURLはまだ取得していません。先に取得してください", data: { failed: true, reason: "未取得のURL" } };
      const src = o.ledger.sources.get(url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase());
      const body = squash(`${page.title}\n${page.text}`);
      const facts = ((input.identity ?? {}) as IdentityFacts) ?? {};
      const raw = Array.isArray(input.observations) ? (input.observations as Record<string, unknown>[]) : [];
      const rejected: { field: string; reason: string }[] = [];
      const ok: Observation[] = [];
      for (const r of raw.slice(0, 20)) {
        const field = String(r.field ?? "") as FieldKey;
        const value = String(r.value ?? "").trim();
        const quote = String(r.quote ?? "").trim();
        if (!FIELD_ENUM.includes(field)) rejected.push({ field, reason: "未対応の項目" });
        else if (!value) rejected.push({ field, reason: "値が空" });
        else if (!quote || !body.includes(squash(quote))) rejected.push({ field, reason: "根拠の原文が、取得したページの本文に見つからない（推測・要約は採用しない）" });
        else if (["applyStart", "applyDeadline", "resultDate"].includes(field) && !DATE_VALUE.test(value)) rejected.push({ field, reason: "日時の形式が正しくない（YYYY-MM-DD または YYYY-MM-DD HH:MM）" });
        else ok.push({ field, value, quote: quote.slice(0, 200), sourceUrl: page.url, basis: basisOfQuote(src?.kind ?? "unknown", quote, `${page.title}\n${page.text}`) });
      }
      const r = o.ledger.integrate(url, facts, ok);
      const s = reassess(`${hostOf(url)}の報告を反映`);
      return { content: JSON.stringify({ identity: r.identity, accepted: r.accepted.map((x) => x.field), skipped: r.skipped, rejected, ...stateJson(s) }), data: { identity: r.identity, accepted: r.accepted.map((x) => x.field), rejected, skipped: r.skipped } };
    },
  } satisfies AgentTool);

  return { registry: reg, pages, searchResults, queries, counts, current: () => last };
}
