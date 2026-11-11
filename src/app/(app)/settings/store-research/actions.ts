"use server";

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAgentLLM, AnthropicWebSearch } from "@/lib/agent/anthropic";
import { DEFAULT_LIMITS, type AgentLimits } from "@/lib/agent/core";
import { isStoreResearchEnabled } from "@/lib/agent/dev-flag";
import { checkRealApi } from "@/lib/agent/real-gate";
import { EVAL_WORLD } from "@/lib/agent/store-location/world";
import { CachedFetcher, CachedSearch, MemoryCache } from "@/lib/agent/store-location/tools";
import { MockFetcher, MockSearch, MockStoreBrain, mockGeocode } from "@/lib/agent/store-location/mock";
import { researchStoreLocation, type ResearchDeps } from "@/lib/agent/store-location/run";
import { STATUS_LABEL, type ResearchResult } from "@/lib/agent/store-location/verify";
import { SafePageFetcher, realGeocode } from "@/lib/server/agent/real-providers";
import { countRealRunsToday, listResearch, listStoresForResearch, loadStoreTarget, saveResearch, type StoreRow } from "@/lib/server/agent/store-location-service";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { createClient } from "@/lib/supabase/server";

/**
 * 店舗所在地の調査（開発用の検証画面。Stage 8D-2）。開発環境でのみ動く（本番では拒否）。
 * 権限: 読み取り（店舗情報・過去の調査）・Web検索/取得・調査結果の保存（専用の表のみ）。店舗マスター・抽選の更新、任意のSQL・コマンドは無い。
 * 既定はモック（実APIを使わない）。実APIは real-gate.ts の条件（開発専用キー・費用上限・実行回数上限・確認）を満たした場合だけ。
 */
/** 検索結果・取得ページの再利用（同じ検索・同じページで無駄にAPI・通信を使わない。プロセス内・24時間） */
const sharedCache = new MemoryCache();

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function ctx(): Promise<Db | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    return (await currentHouseholdId(db)) ? db : null;
  } catch {
    return null;
  }
}

export interface ResearchConfig {
  /** 実APIの条件（キー・上限）が整っているか。確認チェックは別 */
  realConfigured: boolean;
  limits: AgentLimits;
  realRunsToday: number;
  maxRunsPerDay: number | null;
}

export async function loadResearchContextAction(): Promise<R<{ stores: StoreRow[]; config: ResearchConfig }>> {
  if (!isStoreResearchEnabled()) return { ok: false, error: "この画面は開発環境でのみ使えます" };
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  const runs = await countRealRunsToday(db);
  const gate = checkRealApi({ env: process.env, confirm: true, runsToday: runs });
  return { ok: true, stores: await listStoresForResearch(db), config: { realConfigured: gate.ok, limits: gate.ok ? gate.limits : DEFAULT_LIMITS, realRunsToday: runs, maxRunsPerDay: Number(process.env.AGENT_MAX_RUNS_PER_DAY) || null } };
}

export interface ResearchView {
  id: string | null;
  status: ResearchResult["status"];
  statusLabel: string;
  address: string | null;
  prefecture: string | null;
  city: string | null;
  hasLatLng: boolean;
  confidence: number;
  sources: ResearchResult["sources"];
  reasons: string[];
  candidates: { address: string; sourceUrl: string; score: number; problems: string[] }[];
  officialSites: { domain: string; status: string; signals: string[]; problems: string[] }[];
  usage: { steps: number; searches: number; fetches: number; inputTokens: number; outputTokens: number; costJpy: number; ms: number; retries: number; rejectedCalls: number; injectionFlags: number };
  engine: string;
  trace: { label: string; ok: boolean }[];
}

export async function runStoreResearchAction(input: { storeId: string; additional: boolean; useRealApi: boolean; confirmCost: boolean; profileId: string | null }): Promise<R<{ result: ResearchView; history: { status: string; address: string | null; confidence: number; researchedAt: string }[] }>> {
  if (!isStoreResearchEnabled()) return { ok: false, error: "この画面は開発環境でのみ使えます" };
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  const t = await loadStoreTarget(db, input.storeId);
  if (!t.ok) return { ok: false, error: t.error };
  const past = await listResearch(db, input.storeId, 5);

  // 実行方式: 既定はモック。実APIは、条件がすべて整い、画面で費用を確認した場合のみ
  let deps: ResearchDeps;
  if (input.useRealApi) {
    const gate = checkRealApi({ env: process.env, confirm: input.confirmCost, runsToday: await countRealRunsToday(db) });
    if (!gate.ok) return { ok: false, error: gate.reason };
    const client = new Anthropic({ apiKey: gate.apiKey });
    deps = { llm: new AnthropicAgentLLM(client, gate.model), search: new CachedSearch(new AnthropicWebSearch(client, gate.model), sharedCache), fetcher: new CachedFetcher(new SafePageFetcher(), sharedCache), geocode: realGeocode, limits: gate.limits, past: async () => past };
  } else {
    deps = { llm: new MockStoreBrain(t.value.target), search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD), past: async () => past };
  }
  const retryNote = input.additional && past[0] ? `${past[0].status}（信頼度${past[0].confidence}）${past[0].address ?? "住所なし"}` : undefined;
  const out = await researchStoreLocation(t.value.target, t.value.existingAddress, deps, { retryNote });
  const saved = await saveResearch(db, input.storeId, t.value.target, out.result, out.run, out.engine, input.profileId);
  const r = out.result;
  return {
    ok: true,
    result: {
      id: saved.ok ? saved.value.id : null,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status],
      address: r.address,
      prefecture: r.prefecture,
      city: r.city,
      hasLatLng: r.lat !== null,
      confidence: r.confidence,
      sources: r.sources,
      reasons: r.reasons,
      candidates: r.candidates.map((c) => ({ address: c.address, sourceUrl: c.sourceUrl, score: c.score, problems: c.problems })),
      officialSites: r.officialSites.map((o) => ({ domain: o.domain, status: o.status, signals: o.signals, problems: o.problems })),
      usage: { ...out.usage, ms: Math.round(out.usage.ms), costJpy: Math.round(out.usage.costJpy * 100) / 100 },
      engine: out.engine,
      trace: out.run.trace.map((e) => ({ label: e.t === "tool" ? `${e.name}${e.ok ? "" : "（失敗）"}${e.injection ? " ⚠命令らしき文面を無視" : ""}` : e.t === "rejected" ? `拒否: ${e.name}` : e.t === "limit" ? e.detail : e.t === "retry" ? "再試行" : e.t === "error" ? `エラー: ${e.message}` : `ステップ${e.n}`, ok: e.t === "tool" ? e.ok : e.t === "step" })),
    },
    history: (await listResearch(db, input.storeId, 5)).map((h) => ({ status: h.status, address: h.address, confidence: h.confidence, researchedAt: h.researchedAt })),
  };
}
