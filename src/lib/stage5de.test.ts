// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { formatDraftDate, buildResultRows } from "@/components/ai-result-list";
import { flagKind } from "@/components/review-flag";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { aiSnapshot, compareFeedback, inputSnapshot } from "@/lib/ai/feedback";
import { isAnalysisNote, validateExtraction } from "@/lib/ai/validate";
import { EMPTY_FLEX, lotteryInputSchema, type LotteryInput } from "@/lib/lottery-input";
import { placeLabel } from "@/lib/lottery-labels";
import { buildDraft } from "@/lib/lottery-match";
import { COPY_ITEMS, DEFAULT_NAV, MAX_NAV_SLOTS, NAV_ITEMS, SETTING_KEYS, availableNav, isNavActive, normalizeProfileSettings, resolveNav } from "@/lib/profile-settings";

const NOW = new Date("2026-10-28T03:00:00Z");
const d = (m: number, day: number, hour: number | null = null, minute: number | null = null, year: number | null = null) => ({ year, month: m, day, hour, minute });
const base = {
  is_lottery_announcement: true,
  chain_name: "サンプル電機",
  store_name: "三宮店",
  products: [{ name: "拡張パック「ひかりの森」", code: "", quantity: 1, unit: "box" }],
  multi_mode: "single",
};

describe("カード右上の受取場所（受取方法で決まる。距離は出さない）", () => {
  it("発送=通販（店舗が登録されていても）。店頭=都道府県。不明=出さない", () => {
    expect(placeLabel("shipping", "兵庫県")).toBe("通販");
    expect(placeLabel("shipping", null)).toBe("通販");
    expect(placeLabel("store", "兵庫県")).toBe("兵庫県");
    expect(placeLabel("either", "大阪府")).toBe("大阪府"); // 店頭でも受け取れる
    expect(placeLabel("store", "")).toBeNull();
    expect(placeLabel("unknown", "兵庫県")).toBeNull(); // 受取方法が不明なら、都道府県を推測で出さない
  });
});

describe("解析上の説明文を抽選情報の欄に入れない", () => {
  it("「読み取れませんでした」などの説明は欄を空にし、要確認の詳細へ移す", () => {
    const ex = validateExtraction(normalizeExtraction({ ...base, conditions_text: "投稿本文が途中で切れているため、応募条件を読み取れませんでした", notes: "記載がありません" }, NOW), null);
    expect(ex.conditionsText).toBe("");
    expect(ex.notes).toBe("");
    const issue = ex.issues.find((i) => i.field === "conditions");
    expect(issue?.message).toContain("読み取れませんでした");
    expect(ex.confidence.conditions).toBe("low");
  });

  it("本物の応募条件・注意事項は消さない", () => {
    const text = "期間内に当店で購入履歴がある方のみ応募可。応募はアプリ内のフォームから。";
    const ex = validateExtraction(normalizeExtraction({ ...base, conditions_text: text, verification_text: "顔写真付きの身分証明書", announcement_method: "メール" }, NOW), null);
    expect(ex.conditionsText).toBe(text);
    expect(ex.verificationText).toBe("顔写真付きの身分証明書");
    expect(ex.announcementMethod).toBe("メール");
    expect(ex.issues.filter((i) => i.message.includes("読み取れませんでした"))).toEqual([]);
  });

  it("判定: 説明文は true、内容・長い文章は false", () => {
    for (const t of ["不明", "なし", "記載がありません", "応募条件を読み取れませんでした", "画像が途中で切れて見えない", "判断できません。"]) expect(isAnalysisNote(t)).toBe(true);
    for (const t of ["会員限定", "お一人様1回まで", "購入履歴がある方", "x".repeat(200) + "読み取れませんでした"]) expect(isAnalysisNote(t)).toBe(false);
  });

  it("フォームに入る値に説明文は混ざらない（下書きの応募条件・本人確認・発表方法・メモ）", () => {
    const ex = validateExtraction(normalizeExtraction({ ...base, conditions_text: "応募条件は読み取れませんでした", verification_text: "不明", announcement_method: "記載なし", notes: "確認できません" }, NOW), null);
    const draft = buildDraft(ex, createMockData(NOW));
    expect(draft.input.conditionsText).toBe("");
    expect(draft.input.verificationText).toBe("");
    expect(draft.input.announcementMethod).toBe("");
    expect(draft.input.memo).not.toContain("読み取れ");
    expect(draft.flags.conditions).toContain("読み取れませんでした"); // 説明は「要確認」の詳細側
  });
});

describe("購入・受取の期間（開始と終了）", () => {
  const input = (over: Partial<LotteryInput>): LotteryInput => ({
    chain: { id: null, name: "A" },
    store: { id: null, name: "B", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "商品" }, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_only", date: "2026-11-10", time: "" },
    resultDate: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "app",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "person",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });
  const flex = (date: string, time = "") => ({ precision: time ? ("date_time" as const) : ("date_only" as const), date, time });

  it("開始が終了より後ろなら保存できない。同日・開始のみ・終了のみは可。開始が無い既存データも可", () => {
    expect(lotteryInputSchema.safeParse(input({ procedureStart: flex("2026-11-20"), procedureDeadline: flex("2026-11-14") })).error?.issues[0].message).toContain("購入・受取の開始が終了より後");
    expect(lotteryInputSchema.safeParse(input({ procedureStart: flex("2026-11-14"), procedureDeadline: flex("2026-11-14") })).success).toBe(true);
    expect(lotteryInputSchema.safeParse(input({ procedureStart: flex("2026-11-14", "10:00"), procedureDeadline: flex("2026-11-14", "09:00") })).success).toBe(false);
    expect(lotteryInputSchema.safeParse(input({ procedureStart: flex("2026-11-14") })).success).toBe(true);
    expect(lotteryInputSchema.safeParse(input({ procedureDeadline: flex("2026-11-20") })).success).toBe(true); // 従来の入力（終了のみ）
    const parsed = lotteryInputSchema.parse(input({}));
    expect(parsed.procedureStart.precision).toBe("unknown"); // 省略時は不明（時刻を補わない）
  });

  it("AI解析: 購入期間の開始・終了を読み取り、日付のみに時刻を補わず、前後関係の矛盾は要確認", () => {
    const ok = validateExtraction(normalizeExtraction({ ...base, procedure_start: d(11, 14), procedure_deadline: d(11, 20) }, NOW), null);
    expect(ok.procedureStart).toMatchObject({ date: "2026-11-14", precision: "date_only", time: "" });
    expect(ok.procedureDeadline).toMatchObject({ date: "2026-11-20", precision: "date_only", time: "" });
    expect(ok.issues).toEqual([]);
    const bad = validateExtraction(normalizeExtraction({ ...base, procedure_start: d(11, 25), procedure_deadline: d(11, 20) }, NOW), null);
    expect(bad.issues.some((i) => i.field === "procedureStart" && i.message.includes("終了より後"))).toBe(true);
    // 年末の期間は年またぎで補う（開始12/28 → 終了1/5 は翌年）
    const wrap = normalizeExtraction({ ...base, procedure_start: d(12, 28), procedure_deadline: d(1, 5) }, NOW);
    expect(wrap.procedureStart.date).toBe("2026-12-28");
    expect(wrap.procedureDeadline.date).toBe("2027-01-05");
  });

  it("フォーム下書きに反映され、フィードバックでは新しい項目として比較される", () => {
    const ex = validateExtraction(normalizeExtraction({ ...base, apply_deadline: d(11, 10, 23, 59), procedure_start: d(11, 14), procedure_deadline: d(11, 20) }, NOW), null);
    const draft = buildDraft(ex, createMockData(NOW));
    expect(draft.input.procedureStart).toEqual({ precision: "date_only", date: "2026-11-14", time: "" });
    const filled = draft.input;
    const final = { ...filled, procedureStart: { precision: "date_only" as const, date: "2026-11-15", time: "" } };
    const r = compareFeedback(aiSnapshot(ex), inputSnapshot(filled), inputSnapshot(final as never), null);
    expect(r.fields.procedureStart?.status).toBe("modified");
    expect(r.fields.procedureDeadline?.status).toBe("adopted");
    // 購入期間が無かった頃の抽出結果でも比較できる
    const old = JSON.parse(JSON.stringify(ex));
    delete old.procedureStart;
    expect(() => aiSnapshot(old)).not.toThrow();
  });
});

describe("AI結果の項目別一覧", () => {
  it("日付は短く（今年は年なし・日付のみは時刻なし）、未抽出は null（画面では「—」）、購入期間は1行", () => {
    expect(formatDraftDate({ precision: "date_time", date: "2026-10-28", time: "23:59" }, 2026)).toBe("10/28 23:59");
    expect(formatDraftDate({ precision: "date_only", date: "2026-11-14", time: "" }, 2026)).toBe("11/14");
    expect(formatDraftDate({ precision: "date_only", date: "2027-01-10", time: "" }, 2026)).toBe("2027/1/10");
    expect(formatDraftDate({ precision: "unknown", date: "", time: "" })).toBeNull();
    const ex = validateExtraction(normalizeExtraction({ ...base, apply_deadline: d(10, 28, 23, 59), procedure_start: d(11, 14), procedure_deadline: d(11, 20) }, NOW), null);
    const rows = buildResultRows(buildDraft(ex, createMockData(NOW)), { applyUrl: "", purchaseLimitText: "" });
    const get = (id: string) => rows.find((r) => r.id === id);
    expect(get("applyDeadline")?.value).toBe("10/28 23:59");
    expect(get("procedure")?.value).toBe("11/14〜11/20");
    expect(get("applyMethod")?.value).toBeNull();
    expect(get("applyStart")?.value).toBeNull();
    for (const id of ["chain", "store", "item0", "qty0", "applyStart", "applyDeadline", "resultDate", "procedure", "applyMethod", "receiveMethod", "announce", "applyUrl", "announceUrl", "conditions", "limit"]) expect(get(id)).toBeDefined();
    expect(flagKind("マスターに無い系列です。保存すると仮登録されます")).toBe("仮登録");
    expect(flagKind("系列名が読み取れませんでした")).toBe("要確認");
  });
});

describe("プロフィール別の設定と下部メニュー", () => {
  it("保存値の検証: 未知のキー・不正な値は捨てる", () => {
    expect(normalizeProfileSettings({ nav: ["lotteries", 3, "finance"], cardView: "simple", theme: "dark", evil: 1 })).toEqual({ nav: ["lotteries", "finance"], cardView: "simple", theme: "dark" });
    expect(normalizeProfileSettings({ cardView: "huge", theme: "pink", nav: "x" })).toEqual({});
    expect(normalizeProfileSettings(null)).toEqual({});
    expect(normalizeProfileSettings({ cardDisplay: { deadline: false, evil: true } }).cardDisplay?.deadline).toBe(false);
    expect(SETTING_KEYS).toEqual(COPY_ITEMS.map((c) => c.key));
  });

  it("既定: 4項目を直接表示し、コレクションは「その他」から開ける。未実装の機能（available:false）は候補に出ない", () => {
    const r = resolveNav(undefined);
    expect(r.direct.map((n) => n.id)).toEqual(DEFAULT_NAV);
    expect(r.more.map((n) => n.id)).toEqual(["collection"]);
    expect(availableNav().some((n) => n.id === "collection")).toBe(true);
    expect(resolveNav(["collection", "lotteries"]).direct.map((n) => n.id)).toEqual(["collection", "lotteries"]); // コレクションも直接表示にできる
    NAV_ITEMS.push({ id: "future", href: "/future", label: "未実装", available: false });
    try {
      expect(availableNav().some((n) => n.id === "future")).toBe(false);
      expect(resolveNav(["future", "lotteries"]).direct.map((n) => n.id)).toEqual(["lotteries"]); // 未実装の項目は無視
    } finally {
      NAV_ITEMS.pop();
    }
  });

  it("隠れた機能があれば「その他」が出る。重複・存在しないIDは除き、全部外しても最低1つは出る。設定への入口（歯車）とは独立", () => {
    const r = resolveNav(["finance", "lotteries", "lotteries", "nope"]);
    expect(r.direct.map((n) => n.id)).toEqual(["finance", "lotteries"]);
    expect(r.more.map((n) => n.id).sort()).toEqual(["battles", "collection", "purchases"]);
    expect(resolveNav([]).direct).toHaveLength(1);
    expect(resolveNav(["nope"]).direct).toHaveLength(1);
    // 枠の上限: 「その他」を含めて最大5枠
    expect(resolveNav(DEFAULT_NAV).direct.length + (resolveNav(DEFAULT_NAV).more.length ? 1 : 0)).toBeLessThanOrEqual(MAX_NAV_SLOTS);
  });

  it("機能が増えても1行足すだけで対応できる（5枠を超える場合は直接表示4つ＋その他）", () => {
    const extra = Array.from({ length: 3 }, (_, i) => ({ id: `x${i}`, href: `/x${i}`, label: `機能${i}`, available: true }));
    NAV_ITEMS.push(...extra);
    try {
      const all = availableNav().map((n) => n.id);
      const r = resolveNav(all);
      expect(r.direct).toHaveLength(MAX_NAV_SLOTS - 1);
      expect(r.more.length).toBeGreaterThan(0);
      expect(r.direct.length + 1).toBe(MAX_NAV_SLOTS);
    } finally {
      NAV_ITEMS.splice(NAV_ITEMS.length - 3, 3);
    }
  });

  it("現在地の判定: /records は抽選管理、/settings はどのメニュー項目でもない", () => {
    const lot = NAV_ITEMS.find((n) => n.id === "lotteries")!;
    expect(isNavActive(lot, "/records")).toBe(true);
    expect(NAV_ITEMS.filter((n) => isNavActive(n, "/settings/display"))).toEqual([]);
  });
});
