"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { battleInputSchema, isSameMatch, toCanonical, type BattleInput } from "@/lib/battle";
import { createClient } from "@/lib/supabase/server";
import type { BattleRecord } from "@/types/domain";

export type BattleActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): BattleActionResult => ({ ok: false, error });
const uuid = z.uuid();

/**
 * 対戦記録の登録(id=null)・編集（Stage 7G）。ログイン中の本人の権限（RLS: 自世帯のみ）で保存し、操作履歴(audit)に残る。
 *  - 記録の持ち主（profile_id）は操作しているプロフィール（actor）。入力欄では選ばない。
 *  - アプリ内プロフィールとの対戦（opponentProfileId）は1件だけ保存する。相手側から編集しても、保存する形（記録した側から見た形）に直して同じ1件を更新する。
 *  - 外部の相手は opponent（名称・任意）。アプリ内の相手を選んだときは名称を持たない（表示はプロフィール名）。
 *  - opId: 登録操作の識別。再送・二重タップで二重登録しない。相手側が同じ対戦を登録しようとしたときも、登録済みとして断る。
 * 収支・抽選のデータには触れない。
 */
export async function saveBattle(id: string | null, raw: BattleInput, actor: string | null, opId: string | null = null): Promise<BattleActionResult> {
  const parsed = battleInputSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  if ((id !== null && !uuid.safeParse(id).success) || (actor !== null && !uuid.safeParse(actor).success) || (opId !== null && !uuid.safeParse(opId).success)) return fail("リクエストが不正です");
  if (!actor) return fail("操作しているプロフィールを確認できません");
  const i = parsed.data;
  const opponentProfileId = i.opponentProfileId ?? null;

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");

  if (opponentProfileId) {
    const { data: p } = await supabase.from("profiles").select("id").eq("id", opponentProfileId).eq("active", true).maybeSingle();
    if (!p) return fail("対戦相手のプロフィールが見つかりません");
  }

  if (id) {
    const { data: cur } = await supabase.from("battle_records").select("*").eq("id", id).is("archived_at", null).maybeSingle();
    if (!cur) return fail("対戦記録が見つかりません（他の端末で削除された可能性があります）");
    const r = cur as unknown as { profile_id: string | null; opponent_profile_id: string | null };
    // 参加者（記録した人・アプリ内の相手）だけが編集できる。持ち主が決まっていない記録は、先に「自分の記録にする」
    const role = r.profile_id === actor ? "player" : r.opponent_profile_id === actor ? "opponent" : null;
    // 相手側（アプリ内の相手）の編集では、相手の指定は使わない。記録した側の編集で、自分自身は相手に選べない
    if (role === "player" && opponentProfileId === actor) return fail("対戦相手に自分自身は選べません");
    if (!role) return fail(r.profile_id === null ? "持ち主が決まっていない記録です。先に「自分の記録にする」を選んでください" : "他のユーザーの対戦記録は変更できません");
    const c = toCanonical({ myDeck: i.myDeck, opponentDeck: i.opponentDeck, result: i.result, turnOrder: i.turnOrder }, role);
    const row: Record<string, unknown> = { played_on: i.playedOn, my_deck: c.myDeck, opponent_deck: c.opponentDeck, result: c.result, turn_order: c.turnOrder, format: i.format, memo: i.memo, updated_by_profile_id: actor };
    // 相手の変更（アプリ内の相手・外部の名称）は記録した側だけ。相手側からは変えない
    if (role === "player") Object.assign(row, { opponent_profile_id: opponentProfileId, opponent: opponentProfileId ? "" : i.opponent });
    const { data, error } = await supabase.from("battle_records").update(row).eq("id", id).is("archived_at", null).select("id");
    if (error) return fail("保存に失敗しました");
    if (!data || data.length === 0) return fail("対戦記録が見つかりません（他の端末で削除された可能性があります）");
  } else {
    if (opponentProfileId === actor) return fail("対戦相手に自分自身は選べません");
    const { data: hh } = await supabase.from("households").select("id").maybeSingle();
    if (!hh) return fail("世帯が見つかりません");
    // アプリ内同士の対戦は、相手側がすでに同じ対戦を登録していたら二重に登録しない
    if (opponentProfileId) {
      const { data: same } = await supabase.from("battle_records").select("*").eq("played_on", i.playedOn).is("archived_at", null).or(`profile_id.eq.${opponentProfileId},opponent_profile_id.eq.${opponentProfileId}`).limit(50);
      const cand: BattleRecord = { id: "", playedOn: i.playedOn, profileId: actor, opponentProfileId, myDeck: i.myDeck, opponent: "", opponentDeck: i.opponentDeck, result: i.result as BattleRecord["result"], turnOrder: i.turnOrder, format: i.format, memo: "" };
      for (const s of (same ?? []) as unknown as Record<string, unknown>[]) {
        const rec: BattleRecord = { id: s.id as string, playedOn: s.played_on as string, profileId: (s.profile_id as string) ?? null, opponentProfileId: (s.opponent_profile_id as string) ?? null, myDeck: s.my_deck as string, opponent: s.opponent as string, opponentDeck: s.opponent_deck as string, result: s.result as BattleRecord["result"], turnOrder: s.turn_order as BattleRecord["turnOrder"], format: s.format as string, memo: s.memo as string };
        if (isSameMatch(rec, cand)) return fail("同じ対戦がすでに登録されています（相手の記録として表示されます）");
      }
    }
    const row = { played_on: i.playedOn, profile_id: actor, opponent_profile_id: opponentProfileId, my_deck: i.myDeck, opponent: opponentProfileId ? "" : i.opponent, opponent_deck: i.opponentDeck, result: i.result, turn_order: i.turnOrder, format: i.format, memo: i.memo, updated_by_profile_id: actor, op_id: opId, household_id: hh.id };
    const { error } = await supabase.from("battle_records").insert(row as never);
    // 同じ操作の再送（二重タップ・通信の再試行）は、登録済みとして扱う
    if (error && !(error.code === "23505" && opId)) return fail("保存に失敗しました");
  }
  revalidatePath("/battles");
  return { ok: true };
}

/** 持ち主が決まっていない記録（既存データなど）を、操作しているプロフィールの記録にする。すでに持ち主がいる記録は変えない */
export async function claimBattle(id: string, actor: string | null): Promise<BattleActionResult> {
  if (!uuid.safeParse(id).success || !actor || !uuid.safeParse(actor).success) return fail("リクエストが不正です");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data, error } = await supabase.from("battle_records").update({ profile_id: actor, updated_by_profile_id: actor }).eq("id", id).is("profile_id", null).is("archived_at", null).select("id");
  if (error) return fail("保存に失敗しました");
  if (!data || data.length === 0) return fail("この記録はすでに持ち主が決まっているか、見つかりません");
  revalidatePath("/battles");
  return { ok: true };
}

/** 対戦記録の削除。物理削除はせず、記録を非表示（archived_at）にする（操作履歴は残る）。参加者（持ち主・アプリ内の相手）と、持ち主が決まっていない記録のみ */
export async function deleteBattle(id: string, actor: string | null): Promise<BattleActionResult> {
  if (!uuid.safeParse(id).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: cur } = await supabase.from("battle_records").select("profile_id,opponent_profile_id").eq("id", id).is("archived_at", null).maybeSingle();
  if (!cur) return fail("対戦記録が見つかりません");
  const r = cur as unknown as { profile_id: string | null; opponent_profile_id: string | null };
  if (r.profile_id !== null && r.profile_id !== actor && r.opponent_profile_id !== actor) return fail("他のユーザーの対戦記録は削除できません");
  const { data, error } = await supabase.from("battle_records").update({ archived_at: new Date().toISOString(), updated_by_profile_id: actor }).eq("id", id).is("archived_at", null).select("id");
  if (error) return fail("削除に失敗しました");
  if (!data || data.length === 0) return fail("対戦記録が見つかりません");
  revalidatePath("/battles");
  return { ok: true };
}
