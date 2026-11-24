"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { type Draft, type FieldChecks, type Problem } from "@/lib/gold-review/model";
import { buildR1PageGold, exportState, goldReviewEnabled, importState, loadPages, loadState, opConfirm, opExclude, opReopen, opSaveDraft, reviewerId, saveState, writeR1Gold } from "@/lib/server/gold-review/store";
import { createClient } from "@/lib/supabase/server";

/**
 * 独立gold確認（開発専用）の操作。**ローカル開発かつ GOLD_REVIEW=on のときだけ動く**（本番・Vercel・未設定では常に拒否）。ログイン中の利用者だけ。
 * 保存はGit管理外のローカルファイルのみ。AI・旧方式・登録案の出力は使わない。入力は全て検査する（長さ・形式・列挙）。
 */
export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; problems?: Problem[] };

const draftSchema = z.object({ store: z.string().max(120), product: z.string().max(200), applyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), applyEndUnknown: z.boolean(), applyUnit: z.enum(["one_form_one", "store_select", "per_store", "per_product"]).nullable(), applyUnitUnknown: z.boolean(), region: z.string().max(60), round: z.string().max(120), quotes: z.array(z.string().max(400)).max(10) });
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

export async function saveDraftAction(n: number, draft: Draft, checks: FieldChecks): Promise<ActionResult> {
  if (!(await who())) return denied();
  const p = z.object({ n: z.number().int().min(1).max(9999), draft: draftSchema, checks: checksSchema }).safeParse({ n, draft, checks });
  if (!p.success) return { ok: false, error: "入力の形式が正しくありません" };
  try {
    const pages = loadPages();
    saveState(opSaveDraft(loadState(pages), p.data.n, p.data.draft, p.data.checks));
    revalidatePath("/dev/gold-review");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function confirmAction(n: number, draft: Draft, checks: FieldChecks, basis: string): Promise<ActionResult> {
  const uid = await who();
  if (!uid) return denied();
  const p = z.object({ n: z.number().int().min(1).max(9999), draft: draftSchema, checks: checksSchema, basis: z.string().max(400) }).safeParse({ n, draft, checks, basis });
  if (!p.success) return { ok: false, error: "入力の形式が正しくありません" };
  try {
    const pages = loadPages();
    const page = pages.find((x) => x.n === p.data.n);
    if (!page) return { ok: false, error: "ページが見つかりません" };
    const r = opConfirm(loadState(pages), page, p.data.draft, p.data.checks, p.data.basis, reviewerId(uid));
    if (r.problems.length) return { ok: false, error: "確認済みにできません。次の点を直してください", problems: r.problems };
    saveState(r.state);
    revalidatePath("/dev/gold-review");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function excludeAction(n: number, reason: string, note: string): Promise<ActionResult> {
  if (!(await who())) return denied();
  const p = z.object({ n: z.number().int().min(1).max(9999), reason: z.enum(["multi_slot", "multi_product", "multi_store", "not_apply_page", "unclear", "other"]), note: z.string().max(400) }).safeParse({ n, reason, note });
  if (!p.success) return { ok: false, error: "入力の形式が正しくありません" };
  try {
    const pages = loadPages();
    const page = pages.find((x) => x.n === p.data.n);
    if (!page) return { ok: false, error: "ページが見つかりません" };
    saveState(opExclude(loadState(pages), page, p.data.reason, p.data.note));
    revalidatePath("/dev/gold-review");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function reopenAction(n: number): Promise<ActionResult> {
  if (!(await who())) return denied();
  if (!Number.isInteger(n) || n < 1 || n > 9999) return { ok: false, error: "入力の形式が正しくありません" };
  try {
    const pages = loadPages();
    saveState(opReopen(loadState(pages), n));
    revalidatePath("/dev/gold-review");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function exportAction(): Promise<ActionResult<{ json: string }>> {
  if (!(await who())) return denied();
  try {
    return { ok: true, json: exportState(loadState(loadPages())) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function importAction(json: string): Promise<ActionResult<{ downgraded: number[]; ignored: number[] }>> {
  if (!(await who())) return denied();
  if (typeof json !== "string" || json.length > 2_000_000) return { ok: false, error: "ファイルが大きすぎます" };
  try {
    const pages = loadPages();
    const r = importState(json, pages);
    saveState(r.state); // 取り込み前の状態は saveState がバックアップする
    revalidatePath("/dev/gold-review");
    return { ok: true, downgraded: r.downgraded, ignored: r.ignored };
  } catch {
    return { ok: false, error: "取り込めませんでした（形式が正しくないか、壊れています）" };
  }
}

/** R1 の入力（r1-gold-pages.local.json）を書き出す。未確認・要再確認が残っていれば拒否（有料試験の入力を作らない） */
export async function writeGoldAction(): Promise<ActionResult<{ confirmed: number; excluded: number }>> {
  if (!(await who())) return denied();
  try {
    const pages = loadPages();
    const st = loadState(pages);
    if (!buildR1PageGold(st)) return { ok: false, error: "未確認・要再確認のページが残っています。全てのページを確認または除外してください" };
    const r = writeR1Gold(pages, st);
    return r.ok ? { ok: true, confirmed: r.confirmed, excluded: r.excluded } : { ok: false, error: r.reason };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
