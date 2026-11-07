import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import { toManualItem, type ManualItem } from "@/lib/collector/manual-items";
import type { Lottery } from "@/types/domain";

const NOW = new Date("2026-11-04T03:00:00Z");
const items: ManualItem[] = [
  toManualItem({ id: "m1", title: "応募する", source_url: "https://shop.example.invalid/a", due_at: new Date(NOW.getTime() + 4 * 3600_000).toISOString(), manual_reason: "取得できていません", fail_kind: "robots", manual_since: null, draft: { input: { chain: { name: "系列A" }, store: { name: "店舗A" }, items: [{ product: { name: "商品A" } }] } } }, NOW),
  toManualItem({ id: "m2", title: "応募する", source_url: null, due_at: null, manual_reason: "店舗を確実に特定できません", fail_kind: null, manual_since: null, draft: null }, NOW),
];
let notice: unknown = null;
let manual: ManualItem[] = [];
// 画面を開いたまま受付終了を迎えた候補を外す処理（Stage 6N）は、固定の日付の試験データでも動くよう時刻を固定する
vi.mock("@/lib/use-minute-now", () => ({ useMinuteNow: () => new Date("2026-11-04T03:00:00Z") }));
vi.mock("@/app/(app)/collection-notice-actions", () => ({
  getRunNoticesAction: async () => ({ summaries: [], notice, ackIds: [], manual }),
  ackRunNoticesAction: async () => ({ ok: true }),
}));
vi.mock("@/app/(app)/settings/collection/manual-actions", () => ({
  manualDoneAction: async () => ({ ok: true }),
  manualDismissAction: async () => ({ ok: true }),
  manualRecheckAction: async () => ({ ok: true }),
  confirmLotteryAction: async () => ({ ok: true }),
  excludeLotteryAction: async () => ({ ok: true }),
  excludeSourceAction: async () => ({ ok: true }),
  releaseExclusionAction: async () => ({ ok: true }),
  updateExclusionAction: async () => ({ ok: true }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
let persistent = true;
vi.mock("@/components/app-provider", async () => {
  const { createMockData: mk } = await import("@/data/mock");
  const data = mk(new Date("2026-11-04T03:00:00Z"));
  return { useApp: () => ({ data, profile: data.profiles[0], persistent, reload: async () => null, now: new Date("2026-11-04T03:00:00Z") }) };
});

import { CollectionResultNotice } from "@/components/collection-result-notice";
import { ManualReviewList, type ManualGroups } from "@/components/manual-review";
import { RegistrationOrigin } from "@/components/registration-origin";
import { ExclusionRules, HardSources } from "@/components/source-controls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

beforeEach(() => {
  window.sessionStorage.clear();
  notice = null;
  manual = [];
  persistent = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("起動時ポップアップに要手動確認は出さない", () => {
  it("取得不可があっても、起動時のポップアップには出さない（通知・設定の自動収集で確認する）。収集結果だけを出す", async () => {
    manual = items;
    notice = { runId: "r1", trigger: "cron", startedAt: "2026-11-04T21:00:00Z", state: "complete", legacy: false, discovered: 5, analyzed: 5, autoRegistered: 2, review: 1, failed: 0, excluded: 0, duplicates: 0, waiting: 0, costJpy: 0 };
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-notice")).not.toBeNull();
    expect(q("manual-banner")).toBeNull();
    expect(qa("manual-item")).toHaveLength(0);
    expect(q("run-notice-confirm")).not.toBeNull(); // 確認する（要手動確認の一覧へ）
  });
  it("収集結果が無ければ、取得不可があってもポップアップは出ない", async () => {
    manual = items;
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-notice")).toBeNull();
  });
});

describe("要手動確認の一覧（設定）", () => {
  const groups = (over: Partial<ManualGroups> = {}): ManualGroups => ({ open: items, retrying: [], retryingCount: 0, closed: [], ...over });
  it("今すぐ確認（締切7日以内）を優先して表示し、締切不明は折りたたむ。件数の警告には今すぐ確認だけを数える", async () => {
    await act(async () => root.render(createElement(ManualReviewList, { groups: groups() })));
    expect(q("manual-banner")!.textContent).toBe("要手動確認：1件");
    expect(q("manual-now")!.querySelectorAll("[data-testid=manual-row]")).toHaveLength(1);
    expect(q("manual-later")!.textContent).toContain("1件");
    expect(q("manual-now")!.textContent).toContain("公式ページ取得不可");
  });
  it("一覧には操作ボタンを並べず、「詳細・対応」を開くと元情報・編集して登録・再調査・対象外・対応完了が出る", async () => {
    await act(async () => root.render(createElement(ManualReviewList, { groups: groups() })));
    expect(q("manual-recheck")).toBeNull();
    expect(q("manual-done")).toBeNull();
    expect(qa("manual-detail")).toHaveLength(2);
    await act(async () => qa("manual-detail")[0].click());
    expect(q("manual-open-source")).not.toBeNull();
    expect(qa("manual-edit")).toHaveLength(1);
    expect(qa("manual-recheck")).toHaveLength(1);
    expect(qa("manual-done")).toHaveLength(1);
    await act(async () => qa("manual-dismiss")[0].click());
    expect(q("manual-dismiss-form")).not.toBeNull();
    const opts = [...document.querySelectorAll<HTMLOptionElement>('[data-testid="manual-dismiss-code"] option')].map((o) => o.textContent);
    expect(opts).toContain("信頼性に疑問があるショップ");
    expect(opts).toContain("抽選ではない");
    expect(opts).toHaveLength(8);
  });
  it("自動再調査中・終了済みは折りたたみで件数だけ示し、操作ボタンは出さない。通常の説明を赤字にしない", async () => {
    await act(async () => root.render(createElement(ManualReviewList, { groups: groups({ retrying: [items[1]], retryingCount: 5, closed: [items[1]] }) })));
    expect(q("manual-retrying")!.textContent).toContain("自動再調査中（対応不要）：5件");
    expect(q("manual-retrying")!.textContent).toContain("ほか4件");
    expect(q("manual-closed")).not.toBeNull();
    expect(q("manual-retrying")!.querySelector("[data-testid=manual-detail]")).toBeNull();
    expect(document.querySelector("[data-testid=manual-review] .text-danger:not([data-testid=manual-banner]):not([data-testid=manual-due])")).toBeNull();
  });
  it("今すぐ確認が0件なら「0件」。何も無ければ表示しない", async () => {
    await act(async () => root.render(createElement(ManualReviewList, { groups: groups({ open: [items[1]] }) })));
    expect(q("manual-none")!.textContent).toBe("要手動確認：0件");
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(ManualReviewList, { groups: groups({ open: [] }) })));
    expect(q("manual-review")).toBeNull();
  });
});

describe("登録経路アイコン", () => {
  const base = createMockData(NOW).lotteries[0];
  const lot = (over: Partial<Lottery>): Lottery => ({ ...base, sourceUrls: ["https://x.com/some_shop/status/1"], createdAt: "2026-11-01T00:00:00Z", ...over });
  it("自動収集・未確認はロボット、確認済みはチェック。タップで経路・元情報URL・登録日時・確認日時を表示し、正確性を保証しない旨を示す", async () => {
    await act(async () => root.render(createElement(RegistrationOrigin, { lottery: lot({ registrationPath: "auto", sourceKind: "auto" }) })));
    expect(q("origin-icon")!.getAttribute("data-path")).toBe("auto");
    expect(q("origin-icon")!.textContent).toBe("自動収集（未確認）");
    await act(async () => q("origin-icon")!.click());
    expect(q("origin-confirmed")!.textContent).toBe("未確認");
    expect(q("origin-url")!.getAttribute("href")).toContain("x.com/some_shop");
    expect(q("origin-dialog")!.textContent).toContain("保証するものではありません");
    expect(q("origin-confirm")).not.toBeNull();
    expect(q("origin-exclude-lottery")).not.toBeNull();
    expect(q("origin-exclude-source")).not.toBeNull();
  });
  it("手動確認済み: 確認日時を表示し、確認ボタンは出ない", async () => {
    await act(async () => root.render(createElement(RegistrationOrigin, { lottery: lot({ registrationPath: "auto_confirmed", sourceKind: "auto", confirmedAt: "2026-11-02T03:00:00Z" }) })));
    expect(q("origin-icon")!.textContent).toBe("自動収集（ユーザー確認済み）");
    await act(async () => q("origin-icon")!.click());
    expect(q("origin-confirmed")!.textContent).not.toBe("未確認");
    expect(q("origin-confirm")).toBeNull();
  });
  it("手動登録・AI利用の手動登録には除外・確認の操作を出さない", async () => {
    for (const p of ["manual", "manual_ai"] as const) {
      await act(async () => root.render(createElement(RegistrationOrigin, { lottery: lot({ registrationPath: p, sourceKind: "manual" }) })));
      await act(async () => q("origin-icon")!.click());
      expect(q("origin-dialog")).not.toBeNull();
      expect(q("origin-actions")).toBeNull();
      act(() => root.unmount());
      root = createRoot(host);
    }
  });
  it("今後この収集元を除外: 範囲を選ぶまで実行できず、応募資格・条件・地域・重複の理由は選べない", async () => {
    await act(async () => root.render(createElement(RegistrationOrigin, { lottery: lot({ registrationPath: "auto", sourceKind: "auto" }) })));
    await act(async () => q("origin-icon")!.click());
    await act(async () => q("origin-exclude-source")!.click());
    expect(q("exclude-source-form")).not.toBeNull();
    expect((q("exclude-submit") as HTMLButtonElement).disabled).toBe(true);
    const codes = [...document.querySelectorAll<HTMLOptionElement>('[data-testid="exclude-code"] option')].map((o) => o.value);
    expect(codes).toEqual(expect.arrayContaining(["untrusted_shop", "wrong_info", "not_lottery", "other"]));
    for (const bad of ["conditions_mismatch", "duplicate", "out_of_area", "out_of_scope_product"]) expect(codes).not.toContain(bad);
    await act(async () => q("scope-x_account")!.click());
    expect((q("exclude-submit") as HTMLButtonElement).disabled).toBe(false);
  });
  it("この抽選を除外: 標準分類8種から理由を選べる", async () => {
    await act(async () => root.render(createElement(RegistrationOrigin, { lottery: lot({ registrationPath: "auto", sourceKind: "auto" }) })));
    await act(async () => q("origin-icon")!.click());
    await act(async () => q("origin-exclude-lottery")!.click());
    expect(document.querySelectorAll('[data-testid="exclude-code"] option')).toHaveLength(8);
  });
  it("デモ（永続化なし）では操作を出さない", async () => {
    persistent = false;
    await act(async () => root.render(createElement(RegistrationOrigin, { lottery: lot({ registrationPath: "auto", sourceKind: "auto" }) })));
    await act(async () => q("origin-icon")!.click());
    expect(q("origin-actions")).toBeNull();
  });
});

describe("収集元の管理（設定）", () => {
  it("除外ルールの一覧・理由の編集・解除。解除済みは履歴として折りたたむ", async () => {
    const rules = [
      { id: "a", scope: "store" as const, key: "s1", label: "店舗「テスト店」", reason_code: "untrusted_shop" as const, reason_note: "疑わしい", active: true, created_at: "2026-11-01T00:00:00Z", released_at: null },
      { id: "b", scope: "x_account" as const, key: "old", label: "@old", reason_code: "wrong_info" as const, reason_note: "", active: false, created_at: "2026-10-01T00:00:00Z", released_at: "2026-10-05T00:00:00Z" },
    ];
    await act(async () => root.render(createElement(ExclusionRules, { rules })));
    expect(qa("exclusion-row")).toHaveLength(1);
    expect(q("exclusion-rules")!.textContent).toContain("信頼性に疑問があるショップ");
    expect(q("exclusion-release")).not.toBeNull();
    expect(q("exclusion-rules")!.textContent).toContain("解除済み 1件");
  });
  it("取得困難な収集元: 原因・失敗回数・代替取得の成否・手動確認の要否。応募サービスの失敗は店舗単位で示す", async () => {
    const rows = [{ id: "h1", scope: "store", key: "s1|shoplottery.e-starbox.com", label: "テスト店 / shoplottery.e-starbox.com", service_host: null, fail_kind: "robots", fail_count: 3, last_checked_at: "2026-11-04T00:00:00Z", alt_source: "list_text", alt_success: 2, alt_fail: 1, needs_manual: false }];
    await act(async () => root.render(createElement(HardSources, { rows })));
    const t = q("hard-source-row")!.textContent!;
    expect(t).toContain("店舗");
    expect(t).toContain("失敗3回");
    expect(t).toContain("まとめサイトの一覧の表示（成功2・失敗1）");
    expect(t).not.toContain("手動確認が必要");
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(HardSources, { rows: [] })));
    expect(q("hard-sources-empty")).not.toBeNull();
  });
});
