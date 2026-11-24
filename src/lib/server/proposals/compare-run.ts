/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 同条件比較試験の実行部（Phase 2・開発専用・ローカルDBのみ）。純関数の採点・比較は judgment/xsource/compare-eval.ts。
 *  - 比較対象のアーム（例: 先頭1リンク vs 全リンク）ごとに、**同じ案件の入力を加工した候補**をローカルDBへ作る（案件・証拠・設定・モデルは同じ。違うのは比較対象だけ）。
 *  - 候補の入力（CompareCase）に gold は含まれない。gold は採点の段階でだけ読む。
 *  - 実AIの実行は、承認済みの関門を通った評価入口（compare-real.real.test.ts → real-run.ts の runRealProposals）だけ。ここは候補の作成・登録案の読み出し・採点の集計（モックの動作確認にも使う）。
 *  - 本番のDB・候補には接続しない（呼び出し側がローカルのSupabaseを渡す）。
 */
import { buildEvidence } from "@/lib/collector/evidence";
import { armsOf, assertNoGoldLeak, classifyReadStage, datasetClaim, type DatasetKind, compareArms, scoreCase, summarizeReadAudit, type ReadAuditSummary, type ReadStage, type Arm, type CaseScore, type CompareCase, type Comparison, type ExperimentId, type GoldCase } from "@/lib/judgment/xsource/compare-eval";
import { effectiveDecision, type ProposalRecord } from "@/lib/judgment/xsource/proposal";
import { rememberFullPages } from "@/lib/server/collector/collected-docs";
import type { Db } from "@/lib/server/lottery-service";
import { evidenceFromLastGood } from "@/lib/collector/evidence";
import { coverageReport, evaluateCoverage, type CoverageReport } from "@/lib/server/collector/limits-audit";
import { persistCollectedDocuments } from "./collected-store";
import { loadBestDocument, urlHashOf } from "./evidence-store";
import { generateProposalsForCandidate, mockDeps, type CandidateRow, type GenerateDeps } from "./generate";

export const CMP_HOST = "https://eval-cmp.invalid";

export interface ArmCandidate {
  arm: Arm;
  caseId: string;
  candidate: CandidateRow;
  /** AIに渡したページ（採点の引用の実在・混入の検査用。gold ではない） */
  pages: { url: string; text: string }[];
  postText: string;
}

/** 比較対象のアームごとに、案件の入力を加工した候補を作る（全文を保存するアームは evidence_documents にも保存する） */
export async function prepareArmCandidates(a: { db: Db; householdId: string; experiment: ExperimentId; cases: readonly CompareCase[]; now: string }): Promise<ArmCandidate[]> {
  const out: ArmCandidate[] = [];
  for (const base of a.cases) {
    for (const arm of armsOf(a.experiment)) {
      const c = arm.transform(base);
      const url = `${CMP_HOST}/${a.experiment}/${c.caseId}/${arm.id}`;
      const ev = buildEvidence(
        {
          url,
          kind: "x_post",
          post: { text: c.postText, links: c.links, linkMap: c.linkMap },
          linkedPages: c.pages.map((p) => ({ url: p.url, text: p.text })),
          ...(c.imageRefs.length ? { imageRefs: c.imageRefs } : {}),
          ...(c.imageReadings.length ? { imageReadings: c.imageReadings.map((r) => ({ field: r.field, text: r.text, source: `画像${r.imageIndex ?? ""}枚目`, imageIndex: r.imageIndex, kind: "ai_reading" as const, verified: null, uncertainty: r.uncertainty, readAt: a.now })) } : {}),
        } as never,
        a.now,
      );
      if (!ev) throw new Error(`候補の証拠を作れません: ${c.caseId}`);
      const { data, error } = await a.db
        .from("collection_candidates")
        .upsert({ household_id: a.householdId, dedupe_key: url, source_url: url, x_post_id: null, title: `cmp ${a.experiment} ${c.caseId} ${arm.role}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: ev } as never, draft: {} as never }, { onConflict: "household_id,dedupe_key" })
        .select("id,x_post_id,source_url,last_good")
        .single();
      if (error || !data) throw new Error(`候補を作れません: ${error?.message}`);
      if (arm.fullTextStore && c.pages.length) {
        const q = {};
        rememberFullPages(q, c.pages.map((p) => ({ url: p.url, finalUrl: p.url, title: "", text: p.text, truncated: false, fetchedAt: a.now, depth: 0 as const, origins: ["link_map" as const] })));
        await persistCollectedDocuments(a.db, a.householdId, data.id, q, { postUrl: url, postText: c.postText, nowIso: a.now });
      }
      out.push({ arm, caseId: c.caseId, candidate: data as CandidateRow, pages: c.pages, postText: c.postText });
    }
  }
  return out;
}

/** 登録案の行（DB）→ 採点用の記録 */
export async function readProposalRecords(db: Db, candidateId: string): Promise<ProposalRecord[]> {
  const { data } = await (db as unknown as { from: (n: string) => any }).from("registration_proposals").select("proposal_key,source_urls,decision,verified,held_reasons,apply_unit,cost_jpy,turns,fields").eq("candidate_id", candidateId).is("superseded_at", null).order("item_no");
  return ((data ?? []) as Record<string, any>[]).map((r) => ({ proposalKey: r.proposal_key, sourceUrls: r.source_urls ?? [], decision: effectiveDecision({ decision: r.decision, verified: r.verified !== false }), aiDecision: r.decision, verified: r.verified !== false, heldReasons: r.held_reasons ?? [], applyUnit: r.apply_unit, costJpy: r.cost_jpy, turns: r.turns ?? 0, fields: r.fields ?? {} }) as unknown as ProposalRecord);
}

export interface ExperimentOutcome {
  comparison: Comparison;
  claim: "accuracy" | "pipeline_check_only" | "structure_check_only";
  /** データセットの種類（合成と実投稿は別の結果。合成は精度として主張しない） */
  dataset: DatasetKind;
  scores: { baseline: CaseScore[]; treatment: CaseScore[] };
  /** AIへ渡した入力に gold の合言葉が混ざっていないこと */
  goldLeak: { ok: boolean; leaks: string[] };
  /** 上限・切り詰めの監査（毎回記録する）。記録の無い欠落があれば level=fail（結果の信頼性に関わるため、報告で明示する） */
  /** gold の重要条件が、収集→保存→AI入力→読み取り→判断のどこまで届いたか（段階ごとの件数）。アーム別 */
  readAudit: Record<"baseline" | "treatment", ReadAuditSummary>;
  limitAudit: { report: CoverageReport; level: "ok" | "warn" | "fail"; messages: string[] };
}

/** 準備済みの候補の登録案を gold と採点し、2つのアームを比較する（採点は実行の後。gold はここで初めて読まれる） */
export async function scoreExperiment(a: { dataset?: DatasetKind; householdId?: string; db: Db; experiment: ExperimentId; prepared: readonly ArmCandidate[]; gold: readonly GoldCase[]; modes: readonly string[]; required?: number }): Promise<ExperimentOutcome> {
  const goldBy = new Map(a.gold.map((g) => [g.caseId, g]));
  const scores = { baseline: [] as CaseScore[], treatment: [] as CaseScore[] };
  const stages: Record<"baseline" | "treatment", { stage: ReadStage }[]> = { baseline: [], treatment: [] };
  for (const p of a.prepared) {
    const g = goldBy.get(p.caseId);
    if (!g) continue; // gold の無い案件は採点しない（精度に数えない）
    const records = await readProposalRecords(a.db, p.candidate.id);
    const sc = scoreCase(g, records, { postText: p.postText, pages: p.pages });
    scores[p.arm.role].push(sc);
    // 読み飛ばしの切り分け（gold の引用ごと）
    if (a.householdId) {
      const stats = ((await (a.db as unknown as { from: (n: string) => any }).from("evidence_coverage_stats").select("proposal_key,url_hash,shown_ranges,read_ranges").in("proposal_key", records.map((r) => r.proposalKey))).data ?? []) as { proposal_key: string; url_hash: string | null; shown_ranges: number[][]; read_ranges: number[][] }[];  
      for (const o of g.opportunities) {
        const m = sc.matches.find((x) => x.oppId === o.oppId);
        const url = o.url;
        const collected = !!url && p.pages.some((x) => x.url === url);
        const doc = collected && url ? await loadBestDocument(a.db, a.householdId, p.candidate.id, url) : null;
        const ev = evidenceFromLastGood(p.candidate.last_good);
        const stored = doc?.text ?? (url ? ev?.linkedPages?.find((l) => l.url === url)?.text : undefined) ?? null;
        const stat = m?.proposalKey && url ? stats.find((s) => s.proposal_key === m.proposalKey && s.url_hash === urlHashOf(url)) : undefined;
        for (const e of o.evidence) stages[p.arm.role].push(classifyReadStage({ quote: e.quote, collected, storedText: stored, stat: stat ? { shownRanges: stat.shown_ranges, readRanges: stat.read_ranges } : null, fieldsCorrect: m ? m.store !== false && m.product !== false && m.deadline !== false : null }));
      }
    }
  }
  const visible = a.prepared.flatMap((p) => [p.postText, ...p.pages.map((x) => x.text), JSON.stringify((p.candidate.last_good as { evidence?: unknown } | null)?.evidence ?? {})]);
  const audit = coverageReport(a.prepared.map((p) => ({ ev: evidenceFromLastGood(p.candidate.last_good), texts: p.pages })));
  return { readAudit: { baseline: summarizeReadAudit(stages.baseline), treatment: summarizeReadAudit(stages.treatment) }, limitAudit: { report: audit, ...evaluateCoverage(audit) }, comparison: compareArms(a.experiment, scores.baseline, scores.treatment, a.required !== undefined ? { required: a.required } : {}), claim: datasetClaim(a.dataset ?? "real_post", a.modes), dataset: a.dataset ?? "real_post", scores, goldLeak: assertNoGoldLeak(visible, a.gold) };
}

/** モック（費用0・台本のAI）で、候補の作成 → 登録案の生成 → 採点 → 比較の全経路を通す。**結果は精度ではなく、試験の仕組みの確認**（claim=pipeline_check_only） */
export async function runExperimentMock(a: { db: Db; householdId: string; experiment: ExperimentId; cases: readonly CompareCase[]; gold: readonly GoldCase[]; dataset?: DatasetKind; env: Record<string, string | undefined>; now?: string; extraDeps?: (arm: Arm) => Partial<GenerateDeps>; required?: number }): Promise<ExperimentOutcome & { prepared: ArmCandidate[] }> {
  const now = a.now ?? new Date().toISOString();
  const prepared = await prepareArmCandidates({ db: a.db, householdId: a.householdId, experiment: a.experiment, cases: a.cases, now });
  for (const p of prepared) {
    const r = await generateProposalsForCandidate({ db: a.db, householdId: a.householdId, candidate: p.candidate, env: a.env, deps: mockDeps({ learn: p.arm.learn, ...(a.extraDeps?.(p.arm) ?? {}) }) });
    if (!r.ok) throw new Error(`登録案の生成に失敗: ${r.reason}`);
  }
  const out = await scoreExperiment({ householdId: a.householdId, db: a.db, experiment: a.experiment, prepared, gold: a.gold, modes: ["mock"], ...(a.dataset ? { dataset: a.dataset } : {}), ...(a.required !== undefined ? { required: a.required } : {}) });
  return { ...out, prepared };
}

// ------------------------------------------------------------------ 保存済みの実データ → 比較の入力
/**
 * ローカルDBの候補（保存済みの実データ）から、AIが見る入力（CompareCase）を作る。リンク先は評価用に保存した全文（evidence_documents）を優先する。
 * **正解（gold）・人の回答・登録案（AIの出力）は含めない**（原文・URL・リンク・画像の参照だけ）。
 */
export async function casesFromCandidates(db: Db, householdId: string, rows: readonly CandidateRow[]): Promise<CompareCase[]> {
  const { evidenceFromLastGood } = await import("@/lib/collector/evidence");
  const { loadBestDocument } = await import("./evidence-store");
  const out: CompareCase[] = [];
  for (const r of rows) {
    const ev = evidenceFromLastGood(r.last_good);
    if (!ev) continue;
    const pages: { url: string; text: string }[] = [];
    for (const lp of ev.linkedPages ?? []) {
      const full = await loadBestDocument(db, householdId, r.id, lp.url);
      pages.push({ url: lp.url, text: full?.text ?? lp.text });
    }
    out.push({
      caseId: r.id.slice(0, 8),
      postText: ev.text,
      links: ev.links,
      linkMap: ev.linkMap ?? [],
      pages,
      imageRefs: ev.imageRefs ?? [],
      imageReadings: (ev.imageReadings ?? []).map((x) => ({ field: x.field, text: x.text, imageIndex: x.imageIndex, uncertainty: x.uncertainty })),
    });
  }
  return out;
}

/**
 * 人が gold を作るための記入用の下書き（案件の入力の要約だけ。**AIの出力・旧方式の結果・登録案は含めない**）。
 * 人が公式ページ等で根拠を確認し、応募機会ごとに記入する。canary は自動で入る（記入者は触らない）。
 */
export function goldTemplate(cases: readonly CompareCase[]): { instructions: string[]; cases: { caseId: string; input: { postText: string; links: string[]; imageRefs: string[] }; gold: GoldCase }[] } {
  return {
    instructions: [
      "各案件について、公式ページ・投稿・画像を人が見て、応募機会（店舗×商品）を全て列挙する。",
      "AIの出力・旧方式の結果・保存済みの登録案を見て写さない（独立した正解にするため）。",
      "applyEnd は YYYY-MM-DD、不明は null。applyUnit は one_form_one / store_select / per_store / per_product、確認できなければ null。",
      "evidence には、根拠の場所（post / page:<番号> / image:<番号>）と原文の引用を必ず書く。verified.basis に確認方法を書く。",
    ],
    cases: cases.map((c, i) => ({
      caseId: c.caseId,
      input: { postText: c.postText, links: c.pages.map((p) => p.url), imageRefs: c.imageRefs },
      gold: { caseId: c.caseId, canary: `CANARY-${c.caseId}-${(i + 1).toString(36).padStart(2, "0")}-GOLD`, verified: { by: "human", at: "", basis: "" }, opportunities: [] },
    })),
  };
}

/**
 * 校正用の案件の gold（人が確認した根拠の引用）から、検証済み（gold）の調査経験を作って保存する（hints 実験の対照のための経験の元）。
 * 評価対象の案件には使わない（splitCalibration で分けた校正用だけ）。原文・URLは経験に含まれない（特徴語と位置の統計だけ）。
 */
export async function seedGoldExperiences(a: { db: Db; householdId: string; cases: readonly CompareCase[]; gold: readonly GoldCase[]; at: string }): Promise<number> {
  const { buildExperience, discoverFeatures } = await import("@/lib/judgment/xsource/experience");
  const { canonUrl } = await import("@/lib/judgment/xsource/normalize");
  const { saveExperience } = await import("./experience-store");
  let saved = 0;
  const goldBy = new Map(a.gold.map((g) => [g.caseId, g]));
  for (const c of a.cases) {
    const g = goldBy.get(c.caseId);
    if (!g) continue;
    for (const [i, p] of c.pages.entries()) {
      const quotes = g.opportunities.flatMap((o) => o.evidence.filter((e) => e.where === `page:${i}`).map((e) => e.quote));
      if (quotes.length === 0) continue;
      const exp = buildExperience({ features: discoverFeatures({ url: p.url, text: p.text }), text: p.text, quotes, verification: "gold", at: a.at });
      if (!exp) continue;
      if (await saveExperience(a.db, a.householdId, { ...exp, host: canonUrl(p.url).host.slice(0, 120) || "unknown", source: "gold_eval", failedFields: [], hintUsed: false, hintHit: null, mode: "mock", candidateId: null, proposalKey: null })) saved++;
    }
  }
  return saved;
}
