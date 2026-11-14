import { detectInjection, ToolRegistry, wrapUntrusted, type AgentTool, type ToolOutput } from "@/lib/agent/core";
import { HostThrottle } from "@/lib/agent/collection-planner/throttle";
import type { PlannerWorld } from "@/lib/agent/collection-planner/types";

/**
 * 情報収集エージェントが使える調査ツール（読み取り専用・Stage 9C）。名前・権限は ToolRegistry が検査する（書き込み・投稿・SQL等は登録できない）。
 *   get_signals              内部: 調査の手がかり（新商品の発売・抽選の発見状況・日時が不足している抽選・取得に失敗した情報源・未監視の系列）
 *   check_official_site      外部: 公式サイト・告知ページの確認（公開ページ。robots・ログイン・頻度制限を守る）
 *   follow_external_link     外部: 取得したページの外部リンクの追跡（同じ制限）
 *   search_public_web        外部: 公開検索（検索サービスが承認・設定されているときだけ登録）
 *   read_announcement_image  外部: 告知画像の文字の読み取り（画像解析が承認・設定されているときだけ登録）
 *   match_existing_lotteries 内部: 登録済みの抽選との照合（新規・補完・重複の判断の材料）
 * 外部ページの文面はデータとして囲み、命令らしき文面は記録だけして従わない。
 */
export function buildPlannerTools(world: PlannerWorld, throttle: HostThrottle = new HostThrottle()): ToolRegistry {
  const reg = new ToolRegistry();
  const untrusted = (text: string, source: string): ToolOutput => {
    const inj = detectInjection(text);
    return { content: wrapUntrusted(text.slice(0, 3000), source), untrusted: true, data: inj.length ? { injection: inj } : undefined };
  };
  const refuse = (reason: string): ToolOutput => ({ content: `取得できません: ${reason}` });

  reg.register({
    name: "get_signals",
    description: "調査の手がかりを読む。新商品の発売、直近の抽選の発見状況、日時などが不足している抽選、取得に失敗した情報源、未監視の系列・店舗。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    access: "read_internal",
    dedupeKey: () => "signals",
    async run() {
      const s = await world.signals();
      const cut = <T,>(a: T[], n: number) => a.slice(0, n);
      return { content: JSON.stringify({ today: s.today, discovery: s.discovery, releases: cut(s.releases, 12), unmonitoredChains: cut(s.chains.filter((c) => !c.monitored), 15), missingInfo: cut(s.missing, 12), failedSources: cut(s.failed, 10), monitors: cut(s.monitors, 20) }), data: s };
    },
  } satisfies AgentTool);

  const fetchTool = (name: string, description: string): AgentTool => ({
    name,
    description,
    inputSchema: { type: "object", properties: { url: { type: "string", description: "公開された http/https のURL" } }, required: ["url"], additionalProperties: false },
    access: "read_external",
    consumes: "fetch",
    dedupeKey: (i) => String(i.url ?? "").trim().replace(/#.*$/, ""),
    async run(input) {
      const url = String(input.url ?? "");
      const d = throttle.admit(url);
      if (!d.ok) return refuse(d.reason);
      const r = await world.fetchPage(url);
      if (!r.ok) return refuse(r.reason ?? "ページを取得できませんでした");
      const links = (r.links ?? []).slice(0, 15).map((l) => `- ${l.text.slice(0, 40)} ${l.url}`).join("\n");
      const out = untrusted(`${r.title ?? ""}\n${r.text ?? ""}${links ? `\n\n[リンク]\n${links}` : ""}`, url);
      return { ...out, data: { ...(out.data as object | undefined), url, title: r.title, links: r.links } };
    },
  });
  reg.register(fetchTool("check_official_site", "公式サイト・告知ページを確認する（公開ページのみ。ログイン・取得制限のあるページは取得しない）。"));
  reg.register(fetchTool("follow_external_link", "取得したページに載っている外部リンク（応募ページ・公式アカウントなど）を追跡して確認する。"));

  if (world.search) {
    const search = world.search.bind(world);
    reg.register({
      name: "search_public_web",
      description: "公開検索で、抽選の告知・公式アカウント・告知ページを探す。検索回数に上限がある。",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
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
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
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
  reg.register({
    name: "match_existing_lotteries",
    description: "登録済みの抽選と照合する（系列名・商品名・URL）。新規・既存の補完・重複の判断の材料にする。",
    inputSchema: { type: "object", properties: { chainName: { type: "string" }, productName: { type: "string" }, url: { type: "string" } }, additionalProperties: false },
    access: "read_internal",
    async run(input) {
      const r = await world.matchExisting({ chainName: input.chainName as string | undefined, productName: input.productName as string | undefined, url: input.url as string | undefined });
      return { content: JSON.stringify(r.slice(0, 8)), data: r };
    },
  });
  return reg;
}
