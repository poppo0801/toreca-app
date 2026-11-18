// @vitest-environment node
/**
 * Stage 9H-3D: 実AIによる新旧方式の精度比較（**実API・実サイトへのアクセス（費用が発生）**。承認された範囲だけ）。
 * 実行: node scripts/eval-9h3d.mjs run --cases=<id,id> --approved-max-jpy=<円>（条件を確認して vitest を起動する。通常のテストでは実行されない: E9H3D=1 のときだけ）
 *  - A（従来方式）: 事例定義に保存された抽出結果（収集AIの出力）。A′: 同じ入力を現在のコードで、フラグ無効（従来の経路）で処理した最終候補（AIの調査なし）
 *  - B（自律AI方式）: 同じ初期入力（Aの抽出結果）を、9H-3Cの統合経路（processQueue → 調査要否 → 実AI調査 → 合流 → 既存の登録判定）で処理した最終候補
 *  - 登録・更新はしない（自動登録オフ。候補の下書きだけ）。DBは開発用ローカルのテスト世帯のみ。
 *  - 参考知識: 過去の人間の評価は、対象13件と同じ企画の兄弟事例の評価を除外して渡す（正解の流出を防ぐ）
 *  - 費用: backups/eval-9h3d/ledger.json に累計（検索料金を含む）。呼び出しの前に最大費用を確認し、累計・1件15円を超える見込みなら呼ばない
 *  - 中止: 費用上限・異常な繰り返し・調査による系列/店舗/商品の変更（誤統合の疑い）・根拠のない確定・注入の検出
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS, type CollectionConditions } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { configureInvestigation, realInvestigationDeps } from "@/lib/server/agent/case-bridge";
import { buildHumanKnowledge, type AnswersFileLike } from "@/lib/case-model/human-knowledge";
import type { Judgment } from "@/lib/case-model/judgment";
import type { WorldLogEntry } from "@/lib/server/agent/case-world";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ON = process.env.E9H3D === "1";
const OUT = "backups/eval-9h3d";
const CAP = Number(process.env.E9H3D_CAP_JPY ?? 0);
/** B=修正前（情報源の分類の材料を調査へ渡していない）／B2=修正後（店舗マスターの公式URL・まとめを渡す）。結果を区別して保存する */
const VARIANT = process.env.E9H3D_VARIANT === "B2" ? "B2" : "B";
const ids = (process.env.E9H3D_CASES ?? "").split(",").filter(Boolean);

interface CaseDef {
  caseId: string;
  group: string;
  why: string;
  target: CaseTarget;
  classify?: { officialHosts: string[]; officialAccounts: string[]; aggregatorHosts: string[]; aggregatorAccounts: string[] };
  baseline: { extracted: Record<string, string | string[] | null>; sourceUrl?: string; sourceTitle?: string; decision: { status: string } };
}
const flex = (v: unknown) => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(v) : null;
  return m ? { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : null, minute: m[5] ? +m[5] : null } : { year: null, month: null, day: null, hour: null, minute: null };
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

describe.skipIf(!ON || !dbTestsEnabled)("Stage 9H-3D 実AI×統合経路の新旧比較（承認制）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let current: CaseDef | null = null;
  const U = (n: string) => `https://q9h3d.example.invalid/${n}`;
  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      // 初期入力: A（従来方式）の保存済みの抽出結果を、AとBの両方で同じに再現する
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r);
      const e = current!.baseline.extracted;
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
  const refNow = (c: CaseDef) => new Date(new Date(`${(str(c.baseline.extracted.applyDeadline).slice(0, 10) || "2026-11-10")}T12:00:00+09:00`).getTime() - 86400_000);
  const deps = (c: CaseDef, knowledge?: ReturnType<typeof buildHumanKnowledge>): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: refNow(c), actor: null, canRegister: false, serviceRegister: false, extractor: extractor as never, xClient: null,
    fetchPage: async (u: string) => ({ ok: true, finalUrl: u, status: 200, contentType: "text/html", body: `<html><head><title>${str(c.baseline.sourceTitle)}</title></head><body><p>${str(c.baseline.sourceTitle)} の抽選販売のお知らせです。詳細は応募ページをご確認ください。（収集側の入力はAの抽出結果を再現）</p></body></html>`, truncated: false }) as never,
    // X投稿（収集側の取得）: Aの抽出結果を再現する入力として、見出しだけを返す（調査側の取得は実際のネットワーク。X本文はロボット制限で取得できない）
    fetchOembed: async (u: string) => ({ ok: true, text: `${str(c.baseline.sourceTitle)} の抽選販売のお知らせです。詳細は応募ページをご確認ください。`, author: /x\.com\/([^/]+)\/status/.exec(u)?.[1] ?? "", notice: [], postedOn: "" }) as never,
    ...(knowledge ? { humanKnowledge: knowledge } : {}),
    // B2（修正後）: 利用者が登録した情報（まとめアカウント・まとめサイト）を収集側の文脈として持つ
    ...(VARIANT === "B2" && c.classify ? { sourceCtx: { officialAccounts: new Set<string>(), aggregatorAccounts: new Set(c.classify.aggregatorAccounts), listHosts: new Set(c.classify.aggregatorHosts) } } : {}),
  });
  const run = async (c: CaseDef, knowledge?: ReturnType<typeof buildHumanKnowledge>) => processQueue(deps(c, knowledge), { settings: { auto_register: false }, cond: cond(), data: await loadAppData(sys, hid), aiLeft: 8, timeLeft: () => 200_000, perBatch: 4 });
  const add = (n: string, c: CaseDef) => {
    const url = c.baseline.sourceUrl ?? c.target.knownSources[0].url;
    return sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: url, title: str(c.baseline.sourceTitle) || n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url, title: str(c.baseline.sourceTitle) || n, context: str(c.baseline.sourceTitle), card: str(c.baseline.sourceTitle), sourceName: "eval9h3d", attempts: 0 } } as never });
  };
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,reasons,draft").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const mkMasters = async (c: CaseDef) => {
    for (const name of [...new Set([str(c.baseline.extracted.chain), c.target.chain].filter(Boolean))]) {
      if (!(await sys.from("chains").select("id").eq("household_id", hid).eq("name", name).maybeSingle()).data) {
        const ch = (await u1.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
        await u1.from("stores").insert({ household_id: hid, chain_id: ch, name: "応募時に店舗選択", prefecture: "" });
      }
    }
    for (const p of (c.baseline.extracted.products as string[]) ?? []) {
      if (!(await sys.from("products").select("id").eq("household_id", hid).eq("official_name", p).maybeSingle()).data) await u1.from("products").insert({ household_id: hid, official_name: p, packs_per_box: 20 });
    }
  };
  /** B2: 利用者が店舗マスターに公式の店舗URLを登録している状況（9H-2の分類の材料と同じ）。マスターの登録情報で、正解ではない */
  const registerOfficial = async (c: CaseDef) => {
    // 系列ごとの公式サイト（1店舗につき店舗URLは1件）。マスターに登録されうる公式サイトで、事例の正解ではない
    const HOST: Record<string, string> = { "カードラボ": "c-labo.jp", "ドラゴンスター": "dorasuta.membercard.jp", "お宝創庫グループ": "otakarasouko.com", "ポケモンセンター": "pokemoncenter-online.com", "キデイランド": "kiddyland.co.jp" };
    for (const name of [...new Set([str(c.baseline.extracted.chain), c.target.chain].filter(Boolean))]) {
      const host = HOST[name];
      const ch = (await sys.from("chains").select("id").eq("household_id", hid).eq("name", name).maybeSingle()).data;
      if (host && ch) await sys.from("stores").update({ store_url: `https://${host}/` } as never).eq("chain_id", ch.id);
    }
  };
  const clear = async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q9h3d.example.invalid%");
    await sys.from("lotteries").delete().eq("household_id", hid);
  };
  const flags = (mode: "off" | "on") => {
    process.env.TOREMANE_ENV = "local";
    if (mode === "on") {
      process.env.COLLECT_UNIFIED = "on";
      process.env.COLLECT_INVESTIGATE = "on";
      process.env.COLLECT_SPOTCHECK_RATE = "1";
      process.env.COLLECT_SPOTCHECK_EXECUTE = "on";
    } else for (const k of ["COLLECT_UNIFIED", "COLLECT_INVESTIGATE", "COLLECT_SPOTCHECK_RATE", "COLLECT_SPOTCHECK_EXECUTE"]) delete process.env[k];
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3d", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
  });
  afterAll(async () => {
    flags("off");
    configureInvestigation(null);
    await clear();
    await cleanupTestUsers(admin, userIds);
  });

  it("指定した事例を、A′（従来の経路）とB（実AI調査を含む統合経路）で処理し、全過程を保存する", async () => {
    const plan = JSON.parse(readFileSync(`${OUT}/plan.json`, "utf8")) as { digest: string; cases: CaseDef[] };
    const picked = ids.map((id) => plan.cases.find((c) => c.caseId === id) ?? (() => { throw new Error(`計画にない事例: ${id}`); })());
    expect(picked.length).toBeGreaterThan(0);
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H3D_CAP_JPY。100円以下）が必要です");
    if (process.env.E9H3D_CONFIRM !== "yes") throw new Error("実行前の確認（E9H3D_CONFIRM=yes）が必要です");
    const env = { ...process.env, COLLECT_INVESTIGATE_CAP_JPY: String(CAP), COLLECT_INVESTIGATE_CONFIRM: "yes", COLLECT_INVESTIGATE_PER_CASE_JPY: "15", AGENT_MODEL: "claude-haiku-5-5" } as Record<string, string | undefined>;
    const real = realInvestigationDeps({ env, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);

    // 参考知識: 対象事例と兄弟事例の評価を除外（正解の流出を防ぐ）
    const exclude = new Set([...plan.cases.map((c) => c.caseId), "k-6336a920"]);
    const answers = readdirSync("backups/review-answers").filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`backups/review-answers/${f}`, "utf8")) as AnswersFileLike);
    const knowledge = buildHumanKnowledge(answers.map((a) => ({ ...a, results: (a.results ?? []).filter((r) => !exclude.has(r.caseId ?? "")) })));

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = `${OUT}/runs/${runId}`;
    mkdirSync(dir, { recursive: true });
    let captured: { r: CaseInvestigationResult; t: CaseTarget } | null = null;
    const summary: Record<string, unknown>[] = [];
    let stopped: string | null = null;

    for (const c of picked) {
      if (stopped || real.guard.stopped) break;
      current = c;
      await clear();
      await mkMasters(c);
      if (VARIANT === "B2") await registerOfficial(c);
      // A′: 同じ入力を従来の経路（フラグ無効）で処理（AIの調査なし）
      flags("off");
      configureInvestigation(null);
      await add(`${c.caseId}-ap`, c);
      await run(c);
      const ap = await cand(`${c.caseId}-ap`);
      await clear();
      // B: 実AI調査を含む統合経路
      flags("on");
      const logStart = real.log.length;
      captured = null;
      configureInvestigation({ ...real.deps, onResult: (r, t) => { captured = { r, t }; } });
      const spentBefore = real.guard.spentJpy;
      const t0 = Date.now();
      let error: string | undefined;
      await add(`${c.caseId}-b`, c);
      try {
        await run(c, knowledge);
      } catch (e) {
        error = (e as Error).message;
      }
      const ms = Date.now() - t0;
      const b = await cand(`${c.caseId}-b`);
      const costJpy = Number((real.guard.spentJpy - spentBefore).toFixed(4));
      const cap1 = captured as { r: CaseInvestigationResult; t: CaseTarget } | null;
      const j = (b.draft as { judgment?: Judgment } | null)?.judgment ?? null;
      const worldLog: WorldLogEntry[] = real.log.slice(logStart);
      writeFileSync(`${dir}/case-${c.caseId}.json`, JSON.stringify({
        variant: VARIANT, caseId: c.caseId, group: c.group, why: c.why, planDigest: plan.digest, startedAt: new Date(t0).toISOString(), ms, costJpy, error: error ?? null,
        A: { source: "事例定義に保存された従来方式の抽出結果", extracted: c.baseline.extracted, decision: c.baseline.decision },
        Aprime: { status: ap.status, input: (ap.draft as { input?: unknown } | null)?.input ?? null },
        B: { status: b.status, reasons: b.reasons, input: (b.draft as { input?: unknown } | null)?.input ?? null, judgment: j },
        investigation: cap1 ? { result: cap1.r, target: cap1.t } : null,
        worldLog,
      }, null, 1));

      // 中止条件の確認
      const decisions = j?.decisions ?? [];
      const risky = decisions.filter((d) => d.by === "investigation" && d.stage === "merge" && d.kind === "changed" && ["chain", "store", "items"].includes(String(d.field)));
      const bad: string[] = [];
      if (error) bad.push(`実行エラー: ${error.slice(0, 120)}`);
      if (risky.length) bad.push(`調査が系列・店舗・商品を変更（誤統合の疑い。人間が確認）: ${risky.map((d) => `${d.field} ${d.before}→${d.after}`).join(" / ")}`);
      if (cap1 && cap1.r.injectionFlags > 0) bad.push("本文に命令らしき文面を検出");
      const loops = cap1?.r.steps.filter((s) => !s.ok && /同じ|重複/.test(s.resultSummary)).length ?? 0;
      if (loops >= 3) bad.push(`同じ検索・取得の繰り返し（${loops}回）`);
      // 根拠のない確定: 「確定」の項目に、取得した情報源の根拠（URLと原文）が無い
      const unsupported = (cap1?.r.fields ?? []).filter((f) => f.state === "confirmed" && !f.sources.some((x) => x.url && !x.url.startsWith("(") && x.quote));
      if (unsupported.length) bad.push(`根拠のない確定: ${unsupported.map((f) => f.field).join("・")}`);
      if (costJpy >= 15) bad.push(`1件の費用が上限に到達（${costJpy}円）`);
      if (real.guard.spentJpy >= CAP) bad.push("累計の費用が上限に到達");
      if (bad.length) stopped = `${c.caseId}: ${bad.join("；")}`;
      summary.push({ caseId: c.caseId, group: c.group, statusA: c.baseline.decision.status, statusAprime: ap.status, statusB: b.status, costJpy, ms, investigated: !!cap1, stopReason: cap1?.r.stopReason ?? null, steps: cap1?.r.usage.steps ?? 0, searches: cap1?.r.usage.searches ?? 0, fetches: cap1?.r.usage.fetches ?? 0, stop: bad.length ? bad : null });
    }
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ runId, planDigest: plan.digest, model: "claude-haiku-5-5", capJpy: CAP, spentJpy: Number(real.guard.spentJpy.toFixed(4)), stopped, cases: summary }, null, 1));
    console.log(`9H-3D 実行 ${runId}: ${summary.length}件・累計 ${real.guard.spentJpy.toFixed(2)}円/${CAP}円${stopped ? `・停止: ${stopped}` : ""}`);
    expect(summary.length).toBeGreaterThan(0);
    expect(real.guard.spentJpy).toBeLessThanOrEqual(CAP);
  }, 3_000_000);
});

