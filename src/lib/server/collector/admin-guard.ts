import "server-only";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 管理者プロフィールか（Stage 7J）。判定は表示名ではなくプロフィールID（profiles.is_admin）。
 * 操作しているプロフィール（actor）は画面から渡される。RLS により、自世帯のプロフィールだけが読める（他世帯のIDは管理者にならない）。
 * 抽選候補の除外ルールの作成・変更など、管理操作の前に必ず確認する。
 */
export async function isAdminProfile(db: Db, actor: string | null | undefined): Promise<boolean> {
  if (!actor) return false;
  const { data } = await db.from("profiles").select("is_admin,active").eq("id", actor).maybeSingle();
  return !!data && (data as { is_admin?: boolean }).is_admin === true && (data as { active?: boolean }).active !== false;
}

export const ADMIN_ONLY_MESSAGE = "この操作は管理者のプロフィールのみ実行できます";
