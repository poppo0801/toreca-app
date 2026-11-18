/**
 * 自律探索のモックAI（Stage 9H-3P）。実APIを使わずに、エンジン・ツール・検証層・上限の動作を確認するための疑似AI。実際のAIの判断力の評価ではない
 * （実AIでの評価は次のステージ。費用と条件を報告して利用者が承認したあとに行う）。AgentLLM と同じ入口なので、実AIと差し替えられる。
 *   scout   : 状況を読み、起点→店舗一覧→未知の店舗の検索→手がかりの記録→終了を、会話の中の結果だけから選ぶ。特定の店舗名・系列名・検索語は持たない
 *   greedy  : 取得・検索できるだけ続ける（収穫逓減・上限の試験用）
 *   looper  : 同じ検索語・同じURLを繰り返す（重複の拒否・無限ループ防止の試験用）
 *   reckless: 取得していないURL・存在しない原文・個人情報を含む検索語・対象地域外の主張を試みる（検証層の試験用）
 * 世界の記述形式（架空）: 抽選の行「【抽選】系列: X / 店舗: Y / 商品: P・Q / 応募期間: 11/27〜12/3 / 方式: 店舗別|店舗選択 / 地域: 県」、店舗一覧の行「- 店名（都道府県）」。
 */
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";

export type DiscoveryPolicy = "scout" | "greedy" | "looper" | "reckless";
const usage = { inputTokens: 800, outputTokens: 200, costJpy: 0 };

interface Mission {
  id: string;
  kind: string;
  chain?: string;
  store?: string;
  product?: string;
  sourceUrl?: string;
  targetPrefectures: string[];
  officialUrl?: string | null;
  today?: string;
}
interface Pair {
  call: ToolCall;
  content: string;
  isError: boolean;
}
const unwrap = (s: string): string => s.replace(/<\/?untrusted_web_content[^>]*>/g, "");

function pairs(messages: AgentMessage[], name: string): Pair[] {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.calls) calls.set(c.id, c);
  return messages.filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool" && m.name === name).flatMap((m) => {
    const call = calls.get(m.callId);
    return call ? [{ call, content: m.content, isError: !!m.isError }] : [];
  });
}
const norm = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/+$/, "");

export interface ParsedLead {
  chain: string;
  store?: string;
  products: string[];
  applyStart?: string;
  applyDeadline?: string;
  select: boolean;
  pref?: string;
  quote: string;
}
/** ページ本文の「【抽選】…」の行を読む（疑似的な読み取り。実AIの代わり） */
export function readLeads(text: string, today = "2026-11-18"): ParsedLead[] {
  const year = today.slice(0, 4);
  const iso = (md: string) => {
    const m = md.match(/(\d{1,2})\/(\d{1,2})/);
    return m ? `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : undefined;
  };
  return unwrap(text).split(/\n+/).filter((l) => l.includes("【抽選】")).map((line) => {
    const f = (label: string) => line.match(new RegExp(`${label}:\\s*([^/]+?)\\s*(?:/|$)`))?.[1]?.trim();
    const period = f("応募期間")?.split(/[〜~]/) ?? [];
    const store = f("店舗");
    return { chain: f("系列") ?? "", store: store && store !== "なし" ? store : undefined, products: (f("商品") ?? "").split("・").map((s) => s.trim()).filter(Boolean), applyStart: period[0] ? iso(period[0]) : undefined, applyDeadline: period[1] ? iso(period[1]) : undefined, select: /店舗選択/.test(f("方式") ?? ""), pref: f("地域"), quote: line.trim() };
  });
}
/** 店舗一覧の行「- 店名（都道府県）」を読む */
export function readStoreList(text: string): { name: string; pref: string }[] {
  return unwrap(text).split(/\n+/).flatMap((l) => {
    const m = l.trim().match(/^-\s*(.+?)（([^）]+)）\s*$/);
    return m && !/https?:\/\//.test(l) ? [{ name: m[1], pref: m[2] }] : [];
  });
}
const links = (text: string): { text: string; url: string }[] => unwrap(text).split(/\n/).flatMap((l) => {
  const m = l.match(/^- (.*?) (https?:\/\/\S+)$/);
  return m ? [{ text: m[1], url: m[2] }] : [];
});

export class DiscoveryMockBrain implements AgentLLM {
  readonly name: string;
  constructor(private readonly policy: DiscoveryPolicy = "scout") {
    this.name = `mock-discovery:${policy}`;
  }

  async step({ messages }: { system: string; messages: AgentMessage[]; tools: { name: string }[] }): Promise<LlmStep> {
    const calls = (cs: Omit<ToolCall, "id">[]): LlmStep => ({ kind: "tool_calls", calls: cs.map((c, i) => ({ ...c, id: `c${messages.length}-${i}` })), usage });
    const final = (o: { reason: string; note: string; unconfirmed?: string[] }): LlmStep => ({ kind: "final", output: o, usage });
    const first = messages[0]?.role === "user" ? messages[0].text : "";
    const mm = first.match(/<mission>(.*)<\/mission>/);
    const mission: Mission = mm ? JSON.parse(mm[1]) : { id: "?", kind: "chain", targetPrefectures: [] };

    if (this.policy === "looper") return calls([{ name: "search_public_web", input: { query: "同じ検索語" } }, { name: "fetch_source_page", input: { url: "https://loop.example.invalid/a" } }]);
    if (this.policy === "reckless") {
      const n = pairs(messages, "fetch_source_page").length + pairs(messages, "search_public_web").length + pairs(messages, "note_lead").length;
      if (n === 0) return calls([{ name: "fetch_source_page", input: { url: "https://unlisted.example.invalid/secret" } }, { name: "search_public_web", input: { query: "山田太郎 090-1234-5678 yamada@example.com 抽選" } }, { name: "fetch_source_page", input: { url: "http://127.0.0.1:54321/rest/v1/chains" } }, { name: "note_lead", input: { chain: "架空系列", store: "幻の店", scope: "store_specific", products: ["存在しない商品"], url: "https://unlisted.example.invalid/secret", quote: "【抽選】店舗: 幻の店 / 応募期間: 12/1〜12/5" } }]);
      return final({ reason: "sufficient", note: "確認できました（根拠なし）" });
    }

    const searches = pairs(messages, "search_public_web");
    const fetches = pairs(messages, "fetch_source_page");
    const tried = new Set([...fetches.map((p) => norm(String(p.call.input.url ?? "")))]);
    const okPages = fetches.filter((p) => !p.isError);
    const notes = pairs(messages, "note_lead");
    const noted = new Set(notes.map((p) => `${norm(String(p.call.input.url))}|${String(p.call.input.quote)}`));
    const queries = new Set(searches.map((p) => String(p.call.input.query)));
    const searchUrls = searches.flatMap((p) => unwrap(p.content).split(/\n/).flatMap((l) => (l.match(/\s(https?:\/\/\S+)$/) ? [{ url: l.match(/\s(https?:\/\/\S+)$/)![1], line: l }] : [])));

    if (this.policy === "greedy") {
      const nextUrl = [...searchUrls.map((s) => s.url), ...okPages.flatMap((p) => links(p.content).map((l) => l.url)), mission.sourceUrl ?? "", mission.officialUrl ?? ""].map(norm).find((u) => u && !tried.has(u));
      if (nextUrl) return calls([{ name: "fetch_source_page", input: { url: nextUrl } }]);
      return calls([{ name: "search_public_web", input: { query: `${mission.chain ?? ""} ${mission.product ?? ""} 抽選 ${queries.size}` } }]);
    }

    // ---- scout
    if (pairs(messages, "declare_focus").length === 0) {
      const what = mission.kind === "product" ? `新商品「${mission.product}」の抽選を実施している店舗・系列` : mission.kind === "lottery" ? `${mission.chain}の他店舗（起点の店舗以外）` : `${mission.chain}の実施店舗`;
      return calls([{ name: "declare_focus", input: { target: what, reason: mission.kind === "lottery" ? "ある店舗で抽選が確認されたため、同じ系列の他店舗も開催している可能性を調べる" : "目的に沿って、起点の情報から調べる" } }]);
    }
    if (pairs(messages, "list_known_stores").length === 0 && mission.chain) return calls([{ name: "list_known_stores", input: { chain: mission.chain, because: "登録済みの店舗と、公式の店舗一覧を突き合わせるため" } }]);

    // 1) 取得したページの抽選の行を記録する
    const pending: Omit<ToolCall, "id">[] = [];
    for (const p of okPages) {
      const url = norm(String(p.call.input.url));
      for (const l of readLeads(p.content, mission.today)) {
        const key = `${url}|${l.quote}`;
        if (noted.has(key) || pending.length >= 4) continue;
        noted.add(key);
        pending.push({ name: "note_lead", input: { chain: l.chain || mission.chain || "", ...(l.store ? { store: l.store } : {}), scope: l.select ? "store_select" : l.store ? "store_specific" : "chain_common", products: l.products, ...(l.applyStart ? { applyStart: l.applyStart } : {}), ...(l.applyDeadline ? { applyDeadline: l.applyDeadline } : {}), url, quote: l.quote, ...(l.pref ? { statedPrefecture: l.pref } : {}), reason: "取得したページに抽選の記載があったため" } });
      }
    }
    if (pending.length) return calls(pending);

    // 2) 起点・公式サイト・店舗一覧へのリンクを読む
    const seedFailed = !!mission.sourceUrl && fetches.some((p) => p.isError && norm(String(p.call.input.url)) === norm(mission.sourceUrl ?? ""));
    for (const u of [mission.sourceUrl, mission.officialUrl]) if (u && !tried.has(norm(u))) return calls([{ name: "fetch_source_page", input: { url: u, because: u === mission.sourceUrl ? "起点の告知に、他店舗の情報や関連ページがあるか確認するため" : "公式サイトから店舗一覧・告知を探すため" } }]);
    const wanted = /店舗一覧|店舗|ショップ|抽選|お知らせ|ニュース|取扱/;
    for (const p of okPages) for (const l of links(p.content)) if (wanted.test(l.text) && !tried.has(norm(l.url))) return calls([{ name: "fetch_source_page", input: { url: l.url, because: `「${l.text.slice(0, 20)}」に店舗や抽選の情報がありそうなため` } }]);

    // 3) 店舗一覧から、まだ抽選の手がかりがない店舗（未知の店舗を含む）を、対象地域・見込みを見て探す
    const product = mission.product ?? notes.map((n) => (n.call.input.products as string[] | undefined)?.[0]).find(Boolean) ?? "";
    const chain = mission.chain ?? String(notes[0]?.call.input.chain ?? "");
    const foundStores = new Set(notes.map((n) => String(n.call.input.store ?? "")).filter(Boolean));
    const list = okPages.flatMap((p) => readStoreList(p.content));
    const target = mission.targetPrefectures;
    const candidates = list.filter((s) => !foundStores.has(s.name) && (target.length === 0 || target.includes(s.pref))).filter((s) => ![...queries].some((q) => q.includes(s.name)));
    const explored = [...queries].filter((q) => list.some((s) => q.includes(s.name))).length;
    // 検索で見つかった未取得のページ（店舗名が出ているもの）を先に取得する
    for (const s of searchUrls) if (!tried.has(norm(s.url)) && (product === "" || s.line.includes(product) || list.some((x) => s.line.includes(x.name)))) return calls([{ name: "fetch_source_page", input: { url: s.url, because: "検索結果の説明に、探している店舗・商品の記載があったため" } }]);
    if (candidates.length > 0 && explored < 4) {
      const s = candidates[0];
      return calls([{ name: "search_public_web", input: { query: `${chain} ${s.name} ${product} 抽選`.replace(/\s+/g, " ").trim(), because: `公式の店舗一覧にある${s.name}（対象地域）で開催があるか確認するため` } }]);
    }
    // 4) 起点が取得できない・手がかりが無いときは、検索で代替の情報源を探す
    if ((seedFailed || notes.length === 0) && searches.length === 0) return calls([{ name: "search_public_web", input: { query: `${chain} ${product} 抽選 ${target[0] ?? ""}`.replace(/\s+/g, " ").trim(), because: seedFailed ? "起点の告知を取得できないため、代替の情報源を探す" : "手がかりが無いため、検索で情報源を探す" } }]);

    const unconfirmed = [...queries].filter((q) => list.some((s) => q.includes(s.name))).map((q) => list.find((s) => q.includes(s.name))?.name ?? "").filter((n) => n && !foundStores.has(n));
    return final({ reason: notes.length > 0 ? "sufficient" : "no_improvement", note: `${notes.length}件の手がかりを記録。見つからなかった店舗は未確認（開催なしの意味ではない）`, unconfirmed });
  }
}
