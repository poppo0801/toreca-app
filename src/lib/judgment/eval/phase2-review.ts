/**
 * 第2段階（実データ評価）の正解（gold）作成・固定の部品（Stage 10E）。**純関数のみ。DB・ネットワークには接続しない**。架空データでテストする。
 *  - 人が原文を見て確認・修正・承認した内容だけを正解にする。AIの提案（proposal）・旧方式の判定・既存登録結果は、正解に流用しない（提案は参考表示のみ）。
 *  - 全30件を白紙から手入力しなくてよいよう、(1) 構造・機会数の候補と原文を並べたローカルの確認シートを作り、(2) 承認・修正・「判断不能」を選ぶだけにする。
 *  - 固定: 原文と正解のハッシュを manifest に記録し（ローカルのみ・Git管理外）、AI実行の前に固定。実行後の改変は検知できる（コミットは禁止のため、コミットの代わりにこの方式）。
 */
import { createHash } from "node:crypto";
import type { Gold } from "./replay";

export type ReviewDecision = "approved" | "unverifiable" | "excluded" | "pending";

export interface HumanGold {
  /** 確認した人（AI・自動処理の名義は不可） */
  reviewer: string;
  /** 確認日（YYYY-MM-DD） */
  reviewedAt: string;
  decision: ReviewDecision;
  structure?: string;
  opportunityCount?: number;
  fields?: Record<string, string>;
  /** 既存の抽選との関係の正解（既存の抽選IDを使うなら、伏せ字後の連番表記に置き換えたもの） */
  relations?: Record<string, string>;
  mustNotChange?: string[];
  /** 判断できない・曖昧さの注記（曖昧なら verifiable=false か、注記で残す） */
  note?: string;
}

export interface ProposalHint {
  /** 提案の出どころ。正解ではなく**参考表示**だけに使う */
  source: "ai" | "legacy" | "existing_registration";
  structure?: string;
  opportunityCount?: number;
  note?: string;
}

export interface ReviewItem {
  /** 外部へ出す連番（元の識別子は含めない） */
  seq: number;
  stratum: string;
  /** 伏せ字後の原文のハッシュ（改変検知用） */
  textHash: string;
  proposal?: ProposalHint;
  human?: HumanGold;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 確認シートの雛形（原文は含めず、ハッシュだけ。原文は別のローカルファイルで並べて表示する） */
export function newReviewSheet(prepared: { seq: number; stratum: string; text: string | null }[]): ReviewItem[] {
  return prepared.filter((p) => p.text != null).map((p) => ({ seq: p.seq, stratum: p.stratum, textHash: sha256(p.text as string) }));
}

/** 提案から確認の下書きを作る（省力化）。decision は pending で、**人が内容を確認して approved に変えるまで正解にならない** */
export function draftFromProposal(item: ReviewItem): HumanGold | null {
  if (!item.proposal) return null;
  return { reviewer: "", reviewedAt: "", decision: "pending", structure: item.proposal.structure, opportunityCount: item.proposal.opportunityCount, note: `提案（${item.proposal.source}）の下書き。人が確認するまで正解ではない` };
}

const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;

/** 確認内容の形式検査。問題の説明を返す（空なら有効） */
export function validateHuman(h: HumanGold): string[] {
  const e: string[] = [];
  if (!h.reviewer || !h.reviewer.trim()) e.push("確認者が必要です");
  else if (AI_NAME.test(h.reviewer)) e.push("確認者にAI・自動処理の名義は使えません");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(h.reviewedAt)) e.push("確認日は YYYY-MM-DD で必要です");
  if (h.decision === "pending") e.push("確認が完了していません（pending）");
  if (h.decision === "approved") {
    if (!h.structure) e.push("構造が必要です");
    if (!Number.isInteger(h.opportunityCount) || (h.opportunityCount as number) < 1) e.push("応募機会の数（1以上）が必要です");
  }
  return e;
}

export interface BuiltGold {
  gold: Record<string, Gold>;
  /** 正解にしなかった連番と理由（提案のみ・未承認・形式不備・除外） */
  notAdopted: { seq: number; reason: string }[];
}

/** 人が承認した内容だけから正解を作る。提案（proposal）は一切使わない。判断不能は verifiable=false（精度の分母に入れない） */
export function buildGold(items: ReviewItem[]): BuiltGold {
  const gold: Record<string, Gold> = {};
  const notAdopted: BuiltGold["notAdopted"] = [];
  for (const it of items) {
    const h = it.human;
    if (!h) {
      notAdopted.push({ seq: it.seq, reason: it.proposal ? "提案のみで、人の確認がありません" : "人の確認がありません" });
      continue;
    }
    const errs = validateHuman(h);
    if (errs.length) {
      notAdopted.push({ seq: it.seq, reason: errs.join("／") });
      continue;
    }
    if (h.decision === "excluded") {
      notAdopted.push({ seq: it.seq, reason: "除外（外部へ送らない）" });
      continue;
    }
    const id = `R${String(it.seq).padStart(2, "0")}`;
    if (h.decision === "unverifiable") gold[id] = { verifiable: false, reason: h.note || "判断できない原文", issue: h.note || "検証不能" };
    else gold[id] = { verifiable: true, structure: h.structure, opportunityCount: h.opportunityCount, fields: h.fields, relations: h.relations, mustNotChange: h.mustNotChange, issue: h.note || `確認者 ${h.reviewer}（${h.reviewedAt}）` };
  }
  return { gold, notAdopted };
}

export interface FrozenManifest {
  frozenAt: string;
  items: { seq: number; textHash: string; goldHash: string }[];
  rootHash: string;
}

const goldHash = (g: Gold | undefined): string => sha256(JSON.stringify(g ?? null));

/** 原文と正解を固定する（AI実行の前に作る）。ローカルのみ・コミットしない */
export function freezeManifest(items: ReviewItem[], built: BuiltGold, frozenAt: string): FrozenManifest {
  const rows = items
    .filter((i) => built.gold[`R${String(i.seq).padStart(2, "0")}`])
    .map((i) => ({ seq: i.seq, textHash: i.textHash, goldHash: goldHash(built.gold[`R${String(i.seq).padStart(2, "0")}`]) }));
  return { frozenAt, items: rows, rootHash: sha256(JSON.stringify(rows)) };
}

/** 固定後に、原文・正解が変えられていないかを検査する。変わった連番を返す */
export function verifyManifest(m: FrozenManifest, items: ReviewItem[], built: BuiltGold): { ok: boolean; changed: number[] } {
  const changed: number[] = [];
  for (const row of m.items) {
    const it = items.find((i) => i.seq === row.seq);
    const g = built.gold[`R${String(row.seq).padStart(2, "0")}`];
    if (!it || it.textHash !== row.textHash || goldHash(g) !== row.goldHash) changed.push(row.seq);
  }
  const rows = m.items.map((r) => ({ seq: r.seq, textHash: r.textHash, goldHash: r.goldHash }));
  const rootOk = sha256(JSON.stringify(rows)) === m.rootHash;
  return { ok: changed.length === 0 && rootOk, changed };
}

/** AI実行は、正解が固定された後でなければ開始できない（固定が実行開始より後・未固定・改変ありは拒否） */
export function assertGoldFrozenBeforeRun(m: FrozenManifest | null, runStartedAt: string, check: { ok: boolean }): void {
  if (!m) throw new Error("正解が固定されていません（実行不可）");
  if (!(Date.parse(m.frozenAt) <= Date.parse(runStartedAt))) throw new Error("正解の固定が実行開始より後です（実行不可）");
  if (!check.ok) throw new Error("固定後に原文または正解が変更されています（実行不可）");
}

/** ローカルの確認用ファイル（Markdown）。原文と、参考の提案（正解ではないと明記）を並べる。**このファイルもGit管理外に置く** */
export function renderReviewMarkdown(item: ReviewItem, text: string): string {
  const p = item.proposal;
  return [
    `# 確認 #${item.seq}（層: ${item.stratum}）`,
    "",
    "## 原文（伏せ字後）",
    text,
    "",
    "## 参考（正解ではありません）",
    p ? `- 提案の出どころ: ${p.source}\n- 構造の提案: ${p.structure ?? "なし"}\n- 機会数の提案: ${p.opportunityCount ?? "なし"}${p.note ? `\n- 備考: ${p.note}` : ""}` : "- 提案なし（白紙で確認）",
    "",
    "## あなたの確認（JSON の human に記入）",
    "- decision: approved（この内容で正解）/ unverifiable（判断不能）/ excluded（外部へ送らない）",
    "- structure・opportunityCount・fields（締切など）・relations・mustNotChange・note",
    "- reviewer（あなたの名前）・reviewedAt（YYYY-MM-DD）。提案を使う場合も、内容を確認して decision を approved に変える",
  ].join("\n");
}
