import { describe, expect, it } from "vitest";
import { DEFAULT_CONDITIONS, evaluateCandidate, normalizeConditions } from "@/lib/collector/conditions";
import { classifyStage, hasLotteryWording, isTrackableStage } from "@/lib/collector/stage";
import { decideHold, trackingIntervalMs, TRACKING_STALE_DAYS } from "@/lib/collector/triage";
import { diffTracking, inheritTracking, matchTracked, type TrackedLite } from "@/lib/collector/tracking";
import { conditionDiff, conditionDiffText } from "@/lib/collector/condition-diff";
import { chainKey, findDuplicates, isOnlineLikeName, urlIdentity } from "@/lib/lottery-match";
import { judge, type CandidateLite } from "@/lib/collector/reevaluate";
import { isReady } from "@/lib/collector/ready";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import type { AppData, Chain, Lottery, Store } from "@/types/domain";

const NOW = new Date("2026-11-05T05:00:00Z"); // 14:00 JST
const flex = (date: string | null, time = "") => (date ? { precision: date && time ? ("date_time" as const) : ("date_only" as const), date, time } : { precision: "unknown" as const, date: "", time: "" });

function input(o: Partial<LotteryInput> = {}): LotteryInput {
  return {
    multiMode: "single",
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
    applyMethod: "web",
    requirementTags: [],
    sourceUrls: [],
    conditionsText: "",
    memo: "",
    chain: { id: "c1", name: "テスト玩具" },
    store: { id: null, name: "", prefecture: "" },
    items: [{ product: { id: "p1", name: "30th CELEBRATION" }, quantity: 1, unit: "box" }],
    receiveMethod: "shipping",
    ...o,
  } as LotteryInput;
}

describe("Stage 6C: 設定『受付前の抽選予告も追跡する』（既存設定の意味は変えない）", () => {
  const cond = (o = {}) => ({ ...DEFAULT_CONDITIONS, prefectures: ["東京都"], ...o });
  const ctx = { prefecture: "東京都", storeKind: "online_only" as const, distanceKm: null, now: NOW };
  const future = { applyStart: flex("2026-11-08", "10:00"), applyDeadline: flex("2026-11-12", "23:59") };
  it("既定は追跡ON。現在応募可能のみ＋追跡ON: 受付前は破棄せず upcoming（応募可能としては扱わない）", () => {
    expect(normalizeConditions({}).trackUpcoming).toBe(true);
    expect(evaluateCandidate(input(future), cond(), ctx).verdict).toBe("upcoming");
  });
  it("追跡OFF＋現在応募可能のみ: 従来どおり除外／受付前も含む: 通常の登録対象（match）", () => {
    expect(evaluateCandidate(input(future), cond({ trackUpcoming: false }), ctx).verdict).toBe("exclude");
    expect(evaluateCandidate(input(future), cond({ statusMode: "open_or_before" }), ctx).verdict).toBe("match");
  });
  it("他の理由で対象外のもの（締切超過・地域外）は、受付前でも追跡しない", () => {
    expect(evaluateCandidate(input({ applyStart: flex("2026-11-01", "10:00"), applyDeadline: flex("2026-11-03", "23:59") }), cond(), ctx).verdict).toBe("exclude");
    expect(evaluateCandidate(input({ ...future, receiveMethod: "store" }), cond(), { ...ctx, storeKind: "physical", prefecture: "愛知県" }).verdict).toBe("exclude");
  });
});

describe("Stage 6C: 受付状況の分類と、予告の文言の検査", () => {
  it("受付中／受付前（詳細確定）／予告（詳細未発表）／一部判明／受付終了", () => {
    expect(classifyStage({ applyStart: flex("2026-11-01"), applyDeadline: flex("2026-11-10") }, "2026-11-05")).toBe("open");
    expect(classifyStage({ applyStart: flex("2026-11-08"), applyDeadline: flex("2026-11-10") }, "2026-11-05")).toBe("upcoming");
    expect(classifyStage({ applyStart: flex(null), applyDeadline: flex(null) }, "2026-11-05")).toBe("teaser");
    expect(classifyStage({ applyStart: flex("2026-11-08"), applyDeadline: flex(null) }, "2026-11-05")).toBe("partial");
    expect(classifyStage({ applyDeadline: flex("2026-11-03") }, "2026-11-05")).toBe("closed");
    expect([("teaser" as const), "partial", "upcoming", "open", "closed"].filter((s) => isTrackableStage(s as never))).toEqual(["teaser", "partial", "upcoming"]);
  });
  it("抽選・応募・当選・エントリーの文言があれば抽選予告。新商品の発売予定だけの告知は抽選予告にしない", () => {
    expect(hasLotteryWording(["○○店で30th CELEBRATIONの抽選を近日実施予定"])).toBe(true);
    expect(hasLotteryWording(["11月8日から抽選受付開始。応募方法は公式アプリ"])).toBe(true);
    expect(hasLotteryWording(["拡張パック「ハドウシーカー」は11月22日発売予定です。予約受付中"])).toBe(false);
    expect(hasLotteryWording([undefined, "", null])).toBe(false);
  });
});

describe("Stage 6C: 追跡中の保留判定（回数・締切の近さだけで要手動確認へ移さない）", () => {
  const base = { now: NOW, dueAt: null, gaps: ["応募締切が不明です"], holdCount: 20, failKind: null, altTried: false, important: false };
  it("追跡中は保留回数が上限を超えても、締切が近くても、保留（自動再調査）のまま", () => {
    const hd = decideHold({ ...base, tracking: { startDate: "2026-11-08", lastNewsAt: "2026-11-05T00:00:00Z" } });
    expect(hd.triage).toBe("auto_retry");
    expect(decideHold({ ...base, dueAt: new Date("2026-11-05T20:00:00Z"), tracking: { startDate: null, lastNewsAt: "2026-11-05T00:00:00Z" } }).triage).toBe("auto_retry");
    // 追跡していなければ従来どおり（回数上限で要手動確認）
    expect(decideHold({ ...base }).triage).toBe("manual");
  });
  it("受付開始が近いほど短い間隔で再確認する（優先度を上げる）", () => {
    const h = 3600_000;
    expect(trackingIntervalMs(null, NOW)).toBe(12 * h);
    expect(trackingIntervalMs("2026-11-20", NOW)).toBe(12 * h);
    expect(trackingIntervalMs("2026-11-09", NOW)).toBe(6 * h);
    expect(trackingIntervalMs("2026-11-06", NOW)).toBe(2 * h);
    expect(trackingIntervalMs("2026-11-05", NOW)).toBe(0.5 * h);
  });
  it("続報が長期間ないときだけ追跡を終了する。商品マスター未登録・矛盾は追跡中でも利用者の判断", () => {
    expect(decideHold({ ...base, tracking: { startDate: null, lastNewsAt: new Date(NOW.getTime() - (TRACKING_STALE_DAYS + 1) * 86400_000).toISOString() } }).triage).toBe("auto_exclude");
    expect(decideHold({ ...base, gaps: ["商品マスターに未登録の商品です（商品確認待ち）: 「X」"], tracking: { startDate: null, lastNewsAt: NOW.toISOString() } }).triage).toBe("manual");
    expect(decideHold({ ...base, gaps: ["情報に矛盾の疑いがあります: 応募期間"], tracking: { startDate: null, lastNewsAt: NOW.toISOString() } }).triage).toBe("manual");
  });
});

describe("Stage 6C: 続報の照合と更新履歴", () => {
  const teaser = input({ chain: { id: "c1", name: "テスト玩具" }, store: { id: null, name: "", prefecture: "" }, applyStart: flex(null), applyDeadline: flex(null) });
  const tr = (id: string, i: LotteryInput): TrackedLite => ({ id, input: i, tracking: inheritTracking(null, "2026-11-05T00:00:00Z", "https://x.com/a/status/100", null, []), created_at: "2026-11-05T00:00:00Z" });
  const followUp = input({ chain: { id: "c1", name: "テスト玩具" }, store: { id: null, name: "本店", prefecture: "" }, applyStart: flex("2026-11-08", "10:00"), applyDeadline: flex("2026-11-12", "23:59"), memo: "応募URL: https://shop.example.invalid/apply", conditionsText: "会員登録が必要" });

  it("同じ系列・商品の予告を一意に見つけて続報とする（店舗が予告で未発表でも可）", () => {
    const m = matchTracked([tr("t1", teaser)], followUp, "self");
    expect(m.match?.id).toBe("t1");
  });
  it("系列の表記が違っても（駿河屋／駿河屋通販）同じ系列。別の系列・別の商品・別の店舗は統合しない", () => {
    expect(chainKey("駿河屋通販")).toBe(chainKey("駿河屋"));
    const other = (o: Partial<LotteryInput>) => matchTracked([tr("t1", teaser)], { ...followUp, ...o } as LotteryInput, "self").match;
    expect(other({ chain: { id: "c2", name: "別の系列" } })).toBeNull();
    expect(other({ items: [{ product: { id: "p9", name: "ハドウシーカー" }, quantity: 1, unit: "box" }] })).toBeNull();
    const withStore = tr("t2", input({ store: { id: null, name: "梅田店", prefecture: "" } }));
    expect(matchTracked([withStore], followUp, "self").match).toBeNull(); // 店舗が双方分かっていて違う
  });
  it("複数の予告に一致して決められないときは統合せず、関連候補として返す（無理に統合しない）", () => {
    const m = matchTracked([tr("t1", teaser), tr("t2", teaser)], followUp, "self");
    expect(m.match).toBeNull();
    expect(m.ambiguous.sort()).toEqual(["t1", "t2"]);
  });
  it("自分自身は照合しない", () => {
    expect(matchTracked([tr("self", teaser)], followUp, "self").match).toBeNull();
  });
  it("予告→詳細: 受付開始・締切・応募URL・条件・店舗が分かったことを、情報源と日時つきで履歴に残す", () => {
    const e = diffTracking(teaser, followUp, "2026-11-07T00:00:00Z", "https://x.com/a/status/200");
    expect(e.map((x) => x.kind).sort()).toEqual(["apply_url_known", "conditions_known", "deadline_known", "start_known", "store_added"]);
    expect(e.every((x) => x.source === "https://x.com/a/status/200" && x.at === "2026-11-07T00:00:00Z")).toBe(true);
    const t = inheritTracking(tr("t1", teaser).tracking, "2026-11-07T00:00:00Z", "https://x.com/a/status/200", "2026-11-08", e);
    expect(t.since).toBe("2026-11-05T00:00:00Z"); // 追跡の開始は最初の発見
    expect(t.lastNewsAt).toBe("2026-11-07T00:00:00Z");
    expect(t.sources.map((s) => s.url)).toEqual(["https://x.com/a/status/100", "https://x.com/a/status/200"]);
    expect(t.startDate).toBe("2026-11-08");
  });
  it("日時の変更・対象商品の変更も履歴に残す。前回に無い情報は推測で補わない", () => {
    const e = diffTracking(followUp, { ...followUp, applyStart: flex("2026-11-09", "10:00"), items: [{ product: { id: "p2", name: "別商品" }, quantity: 1, unit: "box" }] }, "t", "s");
    expect(e.map((x) => x.kind).sort()).toEqual(["product_changed", "start_changed"]);
    expect(diffTracking(null, followUp, "t", "s")).toEqual([]);
  });
});

describe("Stage 6C: 重複判定（オンライン・系列表記・同じ告知）", () => {
  const chains = [{ id: "c1", name: "駿河屋" }, { id: "c2", name: "駿河屋通販" }, { id: "c3", name: "ポケモンセンター" }] as unknown as Chain[];
  const stores = [
    { id: "s1", chainId: "c1", name: "オンライン", salesKind: "physical" },
    { id: "s2", chainId: "c2", name: "オンライン", salesKind: "physical" },
    { id: "s3", chainId: "c3", name: "オンライン", salesKind: "online_only" },
    { id: "s4", chainId: "c1", name: "秋葉原店", salesKind: "physical" },
  ] as unknown as Store[];
  const lot = (id: string, chainId: string, storeId: string, o: Partial<Lottery> = {}): Lottery =>
    ({ id, chainId, storeId, items: [{ productId: "p1" }], sourceUrls: [], applyDeadline: { precision: "date_only", date: "2026-11-22" }, ...o }) as unknown as Lottery;
  const master = { chains, stores };
  const cand = (o: Partial<LotteryInput> = {}) => input({ chain: { id: "c1", name: "駿河屋" }, store: { id: "s1", name: "オンライン", prefecture: "" }, applyDeadline: flex("2026-11-22"), ...o });

  it("「オンライン」「通販」は店舗ではなく販売形態の語", () => {
    expect(isOnlineLikeName("オンライン")).toBe(true);
    expect(isOnlineLikeName("通販")).toBe(true);
    expect(isOnlineLikeName("秋葉原店")).toBe(false);
  });
  it("同じ系列・同じオンライン・同じ商品・同じ締切日は同一", () => {
    const d = findDuplicates(cand(), [lot("L1", "c1", "s1")], undefined, master);
    expect(d[0]).toMatchObject({ lotteryId: "L1", level: "high" });
  });
  it("系列の表記が違う（駿河屋／駿河屋通販）オンライン抽選も同一として検出する", () => {
    const d = findDuplicates(cand(), [lot("L2", "c2", "s2")], undefined, master);
    expect(d[0]).toMatchObject({ lotteryId: "L2", level: "high" });
  });
  it("店舗が未確定でも、店舗名が『オンライン』なら、オンラインの抽選とだけ照合する（実店舗の抽選とは同一にしない）", () => {
    const c = cand({ store: { id: null, name: "オンライン", prefecture: "" } });
    expect(findDuplicates(c, [lot("L1", "c1", "s1")], undefined, master)[0]?.lotteryId).toBe("L1");
    expect(findDuplicates(c, [lot("L4", "c1", "s4")], undefined, master)).toEqual([]);
  });
  it("商品と締切日だけが一致する別の系列（ポケモンセンター）・別の店舗は統合しない", () => {
    expect(findDuplicates(cand(), [lot("L3", "c3", "s3")], undefined, master)).toEqual([]);
    expect(findDuplicates(cand({ store: { id: "s4", name: "秋葉原店", prefecture: "" } }), [lot("L1", "c1", "s1")], undefined, master)).toEqual([]);
  });
  it("同じ告知（X投稿ID・Googleフォーム）は、投稿者名・URLの書き方が違っても同じ情報源。締切が違っても同一抽選の根拠にする", () => {
    expect(urlIdentity("https://x.com/pokecachan/status/2117905561622819299")).toBe(urlIdentity("https://twitter.com/other/status/2117905561622819299?s=20"));
    expect(urlIdentity("https://docs.google.com/forms/d/e/1FAIpQLSdAbCdEfGhIj/viewform?usp=sf_link")).toBe(urlIdentity("https://docs.google.com/forms/d/e/1FAIpQLSdAbCdEfGhIj/viewform"));
    const l = lot("L1", "c1", "s1", { sourceUrls: ["https://x.com/pokecachan/status/2117905561622819299"], applyDeadline: { precision: "date_only", date: "2026-11-30" } as never });
    const d = findDuplicates(cand({ sourceUrls: ["https://twitter.com/pokecayoyaku/status/2117905561622819299"] }), [l], undefined, master);
    expect(d[0]).toMatchObject({ level: "high", reason: "同じ情報源URLで登録済みです" });
  });
  it("締切がどちらか不明なら、同一かは断定せず要確認（medium）", () => {
    expect(findDuplicates(cand({ applyDeadline: flex(null) }), [lot("L1", "c1", "s1")], undefined, master)[0]?.level).toBe("medium");
  });
});

describe("Stage 6C: 確認待ちの再評価でも、追跡中の予告を除外・再解析しない", () => {
  const data = { chains: [{ id: "c1", name: "テスト玩具", aliases: [], archived: false }], stores: [], products: [{ id: "p1", officialName: "30th CELEBRATION", aliases: [], archived: false }], lotteries: [], homeLat: null, homeLng: null } as unknown as AppData;
  const mk = (stored: Record<string, unknown>): CandidateLite => ({ id: "c", status: "pending", job_state: "review", kind: "new", source_url: "https://x.com/a/status/1", dedupe_key: "x:1", x_post_id: "1", title: "t", reasons: [], due_at: null, lottery_id: null, draft: stored });
  const cond = { ...DEFAULT_CONDITIONS, prefectures: ["東京都"] };
  it("受付前（現在応募可能のみ）の候補は『対象外』として除外せず、追跡を続ける", () => {
    const s = { input: input({ applyStart: flex("2026-11-08", "10:00"), applyDeadline: flex("2026-11-12", "23:59") }), summary: { chain: "exact", store: "none", items: [{ name: "x", kind: "exact", matchedName: "x" }] }, tracking: { startDate: "2026-11-08" } };
    const j = judge(mk(s), data, cond, NOW, isReady);
    expect(j?.action).toBe("keep");
    expect(j?.cls).not.toBe("F");
  });
  it("詳細未発表の予告は、AI再解析（requeue）に回さず追跡を続ける", () => {
    const s = { input: input({ applyStart: flex(null), applyDeadline: flex(null) }), summary: { chain: "exact", store: "none", items: [{ name: "x", kind: "exact", matchedName: "x" }] }, tracking: { startDate: null } };
    expect(judge(mk(s), data, cond, NOW, isReady)?.action).toBe("keep");
  });
});

describe("Stage 6C: 応募条件の違い（系列の手動条件は書き換えない）", () => {
  it("告知にあり系列の登録条件にないもの／登録条件にあるが告知で確認できないものを分けて示す", () => {
    const d = conditionDiff(["member_registration", "newsletter"] as never, ["member_card", "purchase"]);
    expect(d).not.toBeNull();
    expect(d!.onlyRegistered.length).toBeGreaterThan(0);
    expect(conditionDiffText(d!)).toContain("系列の登録条件");
  });
  it("違いが無ければ表示しない", () => {
    expect(conditionDiff([], [])).toBeNull();
  });
});
