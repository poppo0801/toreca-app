import "server-only";
import { extractPageText } from "@/lib/ai/page-text";
import { evidenceFromLastGood, MAX_LINK_LEDGER, MAX_LINKED_PAGE_CHARS, MAX_LINKED_PAGES, type StoredEvidence } from "@/lib/collector/evidence";
import type { HostGate } from "@/lib/collector/fetch-control";
import { looksLikeLoginWall, pendingRecheck, type LinkLedgerEntry } from "@/lib/collector/link-plan";
import { rememberFullPages } from "@/lib/server/collector/collected-docs";
import type { Db } from "@/lib/server/lottery-service";
import { fetchRespectingRobots, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { linkRecheckEnabled } from "@/lib/server/proposals/flag";
import { proposalAfterCandidate, storeCollectedEvidence } from "./proposal-hook";
import { LINKED_PAGE_MAX_CHARS, outcomeOf, type FetchedLinkPage } from "./x-rich";

/**
 * 未取得リンクの自動再調査（Phase 2・開発限定。migration 122 の link_recheck_tasks）。
 *  1) enqueueLinkRechecks: 収集で「取得しなかった」リンク（締切・予算・ホスト制限・429/503・一時的な通信失敗）を、耐久的なタスクとして記録する。取得できないと分かっているもの（robots・ログイン・危険・短縮・X）は登録しない。
 *  2) runLinkRechecks: 別の実行（ワーカーの空き時間）で、期限・試行回数・バックオフ・ホスト共有の制御の範囲で再取得し、**元の候補の証拠（last_good.evidence）へ戻す**（リンク先ページ・台帳の更新・全文の保存）。戻したら登録案を再生成できる。
 *  - 重複実行の防止: claim は skip locked＋リース（落ちたワーカーのリースは期限で失効して再取得できる）。同じ候補への書き戻しは版（recheckSeq）による楽観的排他（競合したら再試行へ）。
 *  - robots拒否・認証必須（401/403）・危険なURLは回避せず、諦める（gave_up）。404も諦める。通信・タイムアウト・429/503・5xxは指数バックオフで再試行（上限の回数・期限あり）。
 *  - 1回の実行の時間・件数の上限（limit・timeLeft）。残り時間が少なければ新しいタスクを始めない（残りは次の実行へ継続）。
 *  - 追加費用は0（取得のみ。AIは呼ばない。登録案の再生成は費用ゼロのモックのみ）。
 */
export const MAX_RECHECK_PER_CANDIDATE = 30;
export const MAX_RECHECK_PENDING_PER_HOUSEHOLD = 300;
export const RECHECK_BACKOFF_BASE_MS = 5 * 60_000;
export const RECHECK_BACKOFF_MAX_MS = 6 * 3600_000;

/** 再調査タスクの追加。既にあるタスクは変えない（二重登録なし）。件数の上限を超える分は登録せず、数だけ返す */
export async function enqueueLinkRechecks(a: { db: Db; householdId: string; candidateId: string; ledger: readonly LinkLedgerEntry[]; now: Date }): Promise<{ queued: number; skipped: number }> {
  const pend = pendingRecheck(a.ledger).filter((e) => /^https?:\/\//.test(e.url));
  if (pend.length === 0) return { queued: 0, skipped: 0 };
  const t = (n: string) => (a.db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
  const house = await t("link_recheck_tasks").select("id", { count: "exact", head: true }).eq("household_id", a.householdId).in("status", ["pending", "leased"]);
  const room = Math.max(0, MAX_RECHECK_PENDING_PER_HOUSEHOLD - (house.count ?? 0));
  const take = pend.slice(0, Math.min(MAX_RECHECK_PER_CANDIDATE, room));
  if (take.length === 0) return { queued: 0, skipped: pend.length };
  const rows = take.map((e) => ({ household_id: a.householdId, candidate_id: a.candidateId, url: e.url.slice(0, 500), url_key: e.key.slice(0, 300), host: e.host.slice(0, 200), order_no: e.order, origins: e.origins, reason: (e.reason ?? "unknown").slice(0, 60), next_attempt_at: new Date(a.now.getTime() + 60_000).toISOString(), expires_at: new Date(a.now.getTime() + 3 * 86_400_000).toISOString() }));
  const r = await t("link_recheck_tasks").upsert(rows, { onConflict: "candidate_id,url_key", ignoreDuplicates: true });
  if (r.error) return { queued: 0, skipped: pend.length };
  // 完了（done）・諦め（gave_up）のタスクが残っていると、同じリンクが再収集で再び未取得になっても二度と再調査されない（監査で発見）。
  // 完了・諦めから1時間以上たち、台帳がまだ未取得を示すなら、新しい試行として戻す（試行回数・期限をリセット。1時間は連続する再登録の暴走を防ぐ）
  const reopenBefore = new Date(a.now.getTime() - 3600_000).toISOString();
  await t("link_recheck_tasks")
    .update({ status: "pending", attempts: 0, last_error: null, done_at: null, lease_until: null, next_attempt_at: new Date(a.now.getTime() + 60_000).toISOString(), expires_at: new Date(a.now.getTime() + 3 * 86_400_000).toISOString(), updated_at: a.now.toISOString() })
    .eq("candidate_id", a.candidateId)
    .in("url_key", take.map((x) => x.key.slice(0, 300)))
    .in("status", ["done", "gave_up"])
    .lt("done_at", reopenBefore);
  return { queued: take.length, skipped: pend.length - take.length };
}

/** 再取得したページを、候補の証拠へ戻す（純関数）。台帳の該当リンクを取得済みにし、リンク先ページを追加する。上限（30ページ・台帳80件）・全文/抜粋の記録は収集時と同じ */
export function mergeRecheckedPage(ev: StoredEvidence, page: FetchedLinkPage, entry: { key: string; order: number; origins: string[]; host: string; shortUrl?: string }): StoredEvidence {
  const excerpt = page.text.slice(0, MAX_LINKED_PAGE_CHARS);
  const lp = { url: page.url.slice(0, 500), text: excerpt, fetchedAt: page.fetchedAt, fullChars: page.text.length, truncated: page.truncated || page.text.length > excerpt.length, depth: page.depth, origins: entry.origins, ...(entry.shortUrl ? { shortUrl: entry.shortUrl } : {}) };
  const pages = [...(ev.linkedPages ?? []).filter((p) => p.url !== lp.url), lp].slice(0, MAX_LINKED_PAGES);
  const ledger = [...(ev.linkLedger ?? [])];
  const i = ledger.findIndex((e) => e.key === entry.key);
  const upd = { url: page.url.slice(0, 500), key: entry.key.slice(0, 300), host: entry.host, order: entry.order, origins: entry.origins, ...(entry.shortUrl ? { shortUrl: entry.shortUrl } : {}), status: "fetched", chars: page.text.length, truncated: lp.truncated, at: page.fetchedAt };
  if (i >= 0) ledger[i] = upd;
  else ledger.push(upd);
  return { ...ev, linkedPages: pages, linkLedger: ledger.slice(0, MAX_LINK_LEDGER), recheckSeq: (ev.recheckSeq ?? 0) + 1 };
}

export interface RecheckSummary {
  claimed: number;
  done: number;
  retried: number;
  gaveUp: number;
  /** 実行時間の都合で始めなかった（リースは期限で失効し、次の実行で再取得される） */
  deferred: number;
  /** 候補の証拠へ戻して、登録案の再生成を呼んだ候補の数 */
  regenerated: number;
}

type Task = { id: string; household_id: string; candidate_id: string; url: string; url_key: string; host: string; order_no: number; origins: string[]; reason: string; attempts: number; max_attempts: number };

export async function runLinkRechecks(a: {
  db: Db;
  householdId: string;
  gate: HostGate;
  limit?: number;
  /** この実行の残り時間（ms）。10秒未満になったら新しいタスクを始めない */
  timeLeft: () => number;
  now?: () => Date;
  fetchPage?: (url: string) => Promise<SafeFetchResult>;
  /** 証拠へ戻した後の再解析（登録案の再生成）。既定は新AIの自動生成の接続口（開発限定・費用0） */
  onUpdated?: (candidateId: string) => Promise<void>;
  shouldCancel?: () => boolean;
}): Promise<RecheckSummary> {
  const out: RecheckSummary = { claimed: 0, done: 0, retried: 0, gaveUp: 0, deferred: 0, regenerated: 0 };
  const now = a.now ?? (() => new Date());
  const rpc = (n: string, args: Record<string, unknown>) => (a.db as unknown as { rpc: (n: string, x: Record<string, unknown>) => Promise<{ data: any; error: unknown }> }).rpc(n, args); // eslint-disable-line @typescript-eslint/no-explicit-any
  const t = (n: string) => (a.db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
  const claimed = await rpc("link_recheck_claim", { p_limit: a.limit ?? 5, p_lease_s: 120, p_now: now().toISOString() });
  const tasks = ((claimed.data ?? []) as Task[]).filter((x) => x.household_id === a.householdId);
  out.claimed = tasks.length;
  const fetchPage = a.fetchPage ?? ((u: string) => fetchRespectingRobots(u));
  const regen = new Set<string>();
  const finish = (id: string, outcome: "done" | "retry" | "gave_up", err: string | null, backoffMs = 0) => rpc("link_recheck_finish", { p_id: id, p_outcome: outcome, p_error: err, p_backoff_ms: backoffMs });
  const backoff = (attempts: number) => Math.min(RECHECK_BACKOFF_MAX_MS, RECHECK_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

  for (const task of tasks) {
    if (a.shouldCancel?.() || a.timeLeft() < 10_000) {
      // 始めない。リースは期限で失効し、次の実行で再取得される（試行回数は消費しない）
      await t("link_recheck_tasks").update({ status: "pending", lease_until: null, attempts: Math.max(0, task.attempts - 1) }).eq("id", task.id);
      out.deferred++;
      continue;
    }
    const gated = await a.gate.run(
      task.host,
      async () => {
        const r = await fetchPage(task.url).catch((): SafeFetchResult => ({ ok: false, code: "network", message: "x" }));
        return { value: r, outcome: outcomeOf(r) };
      },
      { deadlineAt: Date.now() + Math.max(0, a.timeLeft() - 5_000), ...(a.shouldCancel ? { shouldCancel: a.shouldCancel } : {}) },
    );
    if (!gated.ran) {
      // ホストの制限・締切・中止で取得していない: 試行回数を消費せず、バックオフして再試行
      await t("link_recheck_tasks").update({ attempts: Math.max(0, task.attempts - 1) }).eq("id", task.id);
      await finish(task.id, "retry", `gate:${gated.cause}`, gated.cause === "host_suspended" ? 10 * 60_000 : 60_000);
      out.retried++;
      continue;
    }
    const pg = gated.value;
    if (!pg.ok) {
      // 回避しない: robots・ブロック・認証必須・404 は諦める。一時的な失敗は再試行
      const permanent = pg.code === "robots" || pg.code === "blocked" || pg.code === "invalid_url" || pg.code === "unsupported_type" || (pg.code === "http_error" && [401, 403, 404, 410].includes(pg.status ?? 0));
      if (permanent || task.attempts >= task.max_attempts) {
        await finish(task.id, "gave_up", `${pg.code}${pg.status ? `:${pg.status}` : ""}`);
        out.gaveUp++;
      } else {
        await finish(task.id, "retry", `${pg.code}${pg.status ? `:${pg.status}` : ""}`, backoff(task.attempts));
        out.retried++;
      }
      continue;
    }
    const ex = extractPageText(pg.body, pg.finalUrl, LINKED_PAGE_MAX_CHARS);
    if (looksLikeLoginWall(ex.text) || ex.text.length < 30) {
      await finish(task.id, "gave_up", looksLikeLoginWall(ex.text) ? "login_required" : "too_short");
      out.gaveUp++;
      continue;
    }
    const page: FetchedLinkPage = { url: task.url, finalUrl: pg.finalUrl, title: ex.title.slice(0, 200), text: ex.text, truncated: pg.truncated || ex.truncated, fetchedAt: now().toISOString(), depth: 0, origins: task.origins as FetchedLinkPage["origins"] };
    // 候補の証拠へ戻す（版による楽観的排他。競合したら再試行）
    const row = await t("collection_candidates").select("id,source_url,last_good").eq("id", task.candidate_id).eq("household_id", a.householdId).maybeSingle();
    const ev = row.data ? evidenceFromLastGood(row.data.last_good) : null;
    if (!ev) {
      await finish(task.id, "gave_up", "candidate_or_evidence_missing");
      out.gaveUp++;
      continue;
    }
    // 既に、このタスクの取得より**新しい**取得結果（再収集など）が証拠にあるときは、古い再取得結果で上書きしない（完了として扱い、記録する）
    const existing = ev.linkedPages?.find((p) => p.url === page.url);
    if (existing && existing.fetchedAt > page.fetchedAt) {
      await finish(task.id, "done", null);
      out.done++;
      continue;
    }
    const merged = mergeRecheckedPage(ev, page, { key: task.url_key, order: task.order_no, origins: task.origins, host: task.host });
    const seq = ev.recheckSeq ?? 0;
    const lastGood = { ...(row.data.last_good as object), evidence: merged };
    let q = t("collection_candidates").update({ last_good: lastGood }).eq("id", task.candidate_id).eq("household_id", a.householdId);
    q = seq === 0 ? q.is("last_good->evidence->>recheckSeq", null) : q.eq("last_good->evidence->>recheckSeq", String(seq));
    const upd = await q.select("id");
    if (upd.error || !upd.data?.length) {
      await finish(task.id, "retry", "write_conflict", 5_000);
      out.retried++;
      continue;
    }
    // 全文の保存（新AI機能が有効な開発環境だけ。失敗しても証拠への戻しは済んでいる）
    const queued = {};
    rememberFullPages(queued, [page]);
    await storeCollectedEvidence({ db: a.db, householdId: a.householdId, candidateId: task.candidate_id, queued, postUrl: row.data.source_url ?? task.url, postText: null, nowIso: page.fetchedAt });
    await finish(task.id, "done", null);
    out.done++;
    regen.add(task.candidate_id);
  }
  for (const id of regen) {
    try {
      await (a.onUpdated ?? ((cid: string) => proposalAfterCandidate({ db: a.db, householdId: a.householdId, candidateId: cid })))(id);
      out.regenerated++;
    } catch {
      /* 再解析の失敗で再調査の結果は失わない（証拠へは戻っている） */
    }
  }
  return out;
}

/** 収集の接続口: 新AI機能が有効な開発環境だけ、未取得リンクを再調査タスクとして記録する。失敗しても収集は止めない */
export async function maybeEnqueueLinkRechecks(a: { db: Db; householdId: string; candidateId: string; ledger: readonly LinkLedgerEntry[] | undefined; now: Date; env?: Record<string, string | undefined> }): Promise<void> {
  if (!a.ledger?.length || !linkRecheckEnabled(a.env ?? process.env)) return;
  try {
    await enqueueLinkRechecks({ db: a.db, householdId: a.householdId, candidateId: a.candidateId, ledger: a.ledger, now: a.now });
  } catch {
    console.warn("[link-recheck] enqueue_failed");
  }
}

/** 収集ワーカーの空き時間の再調査（開発限定）。残り時間が十分あるときだけ、少数のタスクを処理する。失敗しても収集は止めない */
export async function maybeRunLinkRechecks(a: { db: Db; householdId: string; gate: HostGate; timeLeft: () => number; env?: Record<string, string | undefined> }): Promise<RecheckSummary | null> {
  if (!linkRecheckEnabled(a.env ?? process.env) || a.timeLeft() < 20_000) return null;
  try {
    return await runLinkRechecks({ db: a.db, householdId: a.householdId, gate: a.gate, limit: 3, timeLeft: a.timeLeft });
  } catch {
    console.warn("[link-recheck] run_failed");
    return null;
  }
}
