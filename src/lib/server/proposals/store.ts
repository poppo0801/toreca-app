/**
 * 登録案の保存・読み出し（Stage 10Z）。書き込みはサービス権限（システム）だけ。**lotteries・applications・購入・通知には一切書かない**。
 *  - 冪等: 同じ応募機会候補（proposal_key）で入力（input_hash）が同じなら何もしない。入力が変わったときだけ新しい版を追加し、古い版に superseded_at を付ける（行は消さない）。
 *  - 人のレビューは proposal_key に紐づくため、再評価で版が変わっても残る。AIはレビューを上書き・削除できない（権限もない）。
 */
import type { ProposalRecord } from "@/lib/judgment/xsource/proposal";
import type { Db } from "@/lib/server/lottery-service";

type Rows = { data: unknown; error: { message?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = (db: Db, name: string): any => (db as unknown as { from: (n: string) => unknown }).from(name);

export interface SaveSummary {
  inserted: number;
  unchanged: number;
  superseded: number;
  failed: number;
}

/** キーの順序に依らない比較用の JSON（DBの jsonb はキーの順序を保たない） */
const stableJson = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v));
const rowOf = (householdId: string, r: ProposalRecord, version: number) => ({
  household_id: householdId,
  candidate_id: r.candidateId,
  proposal_key: r.proposalKey,
  version,
  input_hash: r.inputHash,
  post_id: r.postId,
  item_no: r.itemNo,
  item_label: r.itemLabel,
  item_fingerprint: r.itemFingerprint,
  url_status: r.urlStatus,
  source_urls: r.sourceUrls,
  link_hosts: r.linkHosts,
  decision: r.decision,
  verified: r.verified,
  held_reasons: r.heldReasons,
  end_reason: r.endReason,
  fields: r.fields,
  apply_unit: r.applyUnit,
  apply_unit_basis: r.applyUnitBasis,
  unknowns: r.unknowns,
  pages: r.pages,
  possibly_same: r.possiblySame,
  mode: r.mode,
  model_id: r.modelId,
  prompt_version: r.promptVersion,
  cost_jpy: r.costJpy,
  turns: r.turns,
  stop_reason: r.stopReason,
  fetched_at: r.fetchedAt,
  ...(r.judgeTrail?.length ? { judge_trail: r.judgeTrail } : {}),
});

export async function saveProposals(db: Db, householdId: string, records: ProposalRecord[]): Promise<SaveSummary> {
  const s: SaveSummary = { inserted: 0, unchanged: 0, superseded: 0, failed: 0 };
  for (const r of records) {
    try {
      const cur = (await t(db, "registration_proposals").select("id,version,input_hash,decision,verified,apply_unit,apply_unit_basis,held_reasons,fields").eq("household_id", householdId).eq("proposal_key", r.proposalKey).is("superseded_at", null).maybeSingle()) as Rows;
      if (cur.error) {
        s.failed++;
        continue;
      }
      const c = cur.data as { id: string; version: number; input_hash: string; decision?: string; verified?: boolean; apply_unit?: string; apply_unit_basis?: string; held_reasons?: unknown; fields?: unknown } | null;
      // 同じ入力でも、結果（判断・検証・応募単位・保留理由・項目）が変わったら新しい版として残す（RUNTIME_CORRECTNESS: 検証の修正後の再評価が「変更なし」で捨てられた）。結果まで同じなら重複を作らない
      const row = rowOf(householdId, r, 0) as Record<string, unknown>;
      const sameResult = !!c && c.decision === row.decision && c.verified === row.verified && c.apply_unit === row.apply_unit && c.apply_unit_basis === row.apply_unit_basis && stableJson(c.held_reasons ?? null) === stableJson(row.held_reasons ?? null) && stableJson(c.fields ?? null) === stableJson(row.fields ?? null);
      if (c && c.input_hash === r.inputHash && sameResult) {
        s.unchanged++;
        continue;
      }
      // 置き換えは1つのトランザクションで行う（移行127の関数。途中の失敗・中断・同時実行で現行の版が無くならない）。関数が使えない環境（権限・未適用）だけ従来の2段階
      const rp = (await (db as unknown as { rpc: (n: string, a: object) => PromiseLike<{ error: { code?: string; message?: string } | null }> }).rpc("registration_proposal_replace", { p_old: c?.id ?? null, p_row: rowOf(householdId, r, (c?.version ?? 0) + 1) })) as { error: { code?: string; message?: string } | null };
      if (!rp.error) {
        if (c) s.superseded++;
        s.inserted++;
        continue;
      }
      if (!/42883|42501|PGRST202|permission|does not exist|Could not find/i.test(`${rp.error.code ?? ""} ${rp.error.message ?? ""}`)) {
        s.failed++; // 関数はあるが失敗した（同時の置き換え等）: 何も変わっていない（トランザクション）
        continue;
      }
      if (c) {
        const up = (await t(db, "registration_proposals").update({ superseded_at: new Date().toISOString() }).eq("id", c.id)) as Rows;
        if (up.error) {
          s.failed++;
          continue;
        }
        s.superseded++;
      }
      const ins = (await t(db, "registration_proposals").insert(rowOf(householdId, r, (c?.version ?? 0) + 1))) as Rows;
      if (ins.error) {
        // 追加に失敗したら、古い版の superseded_at を戻す（現行の版が無くならないように）
        if (c) await t(db, "registration_proposals").update({ superseded_at: null }).eq("id", c.id);
        s.failed++;
        continue;
      }
      s.inserted++;
    } catch {
      s.failed++;
    }
  }
  return s;
}

export interface StoredProposal {
  id: string;
  candidate_id: string;
  proposal_key: string;
  version: number;
  item_no: number;
  item_label: string;
  url_status: string;
  source_urls: string[];
  link_hosts: { host: string; origin: string }[];
  decision: string;
  verified: boolean;
  held_reasons: string[];
  end_reason: string | null;
  fields: Record<string, { value: string | null; basis: string; quote: string | null; evidence: string | null; support: string }>;
  apply_unit: string;
  apply_unit_basis: string;
  unknowns: { what: string; why: string }[];
  pages: { host: string; scope: string | null; slots: number; textLoss: boolean; viaSearch?: boolean; hash?: string; url?: string }[];
  possibly_same: string[];
  /** 判断の各段（適応型判断。旧い行・1段の行は空） */
  judge_trail?: { stage: string; model: string | null; reason: string | null; decision: string; verified: boolean; adopted?: boolean; note?: string }[];
  mode: string;
  model_id: string | null;
  cost_jpy: number | null;
  turns: number | null;
  stop_reason: string | null;
  judged_at: string;
}
export interface StoredReview {
  id: string;
  proposal_key: string;
  proposal_id: string;
  decision: "hold" | "approve_with_edits" | "reject";
  edits: Record<string, string>;
  note: string;
  created_at: string;
}
export interface StoredTruth {
  id: string;
  proposal_key: string;
  proposal_id: string;
  verdict: "correct" | "corrected" | "unknown_later";
  truth_decision: "register" | "exclude" | "hold" | null;
  opportunity: "exists" | "absent" | "unknown" | null;
  user_fit: "fit" | "unfit" | "unknown" | null;
  edits: Record<string, string>;
  unknown_fields: string[];
  note: string;
  created_at: string;
}
export interface ProposalView extends StoredProposal {
  /** この登録案（現行の版）への最新のレビュー。無ければ null */
  review: StoredReview | null;
  /** 人が記録した最新の正解（ADAPTIVE_REVIEW）。無ければ null。truthOutdated=記録した版と現行の版が違う（再確認の対象） */
  truth?: StoredTruth | null;
  truthOutdated?: boolean;
  /** レビューした版が現行と違うとき、その版の内容（差分の表示用。AIの値）。無ければ null */
  reviewedVersion: { version: number; fields: StoredProposal["fields"]; apply_unit: string } | null;
  /** レビューした版が現行の版と違う（再評価で内容が変わった）。人のレビューは残るが、再確認が必要 */
  reviewOutdated: boolean;
}

const COLS = "id,candidate_id,proposal_key,version,item_no,item_label,url_status,source_urls,link_hosts,decision,verified,held_reasons,end_reason,fields,apply_unit,apply_unit_basis,unknowns,pages,possibly_same,mode,model_id,cost_jpy,turns,stop_reason,judged_at,judge_trail";

/** 候補ごとの現行の登録案と最新のレビュー（RLS: 世帯の構成員だけが読める。利用者のセッションのクライアントでも呼べる） */
export async function loadProposals(db: Db, candidateIds: string[]): Promise<Record<string, ProposalView[]>> {
  if (!candidateIds.length) return {};
  const p = (await t(db, "registration_proposals").select(COLS).in("candidate_id", candidateIds).is("superseded_at", null).order("item_no", { ascending: true })) as Rows;
  const list = ((p.data as StoredProposal[] | null) ?? []).filter(Boolean);
  if (!list.length) return {};
  const rv = (await t(db, "registration_proposal_reviews").select("*").in("proposal_key", list.map((x) => x.proposal_key)).order("created_at", { ascending: false })) as Rows;
  const latest = new Map<string, StoredReview>();
  const truths = new Map<string, StoredTruth>();
  for (const r of ((rv.data as (StoredReview & Partial<StoredTruth> & { kind?: string })[] | null) ?? [])) {
    if ((r.kind ?? "review") === "truth") {
      if (!truths.has(r.proposal_key)) truths.set(r.proposal_key, r as unknown as StoredTruth);
    } else if ((r.kind ?? "review") === "review" && !latest.has(r.proposal_key)) latest.set(r.proposal_key, r);
  }
  // 再評価で版が変わったとき、レビューした版の内容を読む（差分の表示用）
  const oldIds = [...new Set([...latest.values()].filter((r) => !list.some((x) => x.id === r.proposal_id)).map((r) => r.proposal_id))];
  const prev = new Map<string, { version: number; fields: StoredProposal["fields"]; apply_unit: string }>();
  if (oldIds.length) {
    const pv = (await t(db, "registration_proposals").select("id,version,fields,apply_unit").in("id", oldIds)) as Rows;
    for (const p of ((pv.data as { id: string; version: number; fields: StoredProposal["fields"]; apply_unit: string }[] | null) ?? [])) prev.set(p.id, { version: p.version, fields: p.fields, apply_unit: p.apply_unit });
  }
  const out: Record<string, ProposalView[]> = {};
  for (const x of list) {
    const review = latest.get(x.proposal_key) ?? null;
    const outdated = !!review && review.proposal_id !== x.id;
    const truth = truths.get(x.proposal_key) ?? null;
    (out[x.candidate_id] ??= []).push({ ...x, review, reviewOutdated: outdated, reviewedVersion: outdated && review ? prev.get(review.proposal_id) ?? null : null, truth, truthOutdated: !!truth && truth.proposal_id !== x.id });
  }
  return out;
}
