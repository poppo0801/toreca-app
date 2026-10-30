import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ICON_MARKS, ProfileAvatar } from "@/components/profile-avatar";

const base = { color: "blue" as const, initial: "A", label: "A" };
const html = (p: Parameters<typeof ProfileAvatar>[0]["profile"]) => renderToStaticMarkup(<ProfileAvatar profile={p} />);

describe("プロフィールのアイコン（Stage 5I で追加）", () => {
  it("20種類以上あり、鳥・犬・魚・花・音符・ゲーム・ハート・星・月・太陽・王冠を含む", () => {
    const labels = Object.values(ICON_MARKS).map((m) => m.label);
    expect(Object.keys(ICON_MARKS).length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(ICON_MARKS).length).toBeLessThanOrEqual(30);
    for (const l of ["とり", "いぬ", "さかな", "はな", "おんぷ", "ゲーム", "ハート", "星", "つき", "たいよう", "おうかん"]) expect(labels).toContain(l);
    expect(new Set(labels).size).toBe(labels.length); // 名前の重複なし
  });

  it("既存のキーはそのまま（保存済みのアイコンが変わらない）", () => {
    for (const k of ["initial", "star", "heart", "zap", "flame", "leaf", "moon", "sun", "crown", "gem", "ghost", "cat"]) expect(ICON_MARKS[k]).toBeDefined();
    expect(ICON_MARKS.cat.label).toBe("ねこ");
  });

  it("鳥のアイコンが表示される（頭文字ではなくマーク）。未知のキーは頭文字に戻る", () => {
    expect(html({ ...base, iconMark: "bird" })).toContain("<svg");
    expect(html({ ...base, iconMark: "bird" })).not.toContain(">A<");
    expect(html({ ...base, iconMark: "no-such-icon" })).toContain(">A<");
  });

  it("色を変えても同じマークのまま", () => {
    const out = html({ ...base, color: "pink", colorHex: "#ff8800", iconMark: "bird" });
    expect(out).toContain("<svg");
    expect(out).toContain("background-color:#ff8800");
  });
});
