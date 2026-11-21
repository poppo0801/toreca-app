// @vitest-environment node
/** 一覧投稿の分割・対象案件への絞り込み・出力途切れ時の再分割（Stage 10I）。架空データのみ。実AI・ネットワークには触れない。 */
import { describe, expect, it } from "vitest";
import type { CurrentCase } from "./contract";
import { chunkGroups, composeText, focusOnCase, judgeChunkWithSplit, splitListPost, type ChunkJudgeResult } from "./list-split";

const HEAD = "🌋架空地方 | 3件 (1/1)";
const LIST = `${HEAD} 《サンプル店A（架空県）- 2件》 ・架空TCG 拡張パック「テスト弾」 https://t.co/aaa - 4/8(水)23:59〆 ・架空TCG スターターセット https://t.co/bbb - 4/9(木)23:59〆 《サンプル店B（架空県）- 1件》 ・架空TCG 拡張パック「テスト弾」 https://t.co/ccc - 4/8(水)23:59〆 《サンプルチェーンC 各店 (全国各地) - 1件》 ・架空TCG 拡張パック「テスト弾」 https://t.co/ddd - 4/10(金)23:59〆`;
const cur = (o: Partial<CurrentCase>): CurrentCase => ({ chain: null, store: null, products: [], applyStart: null, applyDeadline: null, resultDate: null, storeMode: "fixed", ...o });

describe("一覧の分割", () => {
  it("見出しと項目で分け、共通の冒頭を保持する。印が2つ未満なら一覧ではない（分割しない）", () => {
    const s = splitListPost(LIST);
    expect(s.isList).toBe(true);
    expect(s.header).toContain("架空地方");
    expect(s.groups.map((g) => g.items.length)).toEqual([2, 1, 1]);
    expect(splitListPost("単独の告知 架空TCG 抽選 4/8まで").isList).toBe(false);
    expect(splitListPost("《サンプル店A（架空県）- 1件》 ・架空TCG").isList).toBe(false);
  });
  it("商品名の中の・では項目を割らない（空白の直後の・だけが項目の印）", () => {
    const s = splitListPost(`${HEAD} 《店X（県）- 1件》 ・架空TCG セット ナエトル・ヒコザル・ポッチャマ - 4/8〆 《店Y（県）- 1件》 ・架空TCG パック - 4/9〆`);
    expect(s.groups[0].items).toHaveLength(1);
  });
  it("🏬形式（🏬店舗名 ✅商品 ⏰締切）も分けられる", () => {
    const s = splitListPost("まとめ 🏬店P ✅商品1 ⏰4/8まで 🏬店Q ✅商品2 ⏰4/9まで");
    expect(s.isList).toBe(true);
    expect(s.groups).toHaveLength(2);
  });
});

describe("対象案件への絞り込み: 関係する項目だけを渡し、特定できなければ推測しない", () => {
  const s = splitListPost(LIST);
  it("店舗が一意に見つかれば、その店舗の項目だけ（商品・締切で項目も絞る）。他の店舗・項目は対象外として数える", () => {
    const f = focusOnCase(s, cur({ chain: "サンプルチェーン", store: "サンプル店A", products: ["架空TCG スターターセット"], applyDeadline: "2099-04-09" }));
    expect(f.reason).toBe("unique_store");
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].items).toHaveLength(1);
    expect(f.groups[0].items[0]).toContain("スターターセット");
    expect(f.excludedItems).toBe(3);
    const text = composeText(s.header, f.groups);
    expect(text).toContain("架空地方");
    expect(text).not.toContain("サンプル店B");
  });
  it("店舗が一般的な語（店舗選択・通販）や未登録で、系列が一意に見つかれば系列で絞る", () => {
    expect(focusOnCase(s, cur({ chain: "サンプルチェーンC", store: "応募時に店舗選択", products: ["架空TCG テスト弾"] })).reason).toBe("unique_chain");
  });
  it("該当なし・複数該当・項目が絞れないときは、判断に渡さず理由を残す（推測で結び付けない）", () => {
    expect(focusOnCase(s, cur({ chain: "別系列", store: "存在しない店" })).reason).toBe("none");
    expect(focusOnCase(s, cur({ store: "サンプル店" })).reason).toBe("ambiguous");
    const many = splitListPost(`${HEAD} 《サンプル店Z（県）- 3件》 ・架空TCG パック https://t.co/1 - 4/8〆 ・架空TCG パック https://t.co/2 - 4/8〆 ・架空TCG パック https://t.co/3 - 4/8〆 《サンプル店W（県）- 1件》 ・架空TCG パック - 4/9〆`);
    const f = focusOnCase(many, cur({ store: "サンプル店Z", products: ["架空TCG パック"], applyDeadline: "2099-04-08" }));
    expect(f.reason).toBe("ambiguous");
    expect(f.groups).toEqual([]);
    expect(focusOnCase(splitListPost("単独"), cur({ store: "サンプル店Z" })).reason).toBe("not_list");
  });
});

describe("項目の絞り込み: 完全一致を優先し、登録商品が複数ならすべて残す", () => {
  const ev = splitListPost(`${HEAD} 《サンプルホールQ（架空県）- 4件》 ・架空大会 2099 オープン Day1 個人戦 https://t.co/1 - 4/8(水)09:00〆 ・架空大会 2099 ジュニア Day1 個人戦 https://t.co/2 - 4/8(水)09:00〆 ・架空大会 2099 オープン Day2 個人戦 https://t.co/3 - 4/9(木)09:00〆 ・架空大会 2099 ジュニア Day2 個人戦 https://t.co/4 - 4/9(木)09:00〆 《サンプルホールR（架空県）- 2件》 ・架空TCG 商品あ https://t.co/5 - 4/8〆 ・架空TCG 商品い https://t.co/6 - 4/9〆`);
  it("商品名の先頭が同じ項目が並んでも、商品名の全体が一致する項目だけに絞る（同じ締切の別項目を巻き込まない）", () => {
    const f = focusOnCase(ev, cur({ store: "サンプルホールQ", products: ["架空大会 2099 オープン Day1 個人戦"], applyDeadline: "2099-04-08" }));
    expect(f.reason).toBe("unique_store");
    expect(f.groups[0].items).toHaveLength(1);
    expect(f.groups[0].items[0]).toContain("オープン Day1");
  });
  it("登録商品が複数なら、該当する項目をすべて残す（別々の締切でも1つに絞らない）。登録商品に無い項目は残さない", () => {
    const f = focusOnCase(ev, cur({ store: "サンプルホールR", products: ["架空TCG 商品あ", "架空TCG 商品い"], applyDeadline: "2099-04-08" }));
    expect(f.groups[0].items).toHaveLength(2);
    const g = focusOnCase(ev, cur({ store: "サンプルホールR", products: ["架空TCG 商品あ"], applyDeadline: "2099-04-08" }));
    expect(g.groups[0].items).toHaveLength(1);
  });
  it("登録商品が1つで複数項目が該当し、締切でも絞れなければ推測せず ambiguous", () => {
    const f = focusOnCase(ev, cur({ store: "サンプルホールQ", products: ["架空大会 2099"], applyDeadline: "2099-04-30" }));
    expect(f.reason).toBe("ambiguous");
  });
});

describe("塊への分割と、出力途切れ時の再分割", () => {
  const big = splitListPost(`${HEAD} 《店M（県）- 8件》 ${Array.from({ length: 8 }, (_, i) => `・架空TCG 商品${i} https://t.co/${i} - 4/${i + 1}〆`).join(" ")} 《店N（県）- 1件》 ・架空TCG 商品9 - 4/9〆`);
  it("1塊の項目数を上限内に収める。全項目が漏れなく・重複なくどれかの塊に入り、各塊に見出しが付く", () => {
    const chunks = chunkGroups(big.groups, { maxItems: 4 });
    expect(chunks.every((c) => c.reduce((n, g) => n + g.items.length, 0) <= 4)).toBe(true);
    expect(chunks.flat().reduce((n, g) => n + g.items.length, 0)).toBe(9);
    expect(chunks.length).toBe(3);
    expect(chunks.flat().every((g) => g.label.startsWith("《"))).toBe(true);
  });
  it("失敗した塊は半分に割って再試行し、成功した部分は採用する。同じ巨大な要求を繰り返さない（深さ・回数の上限あり）", async () => {
    const seen: number[] = [];
    // 4項目を超える塊は「途切れる」想定で失敗させる
    const judge = async (text: string): Promise<ChunkJudgeResult> => {
      const n = (text.match(/商品\d/g) ?? []).length;
      seen.push(n);
      return n > 4 ? { ok: false, opportunities: 0, costJpy: 0.5, attempts: 1 } : { ok: true, opportunities: n, costJpy: 0.3, attempts: 1 };
    };
    const limits = { maxDepth: 3, calls: { used: 0, max: 30 }, cost: { spent: 0, max: 50 } };
    const runs = await judgeChunkWithSplit(big.header, big.groups, judge, limits);
    const ok = runs.filter((r) => r.ok);
    expect(ok.reduce((n, r) => n + r.opportunities, 0)).toBe(9); // 失敗した大きな塊の分は、割った塊で全て回収
    expect(seen[0]).toBe(9); // 最初の1回だけ全体
    expect(seen.slice(1).every((n) => n < 9)).toBe(true);
  });
  it("呼び出し回数・費用・深さの上限に達したら、それ以上は呼ばない（無限再試行しない）", async () => {
    let calls = 0;
    const judge = async (): Promise<ChunkJudgeResult> => {
      calls++;
      return { ok: false, opportunities: 0, costJpy: 1, attempts: 1 };
    };
    await judgeChunkWithSplit(big.header, big.groups, judge, { maxDepth: 6, calls: { used: 0, max: 5 }, cost: { spent: 0, max: 50 } });
    expect(calls).toBeLessThanOrEqual(5);
    calls = 0;
    await judgeChunkWithSplit(big.header, big.groups, judge, { maxDepth: 6, calls: { used: 0, max: 99 }, cost: { spent: 0, max: 3 } });
    expect(calls).toBeLessThanOrEqual(4);
  });
});
