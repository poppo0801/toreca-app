import "server-only";
import type { Evidence } from "@/lib/master-identity/learning";
import type { CaseField, CaseFile } from "@/lib/case-model/types";
import { resolveMasterAndLearn } from "@/lib/server/master-identity/alias-service";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 通常の収集（自動収集・自律型AI）の調査結果（案件ファイル）から、系列・商品の表記を名寄せ機構へ渡す（Stage 9H-3S-2）。
 * 根拠: 調査で「確認済み」になった項目の情報源に、一次情報（公式）があれば official_source、独立した出どころが2つ以上あれば independent_sources。
 * 推定・未確認・矛盾の項目は渡さない。根拠が足りなければ関連候補として保持され、AI推定の別名だけを根拠に別名は増えない（learning.ts）。失敗しても収集は止めない。
 */
export function evidenceOfField(f: CaseField): Evidence[] {
  if (f.state !== "confirmed" || !f.value) return [];
  const ev: Evidence[] = [];
  const primary = f.evidence.filter((e) => e.tier === "primary");
  if (primary.length > 0) ev.push({ kind: "official_source", detail: primary[0].url });
  const origins = new Set(f.evidence.map((e) => e.origin ?? e.url).filter(Boolean));
  if (origins.size >= 2) ev.push({ kind: "independent_sources", sources: origins.size });
  return ev;
}

export async function learnFromCaseFile(db: Db, householdId: string, c: CaseFile, actor: string | null = null): Promise<{ learned: number; held: number }> {
  let learned = 0;
  let held = 0;
  const names: { kind: "chain" | "product"; name: string; ev: Evidence[] }[] = [];
  const chain = c.fields.chain;
  if (chain?.value) names.push({ kind: "chain", name: chain.value, ev: evidenceOfField(chain) });
  const items = c.fields.items;
  if (items?.value) for (const n of items.value.split(" / ").map((x) => x.trim()).filter(Boolean)) names.push({ kind: "product", name: n, ev: evidenceOfField(items) });
  for (const n of names) {
    try {
      const r = await resolveMasterAndLearn(db, householdId, n.kind, n.name, { origin: "ai", evidence: n.ev, actor });
      if (r.persisted === "alias") learned++;
      else if (r.persisted === "candidate") held++;
    } catch {
      /* 学習は補助機能 */
    }
  }
  return { learned, held };
}
