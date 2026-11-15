/**
 * Stage 9H-3C: 保存済みの実AI結果（Stage 9H-2: backups/eval-9h2）の再生（実Supabase。有料API・ネットワークなし）
 *  - A（従来の収集AIの出力）: 9H-2の事例定義に保存された抽出結果を、収集側のAI出力として再現する（AIの入力本文は保存されていないため、本文は再現しない）
 *  - B（実AI調査）: 9H-2で保存された調査結果（項目・状態・根拠・行動の記録）を、現在のコードで共通モデルへ変換し、実際の processQueue → processCandidate（応募単位の判定・店舗照合・重複・登録判定）に合流させる
 *  各事例で、AとBの値・最終の登録候補・判断の記録を比べ、**Bの項目が最終結果に残る／理由つきで保留される／理由なく消える** に分類する。消えた項目は0であること。
 *  保存データが無い環境（backups/ は Git管理外）ではスキップ。結果の一覧は backups/eval-9h3c/replay.json に保存する。
 *  npm run test:db
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS, type CollectionConditions } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { resultToCaseFile } from "@/lib/agent/case-investigator/to-case";
import { caseFromInput } from "@/lib/case-model/from-extraction";
import { sameMeaning, type Judgment } from "@/lib/case-model/judgment";
import { CASE_FIELD_KEYS, CASE_FIELD_LABEL, type CaseFile, type CaseFieldKey } from "@/lib/case-model/types";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const OUT = "backups/eval-9h2";
const HAVE = existsSync(`${OUT}/cases.json`) && existsSync(`${OUT}/runs`);

interface CaseDef {
  caseId: string;
  group: string;
  target: CaseTarget;
  baseline: { extracted: Record<string, string | string[] | null>; sourceUrl?: string; sourceTitle?: string; decision: { status: string } };
  priorHuman?: { verdict?: string; comment?: string };
}
const cases: CaseDef[] = HAVE ? (JSON.parse(readFileSync(`${OUT}/cases.json`, "utf8")) as { cases: CaseDef[] }).cases : [];
/** 事例ごとの最新の保存結果 */
function savedResult(caseId: string): { result: CaseInvestigationResult; startedAt: string } | null {
  let best: { result: CaseInvestigationResult; startedAt: string } | null = null;
  for (const run of readdirSync(`${OUT}/runs`)) {
    const f = `${OUT}/runs/${run}/case-${caseId}.json`;
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")) as { result: CaseInvestigationResult | null; startedAt: string };
    if (j.result && (!best || j.startedAt > best.startedAt)) best = { result: j.result, startedAt: j.startedAt };
  }
  return best;
}

const flex = (v: unknown) => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(v) : null;
  return m ? { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : null, minute: m[5] ? +m[5] : null } : { year: null, month: null, day: null, hour: null, minute: null };
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

type Outcome = "kept" | "held" | "lost" | "none" | "not_used";
interface Row {
  field: string;
  a: string | null;
  b: string | null;
  bState: string | null;
  final: string | null;
  outcome: Outcome;
  note: string;
}

describe.skipIf(!dbTestsEnabled || !HAVE)("Stage 9H-3C 保存済みの実AI結果の再生", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let current: CaseDef | null = null;
  let bFile: CaseFile | null = null;
  const U = (n: string) => `https://q9h3c.example.invalid/${n}`;
  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      // 収集側のAI出力は、9H-2に保存されたA（従来方式の抽出結果）を再現する
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
  const cond = (o: Partial<CollectionConditions> = {}): CollectionConditions => ({ ...DEFAULT_CONDITIONS, prefectures: ["東京都"], ...o });
  const refNow = (c: CaseDef) => {
    const d = str(c.baseline.extracted.applyDeadline).slice(0, 10) || "2026-11-10";
    return new Date(new Date(`${d}T12:00:00+09:00`).getTime() - 86400_000);
  };
  const deps = (c: CaseDef, withInvestigation: boolean): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: refNow(c), actor: null, canRegister: false, serviceRegister: true, extractor: extractor as never, xClient: null,
    // 公式ページは取得できる想定（取得制限の事例も、A の抽出結果が得られた状況を再現する）。本文の内容は再現しない（保存されていない）
    fetchPage: async (u: string) => ({ ok: true, finalUrl: u, status: 200, contentType: "text/html", body: `<html><head><title>${str(c.baseline.sourceTitle)}</title></head><body><p>${str(c.baseline.sourceTitle)} の抽選販売のお知らせです。詳細は応募ページをご確認ください。保存済み事例の再生用の本文です。</p></body></html>`, truncated: false }) as never,
    fetchOembed: async () => ({ ok: false, message: "x" }),
    ...(withInvestigation ? { investigate: async () => ({ caseFile: bFile!, stopReason: "replay" }) } : {}),
  });
  const run = async (c: CaseDef, withInvestigation: boolean) => processQueue(deps(c, withInvestigation), { settings: { auto_register: true }, cond: cond(), data: await loadAppData(sys, hid), aiLeft: 8, timeLeft: () => 50_000, perBatch: 4 });
  const add = (n: string, c: CaseDef) =>
    sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: U(n), title: str(c.baseline.sourceTitle) || n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: U(n), title: str(c.baseline.sourceTitle) || n, context: str(c.baseline.sourceTitle), card: str(c.baseline.sourceTitle), sourceName: "replay", attempts: 0 } } as never });
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,reasons,lottery_id,draft").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const mkMasters = async (c: CaseDef) => {
    const names = [str(c.baseline.extracted.chain), ...(c.target.chain ? [c.target.chain] : [])].filter(Boolean);
    for (const name of [...new Set(names)]) {
      const ex = (await sys.from("chains").select("id").eq("household_id", hid).eq("name", name).maybeSingle()).data;
      if (!ex) {
        const ch = (await u1.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
        await u1.from("stores").insert({ household_id: hid, chain_id: ch, name: "応募時に店舗選択", prefecture: "" });
      }
    }
    for (const p of (c.baseline.extracted.products as string[]) ?? []) {
      if (!(await sys.from("products").select("id").eq("household_id", hid).eq("official_name", p).maybeSingle()).data) await u1.from("products").insert({ household_id: hid, official_name: p, packs_per_box: 20 });
    }
  };
  const clearLotteries = async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q9h3c.example.invalid%");
    await sys.from("lotteries").delete().eq("household_id", hid);
  };
  const setFlags = (on: boolean, inv = false) => {
    process.env.TOREMANE_ENV = "local";
    if (on) process.env.COLLECT_UNIFIED = "on";
    else delete process.env.COLLECT_UNIFIED;
    if (inv) process.env.COLLECT_INVESTIGATE = "on";
    else delete process.env.COLLECT_INVESTIGATE;
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3c", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
  });
  afterEach(() => setFlags(false));
  afterAll(async () => {
    await clearLotteries();
    await cleanupTestUsers(admin, userIds);
  });

  const inputOf = (c: { draft: unknown }) => (c.draft as { input?: Parameters<typeof caseFromInput>[0] } | null)?.input;
  const rows: { caseId: string; group: string; status: string; investigation: string; rows: Row[]; lost: string[]; rejected: string[]; note: string }[] = [];

  it("保存された13事例: Bの項目が、最終の登録候補に残る／理由つきで保留される。理由なく消えた項目は0", async () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      const saved = savedResult(c.caseId);
      if (!saved) continue;
      current = c;
      bFile = resultToCaseFile(saved.result, c.target, saved.startedAt);
      await clearLotteries();
      await mkMasters(c);
      setFlags(true, true);
      await add(`${c.caseId}-b`, c);
      await run(c, true);
      const cc = await cand(`${c.caseId}-b`);
      const j = (cc.draft as { judgment?: Judgment } | null)?.judgment;
      const fin = inputOf(cc);
      if (!j || !fin) {
        rows.push({ caseId: c.caseId, group: c.group, status: cc.status, investigation: "判断履歴なし（収集の途中で終了）", rows: [], lost: [], rejected: [], note: JSON.stringify(cc.reasons).slice(0, 160) });
        continue;
      }
      const final = caseFromInput(fin, cc.id, "t");
      // 調査が不要と判定された事例（読み取りが十分）では、Bは使われない（仕様）。使われなかったことを区別して記録する
      const used = !!j.investigation?.executed;
      const out: Row[] = [];
      const lost: string[] = [];
      for (const k of CASE_FIELD_KEYS) {
        const b = bFile.fields[k];
        const a = j.ai[k]?.value ?? null;
        const f = final.fields[k].value;
        if (!b.value || b.state === "missing") {
          if (a || f) out.push({ field: k, a, b: null, bState: null, final: f, outcome: "none", note: "" });
          continue;
        }
        if (!used) {
          out.push({ field: k, a, b: b.value, bState: b.state, final: f, outcome: "not_used", note: "調査が不要と判定されたため合流していない" });
          continue;
        }
        const recorded = j.decisions.some((d) => d.field === k && ["adopted", "changed", "held", "rejected"].includes(d.kind) && d.by !== "ai") || j.unreflected.some((u) => u.key === k);
        const same = sameMeaning(k, b.value, f);
        const outcome: Outcome = same ? "kept" : recorded ? "held" : "lost";
        if (outcome === "lost") lost.push(`${CASE_FIELD_LABEL[k]}: ${b.value}`);
        out.push({ field: k, a, b: b.value, bState: b.state, final: f, outcome, note: recorded ? (j.decisions.find((d) => d.field === k && d.by !== "ai")?.reason ?? "未反映情報に保持").slice(0, 80) : "" });
      }
      rows.push({ caseId: c.caseId, group: c.group, status: cc.status, investigation: j.investigation?.executed ? `実行（採用${j.investigation.outcome?.applied}・保留${j.investigation.outcome?.held}）` : `未実行（${j.investigation?.skipped ?? "-"}）`, rows: out, lost, rejected: j.decisions.filter((d) => d.kind === "rejected").map((d) => `${d.field}: ${d.reason}`.slice(0, 120)), note: "" });
    }
    mkdirSync("backups/eval-9h3c", { recursive: true });
    writeFileSync("backups/eval-9h3c/replay.json", JSON.stringify({ generatedAt: new Date().toISOString(), source: OUT, note: "AIの入力本文は保存されていないため再現していない。Aは事例定義の抽出結果、Bは9H-2の保存結果。", cases: rows }, null, 1));
    const lostAll = rows.flatMap((r) => r.lost.map((l) => `${r.caseId} ${l}`));
    expect(lostAll, JSON.stringify(lostAll)).toEqual([]);
    expect(rows.filter((r) => r.rows.length > 0).length).toBeGreaterThanOrEqual(8); // 判断履歴が取れた事例（残りは収集の途中で終了＝報告に明記）
  });

  const row = (id: string) => rows.find((r) => r.caseId === id);
  const field = (id: string, f: CaseFieldKey) => row(id)?.rows.find((x) => x.field === f);

  it("フルコンプ（k-1d2511ea）: 調査が補った応募開始が届く。店舗の羅列は店舗の値にならず保持され、当選発表の期間が検証で拒否された理由が項目単位で残る", () => {
    const r = row("k-1d2511ea");
    if (!r || !r.rows.length) return;
    expect(field("k-1d2511ea", "applyStart")).toMatchObject({ outcome: "kept" });
    // 応募締切: 受付表示の12:00と主催者本文の11:59（1分差）は同じ締切の表記差。人間の評価どおり早い方に統一され、変更の理由が残る
    expect(field("k-1d2511ea", "applyDeadline")).toMatchObject({ final: "2026-11-15 11:59" });
    const store = field("k-1d2511ea", "store");
    expect(store?.final ?? null).toBeNull(); // 8店舗の羅列が店舗名にならない
    expect(store?.outcome === "held" || !store).toBe(true);
    expect(r.rejected.some((x) => x.includes("日時の形式が正しくない"))).toBe(true);
  });

  it("イトーヨーカドー（k-9916ce22）: 調査の店舗（系列名と同じ文字列・未確認）は、読み取りの店舗『通販』を置き換えない", () => {
    const r = row("k-9916ce22");
    if (!r || !r.rows.length) return;
    const s = field("k-9916ce22", "store");
    expect(s?.final).toBe("通販");
  });

  it("ガンリュウ（k-56f3fd88）: 調査で別店舗（札幌・静岡）の情報が混入しない。系列・店舗は不明のまま（推測で埋めない）", () => {
    const r = row("k-56f3fd88");
    if (!r || !r.rows.length) return;
    expect(field("k-56f3fd88", "store")?.final ?? null).toBeNull();
    expect(field("k-56f3fd88", "chain")?.final ?? null).toBeNull();
  });

  it("キデイランド（9F-2の評価事例。9H-2では未調査）: 過去の人間の判断（店舗選択式）が参考情報としてAIの入力に入る。調査結果が無いので、登録候補は変わらない（未検証＝実AIでの効果は測れていない）", async () => {
    const setFile = readdirSync("backups/review-sets").filter((f) => f.startsWith("review-set-production")).sort().pop();
    if (!setFile) return;
    const set = JSON.parse(readFileSync(`backups/review-sets/${setFile}`, "utf8")) as { cases: { caseId: string; source: { title: string }; ai: { extracted: Record<string, string | string[] | null> } }[] };
    for (const id of ["k-9e5d05dc", "k-6336a920"]) {
      const k = set.cases.find((x) => x.caseId === id);
      if (!k) continue;
      const c = { caseId: id, group: "kidyland", target: { id, chain: "キデイランド", products: [], known: {}, manualFields: [], knownSources: [] }, baseline: { extracted: k.ai.extracted, sourceTitle: k.source.title, decision: { status: "x" } } } as unknown as CaseDef;
      current = c;
      await clearLotteries();
      await mkMasters(c);
      setFlags(true);
      await add(`${id}-kd`, c);
      await run(c, false);
      const cc = await cand(`${id}-kd`);
      const j = (cc.draft as { judgment?: Judgment } | null)?.judgment;
      expect(j, `${cc.status} ${JSON.stringify(cc.reasons)}`).toBeDefined();
      // 実際の評価ファイルから作った参考情報が、AIへの入力に入っている（参考であることの注記つき）
      expect(j!.aiInput?.context.join(""), id).toContain("店舗選択式");
      expect(j!.aiInput?.context.join(""), id).toContain("今回の告知の記載を優先");
      // 調査結果が無いので、店舗は読み取りのまま（モックのAIは判断を変えない）。改善の有無は実AIで検証する
      expect(inputOf(cc)?.store?.name ?? "", id).toBe(str(k.ai.extracted.store));
    }
  });

  it("フラグ無効（従来）とフラグ有効・調査なしで、登録候補の内容が同じ（保存済みの全事例）。有効側にだけ判断履歴が付く", async () => {
    let compared = 0;
    for (const c of cases) {
      current = c;
      await clearLotteries();
      await mkMasters(c);
      setFlags(false);
      await add(`${c.caseId}-off`, c);
      await run(c, false);
      const off = await cand(`${c.caseId}-off`);
      await clearLotteries();
      await mkMasters(c);
      setFlags(true);
      await add(`${c.caseId}-on`, c);
      await run(c, false);
      const on = await cand(`${c.caseId}-on`);
      expect(on.status, c.caseId).toBe(off.status);
      const strip = (x: unknown) => JSON.parse(JSON.stringify(x ?? null, (k, v) => (k === "sourceUrls" ? undefined : v)));
      expect(strip(inputOf(on)), c.caseId).toEqual(strip(inputOf(off)));
      expect((off.draft as { judgment?: unknown } | null)?.judgment, c.caseId).toBeUndefined();
      compared += 1;
    }
    expect(compared).toBe(cases.length);
  });
});
