/**
 * 人が確認できる比較資料（Stage 10Y・ローカル限定。Git管理外の eval/real-data/ にだけ書く）。**1事例＝1行**で、構造化したページの受付枠・元の文言・出典と、AIの候補値（とその根拠の種類）を並べる。
 * 「検証を通った」は正答率ではない（引用が原文に実在することしか確認していない）。値が根拠から導かれるか、応募単位（店舗選択式／店舗別／1フォーム1応募 など）が正しいかは、
 * 人が見て確かめる。独立した正解（gold）がある事例だけ採点し、無い事例は「不足」として具体的に整理する（曖昧な正答率を出さない）。
 */
import type { ApplyPageStructure } from "./page-structure";

export interface AiFieldView {
  field: string;
  basis: string;
  /** AIの候補値・引用は、保存されていれば出す（今回までの評価では保存していない＝null）。 */
  value?: string | null;
  quote?: string | null;
  valueInText?: boolean | null;
}
export interface AiResultView {
  decision: string;
  verified: boolean;
  held: string[] | null;
  end?: string;
  fields: AiFieldView[];
  quoteKinds?: string[];
}
export interface ReviewInput {
  id: string;
  host: string;
  structure: ApplyPageStructure | null;
  /** 元の文言（告知の原文または種）。長いものは切る */
  sourceText: string;
  ai: AiResultView | null;
  /** 独立した正解（人が根拠つきで確定したもの）。無ければ null */
  gold: { unit: string; basis: string | null } | null;
  /** 旧方式（決定論のページ構造解析）の読み取り: 受付枠数 */
  oldMethodSlots: number | null;
}
export interface ReviewRow {
  id: string;
  host: string;
  /** 構造化ページの受付枠（名称・状態・価格・「項目: 値」・注意書き） */
  slots: { title: string; tags: string[]; price: string | null; details: string[]; notes: string[] }[];
  pageNotes: string[];
  relatedEvents: number;
  sourceText: string;
  ai: AiResultView | null;
  oldMethodSlots: number | null;
  gold: { unit: string; basis: string | null } | null;
  scored: boolean;
  /** 人が確認すべき点（機械的に出せる範囲）。AIの確定の理由にはしない */
  toCheck: string[];
}

export function buildReviewRows(inputs: ReviewInput[]): ReviewRow[] {
  const seen = new Set<string>();
  const rows: ReviewRow[] = [];
  for (const i of inputs) {
    if (seen.has(i.id)) continue; // 1事例＝1行（重複は数えない）
    seen.add(i.id);
    const toCheck: string[] = [];
    const slots = (i.structure?.slots ?? []).map((s) => ({ title: s.title, tags: s.statusTags, price: s.price, details: s.details.map((d) => `${d.label}: ${d.value}`), notes: s.notes }));
    if (!i.structure?.recognized) toCheck.push("ページの受付枠を構造として認識できていない（欠落であり、「無い」とは言えない）");
    if (slots.length > 1) toCheck.push(`受付枠が${slots.length}件ある: 店舗選択式／枠ごとに独立した応募／1フォーム1応募 のどれか（応募単位）を、ページの文言で確認する`);
    if ((i.structure?.relatedEvents.length ?? 0) > 0) toCheck.push("「同じ販売元のイベント」はこのページ自身の受付枠ではない（別のイベントとして区別されているか）");
    if (i.ai) {
      if (i.ai.verified) toCheck.push("検証を通過＝引用が原文に実在するだけ。各項目の値が引用から導かれるか、人が確認する");
      for (const f of i.ai.fields) if (f.basis === "observed" && f.valueInText === false) toCheck.push(`${f.field}: 観察とされたが、値が本文にそのまま現れない（書式の変換か、導出か）`);
      for (const f of i.ai.fields) if (f.basis === "observed" && f.value === undefined) toCheck.push(`${f.field}: AIの候補値が保存されていない（次回の評価から保存する）`);
      if (i.ai.decision === "register") toCheck.push("本登録案: 誤った本登録は応募漏れ・重複の被害になる。自動登録ではなく人の承認が前提");
    } else toCheck.push("AIの結果なし");
    if (!i.gold) toCheck.push("独立した正解なし: 採点しない。応募単位の正解を、公開ページ等の根拠つきで人が確定する必要がある");
    rows.push({ id: i.id, host: i.host, slots, pageNotes: i.structure?.pageNotes ?? [], relatedEvents: i.structure?.relatedEvents.length ?? 0, sourceText: i.sourceText.slice(0, 400), ai: i.ai, oldMethodSlots: i.oldMethodSlots, gold: i.gold, scored: !!i.gold && !!i.ai, toCheck });
  }
  return rows;
}

export function reviewSummary(rows: ReviewRow[]): { cases: number; withGold: number; scored: number; withoutGold: number; verifiedWithoutGold: number } {
  return { cases: rows.length, withGold: rows.filter((r) => r.gold).length, scored: rows.filter((r) => r.scored).length, withoutGold: rows.filter((r) => !r.gold).length, verifiedWithoutGold: rows.filter((r) => !r.gold && r.ai?.verified).length };
}

export function reviewMarkdown(rows: ReviewRow[]): string {
  const s = reviewSummary(rows);
  const out = [`# Stage 10Y 人が確認できる比較資料（ローカル限定・Git管理外）`, ``, `事例 ${s.cases} 件／独立した正解あり ${s.withGold} 件（採点 ${s.scored} 件）／正解なし ${s.withoutGold} 件（うち検証通過 ${s.verifiedWithoutGold} 件は**正しさ未確認**）。`, ``];
  for (const r of rows) {
    out.push(`## ${r.id}（${r.host}）`, `- 元の文言: ${r.sourceText.replace(/\n/g, " ")}`);
    out.push(`- ページの受付枠（旧方式の読み取り: ${r.oldMethodSlots ?? "—"}枠／関連イベント ${r.relatedEvents}件）:`);
    for (const sl of r.slots) out.push(`  - ${sl.title}${sl.tags.length ? ` [${sl.tags.join(",")}]` : ""}${sl.price ? ` ${sl.price}` : ""}${sl.details.length ? ` ｜ ${sl.details.join(" / ")}` : ""}${sl.notes.length ? ` ｜ 注意: ${sl.notes.join(" / ")}` : ""}`);
    if (r.pageNotes.length) out.push(`- ページ全体の注意: ${r.pageNotes.join(" / ")}`);
    if (r.ai) out.push(`- AI: ${r.ai.decision}（検証${r.ai.verified ? "通過" : "未通過"}${r.ai.held ? `: ${r.ai.held.join(",")}` : ""}）` + (r.ai.fields.length ? ` ｜ ${r.ai.fields.map((f) => `${f.field}=${f.value ?? "（値は未保存）"}[${f.basis}${f.valueInText === false ? "・値が本文に逐語なし" : ""}]`).join(" / ")}` : ""));
    out.push(`- 正解: ${r.gold ? `${r.gold.unit}（根拠: ${r.gold.basis ?? "なし"}）` : "なし（独立した正解が無い）"}`, `- 確認すること:`);
    for (const t of r.toCheck) out.push(`  - ${t}`);
    out.push(``);
  }
  return out.join("\n");
}
