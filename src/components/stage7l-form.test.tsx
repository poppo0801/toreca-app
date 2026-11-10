import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import { lotteryInputSchema } from "@/lib/lottery-input";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-09 (月) 12:00 JST */
const NOW = new Date("2026-11-09T03:00:00Z");
let data: AppData = createMockData(NOW);
let profileId = "pA";
const saveLottery = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data, createdIds: undefined as string[] | undefined }));
const bulkSave = vi.fn(async (..._a: unknown[]): Promise<{ ok: boolean; error?: string; data?: AppData; createdIds?: string[]; skipped?: { storeName: string; reason: string }[] }> => ({ ok: true, data, createdIds: ["n1", "n2"], skipped: [] }));
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles.find((p) => p.id === profileId), settings: {}, actions: { saveLottery }, persistent: true, reload: async () => null }),
}));
vi.mock("@/app/(app)/lotteries/actions", () => ({
  saveLotteryBulkAction: (...a: unknown[]) => bulkSave(...a),
  loadCollectionAreaAction: async () => ({ ok: true, prefectures: ["兵庫県"] }),
}));
vi.mock("@/components/ai-import-dialog", () => ({ AiImportDialog: () => null }));
vi.mock("@/components/ai-supplement-dialog", () => ({ AiSupplementDialog: () => null }));

import { LotteryFormDialog } from "@/components/lottery-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: Element | null) => act(async () => void (el as HTMLElement).click());
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const setValue = async (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
const memoField = () => [...document.body.querySelectorAll("label")].find((l) => l.textContent?.startsWith("メモ"))!.querySelector("textarea")!;
/** 試験データのIDを UUID 形式にする（入力の検証は UUID を要求するため。参照の関係はそのまま） */
const U = (id: string) => `00000000-0000-4000-8000-${[...id].map((ch) => ch.charCodeAt(0).toString(16)).join("").slice(-12).padStart(12, "0")}`;
const uuidify = (d: AppData): AppData => JSON.parse(JSON.stringify(d).replace(/"([a-z]{1,3}[0-9]{1,2})"/g, (_m, id: string) => `"${U(id)}"`));

beforeEach(() => {
  data = uuidify(createMockData(NOW));
  profileId = "pA";
  saveLottery.mockClear();
  bulkSave.mockClear();
  sessionStorage.clear();
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

const mountEdit = (lottery: Lottery, onOpenChange = vi.fn()) => act(async () => root.render(createElement(LotteryFormDialog, { open: true, onOpenChange, lottery })));
const unmount = () => act(async () => root.render(createElement("div")));

describe("Stage 7L: 抽選編集フォームの一時保存・再開", () => {
  it("閉じる操作は確認なし。未保存の内容は一時保存され、開き直した直後は保存済みの内容。「編集を再開」でだけ復元する（自動フォーカスしない）", async () => {
    const lottery = data.lotteries[0];
    const onOpenChange = vi.fn();
    await mountEdit(lottery, onOpenChange);
    expect(q("resume-edit")).toBeNull(); // 最初は一時保存なし
    await setValue(memoField(), "未保存のメモ");
    await click(q("form-discard"));
    expect(q("form-confirm")).toBeNull(); // 破棄の確認は出さない
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(sessionStorage.getItem("tcg.lottery-resume.v1")).toContain("未保存のメモ"); // この端末内に一時保存

    await unmount();
    await mountEdit(lottery);
    expect(memoField().value).toBe(lottery.memo); // 開いた直後は正式保存済みの内容
    expect(q("resume-edit")).not.toBeNull();
    await click(q("resume-edit"));
    await flush();
    expect(memoField().value).toBe("未保存のメモ");
    expect(q("resume-edit")).toBeNull();
    expect(["INPUT", "SELECT", "TEXTAREA"]).not.toContain(document.activeElement?.tagName); // キーボード・プルダウンを自動表示しない
  });

  it("10分を過ぎた一時保存は復元できない", async () => {
    const lottery = data.lotteries[0];
    await mountEdit(lottery);
    await setValue(memoField(), "古い編集");
    await click(q("form-discard"));
    const s = JSON.parse(sessionStorage.getItem("tcg.lottery-resume.v1")!);
    sessionStorage.setItem("tcg.lottery-resume.v1", JSON.stringify({ ...s, at: Date.now() - 11 * 60_000 }));
    await unmount();
    await mountEdit(lottery);
    expect(q("resume-edit")).toBeNull();
  });

  it("別の抽選を編集すると以前の一時保存は破棄される／別のプロフィールには復元しない", async () => {
    const [a, b] = data.lotteries;
    await mountEdit(a);
    await setValue(memoField(), "Aの編集");
    await click(q("form-discard"));
    await unmount();
    profileId = "pB";
    await mountEdit(a);
    expect(q("resume-edit")).toBeNull(); // 別のプロフィール
    await unmount();
    profileId = "pA";
    await mountEdit(b);
    expect(q("resume-edit")).toBeNull(); // 別の抽選
    expect(sessionStorage.getItem("tcg.lottery-resume.v1")).toBeNull(); // 以前の一時保存は破棄
    await unmount();
    await mountEdit(a);
    expect(q("resume-edit")).toBeNull(); // もう戻らない（最後の1件だけ）
  });

  it("正式に保存すると一時保存は削除され、復元ボタンは出ない", async () => {
    const lottery = data.lotteries[0];
    await mountEdit(lottery);
    await setValue(memoField(), "保存するメモ");
    await click(q("form-discard"));
    await unmount();
    await mountEdit(lottery);
    await click(q("resume-edit"));
    await flush();
    const submit = document.body.querySelector<HTMLButtonElement>('[data-testid="lottery-form"] button[type="submit"]')!;
    await click(submit);
    await flush();
    expect(saveLottery).toHaveBeenCalled();
    expect(sessionStorage.getItem("tcg.lottery-resume.v1")).toBeNull();
  });

  it("他の端末などで保存済みの内容が更新されていた項目は、最新を残して上書きしない", async () => {
    const lottery = data.lotteries[0];
    await mountEdit(lottery);
    await setValue(memoField(), "自分のメモ");
    await click(q("form-discard"));
    await unmount();
    // 保存後に別の端末が同じ抽選のメモを更新した（更新日時も変わる）
    data = { ...data, lotteries: data.lotteries.map((l) => (l.id === lottery.id ? { ...l, memo: "他で更新されたメモ", updatedAt: "2026-11-09T02:00:00Z" } : l)) };
    await mountEdit(data.lotteries[0]);
    await click(q("resume-edit"));
    await flush();
    expect(memoField().value).toBe("他で更新されたメモ"); // 古い一時保存で上書きしない
    expect(q("resume-note")!.textContent).toContain("メモ");
  });

  it("新規登録のフォームは、従来どおり破棄の確認を出す（今回の対象は抽選編集のみ）", async () => {
    await act(async () => root.render(createElement(LotteryFormDialog, { open: true, onOpenChange: vi.fn(), lottery: null })));
    await setValue(memoField(), "入力中");
    await click(q("form-discard"));
    expect(q("form-confirm")!.textContent).toContain("入力中の内容を破棄");
  });
});

describe("Stage 7L: 店舗別の一括登録", () => {
  const input = (chainId = "c1") =>
    lotteryInputSchema.parse({
      chain: { id: U(chainId), name: "サンプル電機" },
      store: { id: null, name: "", prefecture: "" },
      campaignId: null,
      newCampaign: null,
      items: [{ product: { id: U("p1"), name: "テスト拡張パック「ひかりの森」" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "date_only", date: "2026-11-10", time: "" },
      applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" },
      resultDate: { precision: "date_only", date: "2026-11-25", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" },
      receiveMethod: "store",
      applyMethod: "web",
      conditionsText: "",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: [],
      eventState: "open",
      limitBasis: "account",
      limitMaxCount: 1,
      memo: "",
    });
  const prefill = () => ({ draft: { input: input(), flags: {}, modePending: false, duplicates: [], warnings: [], evidence: {}, generalNotes: [], candidates: { chain: [], store: [], items: [[]] }, summary: { chain: "none", store: "none", items: [] } } as never, runId: null });
  const mountNew = (candidateId: string | null = null, onSaved = vi.fn()) => act(async () => root.render(createElement(LotteryFormDialog, { open: true, onOpenChange: vi.fn(), lottery: null, prefill: prefill(), candidateId, onSaved })));
  const rows = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="bulk-store-list"] li')];
  const checkbox = (name: string) => document.body.querySelector<HTMLInputElement>(`[data-testid="bulk-store-list"] input[aria-label="${name}"]`)!;
  const chooseBulk = async () => {
    await setValue(q("store-mode") as HTMLSelectElement, "bulk");
    await flush();
  };
  const submitForm = async () => click(document.body.querySelector('[data-testid="lottery-form"] button[type="submit"]'));
  beforeEach(() => {
    // 系列 c1 の店舗を増やす（対象地域外・所在地不明を含む）
    data = {
      ...data,
      stores: [...data.stores, { id: U("s7"), chainId: U("c1"), name: "東京店", prefecture: "東京都" }, { id: U("s8"), chainId: U("c1"), name: "所在地不明店", prefecture: "" }],
    };
  });

  it("「店舗別に一括登録」を選ぶと、系列マスターの店舗が候補になり、対象地域内の店舗だけが初期選択される（所在地不明は推定しない）", async () => {
    await mountNew();
    expect([...(q("store-mode") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["店舗固定", "応募時に店舗選択", "店舗指定なし", "店舗別に一括登録"]);
    await chooseBulk();
    expect(rows().map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("三宮店"), expect.stringContaining("名谷店"), expect.stringContaining("東京店"), expect.stringContaining("所在地不明店")]));
    expect(checkbox("三宮店").checked).toBe(true);
    expect(checkbox("名谷店").checked).toBe(true);
    expect(checkbox("東京店").checked).toBe(false); // 対象地域外
    expect(checkbox("所在地不明店").checked).toBe(false); // 所在地不明は根拠なく選ばない
    expect(q("bulk-count")!.textContent).toBe("2");
    expect(rows().find((r) => r.textContent?.includes("東京店"))!.textContent).toContain("対象地域外");
    expect(rows().find((r) => r.textContent?.includes("所在地不明店"))!.textContent).toContain("所在地未確認");
    // 他の系列の店舗は出ない
    expect(rows().map((r) => r.textContent).join("")).not.toContain("梅田店");
  });

  it("店舗を外す・追加できる（同じ店舗の重複追加はしない）。登録前に件数と店舗名を示し、選択数と同じ数の入力を送る", async () => {
    await mountNew("cand-1");
    await chooseBulk();
    await click(checkbox("名谷店")); // 外す
    await click(checkbox("東京店")); // 対象地域外を手動で追加
    await setValue(q("bulk-new-name") as HTMLInputElement, "新規の店");
    await click(q("bulk-new-add"));
    await setValue(q("bulk-new-name") as HTMLInputElement, "三宮店"); // 既存と同じ
    await click(q("bulk-new-add"));
    expect(rows().filter((r) => r.textContent?.includes("三宮店"))).toHaveLength(1);
    expect(q("bulk-count")!.textContent).toBe("3"); // 三宮・東京・新規の店

    await submitForm();
    expect(q("bulk-confirm")!.textContent).toContain("3店舗の抽選を登録します");
    expect(q("bulk-confirm-list")!.textContent).toContain("三宮店");
    expect(q("bulk-confirm-list")!.textContent).toContain("新規の店");
    expect(q("bulk-confirm-list")!.textContent).not.toContain("名谷店");
    expect(bulkSave).not.toHaveBeenCalled(); // 確認の前には登録しない

    await click(q("bulk-confirm-ok"));
    await flush();
    expect(bulkSave).toHaveBeenCalledTimes(1);
    const [inputs, opId, candidateId] = bulkSave.mock.calls[0] as [{ store: { id: string | null; name: string }; storeMode: string; items: unknown[] }[], string, string | null];
    expect(inputs.map((i) => i.store.name).sort()).toEqual(["三宮店", "東京店", "新規の店"].sort());
    expect(inputs.find((i) => i.store.name === "三宮店")!.store.id).toBe(U("s1"));
    expect(inputs.find((i) => i.store.name === "新規の店")!.store.id).toBeNull();
    expect(inputs.every((i) => i.storeMode === "fixed" && i.items.length === 1)).toBe(true); // 共通情報は各店舗に同じ内容で
    expect(candidateId).toBe("cand-1"); // 候補との関連
    expect(typeof opId).toBe("string");
  });

  it("登録に成功したら、作成した最初の抽選のIDで onSaved を呼ぶ（候補を処理済みにする）", async () => {
    const onSaved = vi.fn();
    await mountNew("cand-1", onSaved);
    await chooseBulk();
    await submitForm();
    await click(q("bulk-confirm-ok"));
    await flush();
    expect(onSaved).toHaveBeenCalledWith("n1");
  });

  it("登録済みの同じ抽選がある店舗は、対象から除かれ（二重登録を防ぐ）理由が表示される", async () => {
    const lot = data.lotteries[0];
    data = { ...data, lotteries: [{ ...lot, chainId: U("c1"), storeId: U("s1"), items: [{ ...lot.items[0], productId: U("p1") }], applyDeadline: { precision: "date_only", date: "2026-11-20" } as never }, ...data.lotteries.slice(1)] };
    await mountNew();
    await chooseBulk();
    expect(checkbox("三宮店").checked).toBe(false);
    expect(checkbox("三宮店").disabled).toBe(true);
    expect(rows().find((r) => r.textContent?.includes("三宮店"))!.textContent).toContain("登録済み");
    expect(q("bulk-count")!.textContent).toBe("1"); // 名谷店のみ
  });

  it("通信失敗の再試行は同じ操作ID（二重登録しない）。選択を変えると新しい操作ID", async () => {
    bulkSave.mockResolvedValueOnce({ ok: false, error: "通信に失敗しました" });
    await mountNew();
    await chooseBulk();
    await submitForm();
    await click(q("bulk-confirm-ok"));
    await flush();
    expect(document.body.textContent).toContain("通信に失敗しました");
    await submitForm();
    await click(q("bulk-confirm-ok"));
    await flush();
    const ops = bulkSave.mock.calls.map((c) => c[1]);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toBe(ops[1]);
    // 内容を変えたら別の操作
    await mountNew();
  });

  it("一部の店舗が登録済みで除かれたときは、結果を知らせてから閉じる", async () => {
    bulkSave.mockResolvedValueOnce({ ok: true, data, createdIds: ["n1"], skipped: [{ storeName: "名谷店", reason: "同じ店舗・同じ商品の抽選が登録済みです" }] });
    const onSaved = vi.fn();
    await mountNew(null, onSaved);
    await chooseBulk();
    await submitForm();
    await click(q("bulk-confirm-ok"));
    await flush();
    expect(q("bulk-result")!.textContent).toContain("1店舗の抽選を登録しました");
    expect(q("bulk-result")!.textContent).toContain("名谷店");
    expect(onSaved).not.toHaveBeenCalled();
    await click(q("bulk-result-close"));
    expect(onSaved).toHaveBeenCalledWith("n1");
  });

  it("店舗を1つも選ばなければ登録できない", async () => {
    await mountNew();
    await chooseBulk();
    await click(checkbox("三宮店"));
    await click(checkbox("名谷店"));
    await submitForm();
    expect(document.body.textContent).toContain("登録する店舗を1つ以上選択してください");
    expect(q("bulk-confirm")).toBeNull();
  });

  it("既存の3つの店舗指定方式は、一括登録を選ばなければ従来どおり（選択肢の切り替えで一括登録の状態が残らない）", async () => {
    await mountNew();
    await chooseBulk();
    expect(q("bulk-stores")).not.toBeNull();
    await setValue(q("store-mode") as HTMLSelectElement, "select_on_apply");
    expect(q("bulk-stores")).toBeNull();
    expect((q("store-mode") as HTMLSelectElement).value).toBe("select_on_apply");
    await setValue(q("store-mode") as HTMLSelectElement, "fixed");
    expect((q("store-mode") as HTMLSelectElement).value).toBe("fixed");
  });

  it("編集では一括登録は選べない（個別に編集する）", async () => {
    await mountEdit(data.lotteries[0]);
    expect([...(q("store-mode") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["fixed", "select_on_apply", "none"]);
  });
});
