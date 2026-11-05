import { describe, expect, it } from "vitest";
import { assessCompleteness, missingSummary, priorityOf, type Summary } from "@/lib/collector/completeness";
import { classifySource, conflictLabels, mergeSides, provenanceFor, type FieldSource, type Side } from "@/lib/collector/fields";
import { isSupplement, matchOpen, matchSupplement, type OpenLite } from "@/lib/collector/supplement";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";

const NOW = new Date("2026-11-05T05:00:00Z"); // 14:00 JST
const flex = (date: string | null, time = "") => (date ? { precision: time ? ("date_time" as const) : ("date_only" as const), date, time } : EMPTY_FLEX);

function input(o: Partial<LotteryInput> = {}): LotteryInput {
  return {
    chain: { id: null, name: "" },
    store: { id: null, name: "", prefecture: "" },
    items: [{ product: { id: null, name: "" }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "unknown",
    applyMethod: "unknown",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementMethods: [],
    requirementTags: [],
    sourceUrls: [],
    memo: "",
    ...o,
  } as unknown as LotteryInput;
}
const prod = (name: string, id: string | null = null) => ({ items: [{ product: { id, name }, quantity: 1, unit: "box" as const }] });
const sum = (chain: Summary["chain"], store: Summary["store"], items: Summary["items"] = []): Summary => ({ chain, store, items });
const src = (kind: FieldSource["kind"], url: string, origin: string, at = "2026-11-05T01:00:00Z", account = ""): FieldSource => ({ kind, url, origin, at, account });
const side = (i: LotteryInput, s: Summary, source: FieldSource): Side => ({ input: i, summary: s, fields: provenanceFor(i, source), source });

describe("Stage 6D: 項目単位の統合（複数情報源の補完）", () => {
  const list = side(input({ chain: { id: "c1", name: "ふるいち" }, store: { id: "s1", name: "三宮店", prefecture: "兵庫県" }, ...prod("30th CELEBRATION", "p1"), applyDeadline: flex("2026-11-10", "23:59") }), sum("exact", "exact", [{ name: "30th", kind: "exact", matchedName: "30th" }]), src("list_site", "https://pokeso.jp/a", "list:a", "2026-11-05T01:00:00Z", "pokeso.jp"));
  const xOfficial = side(input({ chain: { id: "c1", name: "ふるいち" }, store: { id: "s1", name: "三宮店", prefecture: "" }, ...prod("30th CELEBRATION", "p1"), applyMethod: "web", resultDate: flex("2026-11-12"), conditionsText: "会員登録が必要", memo: "応募URL: https://furuichi.example.invalid/apply" }), sum("exact", "exact", [{ name: "30th", kind: "exact", matchedName: "30th" }]), src("official_x", "https://x.com/furuichi_official/status/900", "x:900", "2026-11-05T02:00:00Z", "furuichi_official"));

  it("まとめサイトに無い応募方法・応募URL・当落発表・条件を、公式Xから項目単位で補う。まとめサイトの値は上書きしない", () => {
    const m = mergeSides(list, xOfficial);
    expect(m.filled.sort()).toEqual(["applyMethod", "applyUrl", "conditions", "resultDate"].sort());
    expect(m.input.applyDeadline.date).toBe("2026-11-10"); // 既にある項目は維持
    expect(m.input.applyMethod).toBe("web");
    expect(m.input.memo).toContain("応募URL: https://furuichi.example.invalid/apply");
    expect(m.fields.applyMethod?.source.url).toBe("https://x.com/furuichi_official/status/900"); // 項目ごとの出典
    expect(m.fields.applyMethod?.state).toBe("confirmed"); // 公式Xは確定
    expect(m.fields.applyDeadline?.state).toBe("unverified"); // まとめサイト単独は未確認
    expect(m.conflicts).toEqual([]);
  });
  it("同じ値を別の出どころが裏付けると確定になる。コピー元が同じ（同じ元の投稿）なら独立した裏付けにしない", () => {
    const a = side(input({ chain: { id: "c1", name: "ふるいち" }, applyDeadline: flex("2026-11-10", "23:59") }), sum("exact", "none"), src("aggregator_x", "https://x.com/a/status/1", "x:100", "2026-11-05T01:00:00Z", "a"));
    const bIndependent = side(input({ chain: { id: "c1", name: "ふるいち" }, applyDeadline: flex("2026-11-10", "23:59") }), sum("exact", "none"), src("aggregator_x", "https://x.com/b/status/2", "x:200", "2026-11-05T01:30:00Z", "b"));
    const bCopy = side(input({ chain: { id: "c1", name: "ふるいち" }, applyDeadline: flex("2026-11-10", "23:59") }), sum("exact", "none"), src("aggregator_x", "https://x.com/b/status/3", "x:100", "2026-11-05T01:30:00Z", "b")); // 同じ元の投稿を引用
    expect(mergeSides(a, bIndependent).fields.applyDeadline?.state).toBe("confirmed");
    expect(mergeSides(a, bCopy).fields.applyDeadline?.state).toBe("unverified");
  });
  it("食い違う項目は、どちらにも決めず矛盾として記録する（優先順位の高い値を仮に残す）。矛盾した項目名が分かる", () => {
    const other = side(input({ chain: { id: "c1", name: "ふるいち" }, store: { id: "s1", name: "三宮店", prefecture: "" }, ...prod("30th CELEBRATION", "p1"), applyDeadline: flex("2026-11-11", "23:59") }), sum("exact", "exact", [{ name: "x", kind: "exact", matchedName: "x" }]), src("official_x", "https://x.com/furuichi_official/status/901", "x:901", "2026-11-05T03:00:00Z", "furuichi_official"));
    const m = mergeSides(list, other);
    expect(m.conflicts.map((c) => c.field)).toEqual(["applyDeadline"]);
    expect(m.input.applyDeadline.date).toBe("2026-11-11"); // 公式Xの値を仮に採用
    expect(m.fields.applyDeadline?.state).toBe("conflict");
    expect(m.fields.applyDeadline?.alt?.value).toContain("2026-11-10");
    expect(conflictLabels(m.fields)).toEqual(["応募締切"]);
  });
  it("同じ情報源（同じアカウント）の新しい情報は、矛盾ではなく更新として扱う", () => {
    const older = side(input({ chain: { id: "c1", name: "ふるいち" }, applyDeadline: flex("2026-11-10", "23:59") }), sum("exact", "none"), src("official_x", "https://x.com/f/status/1", "x:1", "2026-11-05T01:00:00Z", "f"));
    const newer = side(input({ chain: { id: "c1", name: "ふるいち" }, applyDeadline: flex("2026-11-12", "23:59") }), sum("exact", "none"), src("official_x", "https://x.com/f/status/2", "x:2", "2026-11-06T01:00:00Z", "f"));
    const m = mergeSides(older, newer);
    expect(m.updated).toEqual(["applyDeadline"]);
    expect(m.conflicts).toEqual([]);
    expect(m.input.applyDeadline.date).toBe("2026-11-12");
  });
  it("手動で確定した項目は自動で上書きしない", () => {
    const manual: Side = { ...list, fields: { ...list.fields, applyDeadline: { ...list.fields.applyDeadline!, manual: true } } };
    const other = side(input({ chain: { id: "c1", name: "ふるいち" }, applyDeadline: flex("2026-11-12", "23:59") }), sum("exact", "none"), src("official_site", "https://shop.example.invalid/x", "u:x", "2026-11-06T00:00:00Z", "shop.example.invalid"));
    const m = mergeSides(manual, other);
    expect(m.input.applyDeadline.date).toBe("2026-11-10");
    expect(m.conflicts).toEqual([]);
  });
  it("情報源の分類: 登録した公式Xは公式X、収集元のまとめアカウントはXまとめ、まとめサイトは最下位、それ以外の外部ページは公式", () => {
    const ctx = { officialAccounts: new Set(["furuichi_ofcl"]), aggregatorAccounts: new Set(["pokecachan"]), listHosts: new Set(["pokeso.jp"]) };
    expect(classifySource("https://x.com/Furuichi_Ofcl/status/12345678", ctx).kind).toBe("official_x");
    expect(classifySource("https://x.com/pokecachan/status/12345678", ctx).kind).toBe("aggregator_x");
    expect(classifySource("https://pokeso.jp/chusen", ctx).kind).toBe("list_site");
    expect(classifySource("https://livepocket.jp/e/abc", ctx).kind).toBe("official_site");
  });
});

describe("Stage 6D: 情報充実度 A〜E（件数ではなく重みで判定）", () => {
  const today = "2026-11-05";
  const full = { chain: { id: "c1", name: "ふるいち" }, store: { id: "s1", name: "三宮店", prefecture: "兵庫県" }, ...prod("30th CELEBRATION", "p1"), applyDeadline: flex("2026-11-10", "23:59"), applyMethod: "web" as const, receiveMethod: "store" as const, resultDate: flex("2026-11-12") };
  const okSummary = sum("exact", "exact", [{ name: "x", kind: "exact", matchedName: "x" }]);
  const rank = (i: Partial<LotteryInput>, s: Summary = okSummary, ctx: { conflict?: string | null; modePending?: boolean } = {}) => assessCompleteness(input(i), s, { today, ...ctx });

  it("A: 重要項目がすべて揃い、マスター照合も解決している", () => {
    expect(rank(full).rank).toBe("A");
  });
  it("B: 重要項目は揃っているが、商品マスターの確認だけが未解決（例: ふるいち 三宮店 / 商品確認のみ）", () => {
    const a = rank({ ...full, ...prod("未登録の新商品") }, sum("exact", "exact", [{ name: "未登録の新商品", kind: "none", matchedName: null }]));
    expect(a.rank).toBe("B");
    expect(missingSummary(a)).toBe("商品マスターの確認のみ");
  });
  it("C: 系列・商品は分かるが、店舗・締切・応募先のどれかが不足", () => {
    expect(rank({ ...full, store: { id: null, name: "", prefecture: "" }, receiveMethod: "store" }, sum("exact", "none", [{ name: "x", kind: "exact", matchedName: "x" }])).rank).toBe("C");
    expect(rank({ ...full, applyDeadline: EMPTY_FLEX }).rank).toBe("C");
    expect(rank({ ...full, applyMethod: "unknown" }).rank).toBe("C");
  });
  it("D: 系列と商品だけが分かり、応募期間と応募先がどちらも未発表（抽選予告）", () => {
    const a = rank({ chain: { id: "c1", name: "ふるいち" }, ...prod("30th CELEBRATION", "p1") });
    expect(a.rank).toBe("D");
    expect(a.reasons[0]).toContain("未発表");
  });
  it("E: 系列・商品・応募先がほとんど得られていない", () => {
    expect(rank({}).rank).toBe("E");
    expect(rank({ applyMethod: "web" }).rank).toBe("E");
    expect(rank({ ...prod("30th CELEBRATION") }).rank).toBe("E"); // 商品名だけ（系列も応募先も不明）
  });
  it("情報が揃っていて矛盾がある場合は、ランクを下げず『矛盾あり』を別に示す", () => {
    const a = rank(full, okSummary, { conflict: "応募締切が情報源間で食い違います" });
    expect(a.rank).toBe("A");
    expect(a.conflict).toContain("食い違い");
  });
  it("複数商品の応募方式が未確定なら、A/B にはしない", () => {
    expect(rank(full, okSummary, { modePending: true }).rank).toBe("C");
  });
  it("オンライン販売は店舗名が無くても店舗の識別を満たす", () => {
    expect(rank({ ...full, store: { id: null, name: "", prefecture: "" }, receiveMethod: "shipping" }, sum("exact", "none", [{ name: "x", kind: "exact", matchedName: "x" }])).rank).not.toBe("C");
  });
});

describe("Stage 6D: 対応優先度（情報充実度とは独立）", () => {
  const ctx = (o: Partial<Parameters<typeof priorityOf>[1]> = {}) => ({ now: NOW, dueAt: null, stage: "open" as const, ...o });
  it("Aランク／締切が1か月後: 急がない。Cランク／本日締切: 優先確認", () => {
    const a = priorityOf("A", ctx({ dueAt: new Date("2026-12-05T14:59:00Z") }));
    const c = priorityOf("C", ctx({ dueAt: new Date("2026-11-05T14:59:00Z") }));
    expect(a.label).toBe("急がない");
    expect(c.label).toBe("本日締切");
    expect(c.alert).toBe(true);
    expect(c.sort).toBeLessThan(a.sort);
  });
  it("Dランク／受付前: 自動追跡。Eランク／根拠不明: 低優先度", () => {
    expect(priorityOf("D", ctx({ stage: "upcoming", tracking: true })).label).toBe("受付前・自動追跡");
    const e = priorityOf("E", ctx());
    expect(e.label).toBe("根拠不明");
    expect(e.sort).toBeGreaterThan(priorityOf("C", ctx({ dueAt: new Date("2026-11-07T14:59:00Z") })).sort);
  });
  it("受付終了は緊急から外す。★系列・優先収集メモは同条件で先に並ぶ", () => {
    expect(priorityOf("B", ctx({ dueAt: new Date("2026-11-04T14:59:00Z") })).key).toBe("ended");
    const due = new Date("2026-11-08T14:59:00Z");
    expect(priorityOf("B", ctx({ dueAt: due, importantChain: true })).sort).toBeLessThan(priorityOf("B", ctx({ dueAt: due })).sort);
    expect(priorityOf("B", ctx({ dueAt: due, memoMatched: true })).sort).toBeLessThan(priorityOf("B", ctx({ dueAt: due })).sort);
  });
  it("ランクが高くても本日締切が先、ランクが低くても締切が遠ければ後（ランクと優先度は独立）", () => {
    const urgentLow = priorityOf("D", ctx({ dueAt: new Date("2026-11-05T14:59:00Z") }));
    const relaxedHigh = priorityOf("A", ctx({ dueAt: new Date("2026-12-20T14:59:00Z") }));
    expect(urgentLow.sort).toBeLessThan(relaxedHigh.sort);
  });
});

describe("Stage 6D: 同一抽選の照合と補足投稿の紐付け", () => {
  const open = (id: string, i: LotteryInput, o: Partial<OpenLite> = {}): OpenLite => ({ id, input: i, summary: sum("none", "none"), fields: {}, created_at: "2026-11-05T01:00:00Z", source: src("aggregator_x", `https://x.com/a/status/${id}`, `x:${id}`), urls: [], postedAt: "2026-11-05T01:00:00Z", ...o });
  const base = (o: Partial<LotteryInput> = {}) => input({ chain: { id: null, name: "テスト玩具" }, ...prod("30th CELEBRATION"), applyDeadline: flex("2026-11-10", "23:59"), ...o });

  it("系列・商品が一致し日付が矛盾しなければ同じ抽選。商品と締切日だけが一致する別の系列は統合しない", () => {
    const m = matchOpen([open("1", base({ applyDeadline: EMPTY_FLEX }))], base(), "self");
    expect(m.match?.id).toBe("1");
    expect(matchOpen([open("2", base({ chain: { id: null, name: "別の系列" } }))], base(), "self").match).toBeNull();
  });
  it("同じ系列・商品でも、締切が違えば別の抽選回の可能性として関連候補に残し、統合しない。店舗別の抽選も混同しない", () => {
    const m = matchOpen([open("1", base({ applyDeadline: flex("2026-11-20", "23:59") }))], base(), "self");
    expect(m.match).toBeNull();
    expect(m.related).toEqual(["1"]);
    const stores = matchOpen([open("3", base({ store: { id: null, name: "梅田店", prefecture: "" } }))], base({ store: { id: null, name: "三宮店", prefecture: "" } }), "self");
    expect(stores.match).toBeNull();
  });
  it("複数に該当するときは自動確定せず、関連候補として返す", () => {
    const m = matchOpen([open("1", base({ applyDeadline: EMPTY_FLEX })), open("2", base({ applyDeadline: EMPTY_FLEX }))], base(), "self");
    expect(m.match).toBeNull();
    expect(m.related.sort()).toEqual(["1", "2"]);
  });

  const supInput = input({ chain: { id: null, name: "" }, conditionsText: "過去に購入履歴のある方のみ応募可能", requirementTags: ["purchase_history"] as never });
  it("補足投稿の判定: 商品も締切も無く、応募条件だけがある", () => {
    expect(isSupplement(supInput)).toBe(true);
    expect(isSupplement(base())).toBe(false);
    expect(isSupplement(input({}))).toBe(false);
  });
  it("引用元の投稿で対象を一意に特定できれば、商品・締切が補足投稿に無くても紐付ける", () => {
    const target = open("t1", base(), { postId: "900", account: "furuichi_official" });
    const other = open("t2", base({ chain: { id: null, name: "別の系列" } }), { postId: "901", account: "furuichi_official" });
    const m = matchSupplement([target, other], { input: supInput, quotedId: "900", account: "furuichi_official", postedAt: "2026-11-05T02:00:00Z", urls: [] }, "self");
    expect(m.target?.id).toBe("t1");
    expect(m.signal).toBe("quote");
  });
  it("共通の応募URLでも紐付ける", () => {
    const target = open("t1", base({ memo: "応募URL: https://furuichi.example.invalid/apply" }), { urls: ["https://furuichi.example.invalid/apply?utm=1"] });
    const m = matchSupplement([target], { input: supInput, postedAt: "2026-11-05T02:00:00Z", urls: ["https://furuichi.example.invalid/apply"] }, "self");
    expect(m.signal).toBe("url");
    expect(m.target?.id).toBe("t1");
  });
  it("同じアカウントというだけでは統合しない。系列が一致し、一意で、近い時刻のときだけ", () => {
    const a = open("t1", base(), { account: "shop", postedAt: "2026-11-05T01:00:00Z" });
    const b = open("t2", base({ ...prod("別の商品") }), { account: "shop", postedAt: "2026-11-05T01:30:00Z" });
    const supWithChain = input({ chain: { id: null, name: "テスト玩具" }, conditionsText: "会員登録が必要" });
    // 同じアカウント・同じ系列の候補が2件ある → 一意に決まらない → 関連候補
    const two = matchSupplement([a, b], { input: supWithChain, account: "shop", postedAt: "2026-11-05T02:00:00Z", urls: [] }, "self");
    expect(two.target).toBeNull();
    expect(two.related.sort()).toEqual(["t1", "t2"]);
    // 1件だけなら紐付く
    expect(matchSupplement([a], { input: supWithChain, account: "shop", postedAt: "2026-11-05T02:00:00Z", urls: [] }, "self").target?.id).toBe("t1");
    // 系列が不明な補足投稿は、アカウントだけでは統合しない
    expect(matchSupplement([a], { input: supInput, account: "shop", postedAt: "2026-11-05T02:00:00Z", urls: [] }, "self").target).toBeNull();
    // 時間が離れていれば統合しない
    expect(matchSupplement([a], { input: supWithChain, account: "shop", postedAt: "2026-11-08T02:00:00Z", urls: [] }, "self").target).toBeNull();
  });
});

describe("Stage 6D: 矛盾の誤検出を避ける（短縮URL・受取方法の限定）", () => {
  const mk = (memo: string, receive: "store" | "either" | "shipping", at: string) => side(input({ chain: { id: "c1", name: "ふるいち" }, memo, receiveMethod: receive, applyDeadline: flex("2026-11-10", "23:59") }), sum("exact", "none"), src("aggregator_x", `https://x.com/a/status/${at}`, `x:${at}`, "2026-11-05T01:00:00Z", `acc${at}`));
  it("短縮URL（t.co）と実URLは矛盾にしない。実URLを採用する", () => {
    const m = mergeSides(mk("応募URL: https://t.co/abc", "store", "1"), mk("応募URL: https://shop.example.invalid/apply", "store", "2"));
    expect(m.conflicts).toEqual([]);
    expect(m.input.memo).toContain("https://shop.example.invalid/apply");
    // 実URLが主で、他が短縮URLのときは、実URLのまま
    const m2 = mergeSides(mk("応募URL: https://shop.example.invalid/apply", "store", "3"), mk("応募URL: https://t.co/abc", "store", "4"));
    expect(m2.input.memo).toContain("https://shop.example.invalid/apply");
    expect(m2.conflicts).toEqual([]);
  });
  it("異なる実URL同士は矛盾として記録する", () => {
    const m = mergeSides(mk("応募URL: https://a.example.invalid/x", "store", "5"), mk("応募URL: https://b.example.invalid/y", "store", "6"));
    expect(m.conflicts.map((c) => c.field)).toEqual(["applyUrl"]);
  });
  it("受取方法『店頭・発送どちらも可』と『店頭のみ』は矛盾にしない。店頭と発送は矛盾", () => {
    expect(mergeSides(mk("", "store", "7"), mk("", "either", "8")).conflicts).toEqual([]);
    expect(mergeSides(mk("", "store", "9"), mk("", "shipping", "10")).conflicts.map((c) => c.field)).toEqual(["receiveMethod"]);
  });
});
