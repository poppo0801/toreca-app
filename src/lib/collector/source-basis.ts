/**
 * 値の出どころの層（Stage 9H-1・純関数）。応募・チケットサービス（LivePocket等）では、主催者が書いた説明本文と、サービス側の受付期間などの表示は別。
 * 収集経路（保存済みの収集処理）はこの判定だけを使う（自律調査エンジンの部品は本番の経路から読み込まない）。
 */
import type { FieldSource } from "./fields";

/** 応募・チケットサービスのホスト（種類の知識。巡回の規則ではない） */
export const PLATFORM_HOSTS = ["livepocket.jp", "t.livepocket.jp", "peatix.com", "forms.gle", "docs.google.com", "form.run", "e-starbox.com", "shoplottery.e-starbox.com", "select-type.com", "yappli.plus"];

export function platformHostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
export const isPlatformUrl = (u: string): boolean => {
  const h = platformHostOf(u);
  return !!h && PLATFORM_HOSTS.some((x) => h === x || h.endsWith(`.${x}`));
};

/** 一覧の表示（まとめサイト経由）はサービス側の表示、応募サービスのページを直接読んだものは主催者本文 */
export function sourceBasis(url: string, opts: { viaList?: boolean }): FieldSource["basis"] {
  if (!isPlatformUrl(url)) return undefined;
  return opts.viaList ? "platform_meta" : "organizer_body";
}
