import { describe, expect, it } from "vitest";
import { findSelectFormCleanup } from "@/lib/agent/lottery-grouping/form-cleanup";
import { mkLottery, resetSeq } from "@/lib/agent/lottery-grouping/fixtures";
import { formFromStoreMode, groupableForm, judgeForm, nextFormColumns } from "@/lib/lottery-form";
import { findDuplicates } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Chain, Lottery, Store } from "@/types/domain";

/** Stage 8F-6: 抽選形態の判別（構造を根拠にする）・手動の優先・店舗選択式の二重登録の防止・整理候補 */
const base = { storeMode: "fixed" as const, texts: [] as string[] };

describe("抽選形態の判別: 応募受付の構造で決める", () => {
  it("店舗選択欄の記載 → 店舗選択式（A）。選べる店舗の一覧・店舗選択式としての登録が重なるほど確度が上がる", () => {
    expect(judgeForm({ ...base, texts: ["応募フォームで受取店舗を選択してください"] })).toMatchObject({ form: "store_select", confidence: "medium", basisKind: "structure" });
    expect(judgeForm({ ...base, storeMode: "select_on_apply", selectableStoreCount: 5, texts: [] })).toMatchObject({ form: "store_select", confidence: "high" });
    expect(judgeForm({ ...base, texts: ["購入希望店舗は、店舗から選択する"] }).form).toBe("store_select");
    expect(judgeForm({ ...base, texts: ["申込み時に受け取り希望店舗を指定し、同店舗で購入する"] }).form).toBe("store_select");
  });
  it("店舗ごとの受付の記載 → 店舗別独立抽選（B）", () => {
    expect(judgeForm({ ...base, texts: ["各店舗で受付・抽選を行います"] }).form).toBe("store_independent");
    expect(judgeForm({ ...base, texts: ["再販商品のため、店舗ごとの申込は可能（店舗またいでの重複応募可）"] }).form).toBe("store_independent");
    expect(judgeForm({ ...base, requirementTags: ["in_store_apply"], texts: [] }).form).toBe("store_independent");
  });
  it("「1店舗のみ応募」「複数店舗への応募は無効」は制限であり、店舗選択式の証拠ではない（構造が不明なら unknown。制限の印だけ付く）", () => {
    for (const t of ["お一人様につき対象店舗の中から1店舗のみ応募可（複数店舗に応募すると無効）", "複数店舗で同時に抽選を実施しておりますが、エントリー可能な店舗は1店舗のみです", "同じ販売期間に複数店舗へ応募すると重複応募として無効"]) {
      const j = judgeForm({ ...base, texts: [t] });
      expect(j.form, t).toBe("unknown");
      expect(j.restrictionOnly, t).toBe(true);
    }
    expect(judgeForm({ ...base, requirementTags: ["one_store_only"], texts: [] })).toMatchObject({ form: "unknown", restrictionOnly: true });
    // 店舗ごとの受付の構造があれば、制限があっても店舗別独立
    expect(judgeForm({ ...base, texts: ["各店舗で受付します。複数店舗への応募は無効です"] }).form).toBe("store_independent");
  });
  it("構造の記載が食い違う（店舗を選ぶ記載と、店舗ごとの受付の記載の両方）→ 確定しない（conflict）。情報が無ければ unknown（既存の登録を尊重）", () => {
    expect(judgeForm({ ...base, texts: ["応募時に店舗を選択。各店舗で受付"] })).toMatchObject({ form: "unknown", conflict: true });
    expect(judgeForm({ ...base, texts: ["会員登録が必要です"] })).toMatchObject({ form: "unknown", conflict: false, restrictionOnly: false });
  });
  it("通販・店舗を持たない抽選は『その他（C）』", () => {
    expect(judgeForm({ ...base, storeMode: "none", texts: [] }).form).toBe("other");
    expect(judgeForm({ ...base, online: true, texts: [] }).form).toBe("other");
  });
  it("別の情報源URLだけでは店舗別独立としない（裏づけにとどめる）。構造の根拠があるときだけ加点", () => {
    const sibs = [{ sourceUrls: ["https://a.invalid/2"], storeKey: "s2" }];
    expect(judgeForm({ ...base, sourceUrls: ["https://a.invalid/1"], storeKey: "s1", siblings: sibs, texts: [] }).form).toBe("unknown");
    const j = judgeForm({ ...base, sourceUrls: ["https://a.invalid/1"], storeKey: "s1", siblings: sibs, texts: ["各店舗で受付"] });
    expect(j.confidence).toBe("high");
    expect(j.independentSignals.map((s) => s.code)).toContain("per_store_url");
  });
  it("利用者の手動の分類が最優先。構造と食い違っても手動を採用し、食い違いは記録する。AI・収集（rule/ai）の記録は手動ほど強くない", () => {
    const j = judgeForm({ ...base, texts: ["応募フォームで受取店舗を選択してください"], decl: { form: "store_independent", source: "manual" } });
    expect(j).toMatchObject({ form: "store_independent", basisKind: "manual", manualDisagrees: true });
    expect(judgeForm({ ...base, texts: ["応募フォームで受取店舗を選択してください"], decl: { form: "store_independent", source: "ai" } }).form).toBe("store_select");
  });
  it("グループ化の対象になりうる形態は、店舗別独立・未確認（既存を尊重）。店舗選択式・その他は対象外", () => {
    expect([groupableForm("store_independent"), groupableForm("unknown"), groupableForm("store_select"), groupableForm("other")]).toEqual([true, true, false, false]);
  });
});

describe("分類の記録: 手動を、収集・AIが上書きしない", () => {
  it("利用者: 方式を変えたとき・店舗選択式で新規登録したときだけ手動として記録。初期値の店舗固定での新規登録・方式を変えない保存は記録しない", () => {
    expect(nextFormColumns({ isNew: true, byUser: true, nextMode: "fixed" })).toBeNull();
    expect(nextFormColumns({ isNew: true, byUser: true, nextMode: "select_on_apply" })).toEqual({ lottery_form: "store_select", lottery_form_source: "manual" });
    expect(nextFormColumns({ isNew: false, byUser: true, prevMode: "fixed", nextMode: "fixed" })).toBeNull();
    expect(nextFormColumns({ isNew: false, byUser: true, prevMode: "select_on_apply", nextMode: "fixed" })).toEqual({ lottery_form: "store_independent", lottery_form_source: "manual" });
  });
  it("収集・AI: 手動の分類がある抽選には書かない。それ以外で方式が変わるときだけ rule として記録", () => {
    expect(nextFormColumns({ isNew: false, byUser: false, prevMode: "fixed", prevSource: "manual", nextMode: "select_on_apply" })).toBeNull();
    expect(nextFormColumns({ isNew: false, byUser: false, prevMode: "fixed", prevSource: null, nextMode: "select_on_apply" })).toEqual({ lottery_form: "store_select", lottery_form_source: "rule" });
    expect(formFromStoreMode("none")).toBe("other");
  });
});

describe("店舗選択式の二重登録の防止（重複判定）", () => {
  const chains = [{ id: "c", name: "架空チェーン" }] as unknown as Chain[];
  const stores = [{ id: "ph", chainId: "c", name: "応募時に店舗選択", salesKind: "physical" }, { id: "s1", chainId: "c", name: "ア店", salesKind: "physical" }] as unknown as Store[];
  const master = { chains, stores };
  const NOW = new Date("2026-11-10T03:00:00Z");
  const jf = (d: string) => ({ precision: "date_only" as const, date: d });
  const lot = (id: string, o: Partial<Lottery> = {}): Lottery => ({ id, chainId: "c", storeId: "s1", storeMode: "fixed", items: [{ productId: "p1", quantity: 1, unit: "box" }], sourceUrls: ["https://x.invalid/e/1"], applyStart: jf("2026-11-09"), applyDeadline: jf("2026-11-12"), ...o }) as unknown as Lottery;
  const inp = (o: Partial<LotteryInput> = {}): LotteryInput => ({ chain: { id: "c", name: "架空チェーン" }, store: { id: "s1", name: "ア店", prefecture: "" }, storeMode: "fixed", items: [{ product: { id: "p1", name: "p1" }, quantity: 1, unit: "box" }], applyStart: { precision: "date_only", date: "2026-11-09", time: "" }, applyDeadline: { precision: "date_only", date: "2026-11-12", time: "" }, sourceUrls: ["https://x.invalid/e/1"], multiMode: "single", ...o }) as unknown as LotteryInput;
  const dup = (i: LotteryInput, ls: Lottery[]) => findDuplicates(i, ls, undefined, master, { now: NOW });
  it("登録済みの店舗選択式の抽選と同じ情報源の、店舗別の新規候補は、新しいカードを作らない（high）", () => {
    const sel = lot("S", { storeId: "ph", storeMode: "select_on_apply" });
    expect(dup(inp(), [sel])[0]).toMatchObject({ lotteryId: "S", level: "high" });
  });
  it("逆（店舗別に登録済みの同じ情報源に、店舗選択式の新規）は要確認（medium。応募の記録がある既存カードを自動で統合しない）", () => {
    expect(dup(inp({ storeMode: "select_on_apply", store: { id: "ph", name: "応募時に店舗選択", prefecture: "" } }), [lot("F")])[0]).toMatchObject({ lotteryId: "F", level: "medium" });
  });
  it("情報源が別なら、店舗選択式と店舗別は別の抽選のまま（誤統合しない）。明確に別の開催回も統合しない", () => {
    const sel = lot("S", { storeId: "ph", storeMode: "select_on_apply", sourceUrls: ["https://x.invalid/e/OTHER"] });
    expect(dup(inp(), [sel])).toEqual([]);
    const sel2 = lot("S2", { storeId: "ph", storeMode: "select_on_apply", applyStart: jf("2026-12-20"), applyDeadline: jf("2026-12-25") });
    expect(dup(inp(), [sel2])).toEqual([]);
  });
});

describe("店舗選択式の二重登録の整理候補（読み取りのみ。自動で削除・統合しない）", () => {
  it("店舗選択欄の構造がある店舗別カード・店舗選択式と同じ情報源の店舗別カードを候補にする。応募の記録があるものは protectedIds に分ける", () => {
    resetSeq();
    const sel = mkLottery({ storeMode: "select_on_apply", storeId: null, sourceUrls: ["https://x.invalid/e/9"] });
    const f1 = mkLottery({ sourceUrls: ["https://x.invalid/e/9"], hasApplication: true });
    const f2 = mkLottery({ conditionsText: "応募時に受取店舗を選択してください。" });
    const out = findSelectFormCleanup([sel, f1, f2]);
    expect(out).toHaveLength(1);
    expect(out[0].selectCardId).toBe(sel.id);
    expect(out[0].perStoreIds.sort()).toEqual([f1.id, f2.id].sort());
    expect(out[0].protectedIds).toEqual([f1.id]);
    expect(out[0].suggestion).toContain("利用者が確認");
  });
  it("手動で店舗別独立に設定されたもの・構造のないもの・アーカイブ済みは候補にしない", () => {
    resetSeq();
    const manual = mkLottery({ conditionsText: "応募時に受取店舗を選択してください。", formDecl: { form: "store_independent", source: "manual" } });
    const plain = mkLottery();
    const gone = mkLottery({ conditionsText: "応募時に受取店舗を選択してください。", archived: true });
    expect(findSelectFormCleanup([manual, plain, gone])).toEqual([]);
  });
});
