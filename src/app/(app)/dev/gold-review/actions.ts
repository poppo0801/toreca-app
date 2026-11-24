"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { type Draft, type FieldChecks, type Problem } from "@/lib/gold-review/model";
import { buildR1PageGold, exportState, goldReviewEnabled, importState, loadReviewPages, loadState, opConfirm, opExclude, opHold, opReopen, opSaveDraft, reviewerId, saveState, writeR1Gold, writeRealGold } from "@/lib/server/gold-review/store";
import { createClient } from "@/lib/supabase/server";

/**
 * 独立gold確認（開発専用）の操作。**ローカル開発かつ GOLD_REVIEW=on のときだけ動く**（本番・Vercel・未設定では常に拒否）。ログイン中の利用者だけ。
 * 保存はGit管理外のローカルファイルのみ。AI・旧方式・登録案の出力は使わない。入力は全て検査する（長さ・形式・列挙）。
 * set: lp12=保存済みの実在LivePocketページ（合成R1）／real=実投稿のリンク先ページ（実投稿R1）。
 */
export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; problems?: Problem[] };

const setSchema = z.enum(["lp12", "real"]);
const nSchema = z.number().int().min(1).max(99999);
const draftSchema = z.object({ store: z.string().max(120), product: z.string().max(200), applyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), applyEndUnknown: z.boolean(), applyUnit: z.enum(["one_form_one", "store_select", "per_store", "per_product"]).nullable(), applyUnitUnknown: z.boolean(), region: z.string().max(60), round: z.string().max(120), quotes: z.array(z.string().max(400)).max(10), sameOpportunityAs: nSchema.nullable() });
const checksSchema = z.object({ officialPageOpened: z.boolean(), store: z.boolean(), product: z.boolean(), applyEnd: z.boolean(), applyUnit: z.boolean(), quotes: z.boolean() });

async function who(): Promise<string | null> {
  if (!goldReviewEnabled()) return null;
  try {
    const db = await createClient();
    const { data } = await db.auth.getUser();
    return data.user ? data.user.id : null;
  } catch {
    return null;
  }
}
const denied = <T extends object>(): ActionResult<T> => ({ ok: false, error: "この機能は有効になっていません（ログインとローカル開発の設定が必要です）" });
const bad = { ok: false as const, error: "入力の形式が正しくありません" };
const done = (): void => revalidatePath("/dev/gold-review");

export async function saveDraftAction(n: number, draft: Draft, checks: FieldChecks, set: string = "lp12"): Promise<ActionResult> {
  if (!(await who())) return denied();
  const p = z.object({ n: nSchema, draft: draftSchema, checks: checksSchema, set: setSchema }).safeParse({ n, draft, checks, set });
  if (!p.success) return bad;
  try {
    const pages = loadReviewPages(p.data.set);
    saveState(opSaveDraft(loadState(pages, process.env, p.data.set), p.data.n, p.data.draft, p.data.checks), process.env, p.data.set);
    done();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function confirmAction(n: number, draft: Draft, checks: FieldChecks, basis: string, set: string = "lp12"): Promise<ActionResult> {
  const uid = await who();
  if (!uid) return denied();
  const p = z.object({ n: nSchema, draft: draftSchema, checks: checksSchema, basis: z.string().max(400), set: setSchema }).safeParse({ n, draft, checks, basis, set });
  if (!p.success) return bad;
  try {
    const pages = loadReviewPages(p.data.set);
    const page = pages.find((x) => x.n === p.data.n);
    if (!page) return { ok: false, error: "ページが見つかりません" };
    const r = opConfirm(loadState(pages, process.env, p.data.set), page, p.data.draft, p.data.checks, p.data.basis, reviewerId(uid));
    if (r.problems.length) return { ok: false, error: "確認済みにできません。次の点を直してください", problems: r.problems };
    saveState(r.state, process.env, p.data.set);
    done();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function excludeAction(n: number, reason: string, note: string, set: string = "lp12"): Promise<ActionResult> {
  if (!(await who())) return denied();
  const p = z.object({ n: nSchema, reason: z.enum(["multi_slot", "multi_product", "multi_store", "not_apply_page", "unclear", "other"]), note: z.string().max(400), set: setSchema }).safeParse({ n, reason, note, set });
  if (!p.success) return bad;
  try {
    const pages = loadReviewPages(p.data.set);
    const page = pages.find((x) => x.n === p.data.n);
    if (!page) return { ok: false, error: "ページが見つかりません" };
    saveState(opExclude(loadState(pages, process.env, p.data.set), page, p.data.reason, p.data.note), process.env, p.data.set);
    done();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function holdAction(n: number, note: string, set: string = "lp12"): Promise<ActionResult> {
  if (!(await who())) return denied();
  const p = z.object({ n: nSchema, note: z.string().max(200), set: setSchema }).safeParse({ n, note, set });
  if (!p.success) return bad;
  try {
    const pages = loadReviewPages(p.data.set);
    saveState(opHold(loadState(pages, process.env, p.data.set), p.data.n, p.data.note), process.env, p.data.set);
    done();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function reopenAction(n: number, set: string = "lp12"): Promise<ActionResult> {
  if (!(await who())) return denied();
  const p = z.object({ n: nSchema, set: setSchema }).safeParse({ n, set });
  if (!p.success) return bad;
  try {
    const pages = loadReviewPages(p.data.set);
    saveState(opReopen(loadState(pages, process.env, p.data.set), p.data.n), process.env, p.data.set);
    done();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function exportAction(set: string = "lp12"): Promise<ActionResult<{ json: string }>> {
  if (!(await who())) return denied();
  const s = setSchema.safeParse(set);
  if (!s.success) return bad;
  try {
    return { ok: true, json: exportState(loadState(loadReviewPages(s.data), process.env, s.data)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function importAction(json: string, set: string = "lp12"): Promise<ActionResult<{ downgraded: number[]; ignored: number[] }>> {
  if (!(await who())) return denied();
  const s = setSchema.safeParse(set);
  if (!s.success || typeof json !== "string" || json.length > 4_000_000) return { ok: false, error: "ファイルが大きすぎるか、形式が正しくありません" };
  try {
    const pages = loadReviewPages(s.data);
    const r = importState(json, pages);
    saveState(r.state, process.env, s.data); // 取り込み前の状態は saveState がバックアップする
    done();
    return { ok: true, downgraded: r.downgraded, ignored: r.ignored };
  } catch {
    return { ok: false, error: "取り込めませんでした（形式が正しくないか、壊れています）" };
  }
}

/** goldの書き出し（lp12: R1用のページ単位gold／real: 実投稿の案件のgold）。未確認・要再確認が残っていれば（lp12）／確認が完了した案件がなければ（real）拒否 */
export async function writeGoldAction(set: string = "lp12"): Promise<ActionResult<{ confirmed: number; excluded: number; deferred?: number }>> {
  if (!(await who())) return denied();
  const s = setSchema.safeParse(set);
  if (!s.success) return bad;
  try {
    const pages = loadReviewPages(s.data);
    const st = loadState(pages, process.env, s.data);
    if (s.data === "real") {
      const r = writeRealGold(pages, st);
      return r.ok ? { ok: true, confirmed: r.cases, excluded: 0, deferred: r.deferred.length } : { ok: false, error: r.reason };
    }
    if (!buildR1PageGold(st)) return { ok: false, error: "未確認・要再確認のページが残っています。全てのページを確認または除外してください" };
    const r = writeR1Gold(pages, st);
    return r.ok ? { ok: true, confirmed: r.confirmed, excluded: r.excluded } : { ok: false, error: r.reason };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
