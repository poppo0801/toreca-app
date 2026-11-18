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
