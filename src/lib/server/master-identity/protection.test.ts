/**
 * Stage 10E 追加修正（A-1）: lotteryProtection / commonProtection の、マイグレーション108未適用時の互換性と、失敗時にフェイルクローズすること。
 * DB は偽物（クエリの形だけ再現）。実DBでの確認は tests/stage10e.integration.test.ts（関数あり）。関数が無い環境は、ここで PostgREST の実際の応答形（PGRST202 / 404）を再現して検証する。
 */
import { describe, expect, it } from "vitest";
import { classifyRpcResult } from "@/lib/case-model/rpc-availability";
import { commonProtection, lotteryProtection } from "./reeval-service";

type RpcResult = { data: unknown; error: { code?: string; message?: string; status?: number } | null; status?: number };
interface FakeOpts {
  rpc: RpcResult | (() => never);
  /** 参照表ごとの件数（undefined は0件）。fail に入れた表は読み取りエラー */
  counts?: Record<string, number>;
  failTables?: string[];
  managed?: boolean;
  lottery?: Record<string, unknown> | null;
}
function fakeDb(o: FakeOpts) {
  const lottery = o.lottery === undefined ? { id: "L1", archived_at: null, source_kind: "auto", registration_path: "auto", confirmed_at: null } : o.lottery;
  return {
    rpc: async () => (typeof o.rpc === "function" ? o.rpc() : o.rpc),
    from(t: string) {
      const q = {
        select: (_c: string, opt?: { head?: boolean }) => {
          const head = !!opt?.head;
          const done = (): Promise<unknown> => {
            if (o.failTables?.includes(t)) return Promise.resolve({ data: null, count: null, error: { message: "boom", code: "XX000" } });
            if (head) return Promise.resolve({ data: null, count: o.counts?.[t] ?? 0, error: null });
            if (t === "lotteries") return Promise.resolve({ data: lottery, error: null });
            if (t === "lottery_management") return Promise.resolve({ data: o.managed ? { is_managed: true } : null, error: null });
            return Promise.resolve({ data: null, error: null });
          };
          const chain = { eq: () => chain, maybeSingle: done, then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => done().then(res, rej) };
          return chain;
        },
      };
      return q;
    },
  } as never;
}

const MISSING_PGRST202: RpcResult = { data: null, status: 404, error: { code: "PGRST202", message: "Could not find the function public.lottery_history_blockers(p_lottery_id) in the schema cache", status: 404 } };
const FN_OK = (codes: string[]): RpcResult => ({ data: codes, error: null, status: 200 });

describe("classifyRpcResult: 関数の不在だけを不在と判定する", () => {
  const isArr = (d: unknown) => Array.isArray(d);
  it("PGRST202 / 42883 / 404+不在メッセージ は不在", () => {
    expect(classifyRpcResult(MISSING_PGRST202, isArr)).toBe("missing_function");
    expect(classifyRpcResult({ data: null, error: { code: "42883", message: "function does not exist" } }, isArr)).toBe("missing_function");
    expect(classifyRpcResult({ data: null, status: 404, error: { message: "Could not find the function x" } }, isArr)).toBe("missing_function");
  });
  it("権限拒否・認証・接続障害・5xx・未知のコード・メッセージだけ似たもの は判定不能（不在とみなさない）", () => {
    for (const r of [
      { data: null, error: { code: "42501", message: "permission denied for function lottery_history_blockers" } },
      { data: null, status: 403, error: { message: "permission denied" } },
      { data: null, status: 401, error: { code: "PGRST301", message: "JWT expired" } },
      { data: null, status: 401, error: { message: "Could not find the function (unauthorized)" } }, // 認証失敗はメッセージに関わらず不在ではない
      { data: null, status: 500, error: { code: "XX000", message: "internal" } },
      { data: null, status: 503, error: { message: "upstream unavailable" } },
      { data: null, status: 0, error: { message: "TypeError: fetch failed" } },
      { data: null, error: { code: "PGRST999", message: "unknown" } },
      { data: null, status: 404, error: { message: "relation does not exist" } }, // 404 でも関数の不在とは限らない文言
      { data: null, status: 200, error: { message: "function something" } },
    ])
      expect(classifyRpcResult(r as RpcResult, isArr)).toBe("indeterminate");
  });
  it("エラーなしでも形が不正（配列でない）なら判定不能", () => {
    expect(classifyRpcResult({ data: { x: 1 }, error: null }, isArr)).toBe("indeterminate");
    expect(classifyRpcResult({ data: null, error: null }, isArr)).toBe("indeterminate");
  });
});

describe("commonProtection / lotteryProtection（マイグレーション108未適用の互換とフェイルクローズ）", () => {
  it("関数が無い環境（PGRST202）: 従来の確認だけで動く＝保護なしの抽選は null（通過）、従来の保護対象は従来どおり止まる", async () => {
    expect(await lotteryProtection(fakeDb({ rpc: MISSING_PGRST202 }), "L1")).toBeNull();
    expect(await lotteryProtection(fakeDb({ rpc: MISSING_PGRST202, counts: { applications: 1 } }), "L1")).toBe("応募・当落の記録あり");
    expect(await lotteryProtection(fakeDb({ rpc: MISSING_PGRST202, managed: true }), "L1")).toBe("要チェック（★）");
    expect(await lotteryProtection(fakeDb({ rpc: MISSING_PGRST202, lottery: { id: "L1", archived_at: null, source_kind: "manual", registration_path: "manual", confirmed_at: null } }), "L1")).toBe("人が登録・確認した抽選");
  });
  it("関数が正常: 共通の保護が有効（従来の確認に無い手動分類・Xブックマーク等で止まる）。保護なしなら通る", async () => {
    expect(await lotteryProtection(fakeDb({ rpc: FN_OK(["manual_form"]) }), "L1")).toContain("手動");
    expect(await lotteryProtection(fakeDb({ rpc: FN_OK(["x_bookmark"]) }), "L1")).toContain("Xブックマーク");
    expect(await lotteryProtection(fakeDb({ rpc: FN_OK([]) }), "L1")).toBeNull();
  });
  it("権限拒否・接続障害・未知のRPCエラー・例外・不正な応答は、保護なしで続行しない（止める）", async () => {
    const stop = "保護の状態を確認できません";
    const cases: FakeOpts["rpc"][] = [
      { data: null, status: 403, error: { code: "42501", message: "permission denied for function" } },
      { data: null, status: 401, error: { message: "unauthorized" } },
      { data: null, status: 0, error: { message: "fetch failed" } },
      { data: null, status: 500, error: { code: "XX000", message: "internal" } },
      { data: null, error: { code: "PGRST999", message: "x" } },
      { data: { not: "array" }, error: null },
      () => {
        throw new Error("network down");
      },
    ];
    for (const rpc of cases) expect(await lotteryProtection(fakeDb({ rpc }), "L1")).toContain(stop);
    // 非表示・統合・削除の通過判定（null=通過）にならない
    expect(await commonProtection(fakeDb({ rpc: { data: null, status: 403, error: { code: "42501", message: "denied" } } }), "L1")).not.toBeNull();
  });
  it("従来の参照表の読み取りが失敗しても0件とみなさず止める（応募記録の表・通知・ルールの表・★の表）", async () => {
    for (const t of ["applications", "notification_deliveries", "skip_rules", "ai_extraction_feedback", "lottery_management"]) {
      expect(await lotteryProtection(fakeDb({ rpc: FN_OK([]), failTables: [t] }), "L1"), t).toContain("保護の状態を確認できません");
    }
  });
  it("抽選が見つからない・非表示・確認済みは従来どおり", async () => {
    expect(await lotteryProtection(fakeDb({ rpc: FN_OK([]), lottery: null }), "L1")).toBe("抽選が見つかりません");
    expect(await lotteryProtection(fakeDb({ rpc: FN_OK([]), lottery: { id: "L1", archived_at: "2026-01-01", source_kind: "auto", registration_path: "auto", confirmed_at: null } }), "L1")).toBe("すでに非表示です");
  });
});
