// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CaseLedger, type CaseTarget } from "./ledger";

/**
 * Stage 9H-3D: 保存済みの実AIの報告（backups/eval-9h3d の steps に保存された identity・observations）を、AIを再実行せずに、現在の台帳・同一抽選の照合へ通して再生する。
 * 実評価（修正前）では、カードラボ郡山の案件に、札幌店・静岡店・なんば店・甲府店の告知が統合された。現在のコードでは統合されないことを確認する。
 * backups/ は Git管理外。保存データが無い環境ではスキップ。
 */
const OUT = "backups/eval-9h3d/runs";
const have = existsSync(OUT);

type Saved = { variant?: string; investigation: { target: CaseTarget; result: { sources: { url: string; kind: string; tier: "primary" | "secondary" }[]; steps: { tool: string; target: string; detail?: { reported?: { identity: Record<string, unknown>; observations: { field: string; value: string; quote: string }[] } } }[] } } | null };

describe.skipIf(!have)("保存済みの実AIの報告の再生（カードラボ郡山: 別店舗の告知）", () => {
  it("保存された報告（札幌・静岡・なんば・甲府）は、対象の店舗が不明な案件に統合されない（保留）", () => {
    const saved: Saved[] = [];
    for (const run of readdirSync(OUT)) {
      const f = `${OUT}/${run}/case-k-1ca285c0.json`;
      if (existsSync(f)) saved.push(JSON.parse(readFileSync(f, "utf8")) as Saved);
    }
    expect(saved.length).toBeGreaterThan(0);
    let replayed = 0;
    for (const s of saved) {
      const inv = s.investigation;
      if (!inv) continue;
      const ledger = new CaseLedger(inv.target, () => "2026-11-15T00:00:00Z");
      for (const st of inv.result.steps.filter((x) => x.tool === "report_page_findings" && x.detail?.reported)) {
        const src = inv.result.sources.find((x) => x.url === st.target);
        if (!src) continue;
        ledger.recordFetchOk({ url: src.url, kind: src.kind as never, tier: src.tier, fetchedAt: "2026-11-15T00:00:00Z", origin: `u:${src.url}`, derivedFrom: null, injection: false });
        const rep = st.detail!.reported!;
        const r = ledger.integrate(st.target, rep.identity as never, rep.observations.map((o) => ({ field: o.field as never, value: o.value, quote: o.quote, sourceUrl: st.target })));
        // 識別が別の店舗の告知（対象の店舗が不明）→ 同じ抽選と認めない
        if (rep.identity.store) expect(r.identity.verdict, `${st.target} ${String(rep.identity.store)}`).not.toBe("same");
        expect(r.accepted).toEqual([]);
        replayed += 1;
      }
    }
    expect(replayed).toBeGreaterThan(0);
  });
});
