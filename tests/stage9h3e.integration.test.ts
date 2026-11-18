/**
 * Stage 9H-3E: 複数の候補・調査結果の統合（実Supabase・RLS適用下。有料AIなし。保存済みの実データ＋台本）
 *  1. フルコンプ: 同じ抽選が3つの候補（LivePocket・X×2）として別々に収集された → 実際の processQueue を通して、1件の最終候補に統合される
 *  2. 店舗別の独立した抽選（カードラボ）は統合しない
 *  3. フラグ無効では統合しない（従来どおり）
 *  npm run test:db
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS, type CollectionConditions } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { resultToCaseFile } from "@/lib/agent/case-investigator/to-case";
import { caseFromInput } from "@/lib/case-model/from-extraction";
import type { Judgment } from "@/lib/case-model/judgment";
import type { CaseFile } from "@/lib/case-model/types";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const SET = "backups/review-sets";
const RUNS = "backups/eval-9h3d/runs";
const HAVE = existsSync(SET) && existsSync(RUNS);

type Extracted = Record<string, string | string[] | null>;
interface SetCase { caseId: string; source: { url: string; title: string }; ai: { extracted: Extracted } }
const str = (v: unknown) => (typeof v === "string" ? v : "");
const flex = (v: unknown) => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(v) : null;
  return m ? { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : null, minute: m[5] ? +m[5] : null } : { year: null, month: null, day: null, hour: null, minute: null };
};

describe.skipIf(!dbTestsEnabled || !HAVE)("Stage 9H-3E 複数の候補の統合（収集経路）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let current: SetCase | null = null;
  let invCase: CaseFile | null = null;
  const sets = HAVE ? readdirSync(SET).filter((f) => f.startsWith("review-set-production")).sort() : [];
  const cases: SetCase[] = HAVE ? (JSON.parse(readFileSync(`${SET}/${sets[sets.length - 1]}`, "utf8")) as { cases: SetCase[] }).cases : [];
  const byId = (id: string) => cases.find((c) => c.caseId === id)!;
  const U = (n: string) => `https://q9h3e.example.invalid/${n}`;

  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r);
      const e = current!.ai.extracted;
      const raw = JSON.parse(JSON.stringify(o.raw)) as Record<string, unknown>;
      raw.is_lottery_announcement = true;
      raw.chain_name = str(e.chain);
      raw.store_name = str(e.store);
      raw.products = ((e.products as string[]) ?? []).map((name) => ({ name, code: "", quantity: 1, unit: "box" }));
      raw.apply_start = flex(e.applyStart);
      raw.apply_deadline = flex(e.applyDeadline);
      raw.result_date = flex(e.resultDate);
      raw.result_end_date = flex(null);
      raw.apply_url = "";
      raw.conditions_text = str(e.conditions);
      raw.receive_method = str(e.receiveMethod) || "unknown";
      raw.apply_method = str(e.applyMethod) || "unknown";
      raw.apply_unit = "unknown";
      raw.selectable_stores = [];
      raw.notes = "";
      raw.evidence = [];
      raw.warnings = [];
      return { ...o, raw };
    },
  };
  const cond = (): CollectionConditions => ({ ...DEFAULT_CONDITIONS, prefectures: ["東京都"] });
  const deps = (): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: new Date("2026-11-14T03:00:00Z"), actor: null, canRegister: false, serviceRegister: false, extractor: extractor as never, xClient: null,
    fetchPage: async (u: string) => ({ ok: true, finalUrl: u, status: 200, contentType: "text/html", body: `<html><head><title>${current!.source.title}</title></head><body><p>${current!.source.title} の抽選販売のお知らせです。詳細は応募ページをご確認ください。保存済み事例の再生用の本文です。</p></body></html>`, truncated: false }) as never,
    fetchOembed: async (u: string) => ({ ok: true, text: `${current!.source.title} の抽選販売のお知らせです。詳細は応募ページをご確認ください。`, author: /x\.com\/([^/]+)\/status/.exec(u)?.[1] ?? "", notice: [], postedOn: "" }) as never,
    // 調査: 台本（保存済みの実AIの調査結果）。LivePocketの候補にだけ結果を返す
    investigate: async () => (invCase ? { caseFile: invCase, stopReason: "replay" } : { skipped: "no_saved_result" }),
  });
  const run = async () => processQueue(deps(), { settings: { auto_register: false }, cond: cond(), data: await loadAppData(sys, hid), aiLeft: 8, timeLeft: () => 50_000, perBatch: 4 });
  const add = (n: string, c: SetCase) => sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: c.source.url, title: c.source.title || n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: c.source.url, title: c.source.title || n, context: c.source.title, card: c.source.title, sourceName: "replay", attempts: 0 } } as never });
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,job_state,reasons,lottery_id,draft").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const mkMasters = async (names: string[], products: string[]) => {
    for (const name of names) {
      if (!(await sys.from("chains").select("id").eq("household_id", hid).eq("name", name).maybeSingle()).data) {
        const ch = (await u1.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
        await u1.from("stores").insert({ household_id: hid, chain_id: ch, name: "応募時に店舗選択", prefecture: "" });
      }
    }
    for (const p of products) if (!(await sys.from("products").select("id").eq("household_id", hid).eq("official_name", p).maybeSingle()).data) await u1.from("products").insert({ household_id: hid, official_name: p, packs_per_box: 20 });
  };
  const clear = async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q9h3e.example.invalid%");
    await sys.from("lotteries").delete().eq("household_id", hid);
  };
  const flags = (on: boolean) => {
    process.env.TOREMANE_ENV = "local";
    if (on) {
      process.env.COLLECT_UNIFIED = "on";
      process.env.COLLECT_INVESTIGATE = "on";
    } else {
      delete process.env.COLLECT_UNIFIED;
      delete process.env.COLLECT_INVESTIGATE;
    }
  };
  const inputOf = (c: { draft: unknown }) => (c.draft as { input?: Parameters<typeof caseFromInput>[0] } | null)?.input;
  const judgmentOf = (c: { draft: unknown }) => (c.draft as { judgment?: Judgment } | null)?.judgment;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3e", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
  });
  afterEach(() => {
    flags(false);
    invCase = null;
  });
  afterAll(async () => {
    await clear();
    await cleanupTestUsers(admin, userIds);
  });

  it("1. フルコンプ: 3つの候補（X×2・LivePocket）＋実AIの調査結果が、実際の収集経路で1件の最終候補に統合される", async () => {
    await clear();
    await mkMasters(["フルコンプ"], ["ハドウシーカー"]);
    // 保存済みの実AIの調査結果（9H-3D）
    let saved: { result: CaseInvestigationResult; target: CaseTarget; startedAt: string } | null = null;
    for (const r of readdirSync(RUNS)) {
      const f = `${RUNS}/${r}/case-k-1d2511ea.json`;
      if (!existsSync(f)) continue;
      const j = JSON.parse(readFileSync(f, "utf8")) as { variant?: string; startedAt: string; B?: { judgment?: unknown }; investigation: { result: CaseInvestigationResult; target: CaseTarget } | null };
      if (j.investigation && j.B?.judgment && (j.variant ?? "B") === "B" && (!saved || j.startedAt > saved.startedAt)) saved = { startedAt: j.startedAt, ...j.investigation };
    }
    expect(saved).not.toBeNull();
    flags(true);
    // 先に、Xの投稿2件が別々の候補として収集される（それぞれ不完全）
    for (const [n, id] of [["x1", "k-1b76543d"], ["x2", "k-d8eb0a9b"]] as const) {
      current = byId(id);
      await add(n, current);
      await run();
    }
    // 次に、LivePocketの候補。実AIの調査結果が合流する
    current = byId("k-1d2511ea");
    invCase = resultToCaseFile(saved!.result, saved!.target, "2026-11-15T07:45:00Z");
    await add("lp", current);
    await run();

    const lp = await cand("lp");
    const j = judgmentOf(lp);
    expect(j, `${lp.status} ${JSON.stringify(lp.reasons)}`).toBeDefined();
    // 統合: 3つの候補が同一抽選として統合に参加（基準＋調査結果＋同じ抽選の別の候補）
    expect(j!.integration, "統合の記録").not.toBeNull();
    expect(j!.integration!.members.length).toBeGreaterThanOrEqual(3);
    expect(j!.integration!.excluded).toEqual([]);
    // 最終候補: 登録候補の入力（既存の登録経路を通ったあとの値）
    const fin = inputOf(lp)!;
    expect(fin.chain.name).toBe("フルコンプ");
    expect(fin.storeMode).toBe("select_on_apply"); // 店舗選択式
    expect((fin.selectableStores ?? []).map((s) => s.name)).toHaveLength(8); // 対象8店舗
    expect(fin.store.name === "" || fin.store.name.includes("選択")).toBe(true); // 店舗の値にならない
    expect(`${fin.applyStart.date} ${fin.applyStart.time}`.trim()).toBe("2026-11-11");
    expect(`${fin.applyDeadline.date} ${fin.applyDeadline.time}`.trim()).toBe("2026-11-15 11:59"); // 主催者本文の11:59（受付表示の12:00ではない）
    expect(fin.resultDate.date).toBe("2026-11-16");
    expect(fin.resultEndDate).toBe("2026-11-21"); // 当選発表は期間（開始・終了）
    // 候補の状態（確認用の記録）: 統合後に、利用者が見る候補が何件残るか
    const all = (await sys.from("collection_candidates").select("dedupe_key,status,job_state").eq("household_id", hid).like("dedupe_key", "%q9h3e.example.invalid%")).data ?? [];
    // 統合の結果、利用者が見る候補は1件（統合に使った別の候補は「統合済み」として除外。削除はしない）
    const open = all.filter((x) => x.status === "pending" && x.job_state === "review").map((x) => x.dedupe_key.split("/").pop());
    expect(open, JSON.stringify(all)).toEqual(["lp"]);
    expect(all.filter((x) => x.status === "excluded").map((x) => x.dedupe_key.split("/").pop()).sort()).toEqual(["x1", "x2"]);
    // 先に収集された候補は、後から収集された候補が統合した時点で順に「統合済み」になる（x1→x2→lp）
    expect(j!.integration!.superseded?.length).toBeGreaterThanOrEqual(1);
    // 項目ごとの採用理由が追跡できる
    const ad = j!.integration!.adoptions;
    expect(ad.find((a) => a.field === "form")?.reason).toBeTruthy();
    expect(ad.find((a) => a.field === "applyDeadline")?.from.length).toBeGreaterThan(0);
  });

  it("2. 店舗別の独立した抽選（札幌店となんば店・同じ系列・同じ商品）は統合されない。店舗が不明な候補に、特定の店舗の告知を混ぜない", async () => {
    await clear();
    await mkMasters(["カードラボ"], ["ハドウシーカー"]);
    const mk = (id: string, store: string, start: string, dl: string): SetCase => ({ caseId: id, source: { url: `https://shop.example.invalid/blog/${id}`, title: `カードラボ${store} ハドウシーカー 抽選` }, ai: { extracted: { chain: "カードラボ", store, products: ["ハドウシーカー"], applyStart: start, applyDeadline: dl, resultDate: null, conditions: "Xアカウントのフォローが必要", receiveMethod: "store", applyMethod: "web" } } });
    flags(true);
    current = mk("sap", "札幌店", "2026-11-04", "2026-11-08");
    await add("sap", current);
    await run();
    current = mk("nam", "なんば店", "2026-11-13", "2026-11-15");
    await add("nam", current);
    await run();
    const nam = await cand("nam");
    const j = judgmentOf(nam);
    expect(j, `${nam.status}`).toBeDefined();
    // 札幌店の告知は統合に参加していない（参加すれば、応募開始が11/04になりうる）。最終候補はなんば店の内容のまま
    expect(j!.integration === null || j!.integration.members.every((m) => !m.label.includes("札幌")) ).toBe(true);
    const fin = inputOf(nam)!;
    expect(fin.applyStart.date).toBe("2026-11-13");
    expect(fin.store.name).toBe("なんば店");
  });

  it("3. フラグ無効では統合しない（従来の動作。判断履歴・統合の記録なし）", async () => {
    await clear();
    await mkMasters(["フルコンプ"], ["ハドウシーカー"]);
    flags(false);
    for (const [n, id] of [["f1", "k-1b76543d"], ["f2", "k-d8eb0a9b"]] as const) {
      current = byId(id);
      await add(n, current);
      await run();
    }
    const c = await cand("f2");
    expect(judgmentOf(c)).toBeUndefined();
  });
});
