import "server-only";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { emptyChecks, emptyDraft, nowIso, progressOf, validateConfirm, type Draft, type ExcludeReason, type FieldChecks, type HistoryEntry, type PageRecord, type PageVersion, type Problem, type ReviewState } from "@/lib/gold-review/model";
import { pageText } from "@/lib/judgment/xsource/html-text";
import { pageCandidate, validatePageGold, type PageCandidate, type R1PageGold } from "@/lib/judgment/xsource/r1-worksheet";

/**
 * 独立gold確認（開発専用）の保存と読み込み。**Git管理外のローカルファイルだけ**（eval/phase2-compare/gold-review.local.json）。本番・Vercelでは使えない。
 *  - 有効条件: ローカル開発（TOREMANE_ENV=local）・接続先がローカルのSupabase・GOLD_REVIEW=on・Vercelでない。満たさなければ画面は404・操作は拒否。
 *  - 書き込みは原子的（一時ファイル→置換）。書き込みの前に直前の状態をバックアップ（最大30世代）。エクスポート／インポート（検証つき）。
 *  - AI・旧方式・登録案の出力は一切読まない（読むのは保存済みの公開ページと、人の入力だけ）。
 */
type Env = Record<string, string | undefined>;
const LOCAL_SUPABASE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

export function goldReviewEnabled(env: Env = process.env): boolean {
  if (env.VERCEL || env.VERCEL_ENV) return false;
  if (!LOCAL_SUPABASE.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) return false;
  return env.TOREMANE_ENV === "local" && env.GOLD_REVIEW === "on";
}

export const reviewDir = (env: Env = process.env): string => resolve(env.GOLD_REVIEW_DIR || "eval/phase2-compare");
export const pagesDir = (env: Env = process.env): string => resolve(env.GOLD_REVIEW_PAGES_DIR || "eval/real-data/10t-html");
const stateFile = (env: Env = process.env): string => join(reviewDir(env), "gold-review.local.json");
const backupDir = (env: Env = process.env): string => join(reviewDir(env), "gold-review-backups");

export interface ReviewPage {
  n: number;
  url: string;
  text: string;
  version: PageVersion;
  candidate: PageCandidate;
}

/** 保存済みの公開ページ（index.json の ok のもの）。公式ページへのリンクは https の URL だけ */
export function loadPages(env: Env = process.env): ReviewPage[] {
  const dir = pagesDir(env);
  const idxPath = join(dir, "index.json");
  if (!existsSync(idxPath)) return [];
  const idx = JSON.parse(readFileSync(idxPath, "utf8")) as { n: number; url: string; ok: boolean }[];
  const out: ReviewPage[] = [];
  for (const x of idx) {
    if (!x.ok || !Number.isInteger(x.n)) continue;
    const f = join(dir, `lp-${x.n}.html`);
    if (!existsSync(f)) continue;
    let url: string;
    try {
      const u = new URL(x.url);
      if (u.protocol !== "https:") continue;
      url = u.toString();
    } catch {
      continue;
    }
    const html = readFileSync(f, "utf8");
    const text = pageText(html);
    out.push({ n: x.n, url, text, version: { hash: createHash("sha256").update(html).digest("hex").slice(0, 16), chars: text.length, savedAt: statSync(f).mtime.toISOString() }, candidate: pageCandidate({ n: x.n, url, html }) });
  }
  return out.sort((a, b) => a.n - b.n);
}

const newRecord = (n: number): PageRecord => ({ n, status: "unreviewed", draft: emptyDraft(), checks: emptyChecks(), history: [] });

/** 保存された状態を読み、ページの一覧と同期する（新しいページは未確認で追加／ページが変わっていたら要再確認／ページが消えた記録は残す） */
export function loadState(pages: readonly ReviewPage[], env: Env = process.env): ReviewState {
  const f = stateFile(env);
  let st: ReviewState = { v: 1, updatedAt: nowIso(), pages: [] };
  if (existsSync(f)) {
    try {
      const parsed = stateSchema.parse(JSON.parse(readFileSync(f, "utf8")));
      st = parsed as ReviewState;
    } catch {
      throw new Error("確認の保存ファイルを読めません（壊れている可能性。gold-review-backups から復元してください）");
    }
  }
  const byN = new Map(st.pages.map((p) => [p.n, p]));
  const out: PageRecord[] = pages.map((pg) => {
    const rec = byN.get(pg.n) ?? newRecord(pg.n);
    const seen = rec.confirmed?.pageVersion ?? rec.excluded?.pageVersion;
    if ((rec.status === "confirmed" || rec.status === "excluded") && seen && seen.hash !== pg.version.hash) return { ...rec, status: "needs_recheck", history: [...rec.history, { at: nowIso(), action: "page_changed" as const, note: "確認後に保存済みのページの内容が変わりました" }].slice(-100) };
    return rec;
  });
  return { ...st, pages: out };
}

const draftSchema = z.object({ store: z.string().max(120), product: z.string().max(200), applyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), applyEndUnknown: z.boolean(), applyUnit: z.enum(["one_form_one", "store_select", "per_store", "per_product"]).nullable(), applyUnitUnknown: z.boolean(), region: z.string().max(60), round: z.string().max(120), quotes: z.array(z.string().max(400)).max(10) });
const checksSchema = z.object({ officialPageOpened: z.boolean(), store: z.boolean(), product: z.boolean(), applyEnd: z.boolean(), applyUnit: z.boolean(), quotes: z.boolean() });
const versionSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{16}$/), chars: z.number().int().min(0), savedAt: z.string().max(40) });
const historySchema = z.object({ at: z.string().max(40), action: z.enum(["draft_saved", "confirmed", "excluded", "reopened", "imported", "page_changed"]), changed: z.array(z.string().max(30)).max(12).optional(), note: z.string().max(200).optional() });
const stateSchema = z.object({
  v: z.literal(1),
  updatedAt: z.string().max(40),
  pages: z.array(
    z.object({
      n: z.number().int().min(1).max(9999),
      status: z.enum(["unreviewed", "confirmed", "excluded", "needs_recheck"]),
      draft: draftSchema,
      checks: checksSchema,
      confirmed: z.object({ draft: draftSchema, checks: checksSchema, basis: z.string().max(400), verifiedAt: z.string().max(40), pageVersion: versionSchema, reviewer: z.string().max(40) }).optional(),
      excluded: z.object({ reason: z.enum(["multi_slot", "multi_product", "multi_store", "not_apply_page", "unclear", "other"]), note: z.string().max(400), at: z.string().max(40), pageVersion: versionSchema }).optional(),
      history: z.array(historySchema).max(100),
    }),
  ).max(200),
});
export { stateSchema };

/** 原子的に保存（直前の状態をバックアップ）。バックアップは最大30世代 */
export function saveState(st: ReviewState, env: Env = process.env): void {
  const f = stateFile(env);
  mkdirSync(reviewDir(env), { recursive: true });
  if (existsSync(f)) {
    mkdirSync(backupDir(env), { recursive: true });
    copyFileSync(f, join(backupDir(env), `${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    const olds = readdirSync(backupDir(env)).filter((x) => x.endsWith(".json")).sort();
    for (const o of olds.slice(0, Math.max(0, olds.length - 30))) unlinkSync(join(backupDir(env), o));
  }
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: nowIso() }, null, 1));
  renameSync(tmp, f);
}

// ------------------------------------------------------------------ 操作（純関数＋検査）。呼び出し側が saveState する
const hist = (rec: PageRecord, e: HistoryEntry): PageRecord => ({ ...rec, history: [...rec.history, e].slice(-100) });
const replace = (st: ReviewState, rec: PageRecord): ReviewState => ({ ...st, pages: st.pages.map((p) => (p.n === rec.n ? rec : p)) });
const changedFields = (a: Draft, b: Draft): string[] => (Object.keys(a) as (keyof Draft)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

export function opSaveDraft(st: ReviewState, n: number, draft: Draft, checks: FieldChecks): ReviewState {
  const rec = st.pages.find((p) => p.n === n);
  if (!rec) throw new Error("ページが見つかりません");
  // 確認済みの内容は、下書きの保存では変わらない（変更するには「再確認」にする）
  if (rec.status === "confirmed" || rec.status === "excluded") throw new Error("確認済み・除外のページは、先に「再確認にする」を押してください");
  return replace(st, hist({ ...rec, draft, checks }, { at: nowIso(), action: "draft_saved", changed: changedFields(rec.draft, draft) }));
}

export function opConfirm(st: ReviewState, page: ReviewPage, draft: Draft, checks: FieldChecks, basis: string, reviewer: string): { state: ReviewState; problems: Problem[] } {
  const rec = st.pages.find((p) => p.n === page.n);
  if (!rec) throw new Error("ページが見つかりません");
  const problems = validateConfirm({ draft, checks, basis, pageText: page.text });
  if (problems.length) return { state: st, problems };
  const at = nowIso();
  const confirmed = { draft: { ...draft, quotes: draft.quotes.map((q) => q.trim()).filter(Boolean) }, checks, basis: basis.trim(), verifiedAt: at, pageVersion: page.version, reviewer };
  return { state: replace(st, hist({ ...rec, status: "confirmed", draft, checks, confirmed, excluded: undefined }, { at, action: "confirmed", changed: changedFields(rec.confirmed?.draft ?? emptyDraft(), draft) })), problems: [] };
}

export function opExclude(st: ReviewState, page: ReviewPage, reason: ExcludeReason, note: string): ReviewState {
  const rec = st.pages.find((p) => p.n === page.n);
  if (!rec) throw new Error("ページが見つかりません");
  if (reason === "other" && note.trim().length < 3) throw new Error("「その他」の理由をメモに書いてください");
  const at = nowIso();
  return replace(st, hist({ ...rec, status: "excluded", excluded: { reason, note: note.trim().slice(0, 400), at, pageVersion: page.version }, confirmed: undefined }, { at, action: "excluded", note: reason }));
}

/** 確認済み・除外・要再確認を「未確認」へ戻す（入力した内容は下書きに残る。確認済みの内容は履歴に残らず下書きへ移る） */
export function opReopen(st: ReviewState, n: number): ReviewState {
  const rec = st.pages.find((p) => p.n === n);
  if (!rec) throw new Error("ページが見つかりません");
  const draft = rec.confirmed?.draft ?? rec.draft;
  return replace(st, hist({ ...rec, status: "unreviewed", draft, checks: emptyChecks(), confirmed: undefined, excluded: undefined }, { at: nowIso(), action: "reopened" }));
}

// ------------------------------------------------------------------ エクスポート／インポート／R1の入力へ
export const exportState = (st: ReviewState): string => JSON.stringify(st, null, 1);

/** インポート: 形式を検査し、確認済みの記録は**ページの本文・版で再検査**する（通らないものは「要再確認」へ。取り込みが確認を偽装できない） */
export function importState(json: string, pages: readonly ReviewPage[]): { state: ReviewState; downgraded: number[]; ignored: number[] } {
  const parsed = stateSchema.parse(JSON.parse(json)) as ReviewState;
  const byN = new Map(pages.map((p) => [p.n, p]));
  const downgraded: number[] = [];
  const ignored: number[] = [];
  const out: PageRecord[] = [];
  for (const rec of parsed.pages) {
    const pg = byN.get(rec.n);
    if (!pg) {
      ignored.push(rec.n);
      continue;
    }
    if (rec.status === "confirmed" && rec.confirmed) {
      const probs = validateConfirm({ draft: rec.confirmed.draft, checks: rec.confirmed.checks, basis: rec.confirmed.basis, pageText: pg.text });
      if (probs.length || rec.confirmed.pageVersion.hash !== pg.version.hash) {
        downgraded.push(rec.n);
        out.push(hist({ ...rec, status: "needs_recheck" }, { at: nowIso(), action: "imported", note: "取り込み時の再検査を通らなかったため要再確認" }));
        continue;
      }
    }
    out.push(hist(rec, { at: nowIso(), action: "imported" }));
  }
  return { state: { v: 1, updatedAt: nowIso(), pages: out }, downgraded, ignored };
}

/** R1 の入力（ページ単位のgold）。確認が完了していなければ null（未確認が残る間は有料試験の入力を作らない） */
export function buildR1PageGold(st: ReviewState): { gold: R1PageGold[]; excluded: { n: number; reason: ExcludeReason; note: string }[] } | null {
  if (!progressOf(st.pages).complete) return null;
  const gold: R1PageGold[] = [];
  const excluded: { n: number; reason: ExcludeReason; note: string }[] = [];
  for (const p of st.pages) {
    if (p.status === "excluded" && p.excluded) {
      excluded.push({ n: p.n, reason: p.excluded.reason, note: p.excluded.note });
      gold.push({ n: p.n, exclude: true, verified: { by: "human", at: p.excluded.at, basis: `除外（${p.excluded.reason}）` }, store: "", product: "", applyEnd: null, applyUnit: null, region: null, evidence: [] });
    } else if (p.status === "confirmed" && p.confirmed) {
      const c = p.confirmed;
      gold.push({ n: p.n, verified: { by: "human", at: c.verifiedAt, basis: `${c.basis}（確認したページの版 ${c.pageVersion.hash}）` }, store: c.draft.store.trim(), product: c.draft.product.trim(), applyEnd: c.draft.applyEnd, applyUnit: c.draft.applyUnit, region: c.draft.region.trim() || null, evidence: c.draft.quotes.filter(Boolean).map((quote) => ({ quote })) });
    }
  }
  return { gold, excluded };
}

/** 確認が完了していれば r1-gold-pages.local.json を書き出し（既存の r1-build が読む）、ページの本文との照合も再度行う */
export function writeR1Gold(pages: readonly ReviewPage[], st: ReviewState, env: Env = process.env): { ok: true; confirmed: number; excluded: number } | { ok: false; reason: string } {
  const built = buildR1PageGold(st);
  if (!built) return { ok: false, reason: "未確認・要再確認のページが残っています（全てのページを確認または除外してください）" };
  const v = validatePageGold(built.gold, pages.map((p) => ({ n: p.n, html: `<body>${p.text}</body>` })));
  if (!v.ok) return { ok: false, reason: `引用の再照合に失敗しました: ${v.errors.slice(0, 2).join(" / ")}` };
  writeFileSync(join(reviewDir(env), "r1-gold-pages.local.json"), JSON.stringify(built.gold, null, 1));
  return { ok: true, confirmed: built.gold.filter((g) => !g.exclude).length, excluded: built.excluded.length };
}

export const reviewerId = (userId: string): string => createHash("sha256").update(`gold-review:${userId}`).digest("hex").slice(0, 12);
