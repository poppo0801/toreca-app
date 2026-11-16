// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONDITIONS, DEFAULT_PREFECTURES } from "@/lib/collector/conditions";
import { judgeRegion } from "@/lib/collector/region";
import { checkRegionConditions, isRegionExcluded, regionContradictions, regionEvidence, resolveRegionConditions, type PoolForRegion } from "./region-check";
import type { PoolCandidate } from "./new-cases";

describe("評価の地域条件の検査（9H-3K）", () => {
  it("本番相当の条件と一致すれば問題なし。対象地域が東京都のみなど、食い違えば中止の理由を返す", () => {
    expect(checkRegionConditions(DEFAULT_CONDITIONS, DEFAULT_CONDITIONS)).toBeNull();
    expect(checkRegionConditions({ ...DEFAULT_CONDITIONS, prefectures: ["東京都"] }, DEFAULT_CONDITIONS)).toContain("一致しません");
    expect(checkRegionConditions({ ...DEFAULT_CONDITIONS, includeOnline: false }, DEFAULT_CONDITIONS)).toContain("通販");
    expect(checkRegionConditions({ ...DEFAULT_CONDITIONS, prefectures: [...DEFAULT_PREFECTURES].reverse() }, DEFAULT_CONDITIONS)).toBeNull();
  });
  it("地域除外は、情報を取得する前の除外（調査0回・理由に地域）だけ。取得失敗・個別の除外とは別", () => {
    expect(isRegionExcluded({ status: "excluded", reasons: ["対象外の地域です（石川県の店舗限定の抽選で…）"], investigationCalls: 0 })).toBe(true);
    expect(isRegionExcluded({ status: "excluded", reasons: ["対象外の地域です"], investigationCalls: 1 })).toBe(false);
    expect(isRegionExcluded({ status: "pending", reasons: ["取得に失敗しました"], investigationCalls: 0 })).toBe(false);
    expect(isRegionExcluded({ status: "excluded", reasons: ["利用者が除外しました"], investigationCalls: 0 })).toBe(false);
  });
});

/** 本番の候補プール（読み取り専用の書き出し）と、地域条件の整合（別途の正常性テスト） */
const POOL = "backups/eval-9h3f/pool-production-2026-11-16T01-35-35-964Z.json";
describe.skipIf(!existsSync(POOL))("地域除外の正常性（本番の記録との整合）", () => {
  const pool = JSON.parse(readFileSync(POOL, "utf8")) as { candidates: PoolCandidate[] };
  it("コードの既定の対象地域（東京都・千葉県・神奈川県を含む）は、本番の判定の記録と矛盾する＝本番の設定は既定と異なる（9H-3Kで検出した不一致）", () => {
    const ev = regionEvidence(pool);
    expect(regionContradictions(DEFAULT_PREFECTURES, ev).length).toBeGreaterThan(0);
  });
  it("記録から推定した対象地域は、本番の判定の記録と矛盾しない。通販の候補・地域名のない店舗は対象に含めない", () => {
    const r = resolveRegionConditions({ candidates: pool.candidates });
    expect(r.source).toBe("inferred_from_production_records");
    expect(r.conditions.prefectures.length).toBeGreaterThan(0);
    expect(regionContradictions(r.conditions.prefectures, regionEvidence(pool))).toEqual([]);
  });
  it("書き出しに本番の収集設定があれば、それを優先する（確定）", () => {
    const r = resolveRegionConditions({ ...pool, collectionSettings: { prefectures: ["兵庫県", "大阪府"], includeOnline: true, statusMode: "open" } });
    expect(r.source).toBe("production_settings");
    expect(r.conditions.prefectures).toEqual(["兵庫県", "大阪府"]);
  });
  it("地域を理由に除外された候補は、店舗名から判定した都道府県が対象地域（推定）の外にある", () => {
    const r = resolveRegionConditions({ candidates: pool.candidates });
    for (const c of pool.candidates.filter((x) => x.status === "excluded" && x.reasons.some((m) => /対象外の地域です/.test(m)))) {
      const j = judgeRegion({ storeName: c.input.store });
      if (j.prefecture && !c.input.selectable.length) expect(r.conditions.prefectures.includes(j.prefecture), c.id + j.prefecture).toBe(false);
    }
  });
});
