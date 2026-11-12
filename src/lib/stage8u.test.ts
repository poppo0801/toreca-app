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

// ---------------------------------------------------------------- 複数店舗抽選のグループ（表示ロジック）
import { createMockData } from "@/data/mock";
import { buildListRows, commonalityKey, groupBasis, suggestGroupMates, summarizeGroup, type GroupRow } from "@/lib/lottery-group";
import type { AppData, LotteryGroup } from "@/types/domain";

describe("Stage 8U-2: 抽選グループの表示ロジック", () => {
  const NOW = new Date("2026-11-03T03:00:00Z");
  const mk = (): { data: AppData; ids: string[] } => {
    const data = createMockData(NOW);
    const same = data.lotteries.filter((l) => l.chainId === "c1");
    return { data, ids: same.map((l) => l.id) };
  };
  const withGroup = (data: AppData, ids: string[], g: Partial<LotteryGroup> = {}): AppData => ({
    ...data,
    lotteryGroups: [{ id: "G1", chainId: "c1", title: "", origin: "manual", basis: {}, ...g }],
    lotteries: data.lotteries.map((l) => (ids.includes(l.id) ? { ...l, groupId: "G1" } : l)),
  });

  it("グループの子が一覧に2件以上あれば、先頭の子の位置に親カード1枚へまとめる（子は独立した抽選のまま）", () => {
    const { data, ids } = mk();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const g = withGroup(data, ids.slice(0, 2));
    const rows = buildListRows(g.lotteries, g);
    const grp = rows.filter((r) => r.kind === "group") as GroupRow[];
    expect(grp).toHaveLength(1);
    expect(grp[0].members.map((l) => l.id)).toEqual(ids.slice(0, 2));
    expect(grp[0].all).toHaveLength(2);
    expect(rows.filter((r) => r.kind === "single").length).toBe(g.lotteries.length - 2);
    // 親が出る位置は、先頭の子の位置
    expect(rows.findIndex((r) => r.kind === "group")).toBe(g.lotteries.findIndex((l) => l.id === ids[0]));
    // 子の抽選IDは変わらない
    expect(g.lotteries.filter((l) => l.groupId === "G1").map((l) => l.id).sort()).toEqual(ids.slice(0, 2).sort());
  });
  it("一覧に出ている子が1件だけ（他は別のタブ・絞り込み）なら、通常のカード。グループ情報が無いデータ・解散済み（グループ定義なし）も通常のカード", () => {
    const { data, ids } = mk();
    const g = withGroup(data, ids.slice(0, 2));
    const onlyOne = g.lotteries.filter((l) => l.id !== ids[1]);
    expect(buildListRows(onlyOne, g).every((r) => r.kind === "single")).toBe(true);
    expect(buildListRows(g.lotteries, { ...g, lotteryGroups: undefined }).every((r) => r.kind === "single")).toBe(true);
    expect(buildListRows(g.lotteries, { ...g, lotteryGroups: [] }).every((r) => r.kind === "single")).toBe(true);
  });
  it("単に系列が同じというだけではグループにならない（所属が明示されたものだけ）", () => {
    const { data } = mk();
    expect(buildListRows(data.lotteries, { ...data, lotteryGroups: [] }).every((r) => r.kind === "single")).toBe(true);
    expect(data.lotteries.every((l) => !l.groupId)).toBe(true);
  });
  it("親カードの内容: 系列名・対象商品（省略表示）・応募期間・発表日・対象店舗数・応募済み店舗数（現在のプロフィールの子の応募から導出）", () => {
    const { data, ids } = mk();
    const g = withGroup(data, ids);
    const row = buildListRows(g.lotteries, g).find((r) => r.kind === "group") as GroupRow;
    const profile = g.profiles[0];
    const s = summarizeGroup(row, g, profile.id);
    expect(s.chainName).toBe(g.chains.find((c) => c.id === "c1")?.name);
    expect(s.storeCount).toBe(ids.length);
    expect(s.productsText).not.toBe("");
    expect(s.periodText).toMatch(/〜/);
    expect(s.appliedCount).toBeLessThanOrEqual(s.storeCount);
    // 子の応募状態が親へ反映される（親は状態を持たない）
    const acc = g.accounts.find((a) => a.profileId === profile.id)!;
    const target = ids[0];
    const applied: AppData = { ...g, applications: [...g.applications.filter((a) => !(a.lotteryId === target && a.accountId === acc.id)), { id: "A-new", lotteryId: target, accountId: acc.id, state: "applied", result: "pending", fulfillment: "none", appliedAt: NOW.toISOString() } as never] };
    const before = summarizeGroup(row, g, profile.id).appliedCount;
    const after = summarizeGroup(buildListRows(applied.lotteries, applied).find((r) => r.kind === "group") as GroupRow, applied, profile.id).appliedCount;
    expect(after).toBeGreaterThanOrEqual(before);
  });
  it("複数商品は2つまで表示して「ほかN」に省略。店舗ごとに期間が違えば範囲を示し、店舗により異なることを明示する", () => {
    const { data, ids } = mk();
    const prods = data.products.slice(0, 4).map((p) => p.id);
    let g = withGroup(data, ids.slice(0, 2));
    g = { ...g, lotteries: g.lotteries.map((l) => (l.id === ids[0] ? { ...l, items: prods.map((productId) => ({ productId, quantity: 1, unit: "box" as const })) } : l)) };
    const row = buildListRows(g.lotteries, g).find((r) => r.kind === "group") as GroupRow;
    const s = summarizeGroup(row, g, g.profiles[0].id);
    expect(s.products.length).toBeGreaterThanOrEqual(3);
    expect(s.productsText).toMatch(/ほか\d+$/);
    g = { ...g, lotteries: g.lotteries.map((l) => (l.id === ids[1] ? { ...l, applyDeadline: { precision: "date_only" as const, date: "2099-12-31" } } : l)) };
    const s2 = summarizeGroup(buildListRows(g.lotteries, g).find((r) => r.kind === "group") as GroupRow, g, g.profiles[0].id);
    expect(s2.periodVaries).toBe(true);
    expect(s2.periodText).toContain("12/31");
  });
  it("手動グループ化の候補: 系列・商品・応募期間・発表日・応募方式が同じで、まだグループに入っていない抽選。別企画（商品・期間が違う）は候補にしない。根拠（共通・相違の項目）を記録できる", () => {
    const { data, ids } = mk();
    const a = data.lotteries.find((l) => l.id === ids[0])!;
    const b = { ...data.lotteries.find((l) => l.id === ids[1])!, applyDeadline: a.applyDeadline, resultDate: a.resultDate, applyStart: a.applyStart, applyMethod: a.applyMethod, items: a.items };
    const c = { ...b, id: "LX", applyDeadline: { precision: "date_only" as const, date: "2099-01-01" } };
    const d = { ...b, id: "LY", groupId: "G9" };
    expect(commonalityKey(a)).toBe(commonalityKey(b));
    expect(suggestGroupMates(a, [a, b, c, d]).map((l) => l.id)).toEqual([b.id]);
    const basis = groupBasis([a, b, c]);
    expect(basis.common).toEqual(expect.arrayContaining(["chain", "products"]));
    expect(basis.differs).toContain("deadline");
    expect(basis.lotteryCount).toBe(3);
  });
});

// ---------------------------------------------------------------- 操作ID・通信障害の復旧（Stage 8U-3）
import { newOpId, opKeeper, recoverUncertain } from "@/lib/operation-id";
import type { OperationCheck } from "@/services/types";

describe("Stage 8U-3: 操作IDと通信障害後の結果確認", () => {
  const noSleep = async () => undefined;
  it("操作ID: 同じ内容の再送は同じID。内容が変わる・成功して次の操作になるときは新しいID", () => {
    const k = opKeeper();
    const a = k.idFor("内容1");
    expect(k.idFor("内容1")).toBe(a);
    const b = k.idFor("内容2");
    expect(b).not.toBe(a);
    k.reset();
    expect(k.idFor("内容2")).not.toBe(b);
    expect(newOpId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("保存済み（応答だけ失われた）は done、実行されていない（ロールバック）は not_done。失敗と断定しない", async () => {
    expect(await recoverUncertain(async () => ({ ok: true, found: true, result: { ids: ["a"], lotteryId: "l" } }), "op", { sleep: noSleep })).toEqual({ state: "done", result: { ids: ["a"], lotteryId: "l" } });
    expect(await recoverUncertain(async () => ({ ok: true, found: false }), "op", { sleep: noSleep })).toEqual({ state: "not_done" });
  });
  it("確認の通信も失敗したら少し待って再試行し、回復すれば結果を返す。回復しなければ unknown（同じ操作IDで再送すれば二重にならない）", async () => {
    let n = 0;
    const flaky = async (): Promise<OperationCheck> => (++n < 3 ? { ok: false, error: "通信に失敗しました" } : { ok: true, found: true, result: { ids: [] } });
    expect((await recoverUncertain(flaky, "op", { sleep: noSleep })).state).toBe("done");
    expect(n).toBe(3);
    let m = 0;
    expect((await recoverUncertain(async () => (m++, { ok: false, error: "x" }), "op", { tries: 2, sleep: noSleep })).state).toBe("unknown");
    expect(m).toBe(2);
  });
});
