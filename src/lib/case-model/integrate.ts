/**
 * 複数の調査結果・候補の統合（Stage 9H-3E・純関数。再現可能: 同じ入力は常に同じ結果。入力の並びで結果が変わらない）。
 * 同じ抽選について複数の情報（収集AIの読み取り・調査エージェントの結果・同じ抽選の別の候補）があるとき、個別の判断をそのまま登録候補にせず、
 *   1. 同一抽選かを判定し、同一と確認できたものだけを統合する（別の店舗の独立した抽選・別の応募期間・別の系列/商品は混ぜない）
 *   2. 項目ごとに根拠を比べ、最も根拠の強い値を採用する（情報源全体に一律の優先順位は付けない）
 *   3. 不足は他から補い、矛盾は未確認（conflict）として残す
 *   4. 採用した値・採用しなかった値と、その理由を項目ごとに記録する
 * 固定ロジックは「同一性・根拠の強さの比較・明確な矛盾・手動確定の保護」を担当し、AIの判断（調査結果の項目・店舗選択式の判断など）は根拠つきで最大限採用する。
 */
import { productKey } from "@/lib/lottery-match";
import { judgeForm } from "@/lib/lottery-form";
import { knowledgeFor } from "@/lib/collector/knowledge/chain-knowledge";
import { relateDateTimes } from "@/lib/collector/date-phrases";
import { normName } from "@/lib/norm";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { matchIdentity, type IdentityFacts, type IdentityVerdict } from "./identity";
import { parseDt, sameMeaning } from "./judgment";
import { CASE_FIELD_KEYS, CASE_FIELD_LABEL, emptyCase, splitList, type CaseField, type CaseFieldKey, type CaseFile, type DecisionRecord, type EvidenceRef } from "./types";

export interface IntegrationInput {
  /** 候補の識別（記録用。順序に依存しない決定のため、並び替えに使う） */
  id: string;
  /** 表示名（「従来方式の読み取り」「調査結果」「候補 abc123」など） */
  label: string;
  caseFile: CaseFile;
  /** 同じ抽選であることが、統合の前に別の検証で確認済み（調査エージェントの結果は、調べている抽選そのものに対する調査のため。同一性の再判定をしない） */
  sameVerified?: boolean;
}

export interface FieldAdoption {
  field: CaseFieldKey;
  value: string | null;
  state: CaseField["state"];
  /** 採用した値の出どころ（候補の表示名） */
  from: string[];
  reason: string;
  /** 採用しなかった値と理由 */
  rejected: { value: string; from: string; reason: string }[];
}

export interface IntegrationResult {
  caseFile: CaseFile;
  members: { id: string; label: string; matched: string[]; note?: string }[];
  excluded: { id: string; label: string; verdict: IdentityVerdict; reason: string }[];
  adoptions: FieldAdoption[];
  /** 矛盾・確認が必要な項目 */
  unresolved: { field: CaseFieldKey; detail: string }[];
}

/** 根拠の強さ（大きいほど強い）。項目ごとの値に付ける。一律の情報源順位ではなく、値ごとの根拠（原文・一次/二次・主催者本文か・確定か）で決まる */
export function strengthOf(f: CaseField): number {
  if (f.state === "manual" || f.by === "human") return 1000;
  const ev = f.evidence[0];
  let s = f.state === "confirmed" ? 100 : f.state === "inferred" ? 40 : f.state === "unverified" ? 20 : f.state === "conflict" ? 15 : 0;
  if (ev?.tier === "primary") s += 40;
  if (ev?.basis === "organizer_body") s += 15;
  if (ev?.basis === "platform_meta") s -= 15;
  if (ev?.quote) s += 5;
  if (ev?.kind === "official_social") s += 10;
  if (f.by === "fixed" && !ev) s -= 10; // 根拠のない固定ロジックの推定は弱い
  return s;
}
/** 強さの差がこれ以上あれば、強い方を採用し、弱い方は採用しない（それ未満は矛盾として残す） */
const MARGIN = 30;

const ev0 = (f: CaseField): EvidenceRef | undefined => f.evidence[0];
const originClass = (f: CaseField): string => {
  const e = ev0(f);
  if (!e) return "none";
  if (e.tier === "primary") return `p:${e.origin ?? e.url ?? ""}`;
  return e.basis === "organizer_body" ? "platform" : "summary";
};

interface Cand {
  m: IntegrationInput;
  f: CaseField;
  s: number;
}

/** 値の形式の検証。問題があれば理由、なければ null */
function formatProblem(k: CaseFieldKey, v: string): string | null {
  if (k === "applyUrl" && !/^https?:\/\/\S+$/i.test(v)) return "URLの形式ではないため採用しない（応募URLはhttp(s)のURLだけ）";
  if ((k === "applyStart" || k === "applyDeadline" || k === "resultStart" || k === "resultEnd") && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v)) return "日時の形式が正しくないため採用しない";
  if (k === "applyMethod" && !["web", "store", "app", "serial"].includes(v)) return "応募方法の区分に当てはまらないため採用しない";
  if (k === "receiveMethod" && !["store", "shipping", "either"].includes(v)) return "受取方法の区分に当てはまらないため採用しない";
  return null;
}

const isDate = (k: CaseFieldKey) => k === "applyStart" || k === "applyDeadline" || k === "resultStart";
const fmt = (d: { date: string; time?: string | null } | undefined) => (d ? `${d.date}${d.time ? ` ${d.time}` : ""}` : null);

/** 同じ意味の値を、より良い表現にまとめる（日時=境界は早い方・時刻つき／文面=より詳しい方／商品=装飾の少ない短い名前／系列=短い表記） */
function representative(k: CaseFieldKey, vals: string[]): string {
  if (isDate(k)) {
    return vals.reduce((acc, v) => {
      const a = parseDt(acc);
      const b = parseDt(v);
      return a && b ? (fmt(relateDateTimes(a, b).adopt) ?? acc) : acc;
    });
  }
  if (k === "conditions") return [...vals].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  if (k === "items") {
    const names = new Map<string, string>();
    for (const v of vals) for (const n of splitList(v)) {
      const key = productKey(n) || n;
      const cur = names.get(key);
      if (!cur || (n.length < cur.length && n.length >= 3) || (n.length === cur.length && n < cur)) names.set(key, n);
    }
    return [...names.values()].join(" / ");
  }
  if (k === "chain") return [...vals].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return [...vals].sort((a, b) => a.localeCompare(b))[0];
}

/** 抽選の識別材料（案件ファイルから） */
export function factsOf(c: CaseFile): IdentityFacts & { storeSelectList: string[] } {
  const f = c.fields;
  const select = f.form.value === "store_select";
  return {
    chain: f.chain.value ?? undefined,
    store: select ? undefined : (f.store.value ?? undefined),
    storeSelect: select,
    products: splitList(f.items.value),
    applyStart: f.applyStart.value ?? undefined,
    applyDeadline: f.applyDeadline.value ?? undefined,
    storeSelectList: splitList(f.selectableStores.value),
  };
}

/** 同じキャンペーンの店舗別の告知か（店舗が違っても、店舗をまたぐ応募制限などの根拠があれば、店舗選択式の1件として統合できる） */
function sameCampaign(a: CaseFile, b: CaseFile): string | null {
  const texts = [a.fields.conditions.value ?? "", b.fields.conditions.value ?? ""];
  // 店舗ごとに別の情報源（応募ページ・告知）を持つ2つの告知を比べている（perStorePages）。系列の傾向（参考）も、店舗をまたぐ制限の解釈に使う
  const j = judgeForm({ storeMode: "fixed", texts, sourceUrls: [], perStorePages: true, knowledge: knowledgeFor(a.fields.chain.value ?? b.fields.chain.value ?? "") });
  if (j.form === "store_select" && j.selectSignals.some((s) => s.code === "select_field" || s.code === "cross_store_limit")) return "店舗をまたぐ応募制限・店舗選択欄の記載があり、同じ企画の店舗別の告知と判断";
  return null;
}

export function integrateCandidates(inputs: IntegrationInput[], opts: { humanLocked?: CaseFieldKey[]; at?: string } = {}): IntegrationResult {
  if (inputs.length === 0) throw new Error("統合する候補がありません");
  const [anchor, ...others] = inputs;
  // 順序に依存しない: 基準（先頭）以外は ID で並べる
  const rest = [...others].sort((a, b) => a.id.localeCompare(b.id));
  const af = factsOf(anchor.caseFile);
  const members: IntegrationInput[] = [anchor];
  const info: IntegrationResult["members"] = [{ id: anchor.id, label: anchor.label, matched: [] }];
  const excluded: IntegrationResult["excluded"] = [];
  const campaign: IntegrationInput[] = []; // 店舗選択式のキャンペーンに含まれる店舗別の告知
  for (const m of rest) {
    if (m.sameVerified) {
      members.push(m);
      info.push({ id: m.id, label: m.label, matched: [], note: "調べている抽選そのものの調査結果（同一性は調査の検証層で確認済み）" });
      continue;
    }
    const mf = factsOf(m.caseFile);
    const r = matchIdentity(af, mf);
    // 店舗選択式の一覧に含まれる店舗の告知は、同じ企画の一部
    const inList = af.storeSelect && mf.store && af.storeSelectList.some((s) => normName(s).includes(normName(mf.store!)) || normName(mf.store!).includes(normName(s)));
    const inListRev = mf.storeSelect && af.store && mf.storeSelectList.some((s) => normName(s).includes(normName(af.store!)) || normName(af.store!).includes(normName(s)));
    // 店舗が一方だけ分かっている（特定の店舗の抽選と、店舗の記載がない候補）: 店舗ごとに独立した抽選がありうるため、同じ抽選と認めない（店舗選択式どうしは除く）
    if (r.verdict === "same" && !!af.store !== !!mf.store && !af.storeSelect && !mf.storeSelect) {
      excluded.push({ id: m.id, label: m.label, verdict: "unknown", reason: "店舗が一方の候補だけで分かっており、別の店舗の抽選の可能性があるため統合しない（保留）" });
      continue;
    }
    if (r.verdict === "same" || (r.verdict === "unknown" && (inList || inListRev))) {
      members.push(m);
      info.push({ id: m.id, label: m.label, matched: r.matched, ...(inList || inListRev ? { note: "店舗選択式の選べる店舗に含まれる" } : {}) });
      continue;
    }
    // 店舗だけが違う（特定の店舗どうし）: 同じ企画の店舗別告知（店舗選択式）か、独立した別の抽選か
    const storeDiffOnly = r.verdict === "different" && r.mismatched.every((x) => x === "店舗");
    if (storeDiffOnly) {
      const why = sameCampaign(anchor.caseFile, m.caseFile);
      if (why) {
        members.push(m);
        campaign.push(m);
        info.push({ id: m.id, label: m.label, matched: r.matched, note: why });
        continue;
      }
      excluded.push({ id: m.id, label: m.label, verdict: "different", reason: "別の店舗の独立した抽選の可能性があるため統合しない（店舗選択式と判断できる根拠がない）" });
      continue;
    }
    excluded.push({ id: m.id, label: m.label, verdict: r.verdict, reason: r.verdict === "different" ? `別の抽選（${r.mismatched.join("・")}が異なる）` : "同じ抽選と確認できないため統合しない（保留）" });
  }

  const locked = new Set(opts.humanLocked ?? []);
  const out = emptyCase(anchor.caseFile.id, opts.at ?? anchor.caseFile.createdAt);
  out.sources = members.flatMap((m) => m.caseFile.sources).filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i);
  out.humanLocked = [...new Set([...anchor.caseFile.humanLocked, ...locked])];
  out.unreflected = members.flatMap((m) => m.caseFile.unreflected);
  const adoptions: FieldAdoption[] = [];
  const unresolved: IntegrationResult["unresolved"] = [];

  const pick = (k: CaseFieldKey, forceVals?: Cand[]): void => {
    const label = CASE_FIELD_LABEL[k];
    // 人間が確定した項目は、基準の候補の値を保持（他の候補の値は採用しない）
    if (out.humanLocked.includes(k) && anchor.caseFile.fields[k].value) {
      const f = anchor.caseFile.fields[k];
      out.fields[k] = { ...f };
      adoptions.push({ field: k, value: f.value, state: f.state, from: [anchor.label], reason: "人間が確定した項目のため、他の候補の値で上書きしない", rejected: members.slice(1).flatMap((m) => (m.caseFile.fields[k].value && !sameMeaning(k, m.caseFile.fields[k].value, f.value) ? [{ value: m.caseFile.fields[k].value!, from: m.label, reason: "人間が確定した項目のため採用しない" }] : [])) });
      return;
    }
    // データ形式の検証（固定ロジック）: 形式が正しくない値（URLでない応募URL・日時でない値・列挙外の方法）は採用しない。理由を項目単位で記録する
    const invalid: { value: string; from: string; reason: string }[] = [];
    // 入力の項目がすでに矛盾（conflict）のときは、その別の値も候補に加える（矛盾を、統合で消さない）
    const cands0: Cand[] = forceVals ?? members.flatMap((m) => {
      const f = m.caseFile.fields[k];
      if (!f.value) return [];
      const alts: Cand[] = f.state === "conflict" ? f.alternatives.map((x) => ({ m, f: { ...f, value: x.value, evidence: x.evidence, state: "unverified" as const, alternatives: [] }, s: strengthOf({ ...f, value: x.value, evidence: x.evidence, state: "unverified" }) })) : [];
      return [{ m, f, s: strengthOf(f) }, ...alts];
    });
    const cands = cands0.filter((c) => {
      const why = formatProblem(k, c.f.value as string);
      if (why) invalid.push({ value: c.f.value as string, from: c.m.label, reason: why });
      return !why;
    });
    if (cands.length === 0) {
      if (invalid.length) adoptions.push({ field: k, value: null, state: "missing", from: [], reason: "採用できる値がない（形式が正しくない値のみ）", rejected: invalid });
      return;
    }
    // 同じ意味の値でグループ化
    const groups: Cand[][] = [];
    for (const c of cands) {
      const g = groups.find((gr) => sameMeaning(k, gr[0].f.value, c.f.value));
      if (g) g.push(c);
      else groups.push([c]);
    }
    const gTop = (g: Cand[]) => Math.max(...g.map((c) => c.s)) + (new Set(g.map((c) => originClass(c.f))).size >= 2 ? 15 : 0);
    const ranked = [...groups].sort((a, b) => gTop(b) - gTop(a) || (a[0].m.id === anchor.id ? -1 : 0) - (b[0].m.id === anchor.id ? -1 : 0) || String(a[0].f.value).localeCompare(String(b[0].f.value)));
    let win = ranked[0];
    let conflict = false;
    if (ranked.length > 1 && gTop(ranked[0]) - gTop(ranked[1]) < MARGIN) {
      conflict = true;
      // 応募締切は、応募の機会を逃さないよう安全側（早い方）を暫定値にする
      // 暫定値: 基準（収集AIの読み取り）の値が拮抗しているときは、それを保つ（根拠の近い別の値で、黙って置き換えない）
      const ag = ranked.find((g) => g.some((c) => c.m.id === anchor.id));
      if (k !== "applyDeadline" && ag && gTop(ranked[0]) - gTop(ag) < MARGIN) win = ag;
      if (k === "applyDeadline") win = [...ranked].filter((g) => gTop(ranked[0]) - gTop(g) < MARGIN).sort((a, b) => String(a[0].f.value).localeCompare(String(b[0].f.value)))[0];
    }
    let value = representative(k, win.map((c) => c.f.value as string));
    // 商品（9H-3J）: 基準の候補（案件の本来の商品）に無い商品は、別の候補（まとめ投稿・別の抽選の告知）にだけ書かれているときは採用しない。
    // 複数の抽選の商品を、1つの抽選に混在させない。独立した2つ以上の候補が同じ商品を挙げているときだけ、同じ抽選の商品として採用する。判断できない商品は、未確認として保持する
    const heldItems: { name: string; from: string[] }[] = [];
    if (k === "items") {
      const anchorNames = splitList(anchor.caseFile.fields.items.value);
      if (anchorNames.length > 0) {
        const has = (m: (typeof members)[number], n: string) => splitList(m.caseFile.fields.items.value).some((x) => productKey(x) === productKey(n) || sameMeaning("items", x, n));
        const keep: string[] = [];
        for (const n of splitList(value)) {
          if (anchorNames.some((a) => productKey(a) === productKey(n) || sameMeaning("items", a, n))) {
            keep.push(n);
            continue;
          }
          const sup = members.filter((m) => m.id !== anchor.id && has(m, n));
          if (sup.length >= 2) keep.push(n);
          else heldItems.push({ name: n, from: sup.map((m) => m.label) });
        }
        if (heldItems.length > 0 && keep.length > 0) value = keep.join(" / ");
      }
    }
    const best = [...win].sort((a, b) => b.s - a.s)[0];
    const independent = new Set(win.map((c) => originClass(c.f))).size;
    const anyConfirmed = win.some((c) => c.f.state === "confirmed" || c.f.state === "manual");
    const baseState: CaseField["state"] = conflict ? "conflict" : anyConfirmed || (independent >= 2 && win.every((c) => c.f.state !== "unverified")) ? "confirmed" : best.f.state === "unverified" ? "unverified" : best.f.state === "missing" ? "missing" : best.f.state === "conflict" ? "conflict" : "inferred";
    // 文面: 採用した（より詳しい）値が、確定した候補の値そのものでないときは、確定とは言えない（確定した記載を含むだけ）
    const repFrom = k === "conditions" ? win.find((c) => c.f.value === value) : undefined;
    const demoted = !conflict && !!repFrom && repFrom.f.state !== "confirmed" && repFrom.f.state !== "manual" && win.some((c) => c.f.state === "confirmed");
    const finalState: CaseField["state"] = demoted ? (repFrom!.f.state === "unverified" ? "unverified" : "inferred") : baseState;
    const evid: EvidenceRef[] = win.flatMap((c) => c.f.evidence).filter((e, i, a) => a.findIndex((x) => x.url === e.url && x.quote === e.quote) === i).slice(0, 3);
    const rejected = invalid.concat(ranked.filter((g) => g !== win).flatMap((g) => g.map((c) => ({ value: c.f.value as string, from: c.m.label, reason: conflict ? "別の値と根拠の強さが近く、どちらにも決められない" : `根拠が弱い（強さ${c.s} < ${gTop(win)}）。採用した値のほうが根拠が強い` }))));
    // 文面: 短い値が、同じ意味のより詳しい値に置き換わるときの記録
    const detail = k === "conditions" && win.length > 1 ? "より詳しい記載を採用（短い記載で置き換えない）" : "";
    out.fields[k] = { value, state: finalState, by: best.f.by, evidence: evid, alternatives: ranked.filter((g) => g !== win).map((g) => ({ value: g[0].f.value as string, evidence: g[0].f.evidence })) };
    const from = [...new Set(win.map((c) => c.m.label))];
    adoptions.push({
      field: k, value, state: finalState, from,
      reason: conflict ? `情報源どうしで食い違い、根拠の強さが近いため未確認として保持（暫定値${k === "applyDeadline" ? "は応募の機会を逃さない早い方" : ""}）` : `${detail || (win.length > 1 ? `${win.length}件の候補が一致` : ranked.length > 1 ? "根拠が最も強い" : "唯一の記載")}${ev0(best.f)?.tier === "primary" ? "（一次情報）" : ""}${ev0(best.f)?.basis === "organizer_body" ? "（主催者本文）" : ""}`,
      rejected,
    });
    if (conflict) unresolved.push({ field: k, detail: `${label}が食い違っています（${ranked.map((g) => g[0].f.value).join(" / ")}）` });
    for (const h of heldItems) {
      unresolved.push({ field: k, detail: `商品「${h.name}」は、別の候補（${h.from.join("・") || "別の情報源"}）にだけ書かれています。同じ抽選の商品か、別の抽選の商品かを確認できないため、採用していません` });
      rejected.push({ value: h.name, from: h.from.join("・") || "別の候補", reason: "基準の候補にない商品で、独立した複数の候補の裏づけがない（別の抽選の商品の混入を防ぐため採用しない）" });
    }
  };

  // 系列・商品・日時・方法など（店舗に関する項目は別に扱う）
  for (const k of ["chain", "items", "applyStart", "applyDeadline", "resultStart", "applyMethod", "conditions", "applyUrl", "receiveMethod"] as CaseFieldKey[]) pick(k);

  // 当選発表の終了: 採用した開始日と同じ記載の候補（期間の記載）から取る。開始日だけの候補で期間を消さない
  {
    const start = out.fields.resultStart.value;
    const cands = members.flatMap((m) => (m.caseFile.fields.resultEnd.value && (!start || !m.caseFile.fields.resultStart.value || sameMeaning("resultStart", m.caseFile.fields.resultStart.value, start)) ? [{ m, f: m.caseFile.fields.resultEnd, s: strengthOf(m.caseFile.fields.resultEnd) }] : []));
    pick("resultEnd", cands);
    const e = out.fields.resultEnd.value;
    if (e && start && e < start.slice(0, 10)) {
      out.fields.resultEnd = { ...out.fields.resultEnd, value: null, state: "missing" };
      adoptions.push({ field: "resultEnd", value: null, state: "missing", from: [], reason: "当選発表の終了が開始より前のため採用しない", rejected: [{ value: e, from: "", reason: "終了が開始より前" }] });
    }
  }

  // 店舗・抽選形態・選べる店舗: 店舗選択式の根拠（形態の記載・選べる店舗の一覧・店舗をまたぐ応募制限）があれば、店舗選択式の1件として統合する
  {
    const selectCands = members.filter((m) => m.caseFile.fields.form.value === "store_select" && m.caseFile.fields.form.evidence.length > 0);
    const selectAny = members.filter((m) => m.caseFile.fields.form.value === "store_select");
    const asCampaign = campaign.length > 0;
    if (selectCands.length > 0 || asCampaign || (selectAny.length > 0 && members.length > 0)) {
      const src = selectCands.length ? selectCands : selectAny.length ? selectAny : [anchor];
      const best = [...src].sort((a, b) => strengthOf(b.caseFile.fields.form) - strengthOf(a.caseFile.fields.form) || a.id.localeCompare(b.id))[0];
      const formField: CaseField = asCampaign && !selectAny.length
        ? { value: "store_select", state: "inferred", by: "fixed", evidence: campaign.flatMap((c) => c.caseFile.fields.conditions.evidence).slice(0, 2), alternatives: [] }
        : { ...best.caseFile.fields.form };
      out.fields.form = formField;
      const names = new Set<string>();
      const add = (n: string) => {
        const key = normName(n);
        if (![...names].some((x) => normName(x) === key)) names.add(n);
      };
      for (const m of members) {
        for (const s of splitList(m.caseFile.fields.selectableStores.value)) add(s);
        // 店舗別の告知の店舗は、選べる店舗の1つ（店舗の値にはしない）
        if (m.caseFile.fields.store.value && m.caseFile.fields.form.value !== "store_select") add(m.caseFile.fields.store.value);
      }
      const selEv = best.caseFile.fields.selectableStores.evidence.length ? best.caseFile.fields.selectableStores : best.caseFile.fields.form;
      out.fields.selectableStores = { value: [...names].join(" / ") || null, state: selEv.state === "missing" ? "inferred" : selEv.state, by: selEv.by, evidence: selEv.evidence, alternatives: [] };
      if (!names.size) out.fields.selectableStores = { ...out.fields.selectableStores, value: null, state: "missing" };
      out.fields.store = { value: null, state: "missing", by: "fixed", evidence: [], alternatives: [] };
      const specific = members.flatMap((m) => (m.caseFile.fields.store.value && m.caseFile.fields.form.value !== "store_select" ? [{ value: m.caseFile.fields.store.value, from: m.label }] : []));
      adoptions.push({ field: "form", value: "store_select", state: formField.state, from: [best.label], reason: asCampaign && !selectAny.length ? "店舗をまたぐ応募制限・店舗選択欄の記載から、店舗選択式の1件として統合" : "ページの構造から店舗選択式と判断（根拠の抜粋あり）", rejected: [] });
      adoptions.push({ field: "selectableStores", value: out.fields.selectableStores.value, state: out.fields.selectableStores.state, from: [best.label], reason: `選べる店舗${names.size}件を保持（各候補の一覧と、店舗別の告知の店舗を合わせた）`, rejected: [] });
      adoptions.push({ field: "store", value: null, state: "missing", from: [], reason: "店舗選択式のため店舗の値にしない（選べる店舗として保持）", rejected: specific.map((s) => ({ value: s.value, from: s.from, reason: "選べる店舗の1つであり、抽選の店舗ではない" })) });
    } else {
      pick("form");
      pick("selectableStores");
      pick("store");
    }
  }

  // 導き出せる項目（人間の評価の傾向）: 店舗選択式・特定の実店舗なら店舗受取と推定する。確定ではなく推定（読み取りが無いときだけ）
  if (!out.fields.receiveMethod.value) {
    const select = out.fields.form.value === "store_select";
    const store = out.fields.store.value;
    if (select || (store && !/通販|オンライン|ネット/.test(store))) {
      out.fields.receiveMethod = { value: "store", state: "inferred", by: "fixed", evidence: [], alternatives: [], note: "人間の評価の傾向（店舗選択式・特定の実店舗は店舗受取）。確定ではない" };
      adoptions.push({ field: "receiveMethod", value: "store", state: "inferred", from: [], reason: select ? "店舗選択式のため店舗受取と推定（人間の評価の傾向。確定ではない）" : "特定の実店舗のため店舗受取と推定（人間の評価の傾向。確定ではない）", rejected: [] });
    }
  }

  // 決定の記録（基準の候補との差分）
  for (const a of adoptions) {
    const before = anchor.caseFile.fields[a.field].value;
    if (a.value === before) continue;
    const kind: DecisionRecord["kind"] = a.state === "conflict" ? "held" : before === null ? "adopted" : "changed";
    out.decisions.push({ stage: "merge", field: a.field, kind, before, after: a.value, by: a.state === "inferred" && a.from.length === 0 ? "fixed" : "investigation", reason: `統合: ${a.reason}（出典: ${a.from.join("・") || "固定ロジックの推定"}）` });
  }
  for (const x of excluded) out.decisions.push({ stage: "merge", field: "general", kind: "rejected", before: x.label, after: null, by: "fixed", reason: `統合しない: ${x.reason}` });
  for (const a of adoptions) for (const r of a.rejected) if (a.field !== "store") out.decisions.push({ stage: "merge", field: a.field, kind: "rejected", before: r.value, after: a.value, by: "fixed", reason: `${r.from}の値を採用しない: ${r.reason}` });
  for (const u of unresolved) out.decisions.push({ stage: "merge", field: u.field, kind: "held", before: null, after: null, by: "fixed", reason: u.detail });

  return { caseFile: out, members: info, excluded, adoptions, unresolved };
}

/** 判断履歴に保存する統合の要約（候補・不採用・採用した項目と理由・採用しなかった値・未確認）。容量を抑えるため件数を制限する */
export interface IntegrationSummary {
  members: { id: string; label: string; note?: string }[];
  excluded: { label: string; verdict: string; reason: string }[];
  adoptions: { field: CaseFieldKey; value: string | null; state: string; from: string[]; reason: string; rejected: { value: string; from: string; reason: string }[] }[];
  unresolved: { field: CaseFieldKey; detail: string }[];
  /** この統合へまとめて「統合済み」にした、同じ抽選の別の候補のID */
  superseded?: string[];
}
export function summarizeIntegration(r: IntegrationResult): IntegrationSummary {
  return {
    members: r.members.slice(0, 8).map((m) => ({ id: m.id, label: m.label, ...(m.note ? { note: m.note } : {}) })),
    excluded: r.excluded.slice(0, 8).map((e) => ({ label: e.label, verdict: e.verdict, reason: e.reason })),
    adoptions: r.adoptions.slice(0, 20).map((a) => ({ field: a.field, value: a.value === null ? null : a.value.slice(0, 160), state: a.state, from: a.from.slice(0, 4), reason: a.reason.slice(0, 200), rejected: a.rejected.slice(0, 4).map((x) => ({ value: x.value.slice(0, 120), from: x.from, reason: x.reason.slice(0, 160) })) })),
    unresolved: r.unresolved.slice(0, 8),
  };
}

export { CASE_FIELD_KEYS, chainCanonicalKey };
