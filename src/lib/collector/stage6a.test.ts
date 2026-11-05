import { describe, expect, it } from "vitest";
import { dueSources, runResultOf, slotDateOf, type AttemptLite } from "@/lib/collector/schedule";
import { listInfoFromQueued, listInfoOf, rebuildQueued } from "@/lib/collector/queued";
import { healthWarnings, type HealthInput } from "@/lib/collector/queue";
import { monthBudget } from "@/lib/server/ai-budget";
import type { Db } from "@/lib/server/lottery-service";

// 日本時間 2026-11-05 のスロット: 11/5 6:00 JST = 11/4 21:00 UTC
const at = (iso: string) => new Date(iso);
const att = (sourceId: string, status: AttemptLite["status"], iso: string, extra: Partial<AttemptLite> = {}): AttemptLite => ({ sourceId, trigger: "cron", slotDate: "2026-11-05", status, at: at(iso), ...extra });

describe("Stage 6A B1: 定期収集の判定（手動収集と独立）", () => {
  it("スロット日付は日本時間の6:00で切り替わる（6:00前は前日のスロット）", () => {
    expect(slotDateOf(at("2026-11-04T20:59:00Z"), 6)).toBe("2026-11-04"); // 5:59 JST
    expect(slotDateOf(at("2026-11-04T21:00:00Z"), 6)).toBe("2026-11-05"); // 6:00 JST
    expect(slotDateOf(at("2026-11-05T14:59:00Z"), 6)).toBe("2026-11-05"); // 23:59 JST
  });
  it("手動収集の記録（slot_date なし）は数えない: 朝の定期収集は実行される", () => {
    const manual: AttemptLite[] = [{ sourceId: "a", trigger: "manual", slotDate: null, status: "ok", at: at("2026-11-04T04:35:00Z") }];
    const r = dueSources(at("2026-11-04T21:00:30Z"), 6, ["a", "b"], manual);
    expect(r.slotDate).toBe("2026-11-05");
    expect(r.due).toEqual(["a", "b"]);
  });
  it("取得に成功した収集元は同日に再取得しない（重複実行しない）", () => {
    const r = dueSources(at("2026-11-04T22:00:00Z"), 6, ["a", "b"], [att("a", "ok", "2026-11-04T21:00:05Z")]);
    expect(r.done).toEqual(["a"]);
    expect(r.due).toEqual(["b"]);
  });
  it("一部の収集元が失敗しても、他の収集元を実行済みにしない。失敗は30分おいて再試行する", () => {
    const attempts = [att("a", "ok", "2026-11-04T21:00:05Z"), att("b", "error", "2026-11-04T21:00:06Z")];
    expect(dueSources(at("2026-11-04T21:10:00Z"), 6, ["a", "b"], attempts)).toMatchObject({ due: [], waiting: ["b"], done: ["a"] });
    expect(dueSources(at("2026-11-04T21:31:00Z"), 6, ["a", "b"], attempts)).toMatchObject({ due: ["b"], done: ["a"] });
  });
  it("再試行には上限がある（無限に取得し続けない）", () => {
    const many = Array.from({ length: 6 }, (_, i) => att("b", "error", `2026-11-04T2${i}:00:00Z`.replace("T26", "T21")));
    expect(dueSources(at("2026-11-05T03:00:00Z"), 6, ["b"], many).exhausted).toEqual(["b"]);
  });
  it("設定で停止中・予算上限は待っても変わらないので、そのスロットでは完了扱い（再試行しない）", () => {
    const r = dueSources(at("2026-11-04T23:00:00Z"), 6, ["x", "y", "z"], [att("x", "disabled", "2026-11-04T21:00:00Z"), att("y", "budget", "2026-11-04T21:00:00Z"), att("z", "not_configured", "2026-11-04T21:00:00Z")]);
    expect(r.due).toEqual([]);
    expect(r.done).toHaveLength(3);
  });
  it("前日のスロットのまま6:00を迎えると、新しいスロットとして全収集元が対象になる", () => {
    const yesterday = [att("a", "ok", "2026-11-03T21:00:00Z", { slotDate: "2026-11-04" })];
    expect(dueSources(at("2026-11-04T21:00:30Z"), 6, ["a"], yesterday).due).toEqual(["a"]);
  });
  it("結果: すべて成功=complete／一部失敗=partial／すべて失敗=failed／1件も取得していない=empty（正常完了にしない）", () => {
    expect(runResultOf(["ok", "ok"])).toBe("complete");
    expect(runResultOf(["ok", "error"])).toBe("partial");
    expect(runResultOf(["error", "blocked"])).toBe("failed");
    expect(runResultOf(["disabled", "budget"])).toBe("empty");
    expect(runResultOf([])).toBe("empty");
  });
});

describe("Stage 6A C5: 再解析で一覧の情報を保持する", () => {
  const list = {
    title: "【抽選】テスト商品",
    context: "テスト玩具 本店 11/6(金) 21:00まで",
    card: "テスト商品 テスト玩具 本店 販売価格 ¥7,200 11/6(金) 21:00まで",
    fields: { store: "テスト玩具 本店", product: "テスト商品" },
    hints: { deadlineIso: "2026-11-06T12:00:00.000Z", deadlineDate: null, prefecture: "東京都", online: false },
    sourceName: "pokeso",
    seenAt: "2026-11-04T04:00:00.000Z",
  };
  const queuedDraft = { queued: { kind: "web_page", url: "https://q6a.example.invalid/a", title: list.title, context: list.context, card: list.card, fields: list.fields, hints: list.hints, sourceName: "pokeso", attempts: 2, viaList: true, viaKind: "robots", memoId: "m1", listSeenAt: list.seenAt } };

  it("queued が残っていれば、card・fields・hints・context・メモ関連を引き継ぎ、前回の結果の印（viaList）は引き継がない", () => {
    const q = rebuildQueued(queuedDraft, { kind: "web_page", url: "https://q6a.example.invalid/a", sourceName: "再解析", reason: "manual_reanalyze", changed: true });
    expect(q).toMatchObject({ card: list.card, fields: list.fields, hints: list.hints, context: list.context, title: list.title, memoId: "m1", changed: true, attempts: 0, reason: "manual_reanalyze", sourceName: "pokeso" });
    expect(q).not.toHaveProperty("viaList");
    expect(q).not.toHaveProperty("viaKind");
  });
  it("解析が終わって queued が無い草稿でも、listInfo から復元できる（解析後の再解析・保留の再調査・再評価）", () => {
    const info = listInfoFromQueued(queuedDraft.queued, "2026-11-04T05:00:00.000Z");
    expect(info?.seenAt).toBe(list.seenAt);
    const after = { input: { chain: { id: null, name: "x" } }, listInfo: info };
    expect(listInfoOf(after)?.card).toBe(list.card);
    const q = rebuildQueued(after, { kind: "web_page", url: "https://q6a.example.invalid/a", sourceName: "再調査", reason: "auto_recheck", changed: true });
    expect(q).toMatchObject({ card: list.card, fields: list.fields, hints: list.hints });
  });
  it("新しい一覧の情報があればそれを優先し、無い項目だけ以前の情報を残す", () => {
    const q = rebuildQueued(queuedDraft, { kind: "web_page", url: "u", sourceName: "pokeso", reason: "list_change", changed: true }, { title: "新しい題名", context: "", hints: { ...list.hints, deadlineIso: "2026-11-07T12:00:00.000Z" }, seenAt: "2026-11-05T04:00:00.000Z" });
    expect((q.hints as { deadlineIso: string }).deadlineIso).toBe("2026-11-07T12:00:00.000Z");
    expect(q.title).toBe("新しい題名");
    expect(q.card).toBe(list.card); // 新しい情報に無い項目は残す
    expect(q.listSeenAt).toBe("2026-11-05T04:00:00.000Z");
  });
  it("古い情報（seenAt が以前より古い）では、新しい一覧の情報を上書きしない", () => {
    const q = rebuildQueued(queuedDraft, { kind: "web_page", url: "u", sourceName: "pokeso", reason: "list_change" }, { card: "古いカード", seenAt: "2026-11-01T00:00:00.000Z" });
    expect(q.card).toBe(list.card);
    expect(q.listSeenAt).toBe(list.seenAt);
  });
  it("一覧の情報が何も残っていなければ、候補の題名で作る（情報を捏造しない）", () => {
    const q = rebuildQueued({}, { kind: "web_page", url: "u", sourceName: "再解析", reason: "manual_reanalyze", fallbackTitle: "候補の題名" });
    expect(q).toMatchObject({ title: "候補の題名", context: "" });
    expect(q).not.toHaveProperty("card");
  });
});

// 最小のクエリ疑似オブジェクト: 呼ばれたテーブルごとに固定の行を返す
function fakeDb(tables: Record<string, unknown[] | unknown>): Db {
  const make = (name: string) => {
    const rows = tables[name];
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "gte", "limit", "eq", "lt", "order"]) chain[m] = self;
    chain.maybeSingle = async () => ({ data: Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null), error: null });
    chain.then = (res: (v: unknown) => unknown) => res({ data: Array.isArray(rows) ? rows : [], error: null });
    return chain;
  };
  return { from: (n: string) => make(n) } as unknown as Db;
}

describe("Stage 6A A1: 月額予算は利用ログと日別統計の大きい方を基準にする", () => {
  const nowIso = new Date().toISOString();
  const jstMonthDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const logs = (n: number) => Array.from({ length: n }, () => ({ created_at: nowIso, kind: "url", status: "ok", engine: "anthropic", model: "claude-haiku-5-5", input_tokens: 10_000, output_tokens: 3_000 }));
  const settings = [{ ai_monthly_budget_jpy: 3000, ai_usd_jpy_rate: 150, auto_ai_enabled: true }];

  it("利用ログが欠けていても、日別統計の費用を下回らない（過少計上しない）", async () => {
    const b = await monthBudget(fakeDb({ ai_extraction_logs: logs(2), household_settings: settings, collection_daily_stats: [{ day: jstMonthDay, ai_calls: 300, cost_jpy: 150 }] }));
    expect(b.costJpy).toBe(150);
    expect(b.calls).toBe(300);
    expect(b.statsCostJpy).toBe(150);
    expect(b.logCostJpy).toBeLessThan(5);
  });
  it("利用ログが完全なとき（日別統計より多い）はログ基準。二重に加算しない", async () => {
    const b = await monthBudget(fakeDb({ ai_extraction_logs: logs(100), household_settings: settings, collection_daily_stats: [{ day: jstMonthDay, ai_calls: 100, cost_jpy: 12 }] }));
    expect(b.costJpy).toBe(b.logCostJpy);
    expect(b.costJpy).toBeGreaterThan(12);
    expect(b.calls).toBe(100);
  });
  it("日別統計の費用が予算を超えていれば、利用ログが空でも上限（blocked）になる＝有料AI解析を停止できる", async () => {
    const b = await monthBudget(fakeDb({ ai_extraction_logs: [], household_settings: settings, collection_daily_stats: [{ day: jstMonthDay, ai_calls: 9000, cost_jpy: 3100 }] }));
    expect(b.blocked).toBe(true);
  });
  it("日別統計を読めないときは、利用ログだけで判定する（従来どおり）", async () => {
    const db = { from: (n: string) => (n === "collection_daily_stats" ? { select: () => ({ gte: () => ({ eq: () => Promise.resolve({ data: null, error: { code: "x" } }) }), }) } : (fakeDb({ ai_extraction_logs: logs(3), household_settings: settings }) as unknown as { from: (n: string) => unknown }).from(n)) } as unknown as Db;
    const b = await monthBudget(db);
    expect(b.costJpy).toBe(b.logCostJpy);
  });
});

describe("Stage 6A: 整合性の警告", () => {
  const base: HealthInput = { now: new Date("2026-11-05T03:00:00Z"), workerEnabled: true, queued: 0, oldestQueuedAt: null, lastWorkerAt: new Date("2026-11-05T02:58:00Z"), failedLast24h: 0, pausedReason: null, sources: [], scheduleEnabled: true, lastCollectAt: new Date("2026-11-04T21:00:00Z") };
  const codes = (h: Partial<HealthInput>) => healthWarnings({ ...base, ...h }).map((w) => w.code);
  it("AI解析の実績があるのにログが少ない／ログ保存の失敗がある", () => {
    expect(codes({ integrity: { logs2d: 10, statsCalls2d: 250, abnormalReservations: 0, logFailuresToday: 0 } })).toContain("ai_log_gap");
    expect(codes({ integrity: { logs2d: 250, statsCalls2d: 250, abnormalReservations: 0, logFailuresToday: 1 } })).toContain("ai_log_gap");
    expect(codes({ integrity: { logs2d: 300, statsCalls2d: 250, abnormalReservations: 0, logFailuresToday: 0 } })).not.toContain("ai_log_gap"); // 手動の解析でログの方が多いのは正常
  });
  it("予算予約が異常に残っている", () => {
    expect(codes({ integrity: { logs2d: 0, statsCalls2d: 0, abnormalReservations: 2, logFailuresToday: 0 } })).toContain("reservation_stuck");
  });
  it("定期収集の失敗／取得0件を見逃さない（Cron が成功しただけでは正常としない）", () => {
    const at = new Date("2026-11-04T21:00:00Z");
    expect(codes({ lastScheduled: { at, result: "partial", sourcesOk: 3, sourcesFailed: 1, items: 100 } })).toContain("scheduled_failed");
    expect(codes({ lastScheduled: { at, result: "empty", sourcesOk: 0, sourcesFailed: 0, items: 0 } })).toContain("scheduled_zero");
    expect(codes({ lastScheduled: { at, result: "complete", sourcesOk: 4, sourcesFailed: 0, items: 0 } })).toContain("scheduled_zero");
    expect(codes({ lastScheduled: { at, result: "complete", sourcesOk: 4, sourcesFailed: 0, items: 120 } })).not.toContain("scheduled_zero");
  });
});
