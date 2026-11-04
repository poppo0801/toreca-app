import { describe, expect, it } from "vitest";
import { MAX_HOLD, canExcludeSource, classifyGap, decideHold, domainExcludable, feedbackTarget, hardSourceKeys, holdIntervalMs, hostOf, hostRole, manualRank, matchExclusion, preferredAlt, triagePatch, urgencyOf, type ExclusionRule, type HoldInput } from "@/lib/collector/triage";

const NOW = new Date("2026-11-04T03:00:00Z"); // 12:00 JST
const h = (n: number) => new Date(NOW.getTime() + n * 3600_000);
const base: HoldInput = { now: NOW, dueAt: h(24 * 6), gaps: ["店舗を確実に特定できません"], holdCount: 0, failKind: null, altTried: false, important: false };

describe("緊急度と並び順", () => {
  it("本日・明日・近い・余裕・不明・終了を日本時間で判定する", () => {
    expect(urgencyOf(h(5), NOW)).toBe("today"); // 17:00 JST
    expect(urgencyOf(h(14), NOW)).toBe("tomorrow"); // 翌日2:00 JST
    expect(urgencyOf(h(60), NOW)).toBe("soon");
    expect(urgencyOf(h(24 * 6), NOW)).toBe("later");
    expect(urgencyOf(null, NOW)).toBe("unknown");
    expect(urgencyOf(h(-1), NOW)).toBe("overdue");
  });
  it("要手動確認の並び: 本日→明日→近い→締切不明（後回しにしない）→余裕あり", () => {
    const order = (["later", "unknown", "soon", "tomorrow", "today"] as const).slice().sort((a, b) => manualRank(a) - manualRank(b));
    expect(order).toEqual(["today", "tomorrow", "soon", "unknown", "later"]);
  });
});

describe("保留（自動再調査）と要手動確認の判定", () => {
  it("締切に余裕がある店舗の特定失敗は、すぐ確認待ちにせず保留して自動で再調査する", () => {
    const d = decideHold({ ...base });
    expect(d.triage).toBe("auto_retry");
    expect(d.nextMs).toBe(holdIntervalMs(1));
  });
  it("締切が24時間以内なのに情報が足りなければ、規定回数に達していなくても要手動確認", () => {
    const d = decideHold({ ...base, dueAt: h(20), holdCount: 0 });
    expect(d.triage).toBe("manual");
    expect(d.reason).toContain("取得できていません");
  });
  it("優先収集メモ・重要な系列は48時間以内で知らせる", () => {
    expect(decideHold({ ...base, dueAt: h(40) }).triage).toBe("auto_retry");
    expect(decideHold({ ...base, dueAt: h(40), important: true }).triage).toBe("manual");
  });
  it("締切不明は低優先度に固定せず保留する。規定回数を超えたら要手動確認（無限に再試行しない）", () => {
    expect(decideHold({ ...base, dueAt: null }).triage).toBe("auto_retry");
    expect(decideHold({ ...base, dueAt: null, holdCount: MAX_HOLD }).triage).toBe("manual");
  });
  it("保留の間隔は回数とともに延び、締切が近いほど短くなる", () => {
    expect(holdIntervalMs(1)).toBeLessThan(holdIntervalMs(3));
    expect(holdIntervalMs(99)).toBe(holdIntervalMs(MAX_HOLD));
    const near = decideHold({ ...base, dueAt: h(60), holdCount: 4 }); // 24時間間隔でも、締切の1/4（15時間）以内に収める
    expect(near.triage).toBe("auto_retry");
    expect(near.nextMs!).toBeLessThanOrEqual(15 * 3600_000);
  });
  it("受付終了は自動除外", () => {
    expect(decideHold({ ...base, dueAt: h(-2) }).triage).toBe("auto_exclude");
  });
  it("取得制限などの恒常的な失敗で、代替の情報源でも得られなければ要手動確認。一時的な失敗は保留", () => {
    expect(decideHold({ ...base, gaps: ["取得できません"], failKind: "robots", altTried: true }).triage).toBe("manual");
    expect(decideHold({ ...base, gaps: ["取得できません"], failKind: "timeout", altTried: false }).triage).toBe("auto_retry");
  });
  it("重大な矛盾など利用者の判断が必要なものは、すぐ要手動確認", () => {
    expect(decideHold({ ...base, gaps: ["既存の抽選と矛盾する日時"] }).triage).toBe("manual");
  });
  it("発表日・受取方法の不明は軽微（不明のまま登録できる項目）", () => {
    expect(classifyGap("受取方法（店頭・発送）が不明です")).toBe("minor");
    expect(classifyGap("発表日が不明です")).toBe("minor");
    expect(classifyGap("応募締切が不明です")).toBe("source");
    expect(classifyGap("店舗を確実に特定できません")).toBe("source");
  });
  it("保存用の列: 保留は回数を加算して次回時刻を設定、手動確認は未対応(open)で記録", () => {
    const r = decideHold({ ...base });
    const p = triagePatch(r, { hold_count: 2 }, NOW);
    expect(p).toMatchObject({ triage: "auto_retry", hold_count: 3, manual_state: null });
    expect(new Date(p.next_run_at as string).getTime()).toBeGreaterThan(NOW.getTime());
    const m = triagePatch(decideHold({ ...base, dueAt: h(2) }), {}, NOW);
    expect(m).toMatchObject({ triage: "manual", manual_state: "open" });
  });
});

describe("取得元の関係と取得困難の記録", () => {
  it("短縮URL・応募サービス・まとめサイト・Xを区別する", () => {
    expect(hostRole(hostOf("https://t.co/abc"))).toBe("shortener");
    expect(hostRole(hostOf("https://shoplottery.e-starbox.com/lottery/1"))).toBe("apply_service");
    expect(hostRole(hostOf("https://t.livepocket.jp/e/xyz"))).toBe("apply_service");
    expect(hostRole(hostOf("https://pokeso.jp/chusen"))).toBe("aggregator");
    expect(hostRole(hostOf("https://x.com/a/status/1"))).toBe("x");
    expect(hostRole(hostOf("https://shop.example.invalid/news"))).toBe("other");
    expect(hostOf("not a url")).toBeNull();
  });
  it("応募サービスの失敗は店舗×サービスで記録し、サービス全体を理由に店舗全体を取得不可としない", () => {
    const k = hardSourceKeys({ url: "https://shoplottery.e-starbox.com/lottery/1", storeId: "S1", storeName: "テスト店" });
    expect(k.map((x) => x.scope)).toEqual(["store", "service"]);
    expect(k[0].key).toBe("S1|shoplottery.e-starbox.com");
    // 別の店舗は別のキー
    expect(hardSourceKeys({ url: "https://shoplottery.e-starbox.com/lottery/2", storeId: "S2" })[0].key).not.toBe(k[0].key);
    // 短縮URLのドメイン自体は記録しない
    expect(hardSourceKeys({ url: "https://t.co/x", chainId: "C1" }).map((x) => x.scope)).toEqual(["chain"]);
  });
  it("過去に成功した代替取得方法だけを次回優先する", () => {
    expect(preferredAlt({ alt_source: "list_text", alt_success: 3, alt_fail: 1 })).toBe("list_text");
    expect(preferredAlt({ alt_source: "list_text", alt_success: 1, alt_fail: 2 })).toBeNull();
    expect(preferredAlt(null)).toBeNull();
  });
});

describe("収集元の除外ルール", () => {
  const rule = (scope: ExclusionRule["scope"], key: string, active = true): ExclusionRule => ({ id: `${scope}-${key}`, scope, key, active, reason_code: "untrusted_shop" });
  it("指定した範囲にだけ一致する（店舗・系列・Xアカウント・個別サイト・投稿元）", () => {
    expect(matchExclusion([rule("store", "S1")], { storeId: "S1" })).not.toBeNull();
    expect(matchExclusion([rule("store", "S1")], { storeId: "S2", chainId: "S1" })).toBeNull();
    expect(matchExclusion([rule("chain", "C1")], { chainId: "C1" })).not.toBeNull();
    expect(matchExclusion([rule("x_account", "badshop")], { xUsername: "@BadShop" })).not.toBeNull();
    expect(matchExclusion([rule("domain", "bad.example.invalid")], { url: "https://www.bad.example.invalid/a" })).not.toBeNull(); // www. は同じサイトとして扱う
    expect(matchExclusion([rule("domain", "bad.example.invalid")], { url: "https://other.example.invalid/a" })).toBeNull();
    expect(matchExclusion([rule("source_post", "x:123")], { sourcePostKey: "x:123" })).not.toBeNull();
  });
  it("無効（解除済み）のルールは適用しない", () => {
    expect(matchExclusion([rule("store", "S1", false)], { storeId: "S1" })).toBeNull();
  });
  it("X全体・e-starbox全体・まとめサイト全体・短縮URLはドメイン除外の対象にできない", () => {
    for (const host of ["x.com", "shoplottery.e-starbox.com", "pokeso.jp", "torecabiyori.com", "t.co", "livepocket.jp"]) {
      expect(domainExcludable(host), host).toBe(false);
      expect(matchExclusion([rule("domain", host)], { url: `https://${host}/a` }), host).toBeNull();
    }
    expect(domainExcludable("shop.example.invalid")).toBe(true);
  });
  it("応募資格・条件の不一致は収集元全体の除外に使えない。信頼性・誤情報・抽選でないは使える", () => {
    expect(canExcludeSource("conditions_mismatch")).toBe(false);
    expect(canExcludeSource("duplicate")).toBe(false);
    expect(canExcludeSource("out_of_area")).toBe(false);
    expect(canExcludeSource("untrusted_shop")).toBe(true);
    expect(canExcludeSource("wrong_info")).toBe(true);
    expect(canExcludeSource("not_lottery")).toBe(true);
  });
  it("除外理由の反映先は明示的なルール・フィルタ・AIフィードバックだけ（自動学習やブラックリストの自動追加はしない）", () => {
    expect(feedbackTarget("untrusted_shop").note).toContain("利用者が");
    expect(feedbackTarget("wrong_info").target).toBe("ai_feedback");
    expect(feedbackTarget("out_of_scope_product").target).toBe("product_filter");
    expect(feedbackTarget("other").target).toBe("none");
  });
});
