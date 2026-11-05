import type { AppData, Application, Profile } from "@/types/domain";

/**
 * メイン／サブユーザーの紐づけと、「応募済み」「当選」タブの表示範囲（Stage 6J・純関数）。
 *  - メイン: 自分＋自分に紐づくサブ（A に C が紐づくなら A は A＋C）
 *  - サブ: 自分だけ（C は C のみ）
 *  - 紐づいていないサブ・他のメインの履歴は混ぜない
 * 「全情報」「★管理対象」は世帯共通で、この範囲の影響を受けない。
 */

type ProfileLite = Pick<Profile, "id" | "kind" | "linkedMainId" | "active" | "label">;

export const isMain = (p: Pick<Profile, "kind">) => p.kind !== "sub";

/** メイン main に紐づくサブのID（有効・無効を問わない。履歴は無効化したユーザーのものも残るため） */
export function linkedSubIds(profiles: readonly ProfileLite[], mainId: string): string[] {
  return profiles.filter((p) => p.kind === "sub" && p.linkedMainId === mainId).map((p) => p.id);
}

/** 応募済み・当選タブに表示するプロフィールのID（現在のユーザー＋紐づくサブ。サブは本人のみ）。不明なユーザーは本人のみ */
export function scopeProfileIds(profiles: readonly ProfileLite[], profileId: string): string[] {
  const me = profiles.find((p) => p.id === profileId);
  if (!me || !isMain(me)) return [profileId];
  return [profileId, ...linkedSubIds(profiles, profileId)];
}

export const scopeSet = (profiles: readonly ProfileLite[], profileId: string): ReadonlySet<string> => new Set(scopeProfileIds(profiles, profileId));

/** 紐づけ先の選択肢: 同一世帯の有効なメインユーザー（自分自身は含まない）。サブ同士・無効なユーザーは出さない */
export function linkCandidates(profiles: readonly ProfileLite[], subId: string): ProfileLite[] {
  return profiles.filter((p) => p.id !== subId && isMain(p) && p.active !== false);
}

/** 紐づけの検証（画面とサーバーで同じ規則）。mainId=null は解除 */
export function validateLink(profiles: readonly ProfileLite[], subId: string, mainId: string | null): { ok: true } | { ok: false; error: string } {
  if (mainId === null) return { ok: true };
  const sub = profiles.find((p) => p.id === subId);
  const main = profiles.find((p) => p.id === mainId);
  if (!sub || !main) return { ok: false, error: "ユーザーが見つかりません" };
  if (subId === mainId) return { ok: false, error: "自分自身には紐づけられません" };
  if (sub.kind !== "sub") return { ok: false, error: "紐づけできるのはサブユーザーだけです" };
  if (!isMain(main)) return { ok: false, error: "紐づけ先はメインユーザーを選んでください（サブ同士は紐づけできません）" };
  if (main.active === false) return { ok: false, error: "無効なユーザーには紐づけできません" };
  return { ok: true };
}

/** 応募アカウントの所有プロフィール */
export const ownerIdOf = (data: Pick<AppData, "accounts">, app: Pick<Application, "accountId">): string | undefined => data.accounts.find((a) => a.id === app.accountId)?.profileId;

/** 抽選の有効な応募のうち、scope（プロフィールID）に属するもの。scope を渡さなければ全員分 */
export function scopedApplications(data: Pick<AppData, "applications" | "accounts">, lotteryId: string, scope?: ReadonlySet<string>): Application[] {
  const owner = new Map(data.accounts.map((a) => [a.id, a.profileId]));
  return data.applications.filter((a) => a.lotteryId === lotteryId && a.state === "applied" && (!scope || scope.has(owner.get(a.accountId) ?? "")));
}

/** 現在のユーザーが操作してよい応募の所有者か（本人、または本人に紐づくサブ） */
export function canOperateOwner(profiles: readonly ProfileLite[], actorId: string, ownerId: string): boolean {
  return actorId === ownerId || scopeProfileIds(profiles, actorId).includes(ownerId);
}
