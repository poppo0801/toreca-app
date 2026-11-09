import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData, BattleRecord } from "@/types/domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-09T03:00:00Z");
let data: AppData = createMockData(NOW);
let me = 0;
const saveBattle = vi.fn(async () => ({ ok: true as const }));
const claimBattle = vi.fn(async () => ({ ok: true as const }));
vi.mock("next/navigation", () => ({ usePathname: () => "/battles", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/app/(app)/battles/actions", () => ({ saveBattle: (...a: unknown[]) => (saveBattle as (...x: unknown[]) => unknown)(...a), deleteBattle: vi.fn(async () => ({ ok: true })), claimBattle: (...a: unknown[]) => (claimBattle as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[me], settings: {}, persistent: true, reload: async () => null }),
}));

import { BattlesView } from "@/components/battles-view";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  data = createMockData(NOW);
  me = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

const rec = (o: Partial<BattleRecord>): BattleRecord => ({ id: "b0", playedOn: "2026-11-09", profileId: null, opponentProfileId: null, myDeck: "", opponent: "", opponentDeck: "", result: "win", turnOrder: "", format: "", memo: "", ...o });
const setup = (list: (a: string, b: string) => BattleRecord[]) => {
  const [a, b] = data.profiles;
  data = { ...data, battles: list(a.id, b.id) };
  act(() => root.render(createElement(BattlesView)));
};

describe("Stage 7G: 対戦記録ページ", () => {
  it("ヘッダー右上に フィルター・データ分析・＋対戦を記録 の3つ。戻るボタンは無い。説明文も無い", () => {
    setup(() => []);
    expect(q("battle-filter-open")).not.toBeNull();
    expect(q("battle-analysis-open")).not.toBeNull();
    expect(q("battle-add")!.textContent).toContain("対戦を記録");
    expect(document.body.querySelector('a[aria-label="設定へ戻る"]')).toBeNull();
    expect(document.body.textContent).not.toContain("収支・抽選とは別に管理");
    expect(document.body.textContent).not.toContain("Excelの対戦履歴の取り込みは未実施");
    // 使用デッキ・期間のプルダウンは画面上に無い
    expect(document.body.querySelector('select[aria-label="使用デッキで絞り込み"]')).toBeNull();
    expect(document.body.querySelector('select[aria-label="期間で絞り込み"]')).toBeNull();
  });

  it("プロフィールごとに対戦が表示され、共有の対戦は相手側の画面で自分/相手・デッキ・勝敗が反転する", () => {
    const list = (a: string, b: string) => [rec({ id: "x1", profileId: a, opponentProfileId: b, myDeck: "リザードン", opponentDeck: "サーナイト", result: "win", format: "ジムバトル" }), rec({ id: "x2", profileId: a, opponent: "友だち", myDeck: "ピカチュウ", opponentDeck: "ミュウ", result: "lose" })];
    me = 0;
    setup(list);
    expect(qa("battle-row")).toHaveLength(2);
    const first = qa("battle-row").find((r) => r.textContent?.includes("リザードン"))!;
    expect(first.textContent).toContain(`相手：${data.profiles[1].label}`);
    expect(first.textContent).toContain("リザードン vs サーナイト");
    expect(first.querySelector('[data-result="win"]')!.textContent).toBe("◯");
    // 外部の相手
    const ext = qa("battle-row").find((r) => r.textContent?.includes("ピカチュウ"))!;
    expect(ext.textContent).toContain("相手：友だち");
    expect(ext.querySelector('[data-result="lose"]')!.textContent).toBe("×");
    // 相手側（Bの画面）: 共有の1件だけ。デッキ・勝敗が反転し、相手はA
    me = 1;
    act(() => root.render(createElement(BattlesView, { key: "b" })));
    const b = qa("battle-row");
    expect(b).toHaveLength(1);
    expect(b[0].textContent).toContain(`相手：${data.profiles[0].label}`);
    expect(b[0].textContent).toContain("サーナイト vs リザードン");
    expect(b[0].querySelector('[data-result="lose"]')!.textContent).toBe("×");
  });

  it("1枚ごとの独立した角丸カード。1行目=日付・対戦形式・勝敗記号（右端）。引き分けは△", () => {
    setup((a) => [rec({ id: "x1", profileId: a, result: "draw", format: "公認大会", playedOn: "2026-11-09" })]);
    const card = qa("battle-row")[0];
    expect(card.className).toContain("rounded-xl");
    expect(card.querySelector('[data-testid="battle-date"]')!.textContent).toBe("11/09");
    expect(card.textContent).toContain("公認大会");
    const mark = card.querySelector('[data-result="draw"]')!;
    expect(mark.textContent).toBe("△");
    expect(mark.className).toContain("ml-auto"); // 右端
    expect(mark.getAttribute("aria-label")).toBe("引き分け"); // 色だけに頼らない
  });

  it("勝敗の色は 勝ち=青・負け=赤・引き分け=緑（一覧・分析で共通）", () => {
    setup((a) => [rec({ id: "w", profileId: a, result: "win" }), rec({ id: "l", profileId: a, result: "lose" }), rec({ id: "d", profileId: a, result: "draw" })]);
    expect(document.body.querySelector('[data-result="win"]')!.className).toContain("--cat-supply");
    expect(document.body.querySelector('[data-result="lose"]')!.className).toContain("danger");
    expect(document.body.querySelector('[data-result="draw"]')!.className).toContain("success");
  });

  it("フィルターはボトムシート（使用デッキ・期間・対戦形式）で絞り込め、設定中は印が付く", () => {
    setup((a) => [rec({ id: "1", profileId: a, myDeck: "A", format: "ジムバトル" }), rec({ id: "2", profileId: a, myDeck: "B", format: "公認大会" })]);
    click(q("battle-filter-open"));
    const sheet = q("battle-filter")!;
    expect(sheet).not.toBeNull();
    expect([...sheet.querySelectorAll("select")].map((s) => s.getAttribute("aria-label"))).toEqual(["使用デッキ", "期間", "対戦形式"]);
    const fmt = sheet.querySelector<HTMLSelectElement>('select[aria-label="対戦形式"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    act(() => {
      setter.call(fmt, "公認大会");
      fmt.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(qa("battle-row")).toHaveLength(1);
    expect(q("battle-filter-open")!.getAttribute("aria-label")).toBe("絞り込み（設定中）");
  });

  it("データ分析は別の画面（シート）: 総対戦数・勝・負・引分・勝率、使用デッキ別・対戦形式別。相手デッキ別は無い。引き分けは勝率の母数に含めない", () => {
    setup((a, b) => [
      rec({ id: "1", profileId: a, myDeck: "A", format: "ジムバトル", result: "win" }),
      rec({ id: "2", profileId: a, myDeck: "A", format: "ジムバトル", result: "lose" }),
      rec({ id: "3", profileId: a, myDeck: "B", format: "公認大会", result: "draw" }),
      rec({ id: "4", profileId: b, opponentProfileId: a, myDeck: "Z", opponentDeck: "A", format: "ジムバトル", result: "lose" }), // Aから見ると勝ち
    ]);
    expect(q("battle-summary")).toBeNull(); // 一覧には集計を出さない
    click(q("battle-analysis-open"));
    const s = q("battle-analysis")!;
    expect(s.querySelector('[data-testid="battle-total"]')!.textContent).toBe("4");
    expect(s.querySelector('[data-testid="battle-win"]')!.textContent).toBe("2");
    expect(s.querySelector('[data-testid="battle-lose"]')!.textContent).toBe("1");
    expect(s.querySelector('[data-testid="battle-draw"]')!.textContent).toBe("1");
    expect(s.querySelector('[data-testid="battle-rate"]')!.textContent).toBe("67%"); // 2÷(2+1)
    expect(s.textContent).not.toContain("相手デッキ別");
    expect(q("battle-by-deck")!.textContent).toContain("A");
    expect(q("battle-by-format")!.textContent).toContain("ジムバトル");
    expect(q("battle-by-format")!.textContent).toContain("公認大会");
  });

  it("勝敗が無い（引き分けのみ・対戦なし）ときの勝率は「－」", () => {
    setup((a) => [rec({ id: "1", profileId: a, result: "draw" })]);
    click(q("battle-analysis-open"));
    expect(q("battle-rate")!.textContent).toBe("－");
  });

  it("登録画面に「対戦した人」の入力欄は無く、対戦相手はアプリ内のユーザーか外部の相手を選ぶ", () => {
    setup(() => []);
    click(q("battle-add"));
    const f = q("battle-form")!;
    expect(f.textContent).not.toContain("対戦した人");
    expect(f.textContent).not.toContain("収支・抽選とは独立");
    const radios = [...f.querySelectorAll('[role="radiogroup"][aria-label="対戦相手の種類"] [role="radio"]')].map((r) => r.textContent);
    expect(radios).toEqual(["アプリ内のユーザー", "外部の相手"]);
    click(f.querySelector('[role="radiogroup"][aria-label="対戦相手の種類"] [role="radio"]'));
    const sel = f.querySelector<HTMLSelectElement>('select[aria-label="対戦相手のユーザー"]')!;
    // 自分自身は選べない
    expect([...sel.options].map((o) => o.textContent)).not.toContain(data.profiles[0].label);
    expect([...sel.options].map((o) => o.textContent)).toContain(data.profiles[1].label);
  });

  it("持ち主が決まっていない記録は一覧に出さず、「自分の記録にする」で明示したときだけ割り当てる", () => {
    setup(() => [rec({ id: "u1", profileId: null, myDeck: "旧デッキ", opponentDeck: "旧相手" })]);
    expect(qa("battle-row")).toHaveLength(0);
    const un = q("battle-unassigned")!;
    expect(un.textContent).toContain("1件");
    act(() => {
      un.setAttribute("open", "");
    });
    click(q("battle-claim"));
    expect(claimBattle).toHaveBeenCalledWith("u1", data.profiles[0].id);
  });
});
