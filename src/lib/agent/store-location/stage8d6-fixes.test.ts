import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REAL_TARGETS } from "@/lib/agent/store-location/real-eval";
import { verifyResearch, type PageEvidence } from "@/lib/agent/store-location/verify";

/**
 * Stage 8D-6 の初回評価（実API・未知30店舗）で見つかった検証層の不備（初回の結果は変更していない。改善後は別に記録）の回帰テスト。保存した実ページを使用（有料APIなし）。
 *  - ゼロ幅文字（ZWSP）が住所と建物名の間にあると、住所が引用の中に無いと誤判定された（トイコンプ八尾店・公式ページ）
 *  - 公式ページの住所に都道府県が無い（「京都市下京区…」）と、AIが都道府県を補った住所が引用の中に無いと誤判定された（晴れる屋2 京都店・公式ページ）
 */
const fx = JSON.parse(readFileSync("src/lib/agent/store-location/fixtures/stage8d6-pages.json", "utf8")) as Record<string, { url: string; finalUrl: string; title: string; text: string }>;
const page = (k: string): PageEvidence => ({ ...fx[k], links: [], injection: false });
const store = (id: string) => REAL_TARGETS.find((t) => t.id === id)!.store;
const geo = async (q: string) => [{ title: q, lat: 35.1, lng: 135.1 }] as never;
const run = (id: string, p: PageEvidence, address: string, quote: string, st = store(id)) => verifyResearch({ store: st, proposal: { candidates: [{ address, sourceUrl: p.url, quote }] }, pages: [p], geocode: geo, limitReached: false });

describe("ゼロ幅文字（見えない文字）は比較から除く", () => {
  it("公式ページの「3番\u200Bアリオ八尾１F」を含む引用で、住所が引用の中にあると認める（実ページ: トイコンプ八尾店）", async () => {
    const p = page("toycomp_yao");
    expect(p.text).toMatch(/\u200B/); // 実ページに実際に入っていた
    const r = await run("T13", p, "大阪府八尾市光町2丁目3番 アリオ八尾1F", "大阪府八尾市光町2丁目3番\u200Bアリオ八尾１F");
    expect(r.candidates[0].addressInQuote).toBe(true);
    expect(r.status).toBe("confirmed"); // 公式（登録済み）に店舗名と住所が載っている
  });
});

describe("公式ページの住所に都道府県が無いとき、登録済みの都道府県と同じなら補って比べる", () => {
  it("「京都市下京区東洞院通…」（都道府県なし）の引用に対し、「京都府」を補った住所を認める（実ページ: 晴れる屋2 京都店）", async () => {
    const p = page("hareruya_kyoto");
    const r = await run("T15", p, "京都府京都市下京区東洞院通七条下る東塩小路町557番地1 YU-AIビル 6階", "京都市下京区東洞院通七条下る東塩小路町 557 番地1 YU-AIビル 6階");
    expect(r.candidates[0].quoteVerified).toBe(true);
    expect(r.candidates[0].addressInQuote).toBe(true);
  });
  it("登録済みの都道府県と異なる都道府県を補った住所は認めない。市区町村・番地が引用に無い住所も認めない", async () => {
    const p = page("hareruya_kyoto");
    const wrongPref = await run("T15", p, "大阪府京都市下京区東洞院通七条下る東塩小路町557番地1 YU-AIビル 6階", "京都市下京区東洞院通七条下る東塩小路町 557 番地1 YU-AIビル 6階");
    expect(wrongPref.candidates[0].addressInQuote).toBe(false);
    const other = await run("T15", p, "京都府京都市中京区烏丸通四条上る9-9-9", "京都市下京区東洞院通七条下る東塩小路町 557 番地1 YU-AIビル 6階");
    expect(other.candidates[0].addressInQuote).toBe(false);
  });
});
