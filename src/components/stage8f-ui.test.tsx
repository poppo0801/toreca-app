import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData, LotteryGroup, LotteryGroupProposal } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const ungroupLottery = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data }));
const dissolveLotteryGroup = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data }));
let decide: (id: string, d: string) => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true });
const decideGroupProposal = vi.fn((id: string, d: string) => decide(id, d));
const actions = new Proxy({ ungroupLottery, dissolveLotteryGroup, decideGroupProposal } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : vi.fn(async () => ({ ok: true, data }))) });
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => {} }),
}));

import { GroupProposalsSheet } from "@/components/group-proposals-sheet";
import { LotteryGroupSheet } from "@/components/lottery-group-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const flush = () => act(async () => void (await Promise.resolve()));

/** 同じ系列の抽選を3件、指定の出所のグループにする */
function withGroup(origin: LotteryGroup["origin"], basis: Record<string, unknown> = {}) {
  const chainId = data.lotteries[0].chainId;
  const same = data.lotteries.filter((l) => l.chainId === chainId).slice(0, 3);
  expect(same.length).toBeGreaterThanOrEqual(2);
  for (const l of same) l.groupId = "g1";
  data.lotteryGroups = [{ id: "g1", chainId, title: "", origin, basis }];
  return same;
}

beforeEach(() => {
  data = createMockData(NOW);
  ungroupLottery.mockClear();
  dissolveLotteryGroup.mockClear();
  decideGroupProposal.mockClear();
  decide = async () => ({ ok: true });
  window.matchMedia = ((qq: string) => ({ matches: false, media: qq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("Stage 8F: AIがまとめたグループの表示・解除（手動グループと同じ親子カード）", () => {
  const basis = { by: "ai_auto", rationale: "商品・応募期間・発表日が同じ別店舗の抽選", common: ["対象商品", "応募期間", "同じ情報源"], mismatches: [{ field: "applyDeadline", detail: "応募締切が異なる", severity: "hard" }], confidence: 96 };

  it("AIがまとめたグループには、理由・共通点・異なる点・信頼度が詳細に出る（折りたたみ）。手動グループには出ない", () => {
    const m = withGroup("ai", basis);
    act(() => root.render(createElement(LotteryGroupSheet, { anchor: m[0], onClose: () => {} })));
    const d = q("group-ai-reason") as HTMLDetailsElement;
    expect(d).not.toBeNull();
    expect(d.open).toBe(false); // 簡潔に（展開して確認する）
    expect(d.textContent).toContain("AIが自動でまとめました");
    expect(d.textContent).toContain("信頼度 96");
    expect(d.textContent).toContain("商品・応募期間・発表日が同じ別店舗の抽選");
    expect(d.textContent).toContain("共通: 対象商品・応募期間・同じ情報源");
    expect(d.textContent).toContain("異なる点: 応募締切が異なる");
    act(() => root.unmount());
    root = createRoot(host);
    data.lotteryGroups![0].origin = "manual";
    act(() => root.render(createElement(LotteryGroupSheet, { anchor: m[0], onClose: () => {} })));
    expect(q("group-ai-reason")).toBeNull();
  });
  it("承認してまとめた場合の表記", () => {
    const m = withGroup("ai", { ...basis, by: "ai_approved" });
    act(() => root.render(createElement(LotteryGroupSheet, { anchor: m[0], onClose: () => {} })));
    expect(q("group-ai-reason")!.textContent).toContain("AIの提案を承認してまとめました");
  });
  it("AIのグループから外すときは理由を選べる（選んだ理由が渡される）。理由なしでも外せる", async () => {
    const m = withGroup("ai", basis);
    act(() => root.render(createElement(LotteryGroupSheet, { anchor: m[0], onClose: () => {} })));
    click(all("group-remove")[0]);
    expect(ungroupLottery).not.toHaveBeenCalled(); // まず理由の選択
    expect(q("group-remove-reasons")).not.toBeNull();
    click(q("group-remove-reason-period_differs")!);
    await flush();
    expect(ungroupLottery).toHaveBeenCalledWith(m[0].id, { code: "period_differs" });
    ungroupLottery.mockClear();
    click(all("group-remove")[1]);
    click(q("group-remove-noreason")!);
    await flush();
    expect(ungroupLottery).toHaveBeenCalledWith(m[1].id);
  });
  it("手動グループは従来どおり1タップで外せる（理由の選択は出ない）", async () => {
    const m = withGroup("manual");
    act(() => root.render(createElement(LotteryGroupSheet, { anchor: m[0], onClose: () => {} })));
    click(all("group-remove")[0]);
    await flush();
    expect(q("group-remove-reasons")).toBeNull();
    expect(ungroupLottery).toHaveBeenCalledWith(m[0].id);
  });
  it("AIのグループ全体を解除するときも、理由（任意）を記録できる。選ばなければ理由なし", async () => {
    const m = withGroup("ai", basis);
    act(() => root.render(createElement(LotteryGroupSheet, { anchor: m[0], onClose: () => {} })));
    click(q("group-dissolve-open")!);
    click(q("group-dissolve-reason-conditions_differ")!);
    click(q("group-dissolve-run")!);
    await flush();
    expect(dissolveLotteryGroup).toHaveBeenCalledWith("g1", { code: "conditions_differ" });
    dissolveLotteryGroup.mockClear();
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(createElement(LotteryGroupSheet, { anchor: m[0], onClose: () => {} })));
    click(q("group-dissolve-open")!);
    click(q("group-dissolve-run")!);
    await flush();
    expect(dissolveLotteryGroup).toHaveBeenCalledWith("g1", undefined);
  });
});

describe("Stage 8F: グループ候補の確認（承認・却下）", () => {
  const proposal = (over: Partial<LotteryGroupProposal> = {}): LotteryGroupProposal => ({
    id: "p1", kind: "new_group", subjectId: data.lotteries[0].id, lotteryIds: data.lotteries.slice(0, 3).map((l) => l.id), targetGroupId: null, confidence: 72,
    rationale: "同じキャンペーンだが、店舗ごとに応募締切が異なる / 同じ企画の裏づけはあるが、店舗ごとに異なる点がある",
    common: ["系列", "対象商品", "同じキャンペーン"], mismatches: [{ field: "applyDeadline", detail: "応募締切が異なる", severity: "hard" }, { field: "resultDate", detail: "発表日が不明", severity: "gap" }],
    missing: ["発表日が不明"], strongSignals: ["campaign"], engine: "mock-grouping:careful", createdAt: NOW.toISOString(), ...over,
  });

  it("候補の理由・店舗・信頼度・共通点・異なる点を簡潔に表示し、根拠の詳細は折りたたむ", () => {
    data.groupProposals = [proposal()];
    act(() => root.render(createElement(GroupProposalsSheet, { onClose: () => {} })));
    const c = q("group-proposal")!;
    expect(q("group-proposal-title")!.textContent).toContain("3店舗をグループにまとめる");
    expect(q("group-proposal-confidence")!.textContent).toContain("信頼度 72");
    expect(c.textContent).toContain("同じキャンペーンだが、店舗ごとに応募締切が異なる");
    expect(c.textContent).toContain("共通: 系列・対象商品・同じキャンペーン");
    expect(q("group-proposal-mismatch")!.textContent).toContain("異なる点: 応募締切が異なる"); // 不明（gap）は強調せず詳細へ
    const det = c.querySelector("details") as HTMLDetailsElement;
    expect(det.open).toBe(false);
    expect(det.textContent).toContain("同じ企画の裏づけ: 同じキャンペーン");
    expect(det.textContent).toContain("不足している情報: 発表日が不明");
  });
  it("判断の根拠（区分・裏づけ・相違）と、確認した情報源（ホスト名）は、折りたたんだ詳細の中に出る（既定では表示面積を増やさない）。根拠が無い従来の候補も表示できる", () => {
    data.groupProposals = [proposal({ strongSignals: ["event_id"], basis: ["区分: 承認候補", "同じ企画の裏づけ: 取得したページ・URLで同じイベントID", "軽微な違い: 応募条件の一方にだけ記載がある項目がある（記載なし。条件が異なるとは限らない）"], sources: [{ url: "https://livepocket.jp/e/abc", fetchedAt: "2026-11-14T00:00:00Z" }, { url: "https://livepocket.jp/e/def", fetchedAt: "2026-11-14T00:00:00Z" }] })];
    act(() => root.render(createElement(GroupProposalsSheet, { onClose: () => {} })));
    const det = q("group-proposal")!.querySelector("details") as HTMLDetailsElement;
    expect(det.open).toBe(false);
    expect(det.textContent).toContain("同じイベントID（取得したページで確認）");
    expect(q("group-proposal-basis")!.textContent).toContain("区分: 承認候補");
    expect(det.contains(q("group-proposal-basis"))).toBe(true);
    expect(det.textContent).toContain("確認した情報源: livepocket.jp（2件）");
    data.groupProposals = [proposal()]; // basis・sources なし（従来のデータ）
    act(() => root.render(createElement(GroupProposalsSheet, { onClose: () => {} })));
    expect(q("group-proposal-basis")).toBeNull();
  });
  it("既存グループへの追加の表示", () => {
    const m = withGroup("duplicate");
    data.groupProposals = [proposal({ kind: "add_to_group", subjectId: data.lotteries[5].id, lotteryIds: [data.lotteries[5].id], targetGroupId: "g1", mismatches: [] })];
    act(() => root.render(createElement(GroupProposalsSheet, { onClose: () => {} })));
    expect(q("group-proposal-title")!.textContent).toContain(`既存のグループ（${m.length}店舗）に追加`);
    expect(q("group-proposal-mismatch")).toBeNull();
  });
  it("承認・却下がそれぞれ決定の操作を呼ぶ。処理中の連続タップは1回だけ", async () => {
    data.groupProposals = [proposal()];
    let release: () => void = () => {};
    decide = () => new Promise((r) => (release = () => r({ ok: true })));
    act(() => root.render(createElement(GroupProposalsSheet, { onClose: () => {} })));
    click(q("group-proposal-approve")!);
    click(q("group-proposal-approve")!);
    click(q("group-proposal-reject")!);
    expect(decideGroupProposal).toHaveBeenCalledTimes(1);
    expect(decideGroupProposal).toHaveBeenCalledWith("p1", "approve");
    await act(async () => release());
    decideGroupProposal.mockClear();
    click(q("group-proposal-reject")!);
    await flush();
    expect(decideGroupProposal).toHaveBeenCalledWith("p1", "reject");
  });
  it("失敗（状況が変わった等）はメッセージを表示する。候補が無ければ空の表示", async () => {
    data.groupProposals = [proposal()];
    decide = async () => ({ ok: false, error: "対象の抽選が除外・変更されたため、提案は無効になりました" });
    act(() => root.render(createElement(GroupProposalsSheet, { onClose: () => {} })));
    click(q("group-proposal-approve")!);
    await flush();
    expect(document.body.textContent).toContain("提案は無効になりました");
    act(() => root.unmount());
    root = createRoot(host);
    data.groupProposals = [];
    act(() => root.render(createElement(GroupProposalsSheet, { onClose: () => {} })));
    expect(q("group-proposal")).toBeNull();
    expect(document.body.textContent).toContain("確認待ちの候補はありません");
  });
});
