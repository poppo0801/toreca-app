/**
 * 調査エージェントの結果 → 共通モデル（案件ファイル）（Stage 9H-3B・純関数）。
 * 台帳の項目単位の結果（採用値・状態・根拠・矛盾）に、抽選形態・選べる店舗・当選発表の終了日を加え、
 * 取得したのに報告されなかったページ・統合しなかった情報源も「黙って捨てずに」記録する。
 * ここで作る案件ファイルは、通常収集の入口（case-model/merge.ts）にそのまま渡せる。
 */
import type { FieldKey } from "@/lib/collector/fields";
import { addDecision, emptyCase, type CaseFieldKey, type CaseFieldState, type CaseFile, type CaseSource, type EvidenceRef } from "@/lib/case-model/types";
import type { CaseInvestigationResult } from "./engine";
import type { CaseTarget, FieldRecord, FieldStateX, SourceRecord } from "./ledger";
import { looksLikeStoreList } from "./tools";

const KEY_MAP: Partial<Record<FieldKey, CaseFieldKey>> = {
  chain: "chain",
  store: "store",
  items: "items",
  applyStart: "applyStart",
  applyDeadline: "applyDeadline",
  resultDate: "resultStart",
  applyMethod: "applyMethod",
  conditions: "conditions",
  applyUrl: "applyUrl",
  receiveMethod: "receiveMethod",
};

const STATE: Record<FieldStateX, CaseFieldState> = { confirmed: "confirmed", unverified: "unverified", conflict: "conflict", manual: "manual", missing: "missing" };
const SOURCE_STATUS: Record<SourceRecord["status"], CaseSource["status"]> = { fetched: "used", failed: "failed", different_lottery: "not_same", quarantined: "not_same", unreported: "unreported" };

const refsOf = (f: FieldRecord): EvidenceRef[] => f.sources.filter((s) => s.url && !s.url.startsWith("(")).map((s) => ({ url: s.url, kind: s.kind, tier: s.tier, ...(s.basis ? { basis: s.basis as EvidenceRef["basis"] } : {}), ...(s.quote ? { quote: s.quote } : {}), at: s.at }));

/**
 * 9H-3F相当の再現（9H-3I）: 同じ調査結果から、LivePocket本文の構造解析で補った項目（via=structure）を除く。
 * AIの報告・取得した情報は同じで、9H-3Hで追加した構造解析の反映だけが無い状態になる（BとCの差が新機能によるものか確認するため）
 */
export function withoutStructure(r: CaseInvestigationResult): CaseInvestigationResult {
  return { ...r, extras: (r.extras ?? []).filter((x) => x.via !== "structure"), livepocket: (r.livepocket ?? []).map((x) => ({ ...x, applied: null, note: `${x.note}（9H-3F相当: 構造解析は反映しない）`.slice(0, 260) })) };
}

export function resultToCaseFile(r: CaseInvestigationResult, target: CaseTarget, at: string): CaseFile {
  const c = emptyCase(target.id, at);
  for (const s of r.sources) {
    c.sources.push({ url: s.url, kind: s.kind, tier: s.tier, status: s.fetchedAt ? SOURCE_STATUS[s.status] : "registered", ...(s.fetchedAt ? { fetchedAt: s.fetchedAt } : {}), ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}), ...(s.failReason ? { note: s.failReason } : {}) });
  }
  const extrasAll = r.extras ?? [];
  const form = extrasAll.find((x) => x.key === "form");
  const storeSelect = form?.value === "store_select" || target.storeMode === "select_on_apply";
  for (const f of [...r.fields, ...(r.extraFields ?? [])]) {
    const k = KEY_MAP[f.field];
    if (!k) continue;
    if (f.state === "missing") continue;
    // 店舗: 店舗選択式なら店舗の値にしない。複数店舗の羅列は店舗の値にしない（選べる店舗の候補として保持する）
    if (k === "store" && f.adopted && (storeSelect || looksLikeStoreList(f.adopted))) {
      c.unreflected.push({ key: "store", value: f.adopted, reason: storeSelect ? "店舗選択式のため店舗の値にしない（選べる店舗の候補）" : "複数店舗の羅列は店舗の値にしない（店舗選択式か店舗別かを判断できていない）", evidence: refsOf(f) });
      addDecision(c, { stage: "investigation", field: "store", kind: "held", before: f.adopted, after: null, by: "fixed", reason: storeSelect ? "店舗選択式のため店舗の値にしない" : "複数店舗の羅列は店舗の値にしない" });
      continue;
    }
    c.fields[k] = {
      value: f.adopted,
      state: STATE[f.state],
      by: f.state === "manual" ? "human" : "investigation",
      evidence: refsOf(f),
      alternatives: f.alternatives.map((a) => ({ value: a.value, evidence: a.sources.map((u) => ({ url: u })) })),
      ...(f.note ? { note: f.note } : {}),
    };
    addDecision(c, { stage: "investigation", field: k, kind: f.state === "conflict" ? "held" : "adopted", before: null, after: f.adopted, by: "investigation", reason: `${f.state === "confirmed" ? "確定" : f.state === "conflict" ? "矛盾" : f.state === "manual" ? "手動確定" : "未確認"}（${f.sources.length}件の根拠）` });
  }
  // 追加項目（抽選形態・選べる店舗・当選発表の終了日）。一次情報を優先した最初の1件を採用し、残りは別の値として保持する
  for (const key of ["form", "selectableStores", "resultEnd"] as const) {
    const xs = extrasAll.filter((x) => x.key === key);
    if (!xs.length) continue;
    const k: CaseFieldKey = key === "resultEnd" ? "resultEnd" : key;
    const first = xs[0];
    c.fields[k] = {
      value: first.value,
      state: first.tier === "primary" ? "confirmed" : "unverified",
      by: "investigation",
      evidence: [{ url: first.sourceUrl, kind: first.kind, tier: first.tier, ...(first.basis ? { basis: first.basis } : {}), quote: first.quote, at: first.at }],
      alternatives: xs.slice(1).filter((x) => x.value !== first.value).map((x) => ({ value: x.value, evidence: [{ url: x.sourceUrl, quote: x.quote }] })),
    };
    addDecision(c, { stage: "investigation", field: k, kind: "adopted", before: null, after: first.value, by: "investigation", reason: `ページの構造・記載から読み取った（${first.tier === "primary" ? "一次情報" : "二次情報"}）` });
  }
  // 手動で確定した項目は、人間が確定した状態として引き継ぐ
  const lockedMap: Partial<Record<FieldKey, CaseFieldKey>> = { ...KEY_MAP };
  c.humanLocked = target.manualFields.map((f) => lockedMap[f]).filter((x): x is CaseFieldKey => !!x);
  // 黙って捨てない: 取得したが報告されなかったページ・同じ抽選と確認できず統合しなかった情報源
  // AIの報告が安全検証で拒否・保留された項目を、項目単位で記録する（どの検証が・なぜ。台帳に入らなかったAIの判断を追えるようにする）
  for (const s of r.steps ?? []) {
    if (s.tool !== "report_page_findings") continue;
    const d = (s.detail ?? {}) as { rejected?: { field: string; reason: string }[]; skipped?: { field: string; reason: string }[] };
    const where = s.target ? `（${s.target.slice(0, 80)}）` : "";
    for (const x of d.rejected ?? []) addDecision(c, { stage: "investigation", field: KEY_MAP[x.field as FieldKey] ?? "general", kind: "rejected", before: null, after: null, by: "fixed", reason: `検証で不採用${where}: ${x.reason}` });
    for (const x of d.skipped ?? []) addDecision(c, { stage: "investigation", field: KEY_MAP[x.field as FieldKey] ?? "general", kind: "held", before: null, after: null, by: "fixed", reason: `統合しない${where}: ${x.reason}` });
  }
  // 応募サービスのページの主催者の確認結果（主催者本文を一次扱いにしたか）
  for (const s of r.sources) {
    if (!s.organizer || s.organizer.status === "not_applicable") continue;
    addDecision(c, { stage: "investigation", field: "general", kind: "noted", before: s.url, after: s.organizer.status, by: "fixed", reason: `主催者の確認: ${s.organizer.status === "verified" ? "確認済み（主催者本文を一次情報として扱う）" : "未確認（二次情報のまま）"}（${s.organizer.basis}）` });
    const cs = c.sources.find((x) => x.url === s.url);
    if (cs) cs.note = [cs.note, `主催者: ${s.organizer.status === "verified" ? "確認済み" : "未確認"}（${s.organizer.basis}）`].filter(Boolean).join(" / ");
  }
  // LivePocketの構造解析（9H-3H）: 抽選形態に反映したか／反映しなかった理由（C・食い違い・別の抽選）を記録する
  for (const lp of r.livepocket ?? []) {
    const k = lp.structure.klass;
    addDecision(c, { stage: "investigation", field: "form", kind: lp.applied ? "adopted" : "held", before: lp.url, after: lp.applied?.form ?? null, by: "fixed", reason: `LivePocketの構造解析=${k === "A" ? "店舗選択式" : k === "B" ? "店舗別独立" : k === "conflict" ? "食い違い（人の確認）" : "不明"}（${lp.structure.confidence === "high" ? "信頼度高" : lp.structure.confidence === "medium" ? "信頼度中" : "信頼度低"}）${lp.applied ? "。抽選形態の根拠に使った" : "。抽選形態には反映していない"}: ${lp.note}`.slice(0, 300) });
  }
  for (const u of r.unreported ?? []) addDecision(c, { stage: "investigation", field: "general", kind: "dropped", before: u, after: null, by: "fixed", reason: "取得したが報告されなかったため、台帳に反映していない" });
  for (const n of r.notMerged) addDecision(c, { stage: "investigation", field: "general", kind: "rejected", before: n.url, after: null, by: "fixed", reason: n.reason });
  addDecision(c, { stage: "investigation", field: "general", kind: "noted", before: null, after: r.stopReason, by: "investigation", reason: `調査の終了: ${r.stopLabel}` });
  return c;
}
