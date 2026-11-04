/**
 * 抽選の登録経路・確認履歴・除外の対象範囲（Stage 5T）の純関数。
 * 「確認済み」はユーザーが確認した履歴で、内容の安全性・正確性を保証するものではない。
 */
import { domainExcludable, hostOf, type ExclusionScope } from "@/lib/collector/triage";
import type { AppData, Lottery } from "@/types/domain";

export type RegistrationPath = NonNullable<Lottery["registrationPath"]>;

export const PATH_LABEL: Record<RegistrationPath, string> = {
  manual: "手動登録",
  manual_ai: "AIを利用した手動登録",
  auto: "自動収集（未確認）",
  auto_confirmed: "自動収集（ユーザー確認済み）",
};

export interface OriginInfo {
  path: RegistrationPath;
  label: string;
  /** check=確認済みのアイコン / bot=完全自動収集・未確認のアイコン */
  icon: "check" | "bot";
  /** 自動収集による登録（除外・確認の操作を出す対象） */
  auto: boolean;
}

export function originOf(l: Pick<Lottery, "registrationPath" | "sourceKind">): OriginInfo {
  const path: RegistrationPath = l.registrationPath ?? (l.sourceKind === "auto" ? "auto" : "manual");
  return { path, label: PATH_LABEL[path], icon: path === "auto" ? "bot" : "check", auto: path === "auto" || path === "auto_confirmed" };
}

export interface SourceScopeOption {
  scope: ExclusionScope;
  key: string;
  label: string;
  /** 範囲の説明（何が除外されるか） */
  hint: string;
}

/** Xの投稿URLからアカウント名 */
export function xAccountOf(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//.exec(url);
  return m ? m[1] : null;
}

/**
 * 「今後この収集元を除外」で選べる範囲。X全体・まとめサイト全体・共通の応募サービス全体は選択肢に出さない。
 * 店舗・系列・Xアカウント・個別サイト・特定の投稿元のうち、この抽選から特定できるものだけを、対象を明示して返す。
 */
export function sourceScopeOptions(l: Pick<Lottery, "storeId" | "chainId" | "sourceUrls">, data: Pick<AppData, "stores" | "chains">): SourceScopeOption[] {
  const out: SourceScopeOption[] = [];
  const store = data.stores.find((s) => s.id === l.storeId);
  const chain = data.chains.find((c) => c.id === l.chainId);
  if (store) out.push({ scope: "store", key: store.id, label: `店舗「${store.name}」`, hint: "この店舗の抽選を今後は登録しません" });
  if (chain) out.push({ scope: "chain", key: chain.id, label: `系列「${chain.name}」`, hint: "この系列のすべての店舗の抽選を今後は登録しません" });
  for (const u of l.sourceUrls) {
    const x = xAccountOf(u);
    if (x && !out.some((o) => o.scope === "x_account" && o.key === x)) out.push({ scope: "x_account", key: x, label: `Xアカウント @${x}`, hint: "このアカウントの投稿は今後は解析しません（Xの他のアカウントには影響しません）" });
    const host = hostOf(u);
    if (host && domainExcludable(host) && !out.some((o) => o.scope === "domain" && o.key === host)) out.push({ scope: "domain", key: host, label: `サイト ${host}`, hint: "このサイトのページは今後は解析しません（他のサイトには影響しません）" });
  }
  const first = l.sourceUrls[0];
  if (first && out.every((o) => o.scope !== "x_account")) out.push({ scope: "source_post", key: first.slice(0, 300), label: "この投稿元（このURLのみ）", hint: "このURLだけを今後は解析しません" });
  return out;
}

export const EXCLUSION_SCOPE_LABEL: Record<ExclusionScope, string> = { store: "店舗", chain: "系列", x_account: "Xアカウント", domain: "サイト", source_post: "投稿元" };
