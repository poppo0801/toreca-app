import { describe, expect, it } from "vitest";
import { DEFAULT_CARD_DISPLAY, normalizeCardDisplay } from "@/lib/card-display";
import { formatShort } from "@/lib/datetime";
import { DEFAULT_DISTANCE_BANDS_KM, distanceBand, formatKm, haversineKm, isValidLatLng, prefectureOf, validBands } from "@/lib/geo";
import { DRAFT_TTL_MS, clearDraft, fingerprint, listDraftKeys, loadDraft, saveDraft, type DraftStorage } from "@/lib/lottery-draft";
import { EMPTY_FLEX, flexFromParts, flexInputSchema, flexInputToDb } from "@/lib/lottery-input";
import { storeDistance } from "@/lib/store-distance";
import { logoMarkSvg, LOGO_DARK } from "@/lib/brand-svg";

class MemStorage implements DraftStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe("日時入力: 空欄=不明 / 日付のみ / 日付+時刻（時刻未設定と0:00は別）", () => {
  it("空欄は不明、日付だけは日付のみ、日付+時刻は日時", () => {
    expect(flexFromParts("", "").precision).toBe("unknown");
    expect(flexFromParts("2026-11-03", "")).toEqual({ precision: "date_only", date: "2026-11-03", time: "" });
    expect(flexFromParts("2026-11-03", "21:00").precision).toBe("date_time");
  });

  it("0:00 は「時刻あり」で、未設定とは区別される（23:59 などを補わない）", () => {
    const midnight = flexInputToDb(flexFromParts("2026-11-03", "00:00"));
    const none = flexInputToDb(flexFromParts("2026-11-03", ""));
    expect(midnight.precision).toBe("date_time");
    expect(midnight.at).toBe("2026-11-02T15:00:00.000Z"); // JST 0:00
    expect(none).toEqual({ precision: "date_only", date: "2026-11-03", at: null });
  });

  it("時刻だけ入力されて日付が空のときは保存できない（時刻を黙って捨てない）", () => {
    const f = flexFromParts("", "21:00");
    expect(f.precision).toBe("unknown");
    expect(flexInputSchema.safeParse(f).success).toBe(false);
    expect(flexInputSchema.safeParse(EMPTY_FLEX).success).toBe(true);
  });

  it("一覧の短い表記: 不明は—、日付のみは時刻なし、0:00 は 0:00 と表示", () => {
    expect(formatShort({ precision: "unknown" })).toBe("—");
    expect(formatShort({ precision: "date_only", date: "2026-10-27" })).toBe("10/27");
    expect(formatShort({ precision: "date_time", at: "2026-10-27T12:00:00.000Z" })).toBe("10/27 21:00");
    expect(formatShort({ precision: "date_time", at: "2026-10-26T15:00:00.000Z" })).toBe("10/27 0:00");
  });
});

describe("距離計算（Haversine・直線距離）", () => {
  const sannomiya = { lat: 34.6948, lng: 135.1955 };
  const osaka = { lat: 34.7025, lng: 135.4959 }; // 大阪駅付近
  const tokyo = { lat: 35.6812, lng: 139.7671 }; // 東京駅

  it("同一点は0km、既知の2点は妥当な距離（神戸三宮〜大阪駅 約27km、〜東京駅 約420km）", () => {
    expect(haversineKm(sannomiya, sannomiya)).toBeCloseTo(0, 6);
    expect(haversineKm(sannomiya, osaka)).toBeGreaterThan(26);
    expect(haversineKm(sannomiya, osaka)).toBeLessThan(29);
    expect(haversineKm(sannomiya, tokyo)).toBeGreaterThan(410);
    expect(haversineKm(sannomiya, tokyo)).toBeLessThan(430);
  });

  it("対称で、赤道上の経度1度は約111kmになる", () => {
    expect(haversineKm(sannomiya, tokyo)).toBeCloseTo(haversineKm(tokyo, sannomiya), 9);
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.19, 1);
  });

  it("区分: 5未満/5-15/15-30/30-60/60以上。境界値ちょうどは遠い側", () => {
    const b = DEFAULT_DISTANCE_BANDS_KM;
    expect([0, 4.99, 5, 14.9, 15, 29.9, 30, 59.9, 60, 500].map((k) => distanceBand(k, b))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("閾値は後から変更でき、不正な設定は使わない", () => {
    expect(distanceBand(8, [10, 20, 30, 40])).toBe(0);
    expect(validBands([5, 15, 30, 60])).toBe(true);
    expect(validBands([5, 5, 30, 60])).toBe(false);
    expect(validBands([5, 15, 30])).toBe(false);
    expect(validBands([0, 15, 30, 60])).toBe(false);
  });

  it("表示: 10km未満は小数1桁、以上は整数", () => {
    expect(formatKm(3.24)).toBe("3.2km");
    expect(formatKm(27.6)).toBe("28km");
  });

  it("位置が未設定の店舗・自宅では距離を出さない（推測しない）", () => {
    const settings = { homeLat: sannomiya.lat, homeLng: sannomiya.lng, cardDisplay: DEFAULT_CARD_DISPLAY, distanceBandsKm: [5, 15, 30, 60], aiMonthlyBudgetJpy: 3000, autoAiEnabled: true, travelReviewNeeded: false };
    expect(storeDistance({ settings }, { lat: null, lng: null })).toBeNull();
    expect(storeDistance({ settings }, undefined)).toBeNull();
    expect(storeDistance({ settings: { ...settings, homeLat: null, homeLng: null } }, osaka)).toBeNull();
    expect(storeDistance({}, osaka)).toBeNull();
    const d = storeDistance({ settings }, osaka)!;
    expect(d.band).toBe(2);
    expect(d.km).toBeGreaterThan(26);
  });

  it("緯度経度の検証と、住所からの都道府県の取り出し", () => {
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: null, lng: 0 })).toBe(false);
    expect(isValidLatLng(sannomiya)).toBe(true);
    expect(prefectureOf("兵庫県神戸市中央区加納町")).toBe("兵庫県");
    expect(prefectureOf("大阪府大阪市北区")).toBe("大阪府");
    expect(prefectureOf("神戸市中央区")).toBeNull();
  });
});

describe("カード表示設定", () => {
  it("既定は重要項目のみ（交通費・応募方法は非表示）", () => {
    expect(DEFAULT_CARD_DISPLAY.travelCost).toBe(false);
    expect(DEFAULT_CARD_DISPLAY.applyMethod).toBe(false);
    expect(DEFAULT_CARD_DISPLAY.deadline).toBe(true);
  });

  it("保存値の検証: 未知のキー・型違いは無視し、欠けた項目は既定値", () => {
    const d = normalizeCardDisplay({ travelCost: true, deadline: "yes", evil: true });
    expect(d.travelCost).toBe(true);
    expect(d.deadline).toBe(true);
    expect("evil" in d).toBe(false);
    expect(normalizeCardDisplay(null)).toEqual(DEFAULT_CARD_DISPLAY);
  });
});

describe("下書き（端末内保存）", () => {
  const input = { chain: { id: null, name: "サンプル電機" } } as never;
  const draft = { input, urlsText: "", sources: { applyMethod: "default" as const }, base: null };

  it("保存・復元・削除ができ、期限（14日）を過ぎた下書きは破棄される", () => {
    const st = new MemStorage();
    const t0 = 1_000_000;
    expect(saveDraft("new", draft, t0, st)).toBe(true);
    expect(loadDraft("new", t0 + 1000, st)?.urlsText).toBe("");
    expect(listDraftKeys(t0 + 1000, st)).toEqual(["new"]);
    expect(loadDraft("new", t0 + DRAFT_TTL_MS + 1, st)).toBeNull();
    expect(st.getItem("tcg.draft.lottery.new")).toBeNull(); // 期限切れは読み込み時に消える
    saveDraft("new", draft, t0, st);
    clearDraft("new", st);
    expect(loadDraft("new", t0, st)).toBeNull();
  });

  it("壊れた下書きは無視して削除し、例外を出さない。保存先がなくても動く", () => {
    const st = new MemStorage();
    st.setItem("tcg.draft.lottery.x", "{broken");
    expect(loadDraft("x", 0, st)).toBeNull();
    st.setItem("tcg.draft.lottery.y", JSON.stringify({ v: 2 }));
    expect(loadDraft("y", 0, st)).toBeNull();
    expect(saveDraft("z", draft, 0, null)).toBe(false);
    expect(loadDraft("z", 0, null)).toBeNull();
  });

  it("保存先が書き込み不可でも例外にしない", () => {
    const st: DraftStorage = { ...new MemStorage(), getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {}, key: () => null, length: 0 };
    expect(saveDraft("new", draft, 0, st)).toBe(false);
  });

  it("指紋は同じ内容で同じ、違う内容で異なる", () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("ロゴ", () => {
  it("案1の構成（3枚のカード＋星）で、ダーク用は明るい線とオレンジを使う", () => {
    const svg = logoMarkSvg(LOGO_DARK);
    expect((svg.match(/<rect/g) ?? []).length).toBe(3);
    expect(svg).toContain("<path"); // 星
    expect(svg).toContain(LOGO_DARK.accent);
  });
});
