import "server-only";
import { deadlinePassed } from "@/lib/collector/conditions";
import { isMemoOpen, memoDue, memoMatchesText, memoStale, memoTargets, validateMemoInput, type MemoInput, type MemoRow, type MemoState } from "@/lib/collector/memos";
import { classifyFailure, FAIL_KIND_LABEL, hashNormalized, lotteryFlex } from "@/lib/collector/queue";
import { extractPageText } from "@/lib/ai/page-text";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { fetchRespectingRobots, type SafeFetchResult } from "@/lib/server/safe-fetch";
import type { Json } from "@/types/database";
import type { AppData } from "@/types/domain";

/** 優先収集メモのDBアクセスと、収集時の照合（Stage 5S-A）。メモ自体は削除せず、状態で履歴を残す */

type DbRow = {
  id: string; chain_id: string | null; chain_name: string; store_id: string | null; store_name: string; product_ids: string[]; product_names: string[];
  reference_url: string | null; note: string; announced_start: string | null; priority: string; state: string; state_detail: string; fetch_state: string; check_count: number;
  last_checked_at: string | null; last_content_hash: string | null; found_candidate_id: string | null; lottery_id: string | null; created_at: string;
};
const COLS = "id,chain_id,chain_name,store_id,store_name,product_ids,product_names,reference_url,note,announced_start,priority,state,state_detail,fetch_state,check_count,last_checked_at,last_content_hash,found_candidate_id,lottery_id,created_at";

export const toMemo = (r: DbRow): MemoRow => ({
  id: r.id, chainId: r.chain_id, chainName: r.chain_name, storeId: r.store_id, storeName: r.store_name, productIds: r.product_ids ?? [], productNames: r.product_names ?? [],
  referenceUrl: r.reference_url, note: r.note, announcedStart: r.announced_start, priority: r.priority === "high" ? "high" : "normal", state: r.state as MemoState, stateDetail: r.state_detail,
  fetchState: r.fetch_state as MemoRow["fetchState"], checkCount: r.check_count, lastCheckedAt: r.last_checked_at, lastContentHash: r.last_content_hash, foundCandidateId: r.found_candidate_id, lotteryId: r.lottery_id, createdAt: r.created_at,
});

export async function listMemos(db: Db): Promise<MemoRow[]> {
  const { data } = await db.from("collection_memos").select(COLS).order("created_at", { ascending: false }).limit(200);
  return ((data ?? []) as unknown as DbRow[]).map(toMemo);
}

export async function createMemo(db: Db, householdId: string, profileId: string | null, input: MemoInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const v = validateMemoInput(input);
  if (!v.ok) return v;
  const i = v.value;
  const { data, error } = await db
    .from("collection_memos")
    .insert({
      household_id: householdId, chain_id: i.chainId, chain_name: i.chainId ? "" : i.chainName, store_id: i.storeId, store_name: i.storeId ? "" : i.storeName,
      product_ids: i.productIds, product_names: i.productNames, reference_url: i.referenceUrl || null, note: i.note, announced_start: i.announcedStart || null, priority: i.priority,
      created_by_profile_id: profileId,
    } as never)
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "メモを保存できませんでした" };
  return { ok: true, id: data.id };
}

/** 取り下げ（履歴として残す）・再開。調査中などへの自動遷移は runMemoPass だけが行う */
export async function setMemoState(db: Db, id: string, state: "withdrawn" | "unsurveyed"): Promise<boolean> {
  const patch = state === "withdrawn" ? { state, state_detail: "取り下げました" } : { state, state_detail: "再開しました", fetch_state: "ok", check_count: 0, last_checked_at: null };
  const { error } = await db.from("collection_memos").update(patch as never).eq("id", id);
  return !error;
}

export interface MemoPassReport {
  checked: number;
  registered: number;
  found: number;
  boosted: number;
  fetched: number;
  blocked: number;
}

const BOOST_AGE_MS = 400 * 3600_000; // 待ち時間の優先度の加点が上限に達する時間（queue.ts の priorityScore と同じ計算）
const MAX_BOOST_PER_PASS = 10;

function fetchRef(deps: { fetchPage?: (u: string) => Promise<SafeFetchResult> }, url: string): Promise<SafeFetchResult> {
  return deps.fetchPage ? deps.fetchPage(url) : fetchRespectingRobots(url);
}

function lotteryText(data: AppData, l: AppData["lotteries"][number]): string {
  const chain = data.chains.find((c) => c.id === l.chainId)?.name ?? "";
  const store = data.stores.find((s) => s.id === l.storeId)?.name ?? "";
  const items = l.items.map((i) => data.products.find((p) => p.id === i.productId)?.officialName ?? "").join(" ");
  return `${chain} ${store} ${items}`;
}

interface CandRow {
  id: string;
  title: string;
  status: string;
  job_state: string;
  lottery_id: string | null;
  draft: { queued?: { context?: string }; input?: { chain?: { name?: string }; store?: { name?: string }; items?: { product?: { name?: string } }[] } } | null;
  reasons: string[];
  memo_id: string | null;
}

/**
 * 優先収集メモを、既存の抽選 → 収集候補（取得・解析済みを含む）→ 参考URL の順に照合する。
 * 発見できなければ状態を保持して次回も確認する。同じ内容は再解析しない（内容ハッシュ）。確定登録はしない（登録は通常の判定のみ）。
 * 優先度の引き上げは、解析待ちの候補の待ち時間を進める形で行い（1回に最大 MAX_BOOST_PER_PASS 件）、通常の収集が止まらないようにする。
 */
export async function runMemoPass(
  deps: { db: Db; householdId: string; now: Date; fetchPage?: (u: string) => Promise<SafeFetchResult> },
  opts: { ids?: string[]; force?: boolean; max?: number; data?: AppData; /** 取得を伴わない照合だけ（登録直後）。見つからなければ状態は変えない */ noFetch?: boolean } = {},
): Promise<MemoPassReport> {
  const { db, householdId, now } = deps;
  const rep: MemoPassReport = { checked: 0, registered: 0, found: 0, boosted: 0, fetched: 0, blocked: 0 };
  const all = await listMemos(db);
  const memos = all
    .filter((m) => (opts.ids ? opts.ids.includes(m.id) : true) && isMemoOpen(m.state) && memoDue(m, now, opts.force))
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1) || (a.lastCheckedAt ?? "").localeCompare(b.lastCheckedAt ?? ""))
    .slice(0, opts.max ?? 10);
  if (memos.length === 0) return rep;
  const data = opts.data ?? (await loadAppData(db, householdId));
  const cands = ((await db.from("collection_candidates").select("id,title,status,job_state,lottery_id,draft,reasons,memo_id").eq("household_id", householdId).in("status", ["pending", "auto_registered", "duplicate"]).order("created_at", { ascending: false }).limit(600)).data ?? []) as unknown as CandRow[];
  let boostLeft = MAX_BOOST_PER_PASS;

  for (const m of memos) {
    rep.checked++;
    const t = memoTargets(m, data.chains, data.products);
    const patch: Record<string, unknown> = { last_checked_at: now.toISOString(), check_count: m.checkCount + 1 };
    let state: MemoState = m.state;
    let detail = "";
    let done = false;

    // (1) 既存の抽選（受付が終わっていないもの）
    const lot = data.lotteries.find((l) => {
      if (deadlinePassed(lotteryFlex(l.applyDeadline) as never, now) === true) return false;
      return memoMatchesText(t, lotteryText(data, l)).match;
    });
    if (lot) {
      state = "registered";
      detail = "既存の抽選と一致しました";
      patch.lottery_id = lot.id;
      rep.registered++;
      done = true;
    }

    // (2) 収集候補（解析済み・解析待ち）
    if (!done) {
      const hits = cands.filter((c) => {
        const names = c.draft?.input ? `${c.draft.input.chain?.name ?? ""} ${c.draft.input.store?.name ?? ""} ${(c.draft.input.items ?? []).map((i) => i.product?.name ?? "").join(" ")}` : "";
        return memoMatchesText(t, `${c.title} ${c.draft?.queued?.context ?? ""} ${names}`).match;
      });
      const regd = hits.find((c) => c.lottery_id && (c.status === "auto_registered" || c.status === "duplicate"));
      if (regd) {
        state = "registered";
        detail = "自動収集で登録された抽選と一致しました";
        Object.assign(patch, { lottery_id: regd.lottery_id, found_candidate_id: regd.id });
        rep.registered++;
        done = true;
      } else if (hits.length > 0) {
        const review = hits.find((c) => c.job_state === "review");
        const waiting = hits.filter((c) => ["pending", "retry"].includes(c.job_state));
        for (const c of waiting) {
          if (boostLeft <= 0) break;
          boostLeft--;
          rep.boosted++;
          await db.from("collection_candidates").update({ memo_id: m.id, next_run_at: new Date(now.getTime() - BOOST_AGE_MS).toISOString() }).eq("id", c.id).in("job_state", ["pending", "retry"]);
        }
        if (review) {
          state = "insufficient";
          detail = `候補を発見しましたが、確認が必要です: ${review.reasons.slice(0, 2).join("・")}`.slice(0, 280);
          await db.from("collection_candidates").update({ memo_id: m.id }).eq("id", review.id);
          patch.found_candidate_id = review.id;
          rep.found++;
          done = true;
        } else if (waiting.length > 0) {
          state = "found";
          detail = "候補を発見しました（解析を優先して待っています）";
          patch.found_candidate_id = waiting[0].id;
          rep.found++;
          done = true;
        }
      }
    }

    // (3) 参考URL（内容が変わったときだけ解析待ちにする。robots・ログイン制限は回避しない）
    if (!done && m.referenceUrl && !opts.noFetch) {
      const r = await fetchRef(deps, m.referenceUrl).catch((): SafeFetchResult => ({ ok: false, code: "network", message: "ページに接続できませんでした" }));
      rep.fetched++;
      if (r.ok) {
        const text = extractPageText(r.body, r.finalUrl).text;
        const hash = hashNormalized(text);
        patch.fetch_state = "ok";
        if (text.length < 40) {
          detail = "参考URLの本文を取得できませんでした（JavaScript描画の可能性）。画像や文章での登録も検討してください";
          patch.fetch_state = "blocked";
          rep.blocked++;
        } else if (hash === m.lastContentHash) {
          detail = "参考URLに変化はありません（再解析はしません）";
        } else {
          const queued = { kind: "web_page", url: m.referenceUrl, title: `優先収集メモ: ${[m.chainName, ...m.productNames].filter(Boolean).join(" ").slice(0, 60)}`, context: text.slice(0, 600), sourceName: "優先収集メモ", attempts: 0, memoId: m.id, changed: true, reason: "memo_reference" };
          const { data: ins } = await db
            .from("collection_candidates")
            .upsert({ household_id: householdId, dedupe_key: `memo:${m.id}:${hash.slice(0, 16)}`, source_url: m.referenceUrl, title: queued.title, content_hash: hash, status: "pending", job_state: "pending", reasons: ["優先収集メモの参考URL（解析待ち）"], draft: { queued } as unknown as Json, memo_id: m.id, next_run_at: new Date(now.getTime() - BOOST_AGE_MS).toISOString(), last_checked_at: now.toISOString() } as never, { onConflict: "household_id,dedupe_key", ignoreDuplicates: true })
            .select("id");
          patch.last_content_hash = hash;
          state = "surveying";
          detail = ins && ins.length > 0 ? "参考URLの内容を取得し、解析を優先して待っています" : "参考URLの内容は解析済みです";
          if (ins && ins.length > 0) {
            patch.found_candidate_id = ins[0].id;
            rep.boosted++;
          }
        }
      } else {
        const cls = classifyFailure(r.message);
        const exhausted = !cls.permanent && m.checkCount + 1 >= 5;
        patch.fetch_state = cls.permanent || exhausted ? "blocked" : "temporary";
        if (patch.fetch_state === "blocked") rep.blocked++;
        detail = `参考URLを取得できません（${FAIL_KIND_LABEL[cls.kind]}）。${cls.permanent ? "制限は回避しません。文章や画像から登録してください" : exhausted ? "再試行の上限に達しました" : "あとで再確認します"}`;
        if (state === "unsurveyed") state = "surveying";
      }
    }

    if (opts.noFetch && !done) continue;
    // (4) 見つからない: 状態を保持して次回も確認する。長く経っても見つからなければ期限切れ
    if (!done && !detail) detail = "既存の収集元には該当する告知がまだありません（次回以降も確認します）";
    if (!done && state === "unsurveyed") state = "surveying";
    if (!done && state !== "found" && state !== "insufficient" && memoStale(m, now)) {
      state = "expired";
      detail = "予定日から長く経っても告知が見つからないため、終了しました（履歴として残します）";
    }
    await db.from("collection_memos").update({ ...patch, state, state_detail: detail } as never).eq("id", m.id);
  }
  return rep;
}
