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
    const line = (row: Element, id: string) => ({ name: row.querySelector(`[data-testid="${id}"] [data-testid="battle-name"]`)!.textContent, deck: row.querySelector(`[data-testid="${id}"] [data-testid="battle-deck"]`)!.textContent });
    // 自分を1行目、相手を2行目（ラベルなし）。それぞれ独立した1行
    expect(line(first, "battle-me")).toEqual({ name: data.profiles[0].label, deck: "リザードン" });
    expect(line(first, "battle-opp")).toEqual({ name: data.profiles[1].label, deck: "サーナイト" });
    expect(first.textContent).not.toMatch(/MY|VS|vs|自分|相手：/);
    expect(first.querySelector('[data-result="win"]')!.textContent).toBe("◯");
    // 外部の相手
    const ext = qa("battle-row").find((r) => r.textContent?.includes("ピカチュウ"))!;
    expect(line(ext, "battle-opp").name).toBe("友だち");
    expect(ext.querySelector('[data-result="lose"]')!.textContent).toBe("×");
    // 相手側（Bの画面）: 共有の1件だけ。デッキ・勝敗が反転し、相手はA
    me = 1;
    act(() => root.render(createElement(BattlesView, { key: "b" })));
    const b = qa("battle-row");
    expect(b).toHaveLength(1);
    expect(line(b[0], "battle-me")).toEqual({ name: data.profiles[1].label, deck: "サーナイト" });
    expect(line(b[0], "battle-opp")).toEqual({ name: data.profiles[0].label, deck: "リザードン" });
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
    expect(mark.className).toContain("text-[2.5rem]"); // 大きく
    const svg = mark.querySelector('[data-testid="result-svg"]')!; // 太い線のSVG（3種類とも同じ線幅）
    expect(Number(svg.getAttribute("data-stroke"))).toBeGreaterThanOrEqual(3);
    expect(svg.getAttribute("stroke-width")).toBe(svg.getAttribute("data-stroke"));
    expect(mark.parentElement!.className).toContain("items-center"); // 右端で上下中央
    expect(mark.parentElement!.className).toContain("justify-center");
    expect(card.lastElementChild).toBe(mark.parentElement); // カードの右端
    expect(mark.getAttribute("aria-label")).toBe("引き分け"); // 色だけに頼らない
    // 対戦形式は小さな角丸チップ。「vs ○○」の相手名表示は無い
    expect(card.querySelector('[data-testid="battle-format"]')!.className).toContain("rounded-full");
  });

  it("勝敗の色は 勝ち=青・負け=赤・引き分け=緑（一覧・分析で共通）", () => {
    setup((a) => [rec({ id: "w", profileId: a, result: "win" }), rec({ id: "l", profileId: a, result: "lose" }), rec({ id: "d", profileId: a, result: "draw" })]);
    expect(document.body.querySelector('span[data-result="win"]')!.className).toContain("--cat-supply");
    expect(document.body.querySelector('span[data-result="lose"]')!.className).toContain("danger");
    expect(document.body.querySelector('span[data-result="draw"]')!.className).toContain("success");
    // 左端のアクセントバーは記号と同じ色（細いバー。カード全体は塗らない）
    const bar = (r: string) => document.body.querySelector(`[data-testid="battle-row"][data-result="${r}"] [data-testid="battle-bar"]`)!;
    expect(bar("win").className).toContain("--cat-supply");
    expect(bar("lose").className).toContain("bg-danger");
    expect(bar("draw").className).toContain("bg-success");
    expect(bar("win").className).toContain("w-1.5");
    expect(document.body.querySelector('[data-testid="battle-row"]')!.className).not.toContain("bg-[var(--cat-supply)]");
  });

  it("プロフィールアイコン: アプリ内のユーザーは設定済みのアイコン、外部の相手は共通の人物アイコン", () => {
    setup((a, b) => [rec({ id: "i1", profileId: a, opponentProfileId: b, myDeck: "共有デッキ" }), rec({ id: "i2", profileId: a, opponent: "友だち", myDeck: "外部デッキ" })]);
    const rows = qa("battle-row");
    const shared = rows.find((r) => r.textContent?.includes("共有デッキ"))!;
    expect(shared.querySelectorAll('[data-testid="battle-external-icon"]')).toHaveLength(0); // 双方がアプリ内のプロフィール
    const ext = rows.find((r) => r.querySelector('[data-testid="battle-external-icon"]'))!;
    expect(ext.querySelectorAll('[data-testid="battle-external-icon"]')).toHaveLength(1); // 外部の相手だけ人物アイコン
    expect(ext.querySelector('[data-testid="battle-me"] [data-testid="battle-external-icon"]')).toBeNull();
    // アイコンは小さく（24px程度）
    expect(ext.querySelector('[data-testid="battle-external-icon"]')!.className).toContain("size-[17px]");
  });

  it("デッキ名は原則1行で収まるよう、ユーザー名は幅を抑え、デッキ名は最大2行まで", () => {
    setup((a) => [rec({ id: "d1", profileId: a, opponent: "あいうえおかきくけこさしすせそ", myDeck: "スタートデッキ100 (025)", opponentDeck: "スタートデッキ100 (001)" })]);
    const row = qa("battle-row")[0];
    // ユーザー名は固定幅（デッキ名の開始位置が自分・相手で揃う）。アイコンは20px
    const names = [...row.querySelectorAll('[data-testid="battle-name"]')];
    expect(names).toHaveLength(2);
    expect(names.every((n) => n.className.includes("w-[3.75rem]") && n.className.includes("shrink-0"))).toBe(true);
    expect(row.querySelector('[data-testid="battle-external-icon"]')!.className).toContain("size-[17px]");
    expect(row.querySelector('[data-testid="battle-name"]')!.className).toContain("truncate");
    expect(names.some((n) => n.className.includes("font-bold"))).toBe(false); // 自分・相手とも通常の太さ
    expect(row.querySelector('[data-testid="battle-mark-box"]')!.className).toContain("pr-3"); // 勝敗記号を少し左へ
    const deck = row.querySelector('[data-testid="battle-deck"]')!;
    expect(deck.className).toContain("line-clamp-2");
    expect(deck.className).toContain("flex-1");
    expect(deck.textContent).toBe("スタートデッキ100 (025)");
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
    // 一覧の上部の総合集計（対戦数・勝ち・負け・勝率）。分析シートとは別
    expect([...q("battle-summary")!.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["対戦", "勝ち", "負け", "勝率"]);
    expect(q("sum-total-value")!.textContent).toBe("4");
    expect(q("sum-win-value")!.textContent).toBe("2");
    expect(q("sum-lose-value")!.textContent).toBe("1");
    expect(q("sum-rate-value")!.textContent).toBe("67%"); // 引き分け(1)は対戦数に含め、勝率の母数に含めない
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
