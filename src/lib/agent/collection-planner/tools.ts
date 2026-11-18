import { detectInjection, ToolRegistry, wrapUntrusted, type AgentTool, type ToolOutput } from "@/lib/agent/core";
import { HostThrottle } from "@/lib/agent/collection-planner/throttle";
import { evaluateSource } from "@/lib/agent/collection-planner/discovery";
import type { InvestigationSignals, PageData, PlannerWorld } from "@/lib/agent/collection-planner/types";

/**
 * 情報収集エージェントが使える調査ツール（読み取り専用・Stage 9C/9D）。名前・権限は ToolRegistry が検査する（書き込み・投稿・SQL等は登録できない）。
 *   get_signals               内部: 調査の手がかり（新商品の発売・抽選の発見状況・日時が不足している抽選・取得に失敗した情報源・未監視の系列・前回の調査の成果）
 *   check_official_site       外部: 公式サイト・告知ページの確認（公開ページ。robots・ログイン・頻度制限を守る）
 *   follow_external_link      外部: 取得したページの外部リンクの追跡（同じ制限）
 *   search_public_web         外部: 公開検索（検索サービスが承認・設定されているときだけ登録）
 *   read_announcement_image   外部: 告知画像の文字の読み取り（画像解析が承認・設定されているときだけ登録）
 *   analyze_page_for_lottery  内部: 取得したページを抽選情報として解析し、新規/補完/更新/重複/追加調査をプレビューする（登録はしない。解析エンジンが設定されているときだけ登録）
 *   assess_source_candidate 内部: 取得したページの情報源としての公式性・関連性・取得可能性を、取得した根拠で評価する（監視への追加はしない）
 *   match_existing_lotteries  内部: 登録済みの抽選との照合（新規・補完・重複の判断の材料）
 * 外部ページの文面はデータとして囲み、命令らしき文面は記録だけして従わない。ツールの入力に、上限・権限・アクセス範囲を変える項目は無い。
 */
export interface PlannerToolOptions {
  /** 取得したページの保存先（根拠の検証・解析・情報源の評価に使う。実行ごとに作る） */
  pages?: Map<string, PageData>;
  /** 1回の調査で解析できるページ数の上限（解析のAI費用・日次の解析枠の保護） */
  maxAnalyses?: number;
  /** アクセス間隔の待機（テストでは即時） */
  sleep?: (ms: number) => Promise<void>;
  /** すでに監視している情報源のURL（情報源の評価で重複を除く） */
  monitoredUrls?: string[];
  /** リンクをたどる深さの上限（公式サイト=0、そこからのリンク=1…）。既定2 */
  maxFollowDepth?: number;
}

const purposeProp = { purpose: { type: "string", description: "この調査の目的（短く。記録に残る）" } };
const norm = (u: string): string => u.trim().replace(/#.*$/, "");

export function buildPlannerTools(world: PlannerWorld, throttle: HostThrottle = new HostThrottle(), opts: PlannerToolOptions = {}): ToolRegistry {
  const reg = new ToolRegistry();
  const pages = opts.pages ?? new Map<string, PageData>();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let analyses = 0;
  const depth = new Map<string, number>();
  const maxDepth = opts.maxFollowDepth ?? 2;
  let cachedSignals: InvestigationSignals | null = null;
  /** 外部の文面を「データ」として囲む。本文は maxChars まで（リンク一覧など、本文のあとに付ける部分は切らない） */
  const untrusted = (text: string, source: string, maxChars = 3000, tail = ""): ToolOutput => {
    const inj = detectInjection(text);
    return { content: wrapUntrusted(text.slice(0, maxChars) + tail, source), untrusted: true, data: inj.length ? { injection: inj } : undefined };
  };
  const refuse = (reason: string): ToolOutput => ({ content: `取得できません: ${reason}`, data: { failed: true, reason } });

  reg.register({
    name: "get_signals",
    description: "調査の手がかりを読む。新商品の発売、直近の抽選の発見状況、日時などが不足している抽選、取得に失敗した情報源、未監視の系列・店舗、前回までの調査の成果。",
    inputSchema: { type: "object", properties: { ...purposeProp }, additionalProperties: false },
    access: "read_internal",
    dedupeKey: () => "signals",
    async run() {
      const s = await world.signals();
      cachedSignals = s;
      const cut = <T,>(a: T[], n: number) => a.slice(0, n);
      return { content: JSON.stringify({ today: s.today, discovery: s.discovery, releases: cut(s.releases, 12), unmonitoredChains: cut(s.chains.filter((c) => !c.monitored), 15), missingInfo: cut(s.missing, 12), failedSources: cut(s.failed, 10), monitors: cut(s.monitors, 20), previousRuns: s.previous ?? [] }), data: s };
    },
  } satisfies AgentTool);

  const fetchTool = (name: string, description: string, follow: boolean): AgentTool => ({
    name,
    description,
    inputSchema: { type: "object", properties: { url: { type: "string", description: "公開された http/https のURL" }, ...purposeProp }, required: ["url"], additionalProperties: false },
    access: "read_external",
    consumes: "fetch",
    dedupeKey: (i) => norm(String(i.url ?? "")),
    async run(input) {
      const url = String(input.url ?? "");
      // リンクの追跡は、取得済みのページに載っているリンクだけ・深さの上限まで（任意のURLへ広がる巡回をしない）
      let myDepth = 0;
      if (follow) {
        const parent = [...pages.values()].find((p) => p.links.some((l) => norm(l.url) === norm(url)));
        if (!parent) return refuse("取得済みのページに載っているリンクではありません（リンクの追跡は、取得したページ内のリンクだけです）");
        myDepth = (depth.get(parent.url) ?? 0) + 1;
        if (myDepth > maxDepth) return refuse(`リンクをたどる深さの上限（${maxDepth}）に達しています`);
      }
      const d = throttle.admit(url);
      if (!d.ok) return refuse(d.reason);
      if (d.waitMs > 0) await sleep(d.waitMs);
      const r = await world.fetchPage(url);
      if (!r.ok) return refuse(r.reason ?? "ページを取得できませんでした");
      depth.set(norm(url), myDepth);
      pages.set(norm(url), { url: norm(url), title: r.title ?? "", text: r.text ?? "", links: r.links ?? [] });
      // リンクは、告知・応募に関係しそうなもの（抽選・お知らせ・応募など）を先に見せる。ナビゲーションのリンクで枠を使い切らない
      const hint = (t: string) => (/抽選|応募|エントリー|受付|お知らせ|ご案内|予約/.test(t) ? 1 : 0);
      const ranked = [...(r.links ?? [])].sort((a, b) => hint(b.text) - hint(a.text));
      const links = ranked.slice(0, 15).map((l) => `- ${l.text.slice(0, 60)} ${l.url}`).join("\n") + ((r.links ?? []).length > 15 ? `\n（ほかに${(r.links ?? []).length - 15}件のリンク）` : "");
      // 本文は先頭4000文字まで。リンク一覧は本文のあとに付け、本文の長さで切り落とさない（一覧ページの告知へのリンクが見えなくならないように）
      const out = untrusted(`${r.title ?? ""}\n${r.text ?? ""}`, url, 4000, links ? `\n\n[リンク]\n${links}` : "");
      return { ...out, data: { ...(out.data as object | undefined), url, title: r.title, links: r.links } };
    },
  });
  reg.register(fetchTool("check_official_site", "公式サイト・告知ページを確認する（公開ページのみ。ログイン・取得制限のあるページは取得しない）。", false));
  reg.register(fetchTool("follow_external_link", "取得したページに載っている外部リンク（応募ページ・公式アカウントなど）を追跡して確認する。取得済みのページに載っているリンクだけが対象。", true));

  if (world.search) {
    const search = world.search.bind(world);
    reg.register({
      name: "search_public_web",
      description: "公開検索で、抽選の告知・公式アカウント・告知ページを探す。検索回数に上限がある。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, ...purposeProp }, required: ["query"], additionalProperties: false },
      access: "read_external",
      consumes: "search",
      costJpy: 0,
      dedupeKey: (i) => String(i.query ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
      async run(input) {
        const rs = await search(String(input.query ?? ""));
        return untrusted(rs.slice(0, 8).map((r) => `${r.title} ${r.url}\n${r.snippet}`).join("\n\n") || "（結果なし）", "search");
      },
    });
  }
  if (world.readImage) {
    const read = world.readImage.bind(world);
    reg.register({
      name: "read_announcement_image",
      description: "告知画像の文字を読み取る（画像解析が設定されているときだけ使える）。",
      inputSchema: { type: "object", properties: { url: { type: "string" }, ...purposeProp }, required: ["url"], additionalProperties: false },
      access: "read_external",
      consumes: "fetch",
      dedupeKey: (i) => String(i.url ?? ""),
      async run(input) {
        const d = throttle.admit(String(input.url ?? ""));
        if (!d.ok) return refuse(d.reason);
        return untrusted((await read(String(input.url))).text, String(input.url));
      },
    });
  }
  if (world.analyze) {
    const analyze = world.analyze.bind(world);
    const maxAnalyses = opts.maxAnalyses ?? 3;
    reg.register({
      name: "analyze_page_for_lottery",
      description: "取得済みのページを抽選情報として解析し、新規・補完・更新・重複・追加調査のどれになるかをプレビューする（登録はしない）。1回の調査で解析できる回数に上限がある。",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "取得済みのページのURL" }, ...purposeProp }, required: ["url"], additionalProperties: false },
      access: "read_internal",
      dedupeKey: (i) => norm(String(i.url ?? "")),
      async run(input, ctx) {
        const page = pages.get(norm(String(input.url ?? "")));
        if (!page) return { content: "エラー: このURLはまだ取得していません。先にページを取得してください", data: { failed: true, reason: "未取得のURL" } };
        if (analyses >= maxAnalyses) return { content: `エラー: 1回の調査で解析できるのは${maxAnalyses}件までです`, data: { failed: true, reason: "解析の上限" } };
        analyses += 1;
        const p = await analyze(page);
        // 解析の費用（実AIのとき）も、この調査の費用の上限に数える
        if (p.costJpy > 0) ctx.budget.addCost(p.costJpy);
        return { content: JSON.stringify({ recognized: p.recognized, pageKind: p.pageKind, pageKindReason: p.pageKindReason, chain: p.chainName, store: p.storeName, products: p.products, applyDeadline: p.applyDeadline, missing: p.missing, disposition: p.disposition, registrable: p.registrable, blockers: p.blockers }), data: { preview: p } };
      },
    });
  }
  reg.register({
    name: "assess_source_candidate",
    description: "取得済みのページを、新しい監視候補（情報源）として評価する。公式性・関連性・取得可能性を、取得した根拠で判定する。監視への追加はしない。",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "評価する情報源のURL" }, chainId: { type: "string", description: "関係する系列のID（get_signals にあるもの）" }, linkedFromUrl: { type: "string", description: "このURLへのリンクを載せていた取得済みのページのURL" }, ...purposeProp }, required: ["url"], additionalProperties: false },
    access: "read_internal",
    dedupeKey: (i) => `${norm(String(i.url ?? ""))}|${String(i.chainId ?? "")}`,
    async run(input) {
      const url = norm(String(input.url ?? ""));
      const sig = cachedSignals ?? (cachedSignals = await world.signals());
      const chain = sig.chains.find((c) => c.id === input.chainId) ?? null;
      const ev = evaluateSource({
        url,
        page: pages.get(url) ?? null,
        fetchOk: pages.has(url),
        chain: chain ? { name: chain.name, officialUrl: chain.officialUrl } : null,
        linkedFrom: input.linkedFromUrl ? (pages.get(norm(String(input.linkedFromUrl))) ?? null) : null,
        monitoredUrls: opts.monitoredUrls ?? sig.monitors.map((m) => (m as { url?: string }).url ?? "").filter(Boolean),
      });
      return { content: JSON.stringify({ official: ev.official, relevance: ev.relevance, fetchable: ev.fetchable, recommend: ev.recommend, reason: ev.reason, evidence: ev.evidence }), data: { evaluation: { ...ev, chainId: chain?.id ?? null } } };
    },
  });
  reg.register({
    name: "match_existing_lotteries",
    description: "登録済みの抽選と照合する（系列名・商品名・URL）。新規・既存の補完・重複の判断の材料にする。",
    inputSchema: { type: "object", properties: { chainName: { type: "string" }, productName: { type: "string" }, url: { type: "string" }, ...purposeProp }, additionalProperties: false },
    access: "read_internal",
    async run(input) {
      const r = await world.matchExisting({ chainName: input.chainName as string | undefined, productName: input.productName as string | undefined, url: input.url as string | undefined });
      return { content: JSON.stringify(r.slice(0, 8)), data: r };
    },
  });
  return reg;
}
