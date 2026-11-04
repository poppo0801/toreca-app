import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly } from "@/lib/datetime";
import { wonPeriodRows } from "@/lib/lottery-flow";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const actions = { setManaged: vi.fn(), setApplied: vi.fn(), setResult: vi.fn(), setFulfillment: vi.fn() };
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/components/lottery-detail-sheet", () => ({ LotteryDetailSheet: () => null }));

import { LotteryCard } from "@/components/lottery-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const patch = (id: string, p: Partial<Lottery>) => {
  data = { ...data, lotteries: data.lotteries.map((l) => (l.id === id ? { ...l, ...p } : l)) };
};
function mount(id: string, tab: "all" | "managed" | "applied" | "won", view: "simple" | "detail" = "detail") {
  const lottery = data.lotteries.find((l) => l.id === id)!;
  act(() => {
    root.render(createElement(LotteryCard, { lottery, tab, view }));
  });
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

beforeEach(() => {
  data = createMockData(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("日付表示のコンパクト化（5V）", () => {
  it("曜日は半角の()で日付に連続して表示する。全角の括弧・太字・字間指定を使わない", () => {
    patch("L1", { procedureStart: dateOnly("2026-11-07"), procedureDeadline: dateOnly("2026-11-09"), procedureSplit: false });
    mount("L1", "all");
    expect(q('[data-testid="period"]')!.textContent).toBe("11/7(土)〜11/9(月)");
    const dates = q('[data-testid="card-dates"]')!;
    expect(dates.textContent).not.toMatch(/[（）]/);
    expect(dates.className).not.toMatch(/tracking|font-bold|font-semibold/);
    expect(dates.innerHTML).not.toMatch(/font-bold|font-semibold/);
  });
  it("詳細カードの日付は1行ずつ（縦に並べ、各行は途中で折り返さない）", () => {
    mount("L1", "all");
    const dates = q('[data-testid="card-dates"]')!;
    expect(dates.className).toContain("flex-col");
    for (const row of [q('[data-testid="deadline-day"]'), q('[data-testid="period"]')]) {
      expect(row).not.toBeNull();
      expect(row!.className).toContain("whitespace-nowrap");
    }
  });
});

describe("購入期間・受取期間のアイコン", () => {
  it("購入=買い物袋 / 受取=プレゼントボックス（別のアイコン）。同じ情報は同じアイコン", () => {
    patch("L1", { procedureSplit: false });
    mount("L1", "all");
    const buy = q('[data-testid="period"][data-kind="購入"] svg')!;
    expect(buy.getAttribute("class")).toContain("lucide-shopping-bag");
    patch("L1", { procedureSplit: true, receiveStart: dateOnly("2026-11-08"), receiveDeadline: dateOnly("2026-11-10") });
    mount("L1", "all");
    const recv = q('[data-testid="period"][data-kind="受取"] svg')!;
    expect(recv.getAttribute("class")).toContain("lucide-gift");
    expect(recv.getAttribute("class")).not.toBe(buy.getAttribute("class"));
  });
});

describe("当選タブの期間", () => {
  const rows = (over: Partial<Lottery>) => wonPeriodRows({ procedureSplit: false, procedureStart: dateOnly("2026-11-04"), procedureDeadline: dateOnly("2026-11-06"), receiveStart: undefined, receiveDeadline: undefined, ...over } as never, NOW);
  it("購入・受取が分かれていれば2行（購入／受取）、共通なら受取の1行。曜日つき・時刻なし", () => {
    expect(rows({ procedureSplit: true, receiveStart: dateOnly("2026-11-08"), receiveDeadline: dateOnly("2026-11-10") })).toEqual([
      { label: "購入", text: "11/4(水)〜11/6(金)" },
      { label: "受取", text: "11/8(日)〜11/10(火)" },
    ]);
    expect(rows({})).toEqual([{ label: "受取", text: "11/4(水)〜11/6(金)" }]);
  });
  it("未設定は text=null（応募締切で代用しない）", () => {
    expect(rows({ procedureSplit: true, procedureStart: { precision: "unknown" }, procedureDeadline: { precision: "unknown" } } as never)[0].text).toBeNull();
  });
  it("当選タブの詳細カード: 期間は1行ずつ表示し、「期限超過」は下段の操作エリアに1回だけ", () => {
    const l = data.lotteries.find((x) => data.applications.some((a) => a.lotteryId === x.id && a.state === "applied"))!;
    const app = data.applications.find((a) => a.lotteryId === l.id && a.state === "applied")!;
    data = { ...data, applications: data.applications.map((a) => (a.id === app.id ? { ...a, result: "won" as const, fulfillment: "none" as const } : a)), lotteries: data.lotteries.map((x) => (x.id === l.id ? { ...x, procedureSplit: true, procedureStart: dateOnly("2026-10-20"), procedureDeadline: dateOnly("2026-10-25"), receiveStart: dateOnly("2026-10-26"), receiveDeadline: dateOnly("2026-10-30") } : x)) };
    for (const view of ["detail", "simple"] as const) {
      mount(l.id, "won", view);
      expect(qa('[data-testid="period"]').map((e) => e.getAttribute("data-kind"))).toEqual(["購入", "受取"]);
      const n = (host.textContent!.match(/期限超過/g) ?? []).length;
      expect(n, view).toBe(1);
      expect(q('[data-testid="won-row"]')!.textContent).toContain("期限超過");
    }
  });
});

describe("当落発表方法（応募済みタブ）", () => {
  const withMethods = (methods: string[]) => {
    patch("L2", { announcementMethods: methods as never });
    mount("L2", "applied");
    return q('[data-testid="announce-method"]')!;
  };
  it("X DMとSNS投稿を区別し、アイコン＋短い名称で出す。未確認は推測しない", () => {
    expect(withMethods(["x_dm"]).textContent).toBe("X DM");
    expect(withMethods(["sns_post"]).textContent).toBe("SNS投稿");
    expect(withMethods(["winner_mail"]).textContent).toBe("当選者のみメール");
    expect(withMethods(["result_mail"]).textContent).toBe("メール");
    expect(withMethods(["result_page"]).textContent).toBe("Web確認");
    expect(withMethods(["app"]).textContent).toBe("公式アプリ");
    expect(withMethods(["in_store"]).textContent).toBe("店頭掲示");
    expect(withMethods(["phone"]).textContent).toBe("電話");
    expect(withMethods(["sms"]).textContent).toBe("SMS");
    expect(withMethods(["other"]).textContent).toBe("その他");
    expect(withMethods(["unknown"]).textContent).toBe("未確認");
    expect(withMethods([]).textContent).toBe("未確認");
    expect(withMethods(["x_dm"]).querySelector("svg")).not.toBeNull();
    expect(withMethods(["x_dm"]).querySelector("svg")!.getAttribute("class")).not.toBe(withMethods(["sns_post"]).querySelector("svg")!.getAttribute("class"));
  });
});

describe("系列・店舗名は必ず1行", () => {
  it("詳細・シンプルとも、店舗名は折り返さず末尾を省略（完全な名称はtitle/詳細で確認できる）", () => {
    for (const view of ["detail", "simple"] as const) {
      const long = "とても長い系列名の長い長い店舗名 ○○駅前ショッピングセンター店 本館2階";
      const store = data.stores[0];
      data = { ...data, stores: data.stores.map((s) => (s.id === store.id ? { ...s, name: long } : s)) };
      const l = data.lotteries.find((x) => x.storeId === store.id)!;
      mount(l.id, "all", view);
      const name = view === "detail" ? q('[data-testid="store-name"]')! : host.querySelector<HTMLElement>('[data-testid="card-simple"] .truncate')!;
      expect(name.className, view).toContain("truncate");
      expect(name.className, view).not.toContain("line-clamp");
      if (view === "detail") expect(name.getAttribute("title")).toContain(long);
      const place = q('[data-testid="card-place"]');
      if (place) expect(place.className).toContain("flex-nowrap");
    }
  });
});

describe("プロフィール別の応募状況の色", () => {
  it("未応募などは薄く、応募済み・当選は通常の濃さのまま", () => {
    mount("L2", "all");
    const marks = qa('[data-testid="apply-status"] [data-status]');
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      const dim = m.className.includes("opacity-50");
      if (m.getAttribute("data-status") === "applied") expect(dim).toBe(false);
      else if (m.getAttribute("data-status") !== "needs_review") expect(dim).toBe(true);
    }
  });
});
