/**
 * Stage 9H-3B: 収集処理（processQueue → processCandidate）と調査エージェントの統合（実Supabase・RLS適用下。有料AIなし）
 *  AIの出力は収集側（record_lottery の生出力）・調査側（保存済みの実行ログで実際のAIが返した形の報告）とも台本。検証・統合・合流・判定・保存は実際のコードが行う。
 *   1. フラグ無効: 従来と同じ結果で、判断履歴を保存しない。フラグ有効（調査なし）でも登録の結果は変わらない
 *   2. ガンリュウ: Xアカウントの表示名・過去の人間の判断がAIの入力に入り、入力の記録が残る（フラグ無効では入らない）
 *   3. フルコンプ: 調査が店舗選択式・選べる店舗・当選発表の期間を見つけ、既存の登録経路を通って登録候補・登録内容に届く
 *   4. キデイランド: 調査の店舗選択式と店舗別独立が、登録内容で区別される
 *   5. イトーヨーカドー: 系列の表記違いが新しい系列・理由なしの変更にならない
 *   6. AIと固定ロジックの判断の差異（応募単位）が、理由つきで判断履歴に残る
 *   npm run test:db
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS, type CollectionConditions } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { investigateForCollection } from "@/lib/server/agent/case-bridge";
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";
import type { PlannerWorld } from "@/lib/agent/collection-planner/types";
import type { InvestigateFn } from "@/lib/case-model/investigation-types";
import type { Judgment } from "@/lib/case-model/judgment";
import { silentChanges } from "@/lib/case-model/judgment";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const jst = (offsetDays: number, hour: number, minute = 0) => {
  const d = new Date(NOW.getTime() + offsetDays * 86400_000 + 9 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute };
};
const none = { year: null, month: null, day: null, hour: null, minute: null };
const ymd = (o: number) => {
  const d = jst(o, 0);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
};

/** 台本どおりに行動する調査AI */
class ScriptedLLM implements AgentLLM {
  readonly name = "scripted";
  private i = 0;
  constructor(private readonly script: LlmStep[]) {}
  async step(_i: { messages: AgentMessage[] }): Promise<LlmStep> {
    return this.script[Math.min(this.i++, this.script.length - 1)];
  }
}
let n = 0;
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `c${++n}`, name, input });
const usage = { inputTokens: 100, outputTokens: 50, costJpy: 0 };
const tools = (...calls: ToolCall[]): LlmStep => ({ kind: "tool_calls", calls, usage });
const finish = (): LlmStep => ({ kind: "final", output: { reason: "sufficient", note: "" }, usage });

describe.skipIf(!dbTestsEnabled)("Stage 9H-3B 収集処理とAI調査の統合", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  type Plan = { chain?: string; store?: string; products?: string[]; unit?: string; selectable?: string[]; deadline?: object | null; resultEnd?: object; result?: object; conditions?: string };
  let plan: Plan = {};
  const seenText: string[] = [];
  const U = (n: string) => `https://q9h3b.example.invalid/${n}`;
  const extractor = {
    engine: "mock" as const,
    extract: async (r: { text?: string }) => {
      seenText.push(r.text ?? "");
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r as never);
      const raw = JSON.parse(JSON.stringify(o.raw)) as Record<string, unknown>;
      raw.is_lottery_announcement = true;
      raw.chain_name = plan.chain ?? "";
      raw.store_name = plan.store ?? "";
      raw.products = (plan.products ?? []).map((name) => ({ name, code: "", quantity: 1, unit: "box" }));
      raw.apply_start = jst(-1, 10);
      raw.apply_deadline = plan.deadline === null ? none : (plan.deadline ?? jst(5, 23, 59));
      raw.result_date = plan.result ?? none;
      raw.result_end_date = plan.resultEnd ?? none;
      raw.apply_url = "";
      raw.conditions_text = plan.conditions ?? "会員登録が必要";
      raw.receive_method = "store";
      raw.apply_unit = plan.unit ?? "unknown";
      raw.selectable_stores = plan.selectable ?? [];
      raw.notes = "";
      return { ...o, raw };
    },
  };
  const cond = (o: Partial<CollectionConditions> = {}): CollectionConditions => ({ ...DEFAULT_CONDITIONS, prefectures: ["東京都"], ...o });
  let investigate: InvestigateFn | undefined;
  const deps = (): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: NOW, actor: null, canRegister: false, serviceRegister: true, extractor: extractor as never, xClient: null,
    fetchPage: async () => ({ ok: false, code: "robots", message: "robots" }), fetchOembed: async () => ({ ok: false, message: "x" }),
    ...(investigate ? { investigate } : {}),
    humanKnowledge: { version: 1, entries: [{ kind: "store_form", chain: "トレカ9H", form: "store_select", caseId: "k-test" }, { kind: "decision", chain: "ガンリュウ", decision: "register", caseId: "k-test2" }] },
  });
  const run = async () => processQueue(deps(), { settings: { auto_register: true }, cond: cond(), data: await loadAppData(sys, hid), aiLeft: 8, timeLeft: () => 50_000, perBatch: 4 });
  const addWeb = (n: string, card: string) =>
    sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: U(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: U(n), title: `【${n}】`, context: card, card, sourceName: "pokecachan", attempts: 0 } } as never });
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,job_state,triage,reasons,lottery_id,draft").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const judgmentOf = (c: { draft: unknown }) => (c.draft as { judgment?: Judgment } | null)?.judgment;
  const inputOf = (c: { draft: unknown }) => (c.draft as { input?: { storeMode?: string; selectableStores?: { name: string }[]; resultEndDate?: string; store?: { name: string }; chain?: { name: string } } }).input!;
  const setFlags = (on: boolean, inv = false) => {
    process.env.TOREMANE_ENV = "local";
    if (on) process.env.COLLECT_UNIFIED = "on";
    else delete process.env.COLLECT_UNIFIED;
    if (inv) process.env.COLLECT_INVESTIGATE = "on";
    else delete process.env.COLLECT_INVESTIGATE;
  };
  /** 調査: 候補のURLを取得できる架空のページと、台本のAI。実際の調査エンジン・検証層・台帳・共通モデルへの変換を通る */
  const investigator = (pages: Record<string, string>, script: (req: Parameters<InvestigateFn>[0]) => LlmStep[]): InvestigateFn => async (req) => {
    const world: PlannerWorld = {
      signals: async () => ({ today: ymd(0), releases: [], chains: [], missing: [], failed: [], monitors: [], discovery: { found7d: 0, registered7d: 0, held7d: 0 } }),
      fetchPage: async (url) => (pages[url] === undefined ? { ok: false, reason: "ページが見つかりません（404）" } : { ok: true, title: "告知", text: pages[url], links: [] }),
      matchExisting: async () => [],
    };
    return investigateForCollection(req, { llm: new ScriptedLLM(script(req)), world });
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3b", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
    const mkChain = async (name: string) => (await u1.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
    const tc = await mkChain("トレカ9H");
    await u1.from("stores").insert([{ household_id: hid, chain_id: tc, name: "応募時に店舗選択", prefecture: "" }, { household_id: hid, chain_id: tc, name: "本店", prefecture: "東京都" }, { household_id: hid, chain_id: tc, name: "吉祥寺店", prefecture: "東京都" }, { household_id: hid, chain_id: tc, name: "横浜店", prefecture: "神奈川県" }]);
    const iy = await mkChain("イトーヨーカドー");
    await u1.from("stores").insert({ household_id: hid, chain_id: iy, name: "通販", prefecture: "東京都", sales_kind: "online_only" } as never);
    await u1.from("products").insert(["ハドウシーカー", "9H商品A", "9H商品B", "9H商品C", "9H商品D"].map((n) => ({ household_id: hid, official_name: n, packs_per_box: 20 })));
  });
  afterEach(() => {
    setFlags(false);
    investigate = undefined;
    seenText.length = 0;
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q9h3b.example.invalid%");
    await cleanupTestUsers(admin, userIds);
  });

  it("1. フラグ無効では判断履歴を保存せず、フラグ有効（調査なし）でも登録の結果は変わらない", async () => {
    plan = { chain: "トレカ9H", store: "本店", products: ["9H商品A"] };
    setFlags(false);
    await addWeb("off1", "トレカ9H本店で9H商品Aの抽選を実施します");
    await run();
    plan = { chain: "トレカ9H", store: "本店", products: ["9H商品B"] };
    setFlags(true);
    await addWeb("on1", "トレカ9H本店で9H商品Bの抽選を実施します");
    await run();
    const off = await cand("off1");
    const on = await cand("on1");
    expect(off.status, JSON.stringify(off.reasons)).toBe("auto_registered");
    expect(on.status, JSON.stringify(on.reasons)).toBe(off.status);
    expect(judgmentOf(off)).toBeUndefined(); // 従来と同じ保存内容（判断履歴・入力の記録なし）
    expect(JSON.stringify(off.draft)).not.toContain("aiInput");
    const j = judgmentOf(on)!;
    expect(j).toBeDefined();
    expect(j.aiInput?.textLength).toBeGreaterThan(0);
    expect(j.investigation?.reasons.map((r) => r.code)).toEqual(["fetch_restricted"]); // この試験の取得はロボット制限のため一覧の文面から読み取る
    // 登録内容（系列・店舗・形態・商品の数）は同じ
    const lot = async (id: string) => (await sys.from("lotteries").select("chain_id,store_id,store_mode").eq("id", id).single()).data!;
    expect(await lot(on.lottery_id!)).toEqual(await lot(off.lottery_id!));
    // 従来の「判断の追跡」（understanding）の構造も同じ
    const u = (c: { draft: unknown }) => (c.draft as { understanding: { applyUnit: string; decidedBy: unknown; storeChannel?: unknown } }).understanding;
    expect(u(on).applyUnit).toBe(u(off).applyUnit);
    expect(u(on).decidedBy).toEqual(u(off).decidedBy);
  });

  it("2. ガンリュウ: Xアカウントの表示名と過去の人間の判断がAIの入力に入り、入力の記録（伏せ字・ハッシュ）が残る。フラグ無効では入らない", async () => {
    const post = (id: string) => ({ id, text: "WonderGOO・新星堂・Ganryu店舗で抽選。応募は店頭の二次元コードから", images: [] as string[], links: [] as string[], createdAt: new Date().toISOString(), username: "tc_4145", authorId: "99", profile: { name: "ガンリュウ アリオ葛西店", location: "", description: "連絡 taro@example.com" } });
    const addX = (n: string) =>
      sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: U(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "x_post", url: U(n), title: n, context: "", sourceName: "x", attempts: 0, post: post(n) } } as never });
    plan = { chain: "", store: "", products: ["9H商品C"] };
    setFlags(false);
    await addX("gx0");
    await run();
    expect(seenText.join("\n")).not.toContain("ガンリュウ アリオ葛西店");
    seenText.length = 0;
    setFlags(true);
    await addX("gx1");
    await run();
    const sent = seenText.join("\n");
    expect(sent).toContain("【参考情報（告知本文ではありません）】");
    expect(sent).toContain("ガンリュウ アリオ葛西店");
    expect(sent).toContain("過去に「登録する」と判断された例がある"); // 過去の人間の判断は、参考として明示して渡る
    expect(sent).toContain("今回の告知の記載を優先");
    const c = await cand("gx1");
    const j = judgmentOf(c)!;
    expect(j.aiInput?.context.join("")).toContain("ガンリュウ アリオ葛西店");
    expect(JSON.stringify(j)).not.toContain("taro@example.com"); // 個人情報は保存しない
    // 9H-3E: 過去の人間の評価で系列と確認された名称（ガンリュウ）が表示名に含まれるため、マスターに無い系列でも表示名から系列を特定できる（仮の系列。参考）
    expect(inputOf(c).chain?.name).toBe("ガンリュウ");
    expect(j.investigation?.executed).toBe(false);
  });

  const fcPage = (store: string) => ["【抽選】トレカ9H ハドウシーカー", `■応募期間 ${ymd(-1)}～${ymd(5)}`, `■当選発表 ${ymd(7)}～${ymd(12)}`, `■対象店舗 ${store}`, "■応募方法 抽選申込ページの店舗選択欄から、受け取りを希望する店舗を1つ選択して応募"].join("\n");

  it("3. フルコンプ型: 調査が見つけた店舗選択式・選べる店舗・当選発表の期間が、既存の登録経路を通って登録候補・登録内容に届く", async () => {
    plan = { chain: "トレカ9H", store: "本店／吉祥寺店／横浜店", products: ["9H商品D"], deadline: null };
    setFlags(true, true);
    const url = U("fc1");
    const STORES = ["本店", "吉祥寺店", "横浜店"];
    investigate = investigator({ [url]: fcPage("本店／吉祥寺店／横浜店") }, (req) => [
      tools(call("get_case_state", {}), call("fetch_source_page", { url })),
      tools(call("report_page_findings", { url, identity: { chain: "トレカ9H", products: ["9H商品D"] }, applyUnit: { unit: "store_select", selectableStores: STORES, quote: "店舗選択欄から、受け取りを希望する店舗を1つ選択して応募" }, observations: [
        { field: "applyDeadline", value: ymd(5), quote: `${ymd(-1)}～${ymd(5)}` },
        // 実際のAIの報告と同じ形: 当選発表の期間を1つの値として報告する
        { field: "resultDate", value: `${ymd(7)}〜${ymd(12)}`, quote: `${ymd(7)}～${ymd(12)}` },
      ] })),
      finish(),
    ]);
    await addWeb("fc1", "トレカ9H ハドウシーカー 抽選販売のお知らせです。詳細は応募ページをご確認ください");
    await run();
    const c = await cand("fc1");
    const j = judgmentOf(c)!;
    expect(j, `${c.status} ${JSON.stringify(c.reasons)}`).toBeDefined();
    expect(j.investigation).toMatchObject({ needed: true, executed: true });
    expect(j.investigation!.reasons.map((r) => r.code), JSON.stringify({ inv: j.investigation, dec: j.decisions, ai: j.ai })).toEqual(expect.arrayContaining(["required_missing", "form_undecidable"]));
    // 調査で見つけた当選発表の期間が、登録候補の入力に届く（開始・終了が失われない）
    const inp = inputOf(c);
    expect(inp.resultEndDate).toBe(ymd(12));
    // 店舗選択式: 調査の判断が既存の応募単位の判定を通り、選べる店舗が保持される
    expect(inp.storeMode).toBe("select_on_apply");
    expect(inp.selectableStores?.map((s) => s.name)).toEqual(expect.arrayContaining(STORES));
    // 変更の追跡: 調査が採用した項目と、その理由・出典が判断履歴に残る
    const adopted = j.decisions.filter((d) => d.by === "investigation" && d.kind === "adopted");
    expect(adopted.map((d) => d.field)).toEqual(expect.arrayContaining(["form", "selectableStores", "resultEnd"]));
    expect(adopted.find((d) => d.stage === "merge" && d.field === "resultEnd")?.reason).toContain(url);
    // 登録された場合は、登録内容にも届いている
    if (c.lottery_id) {
      const l = (await sys.from("lotteries").select("store_mode,result_end_date").eq("id", c.lottery_id).single()).data!;
      expect(l.store_mode).toBe("select_on_apply");
      expect(l.result_end_date).toBe(ymd(12));
    }
  });

  it("4. キデイランド型: 調査の『店舗別独立』と『店舗選択式』が、登録内容で区別される", async () => {
    setFlags(true, true);
    const mk = async (name: string, unit: "store_independent" | "store_select", store: string, quote: string, page: string) => {
      const url = U(name);
      plan = { chain: "トレカ9H", store, products: ["9H商品A"], deadline: null };
      investigate = investigator({ [url]: page }, () => [
        tools(call("get_case_state", {}), call("fetch_source_page", { url })),
        tools(call("report_page_findings", { url, identity: { chain: "トレカ9H", store: unit === "store_independent" ? store : undefined, products: ["9H商品A"] }, applyUnit: { unit, selectableStores: unit === "store_select" ? ["本店", "吉祥寺店"] : [], quote }, observations: [] })),
        finish(),
      ]);
      await addWeb(name, `トレカ9H ${store} 9H商品A 抽選販売のお知らせです。詳細は応募ページをご確認ください`);
      await run();
      const cc = await cand(name);
      return inputOf(cc);
    };
    const ind = await mk("kd-ind", "store_independent", "吉祥寺店", "店舗ごとに応募ページが異なります", "吉祥寺店の抽選 店舗ごとに応募ページが異なります 本店・吉祥寺店");
    const sel = await mk("kd-sel", "store_select", "", "店舗選択欄から1店舗を選択", "抽選 応募フォームの店舗選択欄から1店舗を選択 本店・吉祥寺店");
    expect(ind.storeMode).not.toBe("select_on_apply");
    expect(ind.store?.name).toBe("吉祥寺店");
    expect(sel.storeMode, JSON.stringify(sel)).toBe("select_on_apply");
  });

  it("5. イトーヨーカドー型: 系列の表記違い（ネット通販）は、新しい系列も理由なしの変更も作らない", async () => {
    setFlags(true, true);
    const url = U("iy1");
    plan = { chain: "イトーヨーカドーネット通販", store: "通販", products: ["9H商品B"], deadline: null };
    investigate = investigator({ [url]: `【抽選】イトーヨーカドー 9H商品B 通販\n■応募期間 ${ymd(-1)}～${ymd(2)}` }, () => [
      tools(call("get_case_state", {}), call("fetch_source_page", { url })),
      tools(call("report_page_findings", { url, identity: { chain: "イトーヨーカドー", store: "通販", products: ["9H商品B"] }, observations: [{ field: "chain", value: "イトーヨーカドー", quote: "イトーヨーカドー 9H商品B 通販" }, { field: "store", value: "通販", quote: "9H商品B 通販" }] })),
      finish(),
    ]);
    const chainsBefore = (await sys.from("chains").select("id").eq("household_id", hid)).data!.length;
    await addWeb("iy1", "イトーヨーカドーネット通販 9H商品B 抽選販売のお知らせです。詳細は応募ページをご確認ください");
    await run();
    const c = await cand("iy1");
    expect((await sys.from("chains").select("id").eq("household_id", hid)).data).toHaveLength(chainsBefore);
    const inp = inputOf(c);
    expect(inp.chain?.name).toBe("イトーヨーカドー"); // 既存の系列に正規化
    const j = judgmentOf(c)!;
    expect(silentChanges(j).filter((d) => d.field === "chain" || d.field === "store")).toEqual([]);
    expect(j.decisions.some((d) => d.field === "chain" && d.kind === "held")).toBe(false);
  });

  it("7. 調査へ渡す情報源の分類の材料: 利用者が店舗マスターに登録した公式サイトのホストと、まとめのホストが、調査の要求に入る（渡さないと、取得したページが公式と判定されなかった）", async () => {
    setFlags(true, true);
    const chainId = (await sys.from("chains").select("id").eq("household_id", hid).eq("name", "トレカ9H").single()).data!.id as string;
    await sys.from("stores").update({ store_url: "https://www.official9h.example.invalid/shop" } as never).eq("chain_id", chainId).eq("name", "本店");
    let seen: Parameters<InvestigateFn>[0] | null = null;
    investigate = async (req) => {
      seen = req;
      return { skipped: "captured" };
    };
    plan = { chain: "トレカ9H", store: "本店", products: ["9H商品A"], deadline: null };
    await addWeb("cl1", "トレカ9H 本店 9H商品A 抽選販売のお知らせです。詳細は応募ページをご確認ください");
    await run();
    const req = seen as Parameters<InvestigateFn>[0] | null;
    expect(req, "調査が呼ばれていない").not.toBeNull();
    expect(req!.classify?.officialHosts).toContain("official9h.example.invalid");
    expect(req!.classify?.aggregatorHosts).toEqual(expect.arrayContaining(["pokeso.jp"]));
    // 他の系列の店舗URLは入らない
    expect(req!.classify?.officialHosts.every((h) => h.includes("official9h"))).toBe(true);
    await sys.from("stores").update({ store_url: null } as never).eq("chain_id", chainId);
  });

  it("6. AIと固定ロジックの判断の差異: AIが店舗別独立と読んでも、告知の構造（店舗のプルダウン）が店舗選択式なら、理由つきで判断履歴に残る", async () => {
    setFlags(true);
    plan = { chain: "トレカ9H", store: "", products: ["9H商品C"], unit: "store_independent" };
    await addWeb("ov1", "トレカ9H 抽選 応募フォームの店舗プルダウンで1店舗に回答して応募");
    await run();
    const c = await cand("ov1");
    const j = judgmentOf(c)!;
    const d = j.decisions.find((x) => x.field === "form");
    expect(d, JSON.stringify(j.decisions)).toBeDefined();
    expect(d).toMatchObject({ before: "store_independent", after: "store_select", by: "fixed" });
    expect(d!.reason).toContain("店舗選択の構造の記載");
    expect(d!.reason).not.toContain("理由の記録なし"); // 黙って置き換えていない
  });
});
