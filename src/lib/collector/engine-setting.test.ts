import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@/lib/agent/core";
import { autonomousSlotDecision, compactRecord, LOCK_MS, MAX_RUNS_PER_SLOT, parseEngine, pruneTargets, resolveEffectiveEngine, RETENTION, slotKeyOf } from "./engine-setting";
import { checkReanalysis } from "./intake-check";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realDiscoveryDeps } from "@/lib/server/agent/discovery-real";

/** Stage 9H-3Q: 収集方式の解決・実行枠・保持方針・再解析との照合・実AIの関門（純関数。DB・外部通信なし） */
describe("収集方式の設定の解決（安全なフォールバックと、勝手に切り替えない）", () => {
  it("正しい値だけを受け付ける。不正値・未取得は従来方式（設定そのものは書き換えない）", () => {
    expect(parseEngine("autonomous")).toBe("autonomous");
    expect(parseEngine("legacy")).toBe("legacy");
    expect(parseEngine("AUTONOMOUS")).toBeNull();
    expect(parseEngine(undefined)).toBeNull();
    expect(resolveEffectiveEngine({ stored: "xyz", toremaneEnv: "local" })).toMatchObject({ engine: "legacy", stored: null });
    expect(resolveEffectiveEngine({ stored: "autonomous", loadFailed: true, toremaneEnv: "local" })).toMatchObject({ engine: "legacy", stored: null });
    expect(resolveEffectiveEngine({ stored: "autonomous", loadFailed: true, toremaneEnv: "local" }).note).toContain("変更していません");
  });
  it("自律型は開発環境のみ。本番では設定が autonomous でも従来方式で動く（保存値は保持）", () => {
    expect(resolveEffectiveEngine({ stored: "autonomous", toremaneEnv: "local" })).toEqual({ engine: "autonomous", stored: "autonomous", note: null });
    expect(resolveEffectiveEngine({ stored: "autonomous", toremaneEnv: undefined })).toMatchObject({ engine: "legacy", stored: "autonomous" });
    expect(resolveEffectiveEngine({ stored: "legacy", toremaneEnv: "local" })).toEqual({ engine: "legacy", stored: "legacy", note: null });
  });
});

describe("実行枠・排他・保持方針", () => {
  const hours = [6, 18];
  const at = (iso: string) => new Date(iso);
  it("同じ時間枠の実行回数に上限がある。前回の実行が続いている間は開始しない（期限を過ぎた残骸は無視）", () => {
    const now = at("2026-11-20T00:30:00Z"); // 日本時間 9:30 → 6時の枠
    expect(slotKeyOf(now, hours)).toBe("2026-11-20T06");
    expect(autonomousSlotDecision({ now, hours, runsInSlot: 0 }).due).toBe(true);
    expect(autonomousSlotDecision({ now, hours, runsInSlot: MAX_RUNS_PER_SLOT }).due).toBe(false);
    expect(autonomousSlotDecision({ now, hours, runsInSlot: 1, runningSince: new Date(now.getTime() - 60_000) }).due).toBe(false);
    expect(autonomousSlotDecision({ now, hours, runsInSlot: 1, runningSince: new Date(now.getTime() - LOCK_MS - 1) }).due).toBe(true);
    expect(slotKeyOf(at("2026-11-20T10:00:00Z"), hours)).toBe("2026-11-20T18");
  });
  it("保持方針: 期限を過ぎた記録・件数超過の記録だけが削除対象。実行中は残す", () => {
    const now = at("2026-12-01T00:00:00Z");
    const old = new Date(now.getTime() - (RETENTION.days + 1) * 86_400_000).toISOString();
    const rows = [
      { id: "old", started_at: old, status: "completed" },
      { id: "oldrun", started_at: old, status: "running" },
      { id: "new", started_at: "2026-11-30T00:00:00Z", status: "completed" },
    ];
    expect(pruneTargets(rows, now)).toEqual(["old"]);
    const many = Array.from({ length: RETENTION.maxRuns + 5 }, (_, i) => ({ id: `r${i}`, started_at: new Date(now.getTime() - i * 60_000).toISOString(), status: "completed" }));
    expect(pruneTargets(many, now)).toHaveLength(5);
  });
  it("記録は切り詰めて保存する（原文・経緯の長文を残さない）", () => {
    const r = { leads: [{ lead: { quote: "あ".repeat(900) } }], followUps: [{ outcome: "い".repeat(900) }] };
    const c = compactRecord(r);
    expect(c.leads[0].lead.quote).toHaveLength(300);
    expect(c.followUps[0].outcome).toHaveLength(160);
    expect(r.leads[0].lead.quote).toHaveLength(900); // 元は変えない
  });
});

describe("AIの発見と、既存の登録経路の再解析との照合（別の抽選の誤登録を防ぐ）", () => {
  const hint = { chain: "テスト玩具", store: "三宮店", selectMode: false, products: ["ハドウシーカー"] };
  const re = (o: object) => ({ chainName: "テスト玩具", storeName: "三宮店", products: ["ハドウシーカー"], selectMode: false, ...o });
  it("系列・店舗・商品が一致すれば通す（店舗名の「店」の有無・系列の表記違いは同一視）", () => {
    expect(checkReanalysis(hint, re({}))).toEqual({ ok: true });
    expect(checkReanalysis(hint, re({ storeName: "三宮" })).ok).toBe(true);
  });
  it("別の系列・別の店舗・店舗を読み取れない・商品が違う・店舗選択式の不一致は、登録しない", () => {
    expect(checkReanalysis(hint, re({ chainName: "別の系列" })).ok).toBe(false);
    expect(checkReanalysis(hint, re({ storeName: "難波店" })).ok).toBe(false);
    expect(checkReanalysis(hint, re({ storeName: "" })).ok).toBe(false);
    expect(checkReanalysis(hint, re({ selectMode: true, storeName: "応募時に店舗を選択" })).ok).toBe(false);
    expect(checkReanalysis(hint, re({ products: ["別の商品"] })).ok).toBe(false);
    expect(checkReanalysis({ ...hint, store: undefined, selectMode: true }, re({ selectMode: false })).ok).toBe(false);
    expect(checkReanalysis({ ...hint, store: undefined, selectMode: true }, re({ selectMode: true, storeName: "応募時に店舗を選択" })).ok).toBe(true);
  });
});

describe("実AI・実検索の関門（有料。承認なしには接続しない）", () => {
  const dir = join(tmpdir(), "ledger-9h3q-test");
  const calls: string[] = [];
  const factory = () => {
    calls.push("client");
    return { messages: { create: () => { throw new Error("呼ばれてはいけない"); } } };
  };
  it("環境が揃っていなければ接続しない（理由つき。キーは理由に含めない）", () => {
    for (const env of [{}, { TOREMANE_ENV: "local" }, { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "sk-test-secret", AGENT_MAX_COST_JPY_PER_RUN: "10", AGENT_MAX_RUNS_PER_DAY: "5" }]) {
      const r = realDiscoveryDeps({ env, clientFactory: factory, ledgerDir: dir });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("sk-test-secret");
    }
    expect(calls).toEqual([]);
  });
  it("累計上限と確認が揃ったときだけ生成される（生成だけ。呼び出さない）", () => {
    const env = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "sk-test-secret", AGENT_MAX_COST_JPY_PER_RUN: "10", AGENT_MAX_RUNS_PER_DAY: "5", COLLECT_AUTONOMOUS_CAP_JPY: "20", COLLECT_AUTONOMOUS_CONFIRM: "yes" };
    const r = realDiscoveryDeps({ env, clientFactory: factory, ledgerDir: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.perMissionJpy).toBeGreaterThan(0);
    expect(new ToolRegistry().names()).toEqual([]);
  });
});

describe("9H-3R: 本番での有効化条件と費用管理（本番の収集方式は変更しない。許可は環境変数で明示）", () => {
  it("開発環境、または AUTONOMOUS_COLLECTION=on のときだけ自律型を使える。許可がなければ設定が autonomous でも従来方式（保存値は保持）", async () => {
    const { autonomousAllowed } = await import("./engine-setting");
    expect(autonomousAllowed({ TOREMANE_ENV: "local" })).toBe(true);
    expect(autonomousAllowed({ AUTONOMOUS_COLLECTION: "on" })).toBe(true);
    expect(autonomousAllowed({})).toBe(false);
    expect(autonomousAllowed({ AUTONOMOUS_COLLECTION: "yes" })).toBe(false);
    expect(resolveEffectiveEngine({ stored: "autonomous" })).toMatchObject({ engine: "legacy", stored: "autonomous" });
    expect(resolveEffectiveEngine({ stored: "autonomous", enabled: true })).toMatchObject({ engine: "autonomous", note: null });
    // 許可を外すだけで従来方式に戻る（設定・データは変えない）
    expect(resolveEffectiveEngine({ stored: "autonomous", enabled: false }).engine).toBe("legacy");
  });
  const prodEnv = { AUTONOMOUS_COLLECTION: "on", ANTHROPIC_API_KEY: "sk-prod-secret" };
  const factory = () => ({ messages: { create: () => { throw new Error("呼ばれてはいけない"); } } });
  it("本番の接続: 許可・キー・残り予算が揃わなければ接続しない（理由にキーを含めない）。予算が1件の上限に満たなければ開始しない", () => {
    expect(realDiscoveryDeps({ env: {}, clientFactory: factory }).ok).toBe(false);
    expect(realDiscoveryDeps({ env: { AUTONOMOUS_COLLECTION: "on" }, budgetRemainingJpy: 50, clientFactory: factory }).ok).toBe(false);
    const noBudget = realDiscoveryDeps({ env: prodEnv, clientFactory: factory });
    expect(noBudget.ok).toBe(false);
    const low = realDiscoveryDeps({ env: prodEnv, budgetRemainingJpy: 3, clientFactory: factory });
    expect(low).toMatchObject({ ok: false });
    expect(JSON.stringify([noBudget, low])).not.toContain("sk-prod-secret");
    const ok = realDiscoveryDeps({ env: prodEnv, budgetRemainingJpy: 25, clientFactory: factory });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.guard.spentJpy).toBe(0);
      expect(ok.ledgerFile).toBe("(db)");
    }
  });
  it("店舗名の屋号・ブランド名つきの表記を同じ店舗として扱う（短い名称では同一視しない）", async () => {
    const { sameStore } = await import("@/lib/agent/discovery/verify");
    expect(sameStore("ビデオインアメリカ 西七条店", "トレカチャンピオン（ビデオインアメリカ西七条店）", "西七条店", "トレカチャンピオン")).toBe(true);
    expect(sameStore("北店", "A", "大北店", "A")).toBe(false);
  });
});

describe("本番運用の調査機会・費用（9H-3R-Release）", () => {
  it("繁忙期: 発売日が3日前〜7日後にあるときだけ。調査機会は通常4回・繁忙期8回", async () => {
    const { isBusyPeriod, opportunityHours } = await import("@/lib/collector/engine-setting");
    expect(isBusyPeriod("2026-11-20", ["2026-11-27"])).toBe(true); // 7日後
    expect(isBusyPeriod("2026-11-19", ["2026-11-27"])).toBe(false); // 8日後
    expect(isBusyPeriod("2026-11-30", ["2026-11-27"])).toBe(true); // 3日後（経過）
    expect(isBusyPeriod("2026-12-01", ["2026-11-27"])).toBe(false);
    expect(isBusyPeriod("2026-11-20", [null, undefined, "不正"])).toBe(false);
    expect(opportunityHours(false)).toHaveLength(4);
    expect(opportunityHours(true)).toHaveLength(8);
  });
  it("費用の上限の既定は 日次100円・月次1,500円・1件15円。不正な値は既定に戻す", async () => {
    const { autonomousCaps } = await import("@/lib/collector/engine-setting");
    expect(autonomousCaps({})).toEqual({ dailyJpy: 100, monthlyJpy: 1500, perMissionJpy: 15 });
    expect(autonomousCaps({ AUTONOMOUS_DAILY_CAP_JPY: "abc", AUTONOMOUS_MONTHLY_CAP_JPY: "-5", COLLECT_AUTONOMOUS_PER_MISSION_JPY: "0" })).toEqual({ dailyJpy: 100, monthlyJpy: 1500, perMissionJpy: 15 });
    expect(autonomousCaps({ AUTONOMOUS_DAILY_CAP_JPY: "60" }).dailyJpy).toBe(60);
  });
  it("時間配分: 既定は調査100秒＋登録40秒。環境変数で短くでき、120秒を超えない", async () => {
    const { autonomousTimeBudget } = await import("@/lib/collector/engine-setting");
    expect(autonomousTimeBudget({})).toEqual({ missionMs: 100_000, totalMs: 140_000 });
    expect(autonomousTimeBudget({ AUTONOMOUS_TIME_BUDGET_MS: "35000" })).toEqual({ missionMs: 35_000, totalMs: 75_000 });
    expect(autonomousTimeBudget({ AUTONOMOUS_TIME_BUDGET_MS: "900000" }).missionMs).toBe(120_000);
    expect(autonomousTimeBudget({ AUTONOMOUS_TIME_BUDGET_MS: "100" }).missionMs).toBe(100_000);
  });
  it("費用の配分: 上限に近ければ開始しない。枠の2件目以降は残りの機会への配分に収まるときだけ", async () => {
    const { paceDecision } = await import("@/lib/collector/engine-setting");
    expect(paceDecision({ dailyRemaining: 100, monthlyRemaining: 1500, slotSpent: 0, slotsLeftToday: 4, perMissionJpy: 15 }).ok).toBe(true);
    expect(paceDecision({ dailyRemaining: 14, monthlyRemaining: 1500, slotSpent: 0, slotsLeftToday: 1, perMissionJpy: 15 })).toMatchObject({ ok: false });
    expect(paceDecision({ dailyRemaining: 100, monthlyRemaining: 10, slotSpent: 0, slotsLeftToday: 4, perMissionJpy: 15 }).reason).toContain("今月");
    // 4回の機会・残り100円: 1枠の配分は25円。1件目で10円使っても、2件目（10円）は収まる。3件目は収まらない
    expect(paceDecision({ dailyRemaining: 90, monthlyRemaining: 1500, slotSpent: 10, slotsLeftToday: 4, perMissionJpy: 15 }).ok).toBe(true);
    expect(paceDecision({ dailyRemaining: 80, monthlyRemaining: 1500, slotSpent: 20, slotsLeftToday: 4, perMissionJpy: 15 }).ok).toBe(false);
    // 残りの機会が少ないほど、配分は大きい
    expect(paceDecision({ dailyRemaining: 60, monthlyRemaining: 1500, slotSpent: 20, slotsLeftToday: 1, perMissionJpy: 15 }).ok).toBe(true);
  });
  it("通常期は、直前の調査で何も見つからなければ残りを見送る。繁忙期・失敗・成果ありは続ける", async () => {
    const { slotWorthContinuing } = await import("@/lib/collector/engine-setting");
    const empty = { status: "completed", found: 0, registered: 0, held: 0 };
    expect(slotWorthContinuing({ busy: false, previous: [] }).ok).toBe(true);
    expect(slotWorthContinuing({ busy: false, previous: [empty] }).ok).toBe(false);
    expect(slotWorthContinuing({ busy: true, previous: [empty] }).ok).toBe(true);
    expect(slotWorthContinuing({ busy: false, previous: [{ ...empty, found: 1 }] }).ok).toBe(true);
    expect(slotWorthContinuing({ busy: false, previous: [{ ...empty, status: "failed" }] }).ok).toBe(true);
  });
});
