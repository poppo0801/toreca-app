import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { defaultFiltersFor, selectLotteries, tabOf, type Tab } from "@/lib/lottery-view";
import { resolveUserScope, DEFAULT_USER_SCOPE } from "@/lib/user-scope";
import * as m from "@/lib/mutations";
import { checkChainAliases } from "@/lib/chain-alias";
import { matchChain } from "@/lib/lottery-match";
import { EMPTY_FLEX, lotteryInputSchema, type LotteryInput } from "@/lib/lottery-input";
import { buildLotteryPayload } from "@/lib/lottery-payload";
import { applySupplement, buildSupplement } from "@/lib/ai-supplement";
import type { LotteryDraft } from "@/lib/lottery-match";
import type { AppData, Chain } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");
const TABS: Tab[] = ["won", "applied", "managed", "all"];
const anyFilter = (tab: Tab) => ({ ...defaultFiltersFor(tab), status: "any" as const, skip: "include" as const });
const idsIn = (d: AppData, tab: Tab, profile: string, scope?: ReadonlySet<string>) => selectLotteries(d, tab, anyFilter(tab), NOW, profile, undefined, scope).map((l) => l.id);

describe("Stage 6L: 4タブの重複排除（当選 → 応募済み → 要チェック → 全情報）", () => {
  it("どのユーザーから見ても、同じ抽選は1つのタブにだけ出る。4タブを合わせると全抽選", () => {
    const d = createMockData(NOW);
    for (const p of ["pA", "pB"]) {
      const lists = TABS.map((t) => idsIn(d, t, p));
      const all = lists.flat();
      expect(new Set(all).size).toBe(all.length); // 重複なし
      expect(all.length).toBe(d.lotteries.length); // 取りこぼしなし
    }
  });

  it("全情報で★を付けると、全情報から消えて要チェックに移る。★を外すと全情報へ戻る", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "all", "pB").find((x) => !d.applications.some((a) => a.lotteryId === x))!;
    expect(id).toBeTruthy();
    const starred = m.setManaged(d, "pB", id, true, NOW);
    expect(idsIn(starred, "all", "pB")).not.toContain(id);
    expect(idsIn(starred, "managed", "pB")).toContain(id);
    const off = m.setManaged(starred, "pB", id, false, NOW);
    expect(idsIn(off, "all", "pB")).toContain(id);
    expect(idsIn(off, "managed", "pB")).not.toContain(id);
  });

  it("要チェックの抽選を応募済みにすると要チェックから応募済みへ、結果が当選なら当選へ移る（途中のタブには残らない）", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "managed", "pA").find((x) => !d.applications.some((a) => a.lotteryId === x))!;
    expect(id).toBeTruthy();
    const applied = m.setApplied(d, "pA", id, "a-c1", true, NOW);
    expect(tabOf(applied, applied.lotteries.find((l) => l.id === id)!, resolveUserScope(applied.profiles, "pA", DEFAULT_USER_SCOPE))).toBe("applied");
    expect(idsIn(applied, "managed", "pA")).not.toContain(id);
    const appId = applied.applications.find((a) => a.lotteryId === id)!.id;
    const won = m.setResult(applied, "pA", appId, "won", NOW);
    expect(idsIn(won, "won", "pA")).toContain(id);
    expect(idsIn(won, "applied", "pA")).not.toContain(id);
  });

  it("他のユーザーの応募だけでは、本人の全情報・要チェックの分類は変わらない（既定の表示範囲は本人＋紐づくサブ）", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "managed", "pB").find((x) => !d.applications.some((a) => a.lotteryId === x))!;
    const aApplied = m.setApplied(d, "pA", id, "a-c1", true, NOW);
    expect(idsIn(aApplied, "applied", "pA")).toContain(id);
    expect(idsIn(aApplied, "managed", "pB")).toContain(id); // Bの要チェックには残る
    expect(idsIn(aApplied, "applied", "pB")).not.toContain(id);
    // 「全ユーザー」を選んだときだけ、他のユーザーの応募もその人の応募済みタブに出る（1抽選=1枚）
    const everyone = new Set(aApplied.profiles.map((p) => p.id));
    expect(idsIn(aApplied, "applied", "pB", everyone).filter((x) => x === id)).toHaveLength(1);
    expect(idsIn(aApplied, "managed", "pB", everyone)).not.toContain(id);
  });

  it("退出アニメーション中のカード（keepIds）は、分類が変わっても今のタブに残る", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "all", "pB")[0];
    const starred = m.setManaged(d, "pB", id, true, NOW);
    expect(selectLotteries(starred, "all", anyFilter("all"), NOW, "pB", new Set([id])).map((l) => l.id)).toContain(id);
  });

  it("タブの件数は表示される一覧の件数と一致する（4タブの合計が全抽選）", () => {
    const d = createMockData(NOW);
    const counts = TABS.map((t) => selectLotteries(d, t, anyFilter(t), NOW, "pA").length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(d.lotteries.length);
  });
});

describe("Stage 6L: 系列の別名", () => {
  const chains = [
    { id: "c1", name: "晴れる屋2" },
    { id: "c2", name: "カードラボ" },
  ];
  const aliases = [{ chainId: "c2", alias: "カドラボ" }];
  it("1系列に複数の別名を登録できる。正式名称と同じ・別名同士の重複は取り除く（全角半角・大小文字・空白は無視）", () => {
    const r = checkChainAliases("c1", "晴れる屋2", ["ハレツー", "ハレツー ", "はれつー2", "晴れる屋２", "HARETSU"], chains, aliases);
    expect(r.problems).toEqual([]);
    expect(r.values).toEqual(["ハレツー", "はれつー2", "HARETSU"]);
  });
  it("他の系列の正式名称・別名と同じ別名は衝突として拒否する（自動で確定しない）", () => {
    const a = checkChainAliases("c1", "晴れる屋2", ["カードラボ"], chains, aliases);
    expect(a.problems[0].message).toContain("別の系列「カードラボ」");
    // 半角カナ・全角英数の表記ゆれも同じとして衝突にする
    expect(checkChainAliases("c1", "晴れる屋2", ["ｶﾄﾞﾗﾎﾞ"], chains, [{ chainId: "c2", alias: "カドラボ" }]).problems).toHaveLength(1);
    expect(checkChainAliases("c1", "晴れる屋2", ["カドラボ"], chains, aliases).problems[0].message).toContain("カードラボ");
  });
  it("新規系列（id なし）でも、他の系列との衝突を検出する。自分の既存の別名は衝突にしない", () => {
    expect(checkChainAliases(null, "新しい系列", ["晴れる屋２"], chains, aliases).problems).toHaveLength(1);
    expect(checkChainAliases("c2", "カードラボ", ["カドラボ"], chains, aliases).problems).toEqual([]);
  });
  it("AI解析・自動収集・手動入力の候補検索で、別名は正式名称と同じ系列IDに照合される", () => {
    const list = [
      { id: "c1", name: "晴れる屋2", aliases: ["ハレツー"] },
      { id: "c2", name: "カードラボ" },
    ] as Chain[];
    const m = matchChain("ハレツー", list);
    expect(m.item?.id).toBe("c1");
    expect(m.kind === "alias" || m.kind === "exact").toBe(true);
    expect(matchChain("ﾊﾚﾂｰ", list).item?.id).toBe("c1"); // 半角カナも同じ
  });
});

describe("Stage 6L: 店舗なしでの抽選登録", () => {
  const base = () => {
    const d = createMockData(NOW);
    return d;
  };
  it("店舗が空でも入力の検証を通り、保存用のデータでは store=null（ダミーの店舗を作らない）", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const input = {
      chain: { id: uuid, name: "" },
      store: { id: null, name: "", prefecture: "" },
      noStore: true,
      campaignId: null,
      newCampaign: null,
      items: [{ product: { id: uuid, name: "" }, quantity: 1, unit: "box" as const }],
      applyStart: EMPTY_FLEX,
      applyDeadline: EMPTY_FLEX,
      resultDate: EMPTY_FLEX,
      procedureDeadline: EMPTY_FLEX,
      receiveMethod: "shipping" as const,
      applyMethod: "web" as const,
      conditionsText: "",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: [],
      eventState: "open" as const,
      limitBasis: "unknown" as const,
      limitMaxCount: 1,
      memo: "",
    };
    const parsed = lotteryInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(buildLotteryPayload(parsed.data, null, null).store).toBeNull();
    // 店舗が入力されていれば従来どおり店舗を送る
    const withStore = lotteryInputSchema.parse({ ...input, store: { id: null, name: "梅田店", prefecture: "大阪府" }, noStore: false });
    expect(buildLotteryPayload(withStore, null, null).store).toEqual({ id: null, name: "梅田店", prefecture: "大阪府" });
  });
  it("店舗なしの抽選（storeId=null）が、一覧・タブ・統計で扱える（系列の対象範囲は系列で判定）", () => {
    const d = base();
    const l = { ...d.lotteries[0], id: "L-no-store", storeId: null };
    const data: AppData = { ...d, lotteries: [...d.lotteries, l] };
    const ids = TABS.flatMap((t) => selectLotteries(data, t, anyFilter(t), NOW, "pA").map((x) => x.id));
    expect(ids.filter((x) => x === "L-no-store")).toHaveLength(1);
  });
});

describe("Stage 6L: AIによる不足情報の補完（差分の確認）", () => {
  const fx = { precision: "date_time" as const, date: "2026-11-20", time: "23:59" };
  const none = { precision: "unknown" as const, date: "", time: "" };
  const current = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: "123e4567-e89b-42d3-a456-426614174000", name: "" },
    store: { id: null, name: "", prefecture: "" },
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: "123e4567-e89b-42d3-a456-426614174001", name: "" }, quantity: 1, unit: "box" }],
    applyStart: none,
    applyDeadline: none,
    resultDate: none,
    procedureStart: none,
    procedureDeadline: none,
    receiveMethod: "unknown",
    applyMethod: "unknown",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "unknown",
    limitMaxCount: 1,
    memo: "",
    ...over,
  });
  const draftOf = (input: Partial<LotteryInput>, evidence: Record<string, { quote: string; verified: boolean | null }> = {}): LotteryDraft =>
    ({ input: current(input), flags: {}, modePending: false, duplicates: [], warnings: [], evidence, generalNotes: [], candidates: { chain: [], store: [], items: [] }, summary: { chain: "none", store: "none", items: [] } }) as unknown as LotteryDraft;

  it("空欄への補完は fill（初期は選択）、既存と食い違う項目は diff（初期は選択なし）。同じ値は候補にしない", () => {
    const cur = current({ applyDeadline: { precision: "date_time", date: "2026-11-10", time: "23:59" }, applyMethod: "web", conditionsText: "会員のみ" });
    const items = buildSupplement(
      cur,
      draftOf(
        { applyDeadline: fx, applyStart: { precision: "date_only", date: "2026-11-01", time: "" }, applyMethod: "web", conditionsText: "過去の購入履歴が必要", verificationText: "本人確認書類を提示" },
        { applyStart: { quote: "11/1から応募開始", verified: true } },
      ),
    );
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by.applyStart.kind).toBe("fill");
    expect(by.applyStart.evidence).toBe("11/1から応募開始");
    expect(by.applyDeadline.kind).toBe("diff"); // 11/10 と 11/20 の食い違い
    expect(by.applyDeadline.current).toContain("2026/11/10");
    expect(by.verificationText.kind).toBe("fill");
    expect(by.conditionsText.kind).toBe("diff"); // 文章は置き換えず追記
    expect(by.conditionsText.patch.conditionsText).toBe("会員のみ\n過去の購入履歴が必要");
    expect(by.applyMethod).toBeUndefined(); // 同じ値
  });

  it("日付のみ → 同じ日の日時は補完（時刻を足すだけ）。画像で読めなかった項目は候補にならない（推測で確定しない）", () => {
    const cur = current({ applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" } });
    const items = buildSupplement(cur, draftOf({ applyDeadline: fx }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "applyDeadline", kind: "fill" });
    expect(buildSupplement(cur, draftOf({}))).toEqual([]); // 何も読み取れなければ候補なし
  });

  it("既存の正しい情報は消えない: 選ばなかった項目・読み取れなかった項目は、そのまま残る", () => {
    const cur = current({ applyDeadline: { precision: "date_time", date: "2026-11-10", time: "23:59" }, conditionsText: "会員のみ", memo: "既存のメモ" });
    const items = buildSupplement(cur, draftOf({ applyDeadline: fx, verificationText: "本人確認書類を提示" }));
    const fills = items.filter((i) => i.kind === "fill");
    const next = applySupplement(cur, fills, { source: "画像", today: "2026-11-06" });
    expect(next.applyDeadline).toEqual(cur.applyDeadline); // 食い違いは選んでいないので変わらない
    expect(next.conditionsText).toBe("会員のみ");
    expect(next.verificationText).toBe("本人確認書類を提示");
  });

  it("反映した項目と読み取り元は、メモの末尾に記録する（出典）。何も選ばなければ変更なし", () => {
    const cur = current({ memo: "既存のメモ" });
    const items = buildSupplement(cur, draftOf({ applyStart: { precision: "date_only", date: "2026-11-01", time: "" } }));
    const next = applySupplement(cur, items, { source: "画像", today: "2026-11-06" });
    expect(next.memo).toBe("既存のメモ\nAI補完（画像・2026-11-06）: 応募開始");
    expect(applySupplement(cur, [], { source: "画像", today: "2026-11-06" })).toBe(cur);
  });

  it("未確認の初期値（応募方法・受取方法）は空欄と同じに扱い、補完の対象にする", () => {
    const cur = current({ applyMethod: "web" });
    const d = draftOf({ applyMethod: "app" });
    expect(buildSupplement(cur, d)[0]).toMatchObject({ key: "applyMethod", kind: "diff" });
    expect(buildSupplement(cur, d, { defaults: new Set(["applyMethod"]) })[0]).toMatchObject({ key: "applyMethod", kind: "fill" });
  });
});
