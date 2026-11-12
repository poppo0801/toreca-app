import { vi } from "vitest";
import { describe, expect, it } from "vitest";
import { isPrefecture, normalizePrefecture, PREFECTURE_LIST } from "@/lib/geo";
import { ENTITIES, buildSchema } from "@/lib/masters";

describe("Stage 8U-1: 店舗マスターの都道府県は47都道府県の選択式", () => {
  it("正規化: 正式名はそのまま。「県・府・都」を省いた表記・全角半角・空白は正式名へ。未設定は空。該当なしはそのまま（推測しない）", () => {
    expect(PREFECTURE_LIST).toHaveLength(47);
    expect(normalizePrefecture("兵庫県")).toBe("兵庫県");
    expect(normalizePrefecture(" 兵庫 ")).toBe("兵庫県");
    expect(normalizePrefecture("東京")).toBe("東京都");
    expect(normalizePrefecture("京都")).toBe("京都府");
    expect(normalizePrefecture("大阪")).toBe("大阪府");
    expect(normalizePrefecture("北海道")).toBe("北海道");
    expect(normalizePrefecture("　")).toBe("");
    expect(normalizePrefecture("")).toBe("");
    expect(normalizePrefecture("関西")).toBe("関西");
    expect(isPrefecture("関西")).toBe(false);
    expect(isPrefecture("沖縄県")).toBe(true);
  });
  it("店舗の検証: 47都道府県と未設定（空）は通り、略記は正式名にそろい、それ以外は拒否される", () => {
    const schema = buildSchema(ENTITIES.stores);
    const base = { chain_id: "11111111-1111-4111-8111-111111111111", name: "S", sales_kind: "physical", nearest_station: "", address_optional: "", parking_memo: "", memo: "", round_trip_fare: "", latitude: "", longitude: "" };
    const ok = (prefecture: unknown) => schema.safeParse({ ...base, prefecture });
    expect(ok("").success).toBe(true);
    expect(ok("兵庫県").success).toBe(true);
    const r = ok("大阪");
    expect(r.success && r.data.prefecture).toBe("大阪府");
    expect(ok("関西").success).toBe(false);
    expect(ok("Hyogo").success).toBe(false);
    expect(ok(undefined).success).toBe(true); // 未指定は未設定
  });
  it("店舗の都道府県は選択式で、選択肢は47都道府県＋未設定", () => {
    const f = ENTITIES.stores.fields.find((x) => x.name === "prefecture")!;
    expect(f.type).toBe("select");
    expect(f.options).toHaveLength(48);
    expect(f.options![0]).toEqual({ value: "", label: "未設定" });
  });
});

// ---------------------------------------------------------------- 抽選候補の編集の一時保存（最後に編集した1件・10分）
import { clearCandidateResume, discardCandidateResumeFor, loadCandidateResume, RESUME_TTL_MS, saveCandidateResume, type ResumeStash } from "@/lib/lottery-resume";

describe("Stage 8U-1: 抽選候補の編集の一時保存", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size };
  };
  const stash = (id: string, at: number, profileId = "p1"): ResumeStash => ({ lotteryId: id, profileId, baseUpdatedAt: null, base: { memo: "元" } as never, baseUrls: "", edited: { memo: "編集中" } as never, editedUrls: "", sources: {}, at });
  const T0 = 1_000_000_000_000;
  it("最後に編集した候補1件だけ保持する。別の候補を開くと以前の分は破棄される。同じ候補・同じプロフィールなら復元できる", () => {
    const st = mem();
    saveCandidateResume(stash("c1", T0), st);
    expect(loadCandidateResume("c1", "p1", T0 + 1000, st)?.edited).toEqual({ memo: "編集中" });
    expect(loadCandidateResume("c2", "p1", T0 + 1000, st)).toBeNull(); // 別の候補と混同しない
    expect(st.size()).toBe(0); // 別の候補を開いたので以前の一時保存は破棄
    saveCandidateResume(stash("c2", T0), st); // 最後に編集した1件だけ（上書き）
    saveCandidateResume(stash("c3", T0 + 10), st);
    expect(loadCandidateResume("c2", "p1", T0 + 20, st)).toBeNull();
  });
  it("有効期限は最後の編集から10分。期限切れは破棄され、通常の編集状態から始まる", () => {
    expect(RESUME_TTL_MS).toBe(10 * 60 * 1000);
    const st = mem();
    saveCandidateResume(stash("c1", T0), st);
    expect(loadCandidateResume("c1", "p1", T0 + RESUME_TTL_MS, st)).not.toBeNull(); // ちょうど10分は有効
    expect(loadCandidateResume("c1", "p1", T0 + RESUME_TTL_MS + 1, st)).toBeNull();
    expect(st.size()).toBe(0);
  });
  it("別のプロフィールの内容は復元しない（内容はそのまま残す）。壊れた保存データは破棄する", () => {
    const st = mem();
    saveCandidateResume(stash("c1", T0, "p1"), st);
    expect(loadCandidateResume("c1", "p2", T0 + 1000, st)).toBeNull();
    expect(loadCandidateResume("c1", "p1", T0 + 1000, st)).not.toBeNull();
    st.setItem("tcg.candidate-resume.v1", "{broken");
    expect(loadCandidateResume("c1", "p1", T0, st)).toBeNull();
    expect(st.size()).toBe(0);
  });
  it("正式登録・除外・削除のあとは、その候補の一時保存だけを破棄する（他の候補の分は残す）。保存先は抽選の編集の一時保存とは別", () => {
    const st = mem();
    saveCandidateResume(stash("c1", T0), st);
    discardCandidateResumeFor("c2", st);
    expect(st.size()).toBe(1);
    discardCandidateResumeFor("c1", st);
    expect(st.size()).toBe(0);
    saveCandidateResume(stash("c1", T0), st);
    clearCandidateResume(st);
    expect(st.size()).toBe(0);
    const lot = mem();
    saveCandidateResume(stash("x", T0), lot);
    expect(lot.getItem("tcg.lottery-resume.v1")).toBeNull(); // 抽選の編集の一時保存の保存先に触れない
  });
});

// ---------------------------------------------------------------- 入力欄の自動スクロール
import { isTextEntry, revealDelta, scrollParentOf, installInputReveal } from "@/lib/input-reveal";

describe("Stage 8U-1: 入力欄の自動スクロール（共通処理）", () => {
  const vv = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale });
  it("見える領域は visualViewport（キーボードを除く）とスクロール領域の枠の重なり。すでに見えていれば動かさない。拡大中は動かさない", () => {
    expect(revealDelta({ top: 100, bottom: 140 }, vv(400), null)).toBe(0); // 見えている
    expect(revealDelta({ top: 420, bottom: 460 }, vv(400), null)).toBe(60 + 12 - 0); // キーボードで隠れる → 下端の余白12pxまで
    expect(revealDelta({ top: -20, bottom: 20 }, vv(400), null)).toBe(-32); // 上に隠れる
    expect(revealDelta({ top: 420, bottom: 460 }, vv(400, 0, 1.5), null)).toBe(0); // 拡大中
    expect(revealDelta({ top: 420, bottom: 460 }, null, null)).toBe(0); // viewport 情報がない
    // ボトムシートの本文の枠（固定フッターの上まで）が小さいとき、その枠に合わせる
    expect(revealDelta({ top: 330, bottom: 370 }, vv(600), { top: 100, bottom: 320 })).toBe(370 - 320 + 12);
  });
  it("対象はテキスト入力だけ（ボタン・チェックボックス・選択・読み取り専用・無効は対象外。data-no-input-reveal の中も対象外）", () => {
    const mk = (html: string) => {
      const d = document.createElement("div");
      d.innerHTML = html;
      document.body.appendChild(d);
      return d;
    };
    const d = mk(`<input id="a" type="text"><input id="b" type="checkbox"><textarea id="c"></textarea><select id="d"></select><input id="e" readonly><input id="f" disabled><div data-no-input-reveal><input id="g"></div><input id="h" type="date"><button id="i"></button>`);
    const el = (id: string) => d.querySelector(`#${id}`);
    expect(isTextEntry(el("a"))).toBe(true);
    expect(isTextEntry(el("c"))).toBe(true);
    expect(isTextEntry(el("h"))).toBe(true);
    for (const id of ["b", "d", "e", "f", "g", "i"]) expect(isTextEntry(el(id)), id).toBe(false);
    d.remove();
  });
  it("スクロール領域は、入力欄を含む最も近い縦スクロール（overflow-y: auto で実際にあふれているもの）。無ければアプリ本体", () => {
    const app = document.createElement("main");
    app.id = "app-scroll";
    const sheet = document.createElement("div");
    sheet.style.overflowY = "auto";
    Object.defineProperty(sheet, "scrollHeight", { value: 800, configurable: true });
    Object.defineProperty(sheet, "clientHeight", { value: 300, configurable: true });
    const input = document.createElement("input");
    sheet.appendChild(input);
    app.appendChild(sheet);
    document.body.appendChild(app);
    expect(scrollParentOf(input)).toBe(sheet);
    const flat = document.createElement("input");
    app.appendChild(flat);
    expect(scrollParentOf(flat)).toBe(app);
    app.remove();
  });
  it("フォーカスされたときだけ反応し、隠れていればスクロール領域を動かす。画面を開いただけ（フォーカスなし）・別の欄へ移ったあとは動かさない", () => {
    vi.useFakeTimers();
    const app = document.createElement("main");
    app.id = "app-scroll";
    const scrollBy = vi.fn();
    app.scrollBy = scrollBy as never;
    const input = document.createElement("input");
    const other = document.createElement("input");
    app.append(input, other);
    document.body.appendChild(app);
    const fakeVv = Object.assign(new EventTarget(), { height: 300, offsetTop: 0, scale: 1 });
    const win = Object.assign(Object.create(window), { visualViewport: fakeVv, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) });
    input.getBoundingClientRect = () => ({ top: 400, bottom: 440, left: 0, right: 0, width: 0, height: 40, x: 0, y: 400, toJSON() {} }) as DOMRect;
    other.getBoundingClientRect = () => ({ top: 100, bottom: 140, left: 0, right: 0, width: 0, height: 40, x: 0, y: 100, toJSON() {} }) as DOMRect; // 見えている位置
    const off = installInputReveal(document, win as unknown as Window, [10]);
    vi.advanceTimersByTime(50);
    expect(scrollBy).not.toHaveBeenCalled(); // フォーカスしていない
    input.focus();
    vi.advanceTimersByTime(50);
    expect(scrollBy).toHaveBeenCalledWith({ top: 440 - 300 + 12 });
    scrollBy.mockClear();
    input.focus();
    other.focus(); // すぐ別の欄へ
    vi.advanceTimersByTime(50);
    expect(scrollBy).not.toHaveBeenCalled(); // 古い入力欄の分では動かさない
    off();
    app.remove();
    vi.useRealTimers();
  });
});
