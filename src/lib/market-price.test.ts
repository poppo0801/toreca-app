import { describe, expect, it } from "vitest";
import { aggregate, computeMarket, matchCard, buildIndex, parseMarketCsv, splitCsv } from "@/lib/market-price";

const HEAD = "shop_key,shop,type,kind,set,no,name,rarity,condition,price_jpy,in_stock,source_url,scraped_at";
const line = (shop: string, kind: "sell" | "buy", set: string, no: string, name: string, rarity: string, cond: string, price: number, stock = 1) => `${shop},店${shop},single,${kind},${set},${no},${name},${rarity},${cond},${price},${stock},https://example.com/${shop}/${no},2026-11-05T06:09+09:00`;
// 100行以上の架空データ（実在しない店舗名・価格）
const filler = Array.from({ length: 110 }, (_, i) => line(`f${i % 5}`, "sell", "ZZ1", `${String(i + 1).padStart(3, "0")}/200`, `ダミー${i}`, "AR", "", 100 + i));
const csv = (rows: string[], comment = "# updated: 2026-11-05T06:09+09:00") => [comment, HEAD, ...rows, ...filler].join("\n");
const parse = (rows: string[]) => {
  const r = parseMarketCsv(csv(rows));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("Stage 6G: CSVの解析", () => {
  it("コメント行・BOM・CRLF・引用符内のカンマを扱い、更新日時を読む", () => {
    const text = "﻿" + ["# updated: 2026-11-05T06:09+09:00", HEAD, `a,"店,A",single,sell,S1,001/100,"カード,名",SR,,500,1,https://x.example/a,2026-11-05T06:09+09:00`, ...filler].join("\r\n");
    const r = parseMarketCsv(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.updatedAt).toBe("2026-11-05T06:09+09:00");
    expect(r.value.rows[0]).toMatchObject({ shop: "店,A", name: "カード,名", price: 500 });
    expect(splitCsv('a,"b""c",d\n')).toEqual([["a", 'b"c', "d"]]);
  });
  it("見出しが違う・行が少なすぎる・価格が不正な行は取り込まない／飛ばす", () => {
    expect(parseMarketCsv("a,b,c\n1,2,3").ok).toBe(false);
    expect(parseMarketCsv([HEAD, line("a", "sell", "S", "1/1", "x", "R", "", 1)].join("\n")).ok).toBe(false); // 行が少ない
    expect(parseMarketCsv("").ok).toBe(false);
    const r = parseMarketCsv([HEAD, line("a", "sell", "S", "1/1", "x", "R", "", 0), line("a", "sell", "S", "1/1", "x", "R", "", 100), ...filler].join("\n"));
    expect(r.ok && r.value.skipped).toBe(1); // 価格0円は飛ばす
  });
});

describe("Stage 6G: カードの照合", () => {
  const rows = [
    line("a", "sell", "SV8A", "211/187", "エーフィex", "SAR", "", 7000),
    line("a", "sell", "SV8A", "217/187", "ブラッキーex", "SAR", "", 56000),
    line("b", "sell", "M6A", "104/103", "アローラナッシー", "AR", "", 300),
    line("b", "sell", "M6A", "104/103", "アローラナッシー(30th)", "AR", "", 900),
  ];
  const idx = buildIndex(parse(rows).rows);
  it("収録弾＋カード番号＋レアリティで一致（大文字小文字の違いを吸収）", () => {
    const m = matchCard({ setCode: "SV8a", cardNumber: "217/187", rarity: "SAR", name: "ブラッキーex" }, idx);
    expect(m.status).toBe("matched");
    expect(matchCard({ setCode: "sv8a", cardNumber: "211/187", rarity: "sar", name: "" }, idx).status).toBe("matched");
  });
  it("同名・別カード: 番号が違えば別カード（名前だけで紐付けない）。弾が違えば未掲載", () => {
    expect(matchCard({ setCode: "SV8a", cardNumber: "999/187", rarity: "SAR", name: "ブラッキーex" }, idx).status).toBe("unlisted");
    expect(matchCard({ setCode: "SV1a", cardNumber: "217/187", rarity: "SAR", name: "ブラッキーex" }, idx).status).toBe("unlisted");
  });
  it("レアリティが違えば確定しない（照合未確定）", () => {
    expect(matchCard({ setCode: "SV8a", cardNumber: "217/187", rarity: "UR", name: "ブラッキーex" }, idx).status).toBe("ambiguous");
  });
  it("同じ番号に特殊仕様（30th）がある場合は、名称で絞る。絞れなければ未確定。選択した対応は再利用される", () => {
    const base = { setCode: "M6A", cardNumber: "104/103", rarity: "AR" };
    expect(matchCard({ ...base, name: "アローラナッシー" }, idx)).toMatchObject({ status: "matched", variant: { name: "アローラナッシー" } });
    const amb = matchCard({ ...base, name: "" }, idx);
    expect(amb.status).toBe("ambiguous");
    if (amb.status !== "ambiguous") return;
    const chosen = amb.variants.find((v) => v.name.includes("30th"))!;
    expect(matchCard({ ...base, name: "" }, idx, chosen.key)).toMatchObject({ status: "matched", variant: { name: "アローラナッシー(30th)" } });
  });
  it("収録弾・番号が未登録のカードは照合しない", () => {
    expect(matchCard({ setCode: "", cardNumber: "1/1", rarity: "AR", name: "x" }, idx).status).toBe("insufficient");
  });
});

describe("Stage 6G: 販売・買取の集計", () => {
  const r = (shop: string, kind: "sell" | "buy", price: number, cond = "", stock = 1) => parse([line(shop, kind, "S", "1/1", "x", "R", cond, price, stock)]).rows.find((x) => x.shopKey === shop && x.set === "S")!;
  it("販売と買取を別々に集計し、中央値・最安販売・最高買取を返す", () => {
    const rows = [r("a", "sell", 1000), r("b", "sell", 1200), r("c", "sell", 1100), r("d", "buy", 800), r("e", "buy", 900)];
    const s = aggregate(rows, "sell")!;
    expect(s).toMatchObject({ medianYen: 1100, lowYen: 1000, highYen: 1200, samples: 3 });
    const b = aggregate(rows, "buy")!;
    expect(b).toMatchObject({ medianYen: 850, highYen: 900, samples: 2 });
  });
  it("売切・状態違い(B/C)は集計に混ぜない。件数は記録する", () => {
    const rows = [r("a", "sell", 1000), r("b", "sell", 500, "", 0), r("c", "sell", 400, "状態B"), r("d", "sell", 1100, "状態A-")];
    const s = aggregate(rows, "sell")!;
    expect(s.samples).toBe(2);
    expect(s.lowYen).toBe(1000);
    expect(s.excluded).toBe(2);
  });
  it("同じ店舗の複数行は1件（販売=最安／買取=最高）", () => {
    const rows = [r("a", "sell", 1500), r("a", "sell", 1000)];
    expect(aggregate(rows, "sell")).toMatchObject({ samples: 1, lowYen: 1000 });
  });
  it("極端な外れ値は集計から外す（3件以上）。1件だけのときはそのまま『1件』", () => {
    const rows = [r("a", "sell", 1000), r("b", "sell", 1100), r("c", "sell", 1050), r("d", "sell", 90000)];
    const s = aggregate(rows, "sell")!;
    expect(s.outliers).toBe(1);
    expect(s.highYen).toBe(1100);
    expect(aggregate([r("a", "sell", 700)], "sell")).toMatchObject({ samples: 1, medianYen: 700 });
  });
  it("売切のみ・データなしは null", () => {
    expect(aggregate([r("a", "sell", 1000, "", 0)], "sell")).toBeNull();
    expect(aggregate([], "buy")).toBeNull();
  });
});

describe("Stage 6G: 一括更新（コレクション全体を1回のCSVで）", () => {
  it("同じカードの重複は1回だけ処理し、更新・未掲載・未確定・情報不足を数える", () => {
    const csvv = parse([
      line("a", "sell", "SV8A", "217/187", "ブラッキーex", "SAR", "", 56000),
      line("b", "sell", "SV8A", "217/187", "ブラッキーex", "SAR", "", 59800),
      line("c", "buy", "SV8A", "217/187", "ブラッキーex", "SAR", "", 44000),
      line("a", "sell", "SV8A", "211/187", "エーフィex", "SAR", "", 7000, 0),
    ]);
    const cards = [
      { id: "1", setCode: "SV8a", cardNumber: "217/187", rarity: "SAR", name: "ブラッキーex" },
      { id: "1", setCode: "SV8a", cardNumber: "217/187", rarity: "SAR", name: "ブラッキーex" },
      { id: "2", setCode: "SV8a", cardNumber: "211/187", rarity: "SAR", name: "エーフィex" }, // 売切のみ
      { id: "3", setCode: "SV1", cardNumber: "5/70", rarity: "R", name: "どこにもない" },
      { id: "4", setCode: "", cardNumber: "", rarity: "", name: "番号なし" },
    ];
    const { results, summary } = computeMarket(cards, csvv);
    expect(summary).toEqual({ total: 4, updated: 1, unlisted: 1, ambiguous: 0, insufficient: 1, noPrice: 1 });
    const one = results.find((x) => x.cardId === "1")!;
    expect(one.sale).toMatchObject({ lowYen: 56000, samples: 2 });
    expect(one.buyback).toMatchObject({ highYen: 44000, samples: 1 });
  });
});
