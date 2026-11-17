// @vitest-environment node
// 9H-3O: 本番の候補プール（2026-11-17）の「対象外の地域」の除外を、9H-3Nの地域判定で再判定する（費用0・読み取りのみ。BUILD_9H3O=1）。
//  旧: 告知に記載された都道府県を、店舗の所在地として採用して除外（1,380候補中、321件が「告知に記載された都道府県」が根拠）。
//  新: 告知の都道府県と店舗名の地名が食い違うときは「不明（要確認）」にして除外しない。
//  結果: backups/eval-9h3o/region-replay.json（人間が確認できるよう、食い違い全件を店舗名・告知の都道府県・店舗名から読める都道府県・元URLつきで出す）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeRegion } from "./region";

const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const ON = process.env.BUILD_9H3O === "1" && existsSync(POOL);

describe.skipIf(!ON)("9H-3O 地域判定の再判定（保存済みデータ）", () => {
  it("食い違いを集計する", () => {
    const pool = JSON.parse(readFileSync(POOL, "utf8")) as { collectionSettings: { prefectures: string[] }; candidates: { id: string; status: string; url?: string; title?: string; reasons?: string[]; input?: { chain?: string; store?: string; products?: string[] } }[] };
    const target = new Set(pool.collectionSettings.prefectures);
    const rows: Record<string, unknown>[] = [];
    let regionExcluded = 0;
    let statedBasis = 0;
    let unchanged = 0;
    for (const c of pool.candidates) {
      const rs = c.reasons ?? [];
      const ex = rs.find((r) => /^対象外の地域です（/.test(r));
      if (!ex) continue;
      regionExcluded++;
      if (!rs.some((r) => /判定根拠: 告知に記載された都道府県/.test(r))) continue;
      statedBasis++;
      const stated = /^対象外の地域です（([^）]+?)）?$/.exec(ex.replace(/の店舗限定.*/, ""))?.[1] ?? "";
      const j = judgeRegion({ storeName: c.input?.store ?? "", statedPrefecture: stated });
      if (j.basis !== "conflict") {
        unchanged++;
        continue;
      }
      const fromName = j.conflict?.find((x) => x.basis !== "stated_prefecture");
      rows.push({
        id: c.id,
        status: c.status,
        chain: c.input?.chain,
        store: c.input?.store,
        product: c.input?.products?.[0] ?? null,
        statedPrefecture: stated,
        storeNamePrefecture: fromName?.prefecture ?? null,
        storeNameBasis: fromName?.note ?? null,
        inTargetRegion: fromName ? target.has(fromName.prefecture) : false,
        newJudgement: "不明（要確認・除外しない）",
        url: c.url ?? null,
        title: c.title ?? null,
      });
    }
    const inTarget = rows.filter((r) => r.inTargetRegion);
    mkdirSync("backups/eval-9h3o", { recursive: true });
    writeFileSync("backups/eval-9h3o/region-replay.json", JSON.stringify({ targetPrefectures: [...target], poolCandidates: pool.candidates.length, regionExcluded, statedBasis, conflict: rows.length, conflictInTargetRegion: inTarget.length, unchanged, rows }, null, 1));
    console.log(`地域除外 ${regionExcluded}件／うち根拠が告知の都道府県 ${statedBasis}件／食い違い ${rows.length}件（店舗名の地名が対象地域内 ${inTarget.length}件）／変わらない ${unchanged}件`);
    expect(statedBasis).toBeGreaterThan(0);
  });
});
