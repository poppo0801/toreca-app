import "server-only";
import { identifyAccount, identityHint, type AccountIdentity } from "@/lib/collector/store-identity";
import { normUsername, usernameFromPostUrl } from "@/lib/collector/x-accounts";
import { deepClean } from "@/lib/text-safe";
import { loadSourceCtx } from "@/lib/server/collector/open";
import { loadXIdentities, saveXIdentity } from "@/lib/server/collector/x-accounts";
import { loadAppData } from "@/lib/server/lottery-service";
import type { XClient } from "@/lib/server/collector/x-client";
import type { XProfile } from "@/lib/collector/x-posts";
import type { Db } from "@/lib/server/lottery-service";
import type { Json } from "@/types/database";
import type { LotteryInput } from "@/lib/lottery-input";

/**
 * 既存の確認待ち候補への、Xアカウントからの店舗・所在地の特定（Stage 6H）。AIは呼ばない。
 *  - 候補の投稿者（まとめアカウントの投稿は引用元）のプロフィールを、未確認のアカウントだけ最大 maxLookups 件取得する（X APIの1アカウントぶんの従量課金）
 *  - 表示名から系列・店舗を読み取り、マスターと照合し、プロフィールに所在地が明記されていれば都道府県を確定する（推測はしない）
 *  - 確認できた対応は x_account_identities に保存して再利用する。候補には、告知から読み取れなかった項目だけを補う
 *  - 候補の元の値は draft.identify.before に残し、復元できる。補ったあとの登録・除外の判定は、既存の再評価（runReevaluation）で行う
 */
export interface IdentifyReport {
  execute: boolean;
  candidates: number;
  /** 投稿者が分かる候補 */
  withAuthor: number;
  accounts: number;
  alreadySaved: number;
  lookups: number;
  lookupFailed: number;
  /** 店舗名（または系列）を表示名から特定できたアカウント */
  storeIdentified: number;
  /** うち都道府県を確定できたアカウント */
  prefectureResolved: number;
  /** 候補の更新（店舗名・都道府県・系列を補った） */
  updated: number;
  /** 更新前後の、店舗名ありの候補数／都道府県が分かる候補数（実行しないときは見込み） */
  before: { storeName: number; prefecture: number };
  after: { storeName: number; prefecture: number };
  notes: string[];
}

interface Row {
  id: string;
  source_url: string | null;
  draft: Record<string, unknown> | null;
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** 候補の投稿者（まとめアカウントの投稿は引用元の投稿者も候補にする） */
function authorsOf(r: Row): string[] {
  const xp = asObj(r.draft?.xpost);
  const q = asObj(xp?.quoted);
  const poster = usernameFromPostUrl(r.source_url) ?? (typeof xp?.username === "string" && xp.username ? normUsername(xp.username) : "");
  const quoted = typeof q?.username === "string" && q.username ? normUsername(q.username) : "";
  return [poster, quoted].filter((x, i, a) => /^[a-z0-9_]{1,15}$/.test(x) && a.indexOf(x) === i);
}

export async function runIdentifyPass(deps: { db: Db; householdId: string; now: Date; xClient: XClient | null }, opts: { execute: boolean; maxLookups?: number; ids?: string[] }): Promise<IdentifyReport> {
  const { db, householdId, now } = deps;
  const maxLookups = Math.min(Math.max(opts.maxLookups ?? 15, 0), 30);
  const data = await loadAppData(db, householdId);
  const sctx = await loadSourceCtx(db, householdId).catch(() => null);
  const aggregators = new Set([...(sctx?.aggregatorAccounts ?? [])].map((a) => a.toLowerCase()));
  const saved = await loadXIdentities(db, householdId);

  let q = db.from("collection_candidates").select("id,source_url,draft").eq("household_id", householdId).eq("status", "pending").eq("kind", "new").limit(1000);
  if (opts.ids?.length) q = q.in("id", opts.ids);
  const rows = ((await q).data ?? []) as unknown as Row[];
  const report: IdentifyReport = { execute: opts.execute, candidates: rows.length, withAuthor: 0, accounts: 0, alreadySaved: 0, lookups: 0, lookupFailed: 0, storeIdentified: 0, prefectureResolved: 0, updated: 0, before: { storeName: 0, prefecture: 0 }, after: { storeName: 0, prefecture: 0 }, notes: [] };

  const inputOf = (r: Row) => r.draft?.input as LotteryInput | undefined;
  const storeOf = (i: LotteryInput | undefined) => data.stores.find((s) => s.id === i?.store?.id);
  const hasStore = (i: LotteryInput | undefined) => Boolean(i?.store?.name?.trim());
  const hasPref = (i: LotteryInput | undefined) => Boolean(i?.store?.prefecture || storeOf(i)?.prefecture);
  for (const r of rows) {
    const i = inputOf(r);
    if (hasStore(i)) report.before.storeName++;
    if (hasPref(i)) report.before.prefecture++;
  }

  // ---- アカウントごとの特定（プロフィールは未確認のものだけ取得）
  const users = new Set<string>();
  for (const r of rows) for (const u of authorsOf(r)) if (!aggregators.has(u)) users.add(u);
  report.accounts = users.size;
  report.withAuthor = rows.filter((r) => authorsOf(r).length > 0).length;
  const identities = new Map<string, AccountIdentity>();
  for (const u of users) {
    const sv = saved.get(u);
    if (sv) {
      report.alreadySaved++;
      identities.set(u, identifyAccount({ username: u, chains: data.chains, stores: data.stores, saved: sv }));
      continue;
    }
    if (!opts.execute) continue;
    if (!deps.xClient?.lookupProfile || report.lookups >= maxLookups) continue;
    report.lookups++;
    const lp = await deps.xClient.lookupProfile(u);
    if (!lp.ok) {
      report.lookupFailed++;
      if (lp.code === "credits_depleted" || lp.code === "unauthorized" || lp.code === "rate_limited") {
        report.notes.push(lp.message);
        break;
      }
      continue;
    }
    const id = identifyAccount({ username: u, profile: lp.profile as XProfile, chains: data.chains, stores: data.stores });
    identities.set(u, id);
    if (id.kind === "store" || id.kind === "chain") await saveXIdentity(db, householdId, id, undefined);
  }
  for (const id of identities.values()) {
    if (id.kind === "store") report.storeIdentified++;
    if (id.kind === "store" && id.prefecture) report.prefectureResolved++;
  }
  if (!opts.execute) report.notes.push(`未確認のアカウント ${[...users].filter((u) => !saved.has(u)).length} 件のプロフィールを取得します（上限 ${maxLookups} 件）`);

  // ---- 候補への反映（告知から読み取れなかった項目だけ補う）
  for (const r of rows) {
    const i = inputOf(r);
    if (!i) continue;
    const id = authorsOf(r).map((u) => identities.get(u)).find((x) => x && (x.kind === "store" || x.kind === "chain"));
    let nextInput = i;
    if (id) {
      const h = identityHint({ chainName: i.chain?.name ?? "", storeName: i.store?.name ?? "", prefecture: i.store?.prefecture ?? "" }, id);
      if (h.used.length > 0) {
        nextInput = {
          ...i,
          chain: h.chainName !== (i.chain?.name ?? "") ? { id: id.chainId, name: h.chainName } : i.chain,
          store: { ...i.store, name: h.storeName, prefecture: h.prefecture, id: h.storeName !== (i.store?.name ?? "") ? id.storeId : i.store?.id ?? null },
        };
        report.updated++;
        if (opts.execute) {
          const d = r.draft ?? {};
          const secondary = [...new Set([...((d.secondary as string[] | undefined) ?? []), ...h.used])];
          const prev = asObj(d.identify);
          const draft = { ...d, input: nextInput, secondary, identify: { at: now.toISOString(), username: id.username, used: h.used, before: prev?.before ?? { chain: i.chain, store: i.store } } };
          await db.from("collection_candidates").update({ draft: deepClean(draft) as unknown as Json }).eq("id", r.id);
        }
      }
    }
    if (hasStore(nextInput)) report.after.storeName++;
    if (nextInput.store?.prefecture || storeOf(nextInput)?.prefecture) report.after.prefecture++;
  }
  return report;
}
