import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import { isXCandidate, judge, rematch, type CandidateLite, type StoredDraft } from "@/lib/collector/reevaluate";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { isReady } from "@/lib/collector/ready";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-11-04T03:00:00Z"); // 2026-11-04 12:00 JST
const data = (): AppData => createMockData(NOW);

const input = (over: Partial<LotteryInput> = {}): LotteryInput =>
  ({
    chain: { id: null, name: "サンプル電機" },
    store: { id: null, name: "三宮店", prefecture: "兵庫県" },
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "ダミー強化拡張パック「つきあかり」" }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" },
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
    requirementTags: [],
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: ["https://example.invalid/chusen/1"],
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    ...over,
  }) as unknown as LotteryInput;

const stored = (inp: LotteryInput, over: Partial<StoredDraft> = {}): StoredDraft => ({
  input: inp,
  summary: { chain: "none", store: "none", items: inp.items.map((i) => ({ name: i.product.name, kind: "none" as const, matchedName: null })) },
  warnings: [],
  ...over,
});
const cand = (draft: StoredDraft, over: Partial<CandidateLite> = {}): CandidateLite => ({
  id: "c-1", status: "pending", job_state: "review", kind: "new", source_url: "https://example.invalid/chusen/1", dedupe_key: "https://example.invalid/chusen/1", x_post_id: null, title: "t", reasons: ["x"], due_at: null, lottery_id: null, draft, ...over,
});

describe("rematch（新しい照合で確実に特定できたものだけ採用）", () => {
  it("未照合だった系列・店舗・商品が、現在のマスターで確実に一致すれば特定される", () => {
    const r = rematch(stored(input()), data());
    expect(r.improved).toBe(true);
    expect(r.input.chain.id).toBe("c1");
    expect(r.input.store.id).toBe("s1");
    expect(r.input.items[0].product.id).toBe("p3");
    expect(["exact", "alias", "code"]).toContain(r.summary.chain);
  });
  it("曖昧・不一致は採用せず、未特定のまま（候補だけ持つ）", () => {
    const r = rematch(stored(input({ chain: { id: null, name: "まったく存在しない系列XYZ" }, store: { id: null, name: "どこかの店", prefecture: "" } })), data());
    expect(r.input.chain.id).toBeNull();
    expect(r.input.store.id).toBeNull();
    expect(r.improved).toBe(true); // 商品だけは特定できた
    expect(r.input.items[0].product.id).toBe("p3");
  });
  it("元の入力は変更しない（コピーで再照合する）", () => {
    const s = stored(input());
    rematch(s, data());
    expect(s.input.chain.id).toBeNull();
  });
});

describe("judge（再評価の分類）", () => {
  const cond = DEFAULT_CONDITIONS;
  const run = (c: CandidateLite, d = data()) => judge(c, d, cond, NOW, isReady);

  it("A/B: 情報が十分で、新しい照合で特定でき、重複なし → 登録（照合が改善した分はB＝AI再解析なし）", () => {
    const j = run(cand(stored(input())))!;
    expect(j.action).toBe("register");
    expect(j.cls).toBe("B");
    expect(j.reasons[0]).toContain("AI再解析なし");
  });
  it("解析時に既に特定済みで条件を満たす候補はA", () => {
    const d = data();
    const inp = input({ chain: { id: "c1", name: "サンプル電機" }, store: { id: "s1", name: "三宮店", prefecture: "" }, items: [{ product: { id: "p3", name: "ダミー強化拡張パック「つきあかり」" }, quantity: 1, unit: "box" } as never] });
    const s = stored(inp, { summary: { chain: "exact", store: "exact", items: [{ name: "x", kind: "exact", matchedName: "x" }] } });
    expect(run(cand(s), d)!.cls).toBe("A");
  });
  it("E: 受付終了（締切を過ぎている）→ 除外（理由つき。物理削除ではない）", () => {
    const j = run(cand(stored(input({ applyDeadline: { precision: "date_only", date: "2026-10-30", time: "" } }))))!;
    expect(j.cls).toBe("E");
    expect(j.action).toBe("exclude");
    expect(j.reasons[0]).toContain("受付終了");
  });
  it("締切日当日（日付のみ）はまだ受付終了ではない", () => {
    const j = run(cand(stored(input({ applyDeadline: { precision: "date_only", date: "2026-11-04", time: "" } }))))!;
    expect(j.deadline).toBe("open");
    expect(j.cls).not.toBe("E");
  });
  it("F: 既存の抽選と同じ店舗・商品・締切 → 重複（既存の抽選へ紐付けるだけで、既存の抽選は変更しない）", () => {
    const d = data();
    const lot = d.lotteries[0];
    const before = JSON.stringify(lot);
    const inp = input({
      chain: { id: lot.chainId, name: "x" }, store: { id: lot.storeId, name: "x", prefecture: "" },
      items: [{ product: { id: lot.items[0].productId, name: "x" }, quantity: 1, unit: "box" } as never],
      applyDeadline: { precision: "date_only", date: lot.applyDeadline.precision === "date_only" ? lot.applyDeadline.date : lot.applyDeadline.precision === "date_time" ? new Date(lot.applyDeadline.at).toISOString().slice(0, 10) : "2026-11-20", time: "" },
      sourceUrls: ["https://example.invalid/other-source"],
    });
    const s = stored(inp, { summary: { chain: "exact", store: "exact", items: [{ name: "x", kind: "exact", matchedName: "x" }] } });
    // 同じ締切日になるよう、既存抽選の締切日付そのものを使う（締切が既に過ぎていても、重複の判定は受付終了より先）
    const j = judge(cand(s, { source_url: "https://example.invalid/other-source" }), d, DEFAULT_CONDITIONS, NOW, isReady)!;
    expect(j.cls).toBe("F");
    expect(j.action).toBe("duplicate");
    expect(j.duplicateOf?.lotteryId).toBe(lot.id);
    expect(JSON.stringify(lot)).toBe(before);
  });
  it("F: 収集条件の対象外 → 除外（理由に収集条件を記録）", () => {
    const d = data();
    // 店頭受取のみ・対象外の都道府県の店舗に既に紐づく候補
    d.stores = d.stores.map((s) => (s.id === "s4" ? { ...s, prefecture: "北海道" } : s));
    const inp = input({ chain: { id: "c3", name: "テスト玩具" }, store: { id: "s4", name: "本店", prefecture: "" }, items: [{ product: { id: "p1", name: "x" }, quantity: 1, unit: "box" } as never], applyDeadline: { precision: "date_only", date: "2026-11-25", time: "" } });
    const s = stored(inp, { summary: { chain: "exact", store: "exact", items: [{ name: "x", kind: "exact", matchedName: "x" }] } });
    const j = judge(cand(s), d, DEFAULT_CONDITIONS, NOW, isReady)!;
    expect(j.cls).toBe("F");
    expect(j.action).toBe("exclude");
    expect(j.reasons[0]).toContain("収集条件");
  });
  it("締切が不明で、X投稿が情報源 → C（画像などの追加取得）。Web → D（取得元の再確認）", () => {
    const unknown = input({ applyDeadline: EMPTY_FLEX });
    const x = run(cand(stored(unknown), { source_url: "https://x.com/abc/status/123456789", dedupe_key: "x:123456789" }))!;
    expect(x.cls).toBe("C");
    expect(x.action).toBe("requeue");
    const web = run(cand(stored(unknown)))!;
    expect(web.cls).toBe("D");
    expect(web.action).toBe("requeue");
  });
  it("照合の失敗だけ（締切は明確）ならAI再解析はしない（B・keep）", () => {
    const j = run(cand(stored(input({ chain: { id: null, name: "まったく存在しない系列XYZ" }, store: { id: null, name: "", prefecture: "" } }), { warnings: [] })))!;
    expect(j.action).not.toBe("requeue");
  });
  it("解析時の注意（矛盾など）が残る候補は自動登録しない", () => {
    const j = run(cand(stored(input(), { warnings: ["結果発表日が本文と受付欄で異なります"] })))!;
    expect(j.action).not.toBe("register");
  });
  it("更新の提案・解析結果のない候補は対象外（null）", () => {
    expect(run(cand(stored(input(), { update: { changes: [] } })))).toBeNull();
    expect(run(cand(stored(input()), { kind: "update" }))).toBeNull();
    expect(run(cand(null as never))).toBeNull();
  });
  it("処理の優先順位: 締切が近い受付中 < マスター照合 < X画像 < その他の受付中 < 受付終了 < 対象外・重複", () => {
    const soon = run(cand(stored(input({ applyDeadline: { precision: "date_only", date: "2026-11-05", time: "" } }))))!;
    const later = run(cand(stored(input())))!;
    const past = run(cand(stored(input({ applyDeadline: { precision: "date_only", date: "2026-10-01", time: "" } }))))!;
    expect(soon.priority).toBeLessThanOrEqual(later.priority);
    expect(past.priority).toBeGreaterThan(later.priority);
  });
});

describe("isXCandidate", () => {
  it("X投稿ID・x:キー・x.comの投稿URLのいずれかで判定する", () => {
    expect(isXCandidate({ dedupe_key: "x:1", source_url: null, x_post_id: null })).toBe(true);
    expect(isXCandidate({ dedupe_key: "k", source_url: "https://x.com/u/status/9", x_post_id: null })).toBe(true);
    expect(isXCandidate({ dedupe_key: "k", source_url: "https://example.com/a", x_post_id: null })).toBe(false);
  });
});
