import { describe, expect, it } from "vitest";
import { buildQuery, isCompleteAddress, normalizeForMatch, pickCandidate } from "@/lib/geocode";

const hit = (title: string, lat = 34.68, lng = 135.18) => ({ title, lat, lng });

describe("住所ジオコーディングの判定", () => {
  it("正規化: 全角・丁目・番地・号をそろえる", () => {
    expect(normalizeForMatch("兵庫県神戸市中央区東川崎町１丁目")).toBe("兵庫県神戸市中央区東川崎町1");
    expect(normalizeForMatch("兵庫県神戸市中央区東川崎町1-7-2")).toBe("兵庫県神戸市中央区東川崎町1-7-2");
  });
  it("国土地理院の結果（漢数字・番・号）も住所と同じ形にそろう", () => {
    expect(pickCandidate("兵庫県神戸市北区上津台8-1-1 イオンモール神戸北3F", [hit("兵庫県神戸市北区上津台八丁目１番")]).kind).toBe("ok");
    expect(pickCandidate("大阪府大阪市中央区西心斎橋1-6-14 ビル B1F", [hit("大阪府大阪市中央区西心斎橋一丁目６番１４号")]).kind).toBe("ok");
    expect(pickCandidate("兵庫県神戸市中央区東川崎町1-7-2 umie", [hit("兵庫県神戸市中央区東川崎町一丁目７番")]).kind).toBe("ok");
    expect(normalizeForMatch("十二")).toBe("12");
  });
  it("検索住所: 都道府県が無ければ登録済みの都道府県を足す。推測はしない", () => {
    expect(buildQuery("神戸市中央区東川崎町1-7-2", "兵庫県")).toBe("兵庫県神戸市中央区東川崎町1-7-2");
    expect(buildQuery("兵庫県神戸市中央区東川崎町1-7-2", "大阪府")).toBe("兵庫県神戸市中央区東川崎町1-7-2");
    expect(buildQuery("神戸市中央区東川崎町1-7-2", "")).toBe("神戸市中央区東川崎町1-7-2");
  });
  it("住所不完全: 都道府県・市区町村・手がかりが足りないものは対象外", () => {
    expect(isCompleteAddress("兵庫県神戸市中央区東川崎町1-7-2")).toBe(true);
    expect(isCompleteAddress("神戸市中央区東川崎町1-7-2")).toBe(false);
    expect(isCompleteAddress("兵庫県神戸市")).toBe(false);
    expect(isCompleteAddress("三宮店")).toBe(false);
    expect(isCompleteAddress("三重県名張市夏見3303")).toBe(true); // 「三重県」は漢数字の変換で「3重県」になるが、都道府県として判定する
    expect(isCompleteAddress("三重県津市一身田上津部田字口の坪115-1")).toBe(true);
  });
  it("住所の先頭と一致する最も細かい候補を採用する", () => {
    const r = pickCandidate("兵庫県神戸市中央区東川崎町1-7-2 ハーバーランドumie", [hit("兵庫県神戸市中央区"), hit("兵庫県神戸市中央区東川崎町１丁目", 34.6785, 135.1818)]);
    expect(r).toMatchObject({ kind: "ok", hit: { lat: 34.6785 } });
  });
  it("市区町村止まり・一致なしは採用しない（別店舗の座標を推測しない）", () => {
    expect(pickCandidate("兵庫県神戸市中央区東川崎町1-7-2", [hit("兵庫県神戸市中央区")]).kind).toBe("ambiguous");
    expect(pickCandidate("兵庫県神戸市中央区東川崎町1-7-2", [hit("大阪府大阪市北区梅田１丁目")]).kind).toBe("no_match");
    expect(pickCandidate("兵庫県神戸市中央区東川崎町1-7-2", []).kind).toBe("no_match");
  });
  it("同じ細かさで離れた別の場所が複数あるときは採用しない", () => {
    expect(pickCandidate("兵庫県神戸市中央区東川崎町1-7-2", [hit("兵庫県神戸市中央区東川崎町１丁目", 34.6, 135.1), hit("兵庫県神戸市中央区東川崎町１丁目", 34.9, 135.4)]).kind).toBe("ambiguous");
  });
});
