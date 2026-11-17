import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { GroupRow } from "@/lib/lottery-group";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const actions = new Proxy({} as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : vi.fn(async () => ({ ok: true, data }))) });
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/app/(app)/lotteries/actions", () => ({ acknowledgeCautionsAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/lotteries/seen-actions", () => ({ markLotterySeen: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/settings/rules/actions", () => ({ addSkipRuleAction: vi.fn(), removeSkipRuleAction: vi.fn(), setLimitExemptionAction: vi.fn(), setSkipExceptionAction: vi.fn() }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));
vi.mock("@/components/duplicate-dialog", () => ({ DuplicateDialog: () => null }));
vi.mock("@/components/ongoing-ops", () => ({ OngoingOps: () => null }));
vi.mock("@/components/past-apply-recorder", () => ({ PastApplyRecorder: () => null }));

import { LotteryGroupCard } from "@/components/lottery-group-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

function build(deadlineOf2?: string) {
  const base = data.lotteries.find((l) => l.id === "L4")!;
  const own = data.stores.filter((s) => s.chainId === base.chainId);
  const extra = [0, 1, 2].map((i) => ({ ...own[0], id: "gs" + i, name: "グループ店" + i, prefecture: "兵庫県", address: "兵庫県神戸市中央区" + i }));
  data = { ...data, stores: [...data.stores, ...extra] } as AppData;
  const stores = extra;
  const mk = (id: string, i: number, o: Partial<Lottery> = {}): Lottery => ({ ...base, id, storeId: stores[i].id, groupId: "G1", isNew: false, ...o });
  const members = [mk("g1", 0), mk("g2", 1, deadlineOf2 ? { applyDeadline: { precision: "date_only", date: deadlineOf2 } } : {}), mk("g3", 2)];
  const group = { id: "G1", chainId: base.chainId, title: "", origin: "manual" as const, basis: {} };
  data = { ...data, lotteries: [...data.lotteries, ...members], lotteryGroups: [group] } as AppData;
  const row: GroupRow = { kind: "group", key: "g:G1", group, members, all: members };
  return row;
}
const mount = (row: GroupRow, compact = true) => act(async () => root.render(createElement(LotteryGroupCard, { row, renderChild: () => null, forceOpen: true, onManage: vi.fn(), compactChildren: compact })));

beforeEach(() => {
  data = createMockData(NOW);
  window.matchMedia = ((qq: string) => ({ matches: false, media: qq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("UI-1: グループ化カード", () => {
  it("親カード: 商品の正式名称・系列・共通の応募期間と発表日・応募状況（N/M店舗）・締切の残り時間を出す。子は店舗名と地域・応募ボタンだけで、共通の商品名・日程を繰り返さない", async () => {
    const row = build();
    await mount(row);
    const productName = data.products.find((p) => p.id === row.members[0].items[0].productId)!.officialName;
    expect(q("group-products")!.textContent).toContain(productName);
    expect(q("group-count")!.textContent).toContain("0/3店舗");
    expect(q("group-period")!.textContent).toMatch(/応募 .+〜.+/);
    expect(q("group-period")!.textContent).not.toContain("店舗により異なる");
    expect(q("group-deadline")).not.toBeNull();
    expect(q("group-image")).not.toBeNull();
    const kids = qa("group-child");
    expect(kids).toHaveLength(3);
    for (const k of kids) {
      expect(k.textContent).not.toContain(productName); // 商品名を繰り返さない
      expect(k.querySelector('[data-testid="group-child-diff"]')).toBeNull(); // 共通なので違いの表示なし
      expect(k.querySelector('[data-testid="my-apply"]')).not.toBeNull(); // 応募操作
      expect(k.querySelector('[data-testid="group-child-region"]')!.textContent).toContain("兵庫県 神戸市"); // 地域
    }
  });
  it("店舗ごとに締切が違うとき、親は共通日程にせず「店舗により異なる」と示し、違う店舗の子にだけその締切を出す", async () => {
    const row = build("2026-11-30");
    await mount(row);
    expect(q("group-period")!.textContent).toContain("応募期間は店舗により異なる");
    const kids = qa("group-child");
    const diffs = kids.map((k) => k.querySelector('[data-testid="group-child-diff"]')?.textContent ?? "");
    expect(diffs.filter((t) => t.includes("締切")).length).toBeGreaterThan(0);
    expect(diffs.some((t) => t.includes("11/30"))).toBe(true);
    expect(q("group-deadline")!.textContent).toContain("最短");
  });
  it("子の店舗名をタップすると従来の抽選詳細が開く（詳細・応募操作へ辿れる）。子の応募ボタンは詳細を開かない", async () => {
    const row = build();
    await mount(row);
    const kid = qa("group-child")[0];
    await act(async () => void kid.querySelector<HTMLElement>('[data-testid="my-apply"]')!.click());
    expect(q("lottery-detail")).toBeNull();
    await act(async () => void kid.querySelector<HTMLElement>('[data-testid="group-child-open"]')!.click());
    expect(q("lottery-detail")).not.toBeNull();
  });
  it("compactChildren=false（応募済み・当選のタブ）では従来の子カード（renderChild）を使う", async () => {
    const row = build();
    const render = vi.fn((l: Lottery) => createElement("li", { key: l.id, "data-testid": "legacy-child" }));
    await act(async () => root.render(createElement(LotteryGroupCard, { row, renderChild: render, forceOpen: true, onManage: vi.fn(), compactChildren: false })));
    expect(qa("legacy-child")).toHaveLength(3);
    expect(qa("group-child")).toHaveLength(0);
  });
});
