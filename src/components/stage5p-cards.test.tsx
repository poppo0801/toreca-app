import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/app/(app)/lotteries/actions", () => ({ acknowledgeCautionsAction: vi.fn(async () => ({ ok: true })) }));
import { createMockData } from "@/data/mock";
import { dateOnly } from "@/lib/datetime";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const actions = {
  setManaged: vi.fn(async () => ({ ok: true as const, data })),
  setApplied: vi.fn(async () => ({ ok: true as const, data })),
  setResult: vi.fn(async () => ({ ok: true as const, data })),
  setFulfillment: vi.fn(async () => ({ ok: true as const, data })),
};
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/components/lottery-detail-sheet", () => ({ LotteryDetailSheet: () => null }));

import { LotteryCard } from "@/components/lottery-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const patchLottery = (id: string, patch: Partial<Lottery>) => {
  data = { ...data, lotteries: data.lotteries.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
};
function mount(id: string, tab: "all" | "managed" | "applied" | "won", view: "simple" | "detail" = "detail") {
  const lottery = data.lotteries.find((l) => l.id === id)!;
  act(() => {
    root.render(createElement(LotteryCard, { lottery, tab, view }));
  });
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const text = (sel: string) => q(sel)?.textContent ?? "";

beforeEach(() => {
  data = createMockData(NOW);
  Object.values(actions).forEach((f) => f.mockClear());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("応募済みタブのカード（日付・ボタン）", () => {
  // L2 は A が応募済み（結果待ち）
  it("左=発表日（曜日つき）／右=購入期間。応募締切はカードに出さない。時刻は出さない", () => {
    patchLottery("L2", { resultDate: dateOnly("2026-11-03"), procedureStart: dateOnly("2026-11-04"), procedureDeadline: dateOnly("2026-11-06"), procedureSplit: false });
    mount("L2", "applied");
    expect(text('[data-testid="result-day"]')).toBe("11/3(火)");
    // 応募済みタブの一覧では年・曜日を省く（Stage 6K。詳細画面では曜日つきの正確な日付）
    expect(text('[data-testid="period"]')).toBe("11/4〜11/6");
    expect(q('[data-testid="period"]')!.getAttribute("data-kind")).toBe("購入");
    expect(q('[data-testid="period"] svg')).not.toBeNull();
    expect(host.textContent).not.toContain("締切");
    expect(q('[data-testid="deadline-day"]')).toBeNull();
    // 左（発表）が右（期間）より先に並ぶ
    const day = q('[data-testid="result-day"]')!;
    const period = q('[data-testid="period"]')!;
    expect(day.compareDocumentPosition(period) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("購入・受取が分かれた抽選は右側に受取期間を出す", () => {
    patchLottery("L2", { resultDate: dateOnly("2026-11-03"), procedureSplit: true, procedureStart: dateOnly("2026-11-04"), procedureDeadline: dateOnly("2026-11-06"), receiveStart: dateOnly("2026-11-05"), receiveDeadline: dateOnly("2026-11-08") });
    mount("L2", "applied");
    expect(text('[data-testid="period"]')).toBe("11/5〜11/8");
    expect(q('[data-testid="period"]')!.getAttribute("data-kind")).toBe("受取");
  });
  it("期間が未設定なら「未定」（応募締切を代用しない）。発表日が不明ならカウントダウンを出さない", () => {
    patchLottery("L2", { resultDate: { precision: "unknown" }, procedureStart: { precision: "unknown" }, procedureDeadline: { precision: "unknown" }, applyDeadline: dateOnly("2026-11-30") });
    mount("L2", "applied");
    expect(text('[data-testid="period"]')).toBe("未定");
    expect(text('[data-testid="result-day"]')).toContain("発表日未確認");
    expect(q('[data-testid="result-badge"]')).toBeNull();
    expect(host.textContent).not.toContain("11/30");
  });
  it("ボタンは左=落選（グレー系）／右=当選（オレンジ）", () => {
    mount("L2", "applied");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    expect(buttons.map((b) => b.textContent)).toEqual(["落選", "当選"]);
    expect(buttons[1].className).toContain("bg-primary");
    expect(buttons[0].className).not.toContain("bg-primary");
  });
});

describe("全情報・★管理対象の詳細カード（日付・距離・残り日数・応募状況）", () => {
  it("左=抽選締切（曜日つき・時刻あり）／右=購入期間（曜日つき・時刻なし）", () => {
    patchLottery("L1", { applyDeadline: { precision: "date_time", at: "2026-11-06T14:59:00Z" }, procedureStart: dateOnly("2026-11-13"), procedureDeadline: dateOnly("2026-11-15") });
    mount("L1", "managed");
    expect(text('[data-testid="deadline-day"]')).toBe("11/6(金) 23:59");
    expect(text('[data-testid="period"]')).toBe("11/13(金)〜11/15(日)");
  });
  it("残り日数は下段の操作ボタンの隣（上段のメタ行には置かない）", () => {
    mount("L1", "managed");
    const bottom = q('[data-testid="card-bottom"]')!;
    expect(bottom.querySelector('[data-testid="deadline-badge"]')).not.toBeNull();
    expect(bottom.querySelector('[data-testid="my-apply"]')).not.toBeNull();
    expect(q('[data-testid="card-meta"]')!.querySelector('[data-testid="deadline-badge"]')).toBeNull();
  });
  it("店頭受取は自宅からの距離を出す。通販・受取方法が不明なら出さない", () => {
    mount("L1", "managed");
    expect(q('[data-testid="distance"]')).not.toBeNull();
    patchLottery("L1", { receiveMethod: "shipping" });
    mount("L1", "managed");
    expect(q('[data-testid="distance"]')).toBeNull();
    patchLottery("L1", { receiveMethod: "unknown" });
    mount("L1", "managed");
    expect(q('[data-testid="distance"]')).toBeNull();
  });
  it("店舗の位置情報が無いときは距離を出さない（推測しない）", () => {
    data = { ...data, stores: data.stores.map((s) => (s.id === "s1" ? { ...s, lat: null, lng: null } : s)) };
    mount("L1", "managed");
    expect(q('[data-testid="distance"]')).toBeNull();
  });
  it("詳細カードの未応募は従来どおりの「－」（「未」の丸にしない）。アイコンはモノクロ、応募済みは色つきのまま", () => {
    mount("L1", "managed");
    expect(host.querySelectorAll('[data-testid="apply-status"] [data-testid="unapplied-mark"]').length).toBe(0);
    const unapplied = host.querySelector('[data-testid="apply-status"] [data-status="eligible_unapplied"]');
    expect(unapplied).not.toBeNull();
    expect(unapplied!.getAttribute("aria-label")).toContain("未応募");
    const unappliedAvatar = host.querySelector('[data-testid="apply-status"] [data-status="eligible_unapplied"] span[aria-hidden="true"]');
    expect(unappliedAvatar?.className).toContain("grayscale");
  });
});

describe("シンプルカード", () => {
  it("未応募の操作ボタンは丸の中に「未」。★は左上の端、画像は★から少し右にずらす", () => {
    mount("L4", "managed", "simple");
    expect(text('[data-testid="my-apply"]')).toBe("未");
    expect(q('[data-testid="card-star"]')!.className).toContain("left-0");
    expect(q('[data-testid="card-image"]')!.className).toContain("ml-2");
  });
});

describe("当選タブ: 通販の購入・受取（別々の状態）", () => {
  // L7 は A が当選（c2・店頭）。通販にして購入・受取の各状態を確かめる
  const ship = (fulfillment: "none" | "procedure_done" | "purchased") => {
    patchLottery("L7", { receiveMethod: "shipping", procedureDeadline: dateOnly("2026-11-20") });
    data = { ...data, applications: data.applications.map((a) => (a.id === "ap5" ? { ...a, fulfillment } : a)) };
    mount("L7", "won");
  };
  const btn = (id: string) => q(`[data-testid="${id}"]`);
  it("購入前: 「購入を記録」「受取を記録」の2つを出す", () => {
    ship("none");
    expect(btn("record-purchase")?.textContent).toBe("購入を記録");
    expect(btn("record-receive")?.textContent).toBe("受取を記録");
  });
  it("購入を記録 → 「✓購入済」。受取はまだ押せる", () => {
    ship("none");
    act(() => btn("record-purchase")!.click());
    expect(actions.setFulfillment).toHaveBeenCalledWith("ap5", "procedure_done");
    ship("procedure_done");
    expect(btn("won-purchased")?.textContent).toBe("購入済");
    expect(btn("record-purchase")).toBeNull();
    expect(btn("record-receive")).not.toBeNull();
  });
  it("受取を記録 → 「✓受取済」。購入済と並んで表示される", () => {
    ship("procedure_done");
    act(() => btn("record-receive")!.click());
    expect(actions.setFulfillment).toHaveBeenCalledWith("ap5", "purchased");
    ship("purchased");
    expect(btn("won-purchased")?.textContent).toBe("購入済");
    expect(btn("won-done")?.textContent).toBe("受取済");
    expect(btn("record-purchase")).toBeNull();
    expect(btn("record-receive")).toBeNull();
  });
  it("店頭は従来どおり「受取を記録」だけ。期限超過は「期限超過」とだけ表示する", () => {
    patchLottery("L7", { procedureDeadline: dateOnly("2026-11-01") });
    mount("L7", "won");
    expect(btn("record-purchase")).toBeNull();
    expect(btn("record-receive")).not.toBeNull();
    expect(text('[data-testid="won-label"]')).toBe("期限超過");
  });
});
