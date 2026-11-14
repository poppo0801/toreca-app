import "server-only";
import { classifySource, provenanceFor, type FieldMap, type FieldSource, type SourceContext } from "@/lib/collector/fields";
import { sourceBasis } from "@/lib/collector/source-basis";
import type { Summary } from "@/lib/collector/completeness";
import type { OpenLite } from "@/lib/collector/supplement";
import type { Tracking } from "@/lib/collector/tracking";
import { urlIdentity } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";

/** 収集元・公式アカウントの対応づけから、情報源の分類に使う文脈を作る（まとめサイトのホストは固定） */
export async function loadSourceCtx(db: Db, householdId: string): Promise<SourceContext> {
  const [links, srcs] = await Promise.all([
    db.from("x_account_links").select("username").eq("household_id", householdId).limit(500),
    db.from("collection_sources").select("x_username").eq("household_id", householdId).eq("kind", "x").limit(100),
  ]);
  return {
    officialAccounts: new Set((links.data ?? []).map((r) => r.username.toLowerCase())),
    aggregatorAccounts: new Set((srcs.data ?? []).map((r) => (r.x_username ?? "").toLowerCase()).filter(Boolean)),
    listHosts: new Set(["pokeso.jp", "torecabiyori.com"]),
  };
}

export interface OpenRow {
  id: string;
  source_url: string | null;
  created_at: string;
  draft: unknown;
}

type StoredDraft = { input?: LotteryInput; summary?: Summary; fields?: FieldMap; tracking?: Tracking; viaList?: boolean; confirmedAt?: string; xpost?: { id?: string; username?: string; createdAt?: string; quoted?: { id?: string } }; queued?: { post?: { id?: string; username?: string; createdAt?: string; quoted?: { id?: string } } } };

/** 保存済みの候補（草稿）から、照合・統合用の情報を作る。項目別の出典が無い旧い草稿は、候補の情報源から補う */
export function toOpenLite(row: OpenRow, ctx: SourceContext): OpenLite | null {
  const d = row.draft as StoredDraft | null;
  if (!d?.input || !d.summary) return null;
  const url = row.source_url ?? d.input.sourceUrls?.[0] ?? "";
  const sc = classifySource(url, ctx);
  const post = d.xpost ?? d.queued?.post;
  const kind = d.viaList ? "list_site" : sc.kind;
  const postId = post?.id ?? sc.postId;
  const quotedId = post?.quoted?.id;
  const at = d.confirmedAt ?? row.created_at;
  const origin = quotedId ? `x:${quotedId}` : postId ? `x:${postId}` : d.viaList ? `list:${url}` : `u:${urlIdentity(url) ?? url}`;
  const basis = sourceBasis(url, { viaList: !!d.viaList });
  const source: FieldSource = { ...(basis ? { basis } : {}), url, kind, origin, at, ...(sc.account ? { account: sc.account } : {}), ...(postId ? { postId } : {}) };
  const fields = d.fields && Object.keys(d.fields).length > 0 ? d.fields : provenanceFor(d.input, source);
  return {
    id: row.id,
    input: d.input,
    summary: d.summary,
    fields,
    tracking: d.tracking ?? null,
    created_at: row.created_at,
    source,
    postId,
    quotedId,
    account: (post?.username ?? sc.account ?? "").toLowerCase() || undefined,
    urls: [...new Set([url, ...(d.input.sourceUrls ?? [])].filter(Boolean))],
    postedAt: post?.createdAt || at,
  };
}

/** 確認待ち・保留中・追跡中の候補（解析済みのもの）。照合の対象 */
export async function loadOpen(db: Db, householdId: string, ctx: SourceContext, opts: { ids?: string[] } = {}): Promise<OpenLite[]> {
  let q = db.from("collection_candidates").select("id,source_url,created_at,draft").eq("household_id", householdId).eq("status", "pending").eq("job_state", "review").eq("kind", "new").limit(400);
  if (opts.ids) q = q.in("id", opts.ids);
  const { data } = await q;
  return (data ?? []).map((r) => toOpenLite(r as OpenRow, ctx)).filter((x): x is OpenLite => !!x);
}

/** 最近、自動登録した抽選の元の候補（Stage 9A）。補足投稿（応募条件だけの投稿）の補完先の探索に使う。抽選IDも返す */
export async function loadRecentRegistered(db: Db, householdId: string, ctx: SourceContext, days = 14): Promise<(OpenLite & { lotteryId: string })[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db.from("collection_candidates").select("id,source_url,created_at,draft,lottery_id").eq("household_id", householdId).eq("status", "auto_registered").not("lottery_id", "is", null).gte("created_at", since).limit(200);
  return (data ?? []).flatMap((r) => {
    const o = toOpenLite(r as OpenRow, ctx);
    return o && r.lottery_id ? [{ ...o, lotteryId: r.lottery_id as string }] : [];
  });
}
