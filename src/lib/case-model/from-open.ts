/**
 * 保存済みの候補（確認待ち・追跡中の草稿）→ 案件ファイル（Stage 9H-3E・純関数）。
 * 同じ抽選の別の候補（Xの投稿・まとめ・応募ページなど、別々に収集された記載）を、統合処理（integrate.ts）へ渡すための変換。
 * 項目ごとの出どころ（情報源の種類・主催者本文か受付表示か）は、候補が持つ項目別の根拠（FieldMap）から作る。
 */
import { isOfficial, type FieldKey, type FieldMap, type FieldSource } from "@/lib/collector/fields";
import type { LotteryInput } from "@/lib/lottery-input";
import { caseFromInput } from "./from-extraction";
import type { CaseFieldKey, CaseFile, EvidenceRef } from "./types";

export interface OpenLike {
  id: string;
  input: LotteryInput;
  fields: FieldMap;
  source: FieldSource;
  created_at: string;
}

const KEY_TO_FIELD: Partial<Record<CaseFieldKey, FieldKey>> = { chain: "chain", store: "store", items: "items", applyStart: "applyStart", applyDeadline: "applyDeadline", resultStart: "resultDate", applyMethod: "applyMethod", conditions: "conditions", receiveMethod: "receiveMethod" };

const refOf = (s: FieldSource): EvidenceRef => ({ url: s.url, kind: s.kind, tier: isOfficial(s.kind) ? "primary" : "secondary", ...(s.basis ? { basis: s.basis } : {}), at: s.at, origin: s.origin });

export function caseFromOpen(o: OpenLike): CaseFile {
  const c = caseFromInput(o.input, o.id, o.created_at, "ai");
  c.sources.push({ url: o.source.url, kind: o.source.kind, tier: isOfficial(o.source.kind) ? "primary" : "secondary", status: "used", fetchedAt: o.source.at });
  for (const [ck, fk] of Object.entries(KEY_TO_FIELD) as [CaseFieldKey, FieldKey][]) {
    const f = c.fields[ck];
    if (!f.value) continue;
    const prov = o.fields[fk];
    const src = prov?.source ?? o.source;
    f.evidence = [refOf(src)];
    f.state = prov?.state === "confirmed" ? "confirmed" : prov?.state === "conflict" ? "conflict" : "inferred";
    if (prov?.manual) {
      f.state = "manual";
      f.by = "human";
      c.humanLocked.push(ck);
    }
    if (prov?.alt) f.alternatives = [{ value: prov.alt.value, evidence: [refOf(prov.alt.source)] }];
  }
  // 抽選形態・選べる店舗: 候補の登録内容（店舗選択式）から。根拠は、その候補の情報源
  for (const k of ["form", "selectableStores"] as CaseFieldKey[]) if (c.fields[k].value) c.fields[k].evidence = [{ ...refOf(o.source), quote: "候補の登録内容（店舗選択式）" }];
  return c;
}
