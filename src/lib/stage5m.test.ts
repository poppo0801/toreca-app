import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { STATUS_META } from "@/components/status-icon";
import {
  classifyAnnouncement,
  classifyRequirements,
  foldAnnounceNote,
  normalizeAnnounceMethods,
  resolveAnnouncement,
  splitAnnounce,
  visibleRequirementTags,
} from "@/lib/lottery-taxonomy";
import { splitNotes } from "@/lib/notes";
import { effectiveEventState } from "@/lib/eligibility";
import { DEFAULT_FILTERS, selectLotteries } from "@/lib/lottery-view";
import * as m from "@/lib/mutations";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");

describe("当落発表方法の単一選択", () => {
  it("複数渡されても主な1つだけ残し、残りは補足へ回す候補になる", () => {
    expect(normalizeAnnounceMethods(["result_page", "result_mail", "app"])).toEqual(["result_mail"]);
    expect(splitAnnounce(["result_page", "result_mail", "app"])).toEqual({ primary: "result_mail", rest: ["result_page", "app"] });
    expect(normalizeAnnounceMethods(["unknown", "line"])).toEqual(["line"]);
    expect(normalizeAnnounceMethods(["unknown"])).toEqual(["unknown"]);
    expect(normalizeAnnounceMethods([])).toEqual([]);
  });
  it("補足は既存の文を消さずに追記し、同じ内容は重複させない", () => {
    const once = foldAnnounceNote("LivePocketのマイページでも確認可能", ["result_page"]);
    expect(once).toBe("LivePocketのマイページでも確認可能\n他の確認方法: 結果確認ページ");
    expect(foldAnnounceNote(once, ["result_page"])).toBe(once);
    expect(foldAnnounceNote("", ["app", "line"])).toBe("他の確認方法: 公式アプリ、LINE");
    expect(foldAnnounceNote("そのまま", [])).toBe("そのまま");
  });
  it("AIが複数の確認方法を検出したら、主な方法を1つ選び、その他を補足へ", () => {
    const c = classifyAnnouncement("当落結果をメールでお知らせし、マイページでも確認できます");
    expect(c.methods).toEqual(["result_mail"]);
    expect(c.extra).toEqual(["result_page"]);
  });
  it("LivePocketの標準補完は維持（主な方法は当落メール、結果確認ページは補足、推定として区別）", () => {
    const r = resolveAnnouncement({ text: "", urls: ["https://t.livepocket.jp/e/xyz"] });
    expect(r).toMatchObject({ methods: ["result_mail"], extra: ["result_page"], inferred: true, service: "livepocket" });
    const explicit = resolveAnnouncement({ text: "当選者のみにメールでご連絡します", urls: ["https://t.livepocket.jp/e/xyz"] });
    expect(explicit).toMatchObject({ methods: ["winner_mail"], inferred: false });
  });
});

describe("本人確認条件の表示整理", () => {
  it("一般的な本人確認（身分証・顔写真付き・免許・マイナンバー）は表示対象から外す", () => {
    for (const t of ["本人確認が必要です", "身分証明書の提示が必要", "顔写真付き身分証明書が必要", "運転免許証が必要", "マイナンバーカードが必要"]) {
      const c = classifyRequirements(t);
      expect(visibleRequirementTags(c.tags), t).toEqual([]);
      expect(c.tags.length, `${t} は内部データとして保持`).toBeGreaterThan(0);
    }
  });
  it("特殊な書類・手続きは表示対象として残す", () => {
    const a = classifyRequirements("学生証と在学証明書の両方が必要");
    expect(visibleRequirementTags(a.tags)).toContain("other_verification");
    const b = classifyRequirements("指定サービスで事前の本人認証が必要");
    expect(visibleRequirementTags(b.tags)).toContain("other_verification");
  });
  it("ほかの条件と並んでも、通常の本人確認だけが隠れる", () => {
    const c = classifyRequirements("会員証の提示と顔写真付き身分証が必要。1人1回まで");
    expect(c.tags).toEqual(expect.arrayContaining(["member_card", "photo_id", "once_per_person"]));
    expect(visibleRequirementTags(c.tags)).toEqual(expect.arrayContaining(["member_card", "once_per_person"]));
    expect(visibleRequirementTags(c.tags)).not.toContain("photo_id");
  });
});

describe("備考の箇条書き", () => {
  it("改行・行頭記号・文末の「。」で項目に分ける", () => {
    expect(splitNotes("応募は1人1回まで\n当選後のキャンセル不可\n購入時に会員証を提示")).toEqual(["応募は1人1回まで", "当選後のキャンセル不可", "購入時に会員証を提示"]);
    expect(splitNotes("・応募は1人1回まで\n・当選後のキャンセル不可")).toEqual(["応募は1人1回まで", "当選後のキャンセル不可"]);
    expect(splitNotes("応募は1人1回まで。当選後のキャンセル不可。受取期間を過ぎると当選無効。")).toHaveLength(3);
  });
  it("単一の文章はそのまま1項目（括弧内の「。」では分けない）", () => {
    expect(splitNotes("一つだけの注意事項です")).toEqual(["一つだけの注意事項です"]);
    expect(splitNotes("（注意。ここは分けない）続き")).toEqual(["（注意。ここは分けない）続き"]);
    expect(splitNotes("")).toEqual([]);
  });
});

describe("状態の絞り込み（全情報・★管理対象の既定は受付中かつ現在のプロフィールが未応募）", () => {
  const managed = (d: AppData): AppData => ({ ...d, management: d.lotteries.map((l) => ({ lotteryId: l.id, isManaged: true, managedSource: "manual" as const })) });
  const ids = (d: AppData, tab: "managed" | "all" | "applied" | "won", f: Partial<typeof DEFAULT_FILTERS>, profile = "pA", keep?: ReadonlySet<string>) =>
    selectLotteries(d, tab, { ...DEFAULT_FILTERS, ...f }, NOW, profile, keep).map((l) => l.id);
  it("既定は「受付中・未応募」。現在のプロフィールで応募済みの抽選だけ隠れる（他のプロフィールの応募には影響されない）", () => {
    expect(DEFAULT_FILTERS.status).toBe("default");
    const base = managed(createMockData(NOW));
    const applied = m.setApplied(base, "pA", "L4", "a-c3", true, NOW);
    expect(ids(applied, "managed", {}, "pA")).not.toContain("L4");
    expect(ids(applied, "managed", {}, "pB")).toContain("L4"); // Bは未応募
  });
  it("受付終了の抽選は既定で除外され、「受付終了」「すべて」で表示される。全情報も同じ", () => {
    const base = createMockData(NOW);
    const closed = base.lotteries.filter((l) => effectiveEventState(l, NOW) === "closed").map((l) => l.id);
    expect(closed.length).toBeGreaterThan(0);
    for (const tab of ["managed", "all"] as const) {
      // 同じ抽選は1つのタブにだけ出るので、要チェックは全件を★に、全情報は★なし・応募なしにして確かめる
      const d: AppData = tab === "managed" ? { ...managed(base), applications: [] } : { ...base, management: [], applications: [] };
      for (const id of closed) expect(ids(d, tab, {})).not.toContain(id);
      for (const id of closed) expect(ids(d, tab, { status: "closed" })).toContain(id);
      for (const id of closed) expect(ids(d, tab, { status: "any" })).toContain(id);
    }
  });
  it("「応募済み」「当選」「落選」は現在のプロフィールの応募で判定する", () => {
    const d = managed(createMockData(NOW));
    const applied = m.setApplied(d, "pA", "L4", "a-c3", true, NOW);
    expect(ids(applied, "applied", { status: "applied" }, "pA")).toContain("L4"); // 応募した本人は応募済みタブ
    expect(ids(applied, "managed", { status: "applied" }, "pB")).not.toContain("L4");
    expect(ids(applied, "managed", { status: "unapplied" }, "pB")).toContain("L4");
    expect(ids(applied, "managed", { status: "won" }, "pA")).not.toContain("L4");
    expect(ids(applied, "managed", { status: "lost" }, "pA")).not.toContain("L4");
  });
  it("★管理対象では、★が付いていない抽選は状態に関係なく表示しない", () => {
    const d = createMockData(NOW);
    const none: AppData = { ...d, management: [] };
    expect(ids(none, "managed", { status: "any" })).toEqual([]);
    // 4つのタブは重複せず、合わせると全抽選になる（同じ抽選は1つのタブにだけ出る）
    const sum = (["won", "applied", "managed", "all"] as const).reduce((n, t) => n + ids(none, t, { status: "any", skip: "include" }).length, 0);
    expect(sum).toBe(d.lotteries.length);
  });
  it("応募済み・当選タブでは既定のままでも状態で絞らない。他の条件（系列）とも組み合わせられる", () => {
    const applied = m.setApplied(managed(createMockData(NOW)), "pA", "L4", "a-c3", true, NOW);
    expect(ids(applied, "applied", {})).toContain("L4");
    const chainOfL4 = applied.lotteries.find((l) => l.id === "L4")!.chainId;
    expect(ids(applied, "applied", { status: "any", chainId: chainOfL4 })).toContain("L4");
    expect(ids(applied, "applied", { status: "any", chainId: "no-such-chain" })).toEqual([]);
  });
  it("退場アニメーション中のカードは一覧に残り、解除すると未応募で表示される", () => {
    const applied = m.setApplied(managed(createMockData(NOW)), "pA", "L4", "a-c3", true, NOW);
    expect(ids(applied, "managed", {}, "pA", new Set(["L4"]))).toContain("L4");
    const undone = m.setApplied(applied, "pA", "L4", "a-c3", false, NOW);
    expect(ids(undone, "managed", {}, "pA")).toContain("L4");
  });
  it("継続抽選・招待制販売は有効期限を過ぎたら受付終了として扱う（期限が未設定なら締切のまま）", () => {
    const d = managed(createMockData(NOW));
    const base = d.lotteries.find((l) => effectiveEventState(l, NOW) === "open")!;
    const expired: AppData = { ...d, lotteries: d.lotteries.map((l) => (l.id === base.id ? { ...l, kind: "ongoing" as const, validUntil: "2026-10-01" } : l)) };
    expect(ids(expired, "managed", {})).not.toContain(base.id);
    expect(ids(expired, "managed", { status: "closed" })).toContain(base.id);
    const noLimit: AppData = { ...d, lotteries: d.lotteries.map((l) => (l.id === base.id ? { ...l, kind: "ongoing" as const } : l)) };
    expect(ids(noLimit, "managed", {})).toContain(base.id);
  });
});

describe("応募状況アイコン", () => {
  it("未応募は「－」、応募済みは✓系のアイコン。対象外は未応募と区別できる別の記号", () => {
    expect(STATUS_META.eligible_unapplied.symbol).toBe("－");
    expect(STATUS_META.ineligible.symbol).not.toBe("－");
    expect(STATUS_META.applied.label).toBe("応募済み");
    expect(STATUS_META.skipped.label).toBe("スルー");
  });
});
