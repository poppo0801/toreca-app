"use server";

import { z } from "zod";
import { normalizeProfileSettings, SETTING_KEYS, type ProfileSettingKey, type ProfileSettings } from "@/lib/profile-settings";
import { createClient } from "@/lib/supabase/server";

/**
 * プロフィール別の設定の保存とコピー。ログイン必須で、世帯内のプロフィールだけが対象（RLS・RPC側でも確認する）。
 * 保存値は normalizeProfileSettings を通した項目だけ。通知先・応募履歴などプロフィール固有のデータには触れない。
 */
type R = { ok: true } | { ok: false; error: string };
const fail = (error: string): R => ({ ok: false, error });
const uuid = z.uuid();

async function authed() {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user ? supabase : null;
  } catch {
    return null;
  }
}

/** 指定した項目だけを更新する（他の項目は保持）。値が null の項目は設定を消して既定に戻す */
export async function saveProfileSettings(profileId: string, patch: Partial<Record<ProfileSettingKey, unknown>>, actor: string | null): Promise<R> {
  if (!uuid.safeParse(profileId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const supabase = await authed();
  if (!supabase) return fail("ログインが必要です");
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return fail("世帯が見つかりません");

  const keys = Object.keys(patch).filter((k): k is ProfileSettingKey => (SETTING_KEYS as string[]).includes(k));
  if (keys.length === 0) return fail("変更する項目がありません");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
  const db = supabase as any;
  const cur = await db.from("profile_settings").select("settings").eq("profile_id", profileId).maybeSingle();
  if (cur.error) return fail("設定を読み込めませんでした");
  const next: Record<string, unknown> = { ...normalizeProfileSettings(cur.data?.settings) };
  for (const k of keys) {
    const v = patch[k];
    if (v === null) {
      delete next[k];
      continue;
    }
    const checked = normalizeProfileSettings({ [k]: v });
    if (!(k in checked)) return fail("設定の値が正しくありません");
    next[k] = checked[k];
  }
  const { error } = await db.from("profile_settings").upsert({ profile_id: profileId, household_id: hh.id, settings: next, updated_by_profile_id: actor }, { onConflict: "profile_id" });
  if (error) return fail("設定を保存できませんでした");
  return { ok: true };
}

/** 選んだ項目だけを、コピー元のプロフィールからコピー先へ上書きする（1トランザクション。失敗時は何も変わらない） */
export async function copyProfileSettings(fromId: string, toId: string, keys: string[], actor: string | null): Promise<R> {
  if (!uuid.safeParse(fromId).success || !uuid.safeParse(toId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  if (fromId === toId) return fail("コピー元とコピー先は別のプロフィールを選んでください");
  const allowed = [...new Set(keys)].filter((k) => (SETTING_KEYS as string[]).includes(k));
  if (allowed.length === 0 || allowed.length !== new Set(keys).size) return fail("コピーする項目を選んでください");
  const supabase = await authed();
  if (!supabase) return fail("ログインが必要です");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い場合がある
  const { error } = await (supabase as any).rpc("copy_profile_settings", { p_from: fromId, p_to: toId, p_keys: allowed, p_actor: actor });
  if (error) return fail("設定をコピーできませんでした。何も変更していません");
  return { ok: true };
}

export type { ProfileSettings };
