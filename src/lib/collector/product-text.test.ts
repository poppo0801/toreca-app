// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyItemsChange, isItemsChangeUnsafe, sanitizeItemsValue, splitProductDetail } from "./product-text";

/** Stage 9H-3I: 商品名と詳細（価格・購入制限）の分離、商品の変更の分類（安全停止の判定）。特定の商品・系列に合わせた例外は無い */
const BASE = "30th CELEBRATION カードセット 9種セット";
const DECORATED = "ポケモンカードゲーム 30th CELEBRATION カードセット （9種セット） 購入可能数：お一人様9種1セットまで 販売価格：10800円（税込）";

describe("商品名から詳細（価格・購入制限など）を分ける", () => {
  it("価格・購入制限が付いた商品名 → 正式な商品名と詳細に分ける。詳細は捨てずに残す", () => {
    const r = splitProductDetail(DECORATED);
    expect(r.name).toBe("ポケモンカードゲーム 30th CELEBRATION カードセット (9種セット)");
    expect(r.details.join("")).toContain("購入可能数");
    expect(r.details.join("")).toContain("10800円");
  });
  it("詳細の語が無い商品名はそのまま。商品名が無く詳細だけのときは、商品名は空（採用しない）", () => {
    expect(splitProductDetail("拡張パック ハドウシーカー")).toEqual({ name: "拡張パック ハドウシーカー", details: [] });
    expect(splitProductDetail("販売価格：10800円（税込）").name).toBe("");
  });
  it("【抽選販売】のような見出しを商品名の詳細として切らない", () => {
    expect(splitProductDetail("【抽選販売】拡張パック ハドウシーカー").name).toBe("【抽選販売】拡張パック ハドウシーカー");
  });
});

describe("商品の変更の分類と、安全停止の判定", () => {
  const unsafe = (b: string[], a: string[]) => isItemsChangeUnsafe(classifyItemsChange(b, a));
  it("同じ商品への詳細情報（価格・購入制限）の追加だけ: 停止しない", () => {
    const c = classifyItemsChange([BASE], [BASE, DECORATED]);
    expect(c.kind).toBe("detail_only");
    expect(unsafe([BASE], [BASE, DECORATED])).toBe(false);
    expect(unsafe([BASE], [DECORATED])).toBe(false);
  });
  it("商品名の表記揺れ（全角半角・括弧・空白）: 停止しない", () => {
    expect(classifyItemsChange(["拡張パック ハドウシーカー"], ["拡張パック　ハドウシーカー"]).kind).toBe("same");
    expect(unsafe([BASE], ["30th CELEBRATION カードセット （9種セット）"])).toBe(false);
  });
  it("別の商品の混入・置き換え: 停止する（商品名の変更を無条件に許可しない）", () => {
    expect(classifyItemsChange(["拡張パック ハドウシーカー"], ["拡張パック ハドウシーカー", "拡張パック ニンジャスピナー"]).kind).toBe("added_different");
    expect(classifyItemsChange(["拡張パック ハドウシーカー"], ["拡張パック ニンジャスピナー"]).kind).toBe("replaced");
    expect(unsafe(["拡張パック ハドウシーカー"], ["拡張パック ニンジャスピナー"])).toBe(true);
  });
  it("似ているが別の商品（「30th CELEBRATION」と「30th CELEBRATION カードセット」）を同じとみなさない: 停止する", () => {
    expect(unsafe(["30th CELEBRATION"], ["30th CELEBRATION", BASE])).toBe(true);
  });
  it("複数商品の抽選: 同じ複数商品の詳細の追加は停止しない。商品が1つ増えたら停止する", () => {
    const two = ["拡張パック ハドウシーカー", BASE];
    expect(unsafe(two, [...two, "ポケモンカードゲーム 拡張パック ハドウシーカー 購入可能数：1人1BOXまで"])).toBe(false);
    expect(unsafe(two, [...two, "スペシャルデッキセット MEGA"])).toBe(true);
  });
  it("商品名が不明（説明だけ）・変更前の商品名が判断できない: 判断できないので安全停止", () => {
    expect(classifyItemsChange([BASE], ["販売価格：10800円（税込）"]).kind).toBe("undetermined");
    expect(unsafe(["購入可能数：1人1個まで"], [BASE])).toBe(true);
  });
  it("商品が無い状態から商品が加わった場合も、別商品の追加として扱う（確認が必要）", () => {
    expect(classifyItemsChange([], [BASE]).kind).toBe("added_different");
  });
});

/** 保存済みの実AI調査結果（9H-3I・停止した事例）での再現。保存が無い環境ではスキップ */
const RUNS = "backups/eval-9h3i/runs";
const has = existsSync(RUNS);
describe.skipIf(!has)("保存済みの実AI調査結果（フルコンプ）での再現", () => {
  it("停止原因の商品変更は『同じ商品への詳細（購入数量・価格）の追加だけ』と分類され、修正後は停止しない。別商品は混入していない", () => {
    type Dec = { stage: string; kind: string; field: string; before: string; after: string };
    // 修正前の実行（商品に詳細が付いて停止した記録）を探す。後の再利用の実行（整え直した結果）には、この変更は残らない
    let d: Dec | undefined;
    for (const r of readdirSync(RUNS).sort()) {
      const f = `${RUNS}/${r}/case-k-2c187ae1.json`;
      if (!existsSync(f)) continue;
      const j = JSON.parse(readFileSync(f, "utf8")) as { arms: { C: { judgment?: { decisions?: Dec[] } } } | null };
      d = d ?? (j.arms?.C.judgment?.decisions ?? []).find((x) => x.stage === "merge" && x.kind === "changed" && x.field === "items");
    }
    expect(d).toBeDefined();
    const c = classifyItemsChange(String(d!.before).split(" / "), String(d!.after).split(" / "));
    expect(c.kind).toBe("detail_only");
    expect(isItemsChangeUnsafe(c)).toBe(false);
    // 修正前の規則（商品名が変わったら停止）では停止していた
    expect(d!.before).not.toBe(d!.after);
  });
});

describe("長音記号で終わる商品名を壊さない", () => {
  it("「ハドウシーカー 購入可能数…」→ 名前は『ハドウシーカー』（末尾の長音を落とさない）", () => {
    expect(splitProductDetail("ハドウシーカー 購入可能数：お一人様1BOXまで").name).toBe("ハドウシーカー");
  });
});

describe.skipIf(!has)("保存済みの実AIの報告（フルコンプ）: 修正後の経路でも商品が増えない", () => {
  it("AIが報告した商品の値（説明つき）を、修正後の正規化に通すと、登録済みの商品と同じ商品になり、停止対象にならない", () => {
    let steps: { tool: string; detail?: { reported?: { observations?: { field: string; value: string }[] } } }[] = [];
    for (const r of readdirSync(RUNS).sort()) {
      const f = `${RUNS}/${r}/case-k-2c187ae1.json`;
      if (existsSync(f)) steps = (JSON.parse(readFileSync(f, "utf8")) as { investigation: { result: { steps: typeof steps } } }).investigation.result.steps;
    }
    const values = steps.filter((s) => s.tool === "report_page_findings").flatMap((s) => s.detail?.reported?.observations ?? []).filter((o) => o.field === "items").map((o) => o.value);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      const sp = splitProductDetail(v);
      expect(sp.name).not.toContain("購入可能数");
      expect(sp.name).not.toContain("円");
      expect(isItemsChangeUnsafe(classifyItemsChange([BASE], [BASE, sp.name]))).toBe(false);
    }
  });
});

describe("保存済みの調査結果の整え直し（sanitizeItemsValue）", () => {
  it("同じ商品を1つにまとめ、詳細を除く。別の商品は残す", () => {
    expect(sanitizeItemsValue(`${BASE} / ${DECORATED}`)).toBe(BASE);
    expect(sanitizeItemsValue("拡張パック ハドウシーカー / スペシャルデッキセット MEGA 販売価格：3000円")).toBe("拡張パック ハドウシーカー / スペシャルデッキセット MEGA");
  });
});

describe("数量・入数の表記（1BOX・30パック入）は商品名の詳細として分ける（9H-3J）", () => {
  it("「ハドウシーカー 1BOX（30パック入）」→ 商品名は『ハドウシーカー』。同じ商品の表記違いとして、隔離しない", () => {
    expect(splitProductDetail("ポケモンカードゲーム MEGA 拡張パック ハドウシーカー 1BOX（30パック入）").name).toBe("ポケモンカードゲーム MEGA 拡張パック ハドウシーカー");
    expect(splitProductDetail("「ストームエメラルダ」(1BOX)").name).toBe("「ストームエメラルダ」");
    const ch = classifyItemsChange(["ポケモン Pokemon ポケモンカードゲーム MEGA 拡張パック ハドウシーカー"], ["ポケモン Pokemon ポケモンカードゲーム MEGA 拡張パック ハドウシーカー", "ポケモンカードゲーム MEGA 拡張パック ハドウシーカー 1BOX（30パック入）"]);
    expect(ch.kind).toBe("detail_only");
    expect(isItemsChangeUnsafe(ch)).toBe(false);
    expect(isItemsChangeUnsafe(classifyItemsChange(["拡張パック ハドウシーカー"], ["拡張パック ハドウシーカー", "拡張パック ニンジャスピナー 1BOX"]))).toBe(true);
  });
  it("数字を含む正式な商品名（30th CELEBRATION・9種セット・BOXなしの商品名）は壊さない", () => {
    expect(splitProductDetail("30th CELEBRATION カードセット 9種セット").name).toBe("30th CELEBRATION カードセット 9種セット");
    expect(splitProductDetail("スペシャルデッキセット MEGA").name).toBe("スペシャルデッキセット MEGA");
    expect(splitProductDetail("拡張パック ハドウシーカー BOX").name).toBe("拡張パック ハドウシーカー BOX");
  });
});

describe.skipIf(!has)("保存済みの実AI調査結果（ヨドバシ）: 数量・入数の表記の違いだけの商品変更は、停止対象にならない", () => {
  it("「ハドウシーカー 1BOX（30パック入）」の追加は、同じ商品の詳細の追加と判定される（修正前は別商品の追加として隔離された）", () => {
    let sj: { before: string; after: string }[] = [];
    for (const r of readdirSync(RUNS).sort()) {
      const f = `${RUNS}/${r}/case-k-1bd7131b.json`;
      if (existsSync(f)) sj = (JSON.parse(readFileSync(f, "utf8")) as { stopJudgments?: { before: string; after: string }[] }).stopJudgments ?? sj;
    }
    expect(sj.length).toBeGreaterThan(0);
    for (const d of sj) expect(isItemsChangeUnsafe(classifyItemsChange(d.before.split(" / "), d.after.split(" / ")))).toBe(false);
  });
});
