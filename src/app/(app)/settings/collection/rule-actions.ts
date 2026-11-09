"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PREFECTURE_LIST } from "@/lib/geo";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

/**
 * 除外ルール（collection_rules）の見直し（Stage 7H）: 編集・無効化・再有効化・削除。
 * 候補の除外履歴（collection_exclusion_log）は、ルールを削除しても残る（誰が・いつ・何のルールを作ったかの監査情報）。
 * 信頼性なし（系列・情報源）のルールは、従来の収集元の除外ルール（collection_exclusions）の画面で管理する。
 */
export type RuleResult = { ok: true } | { ok: false; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
const any = (db: Db) => db as any;
const id = z.uuid();

async function ctx(): Promise<{ db: Db } | null> {
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  return (await currentHouseholdId(db)) ? { db } : null;
}

export async function setRuleActiveAction(ruleId: string, active: boolean): Promise<RuleResult> {
  if (!id.safeParse(ruleId).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const now = new Date().toISOString();
  const { data, error } = await any(c.db).from("collection_rules").update({ active, released_at: active ? null : now, updated_at: now }).eq("id", ruleId).select("id");
  revalidatePath("/settings/collection");
  return error || !data?.length ? { ok: false, error: "更新できませんでした" } : { ok: true };
}

const editSchema = z.object({
  label: z.string().trim().max(120),
  note: z.string().trim().max(500),
  prefecture: z.string().trim().max(20).refine((v) => v === "" || (PREFECTURE_LIST as readonly string[]).includes(v), "都道府県が正しくありません"),
  city: z.string().trim().max(40),
  keywords: z.array(z.string().trim().min(2).max(40)).max(20),
});

export async function updateRuleAction(ruleId: string, raw: z.input<typeof editSchema>): Promise<RuleResult> {
  const p = editSchema.safeParse(raw);
  if (!id.safeParse(ruleId).success || !p.success) return { ok: false, error: p.success ? "不正な指定です" : (p.error.issues[0]?.message ?? "入力内容を確認してください") };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const cur = (await any(c.db).from("collection_rules").select("kind").eq("id", ruleId).maybeSingle()).data as { kind: string } | null;
  if (!cur) return { ok: false, error: "ルールが見つかりません" };
  // 別ゲームのルールは、キーワードが1つ以上必要（空にして広範囲を除外しない）
  if (cur.kind === "other_game" && p.data.keywords.length === 0) return { ok: false, error: "除外するキーワードを1つ以上入力してください" };
  const patch: Record<string, unknown> = { label: p.data.label, note: p.data.note, updated_at: new Date().toISOString() };
  if (cur.kind === "region_store") Object.assign(patch, { prefecture: p.data.prefecture, city: p.data.city });
  if (cur.kind === "other_game") Object.assign(patch, { keywords: [...new Set(p.data.keywords)] });
  const { error } = await any(c.db).from("collection_rules").update(patch).eq("id", ruleId);
  revalidatePath("/settings/collection");
  return error ? { ok: false, error: "更新できませんでした" } : { ok: true };
}

export async function deleteRuleAction(ruleId: string): Promise<RuleResult> {
  if (!id.safeParse(ruleId).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const { error } = await any(c.db).from("collection_rules").delete().eq("id", ruleId);
  revalidatePath("/settings/collection");
  return error ? { ok: false, error: "削除できませんでした" } : { ok: true };
}
