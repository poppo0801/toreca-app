/**
 * 調査ループの検索ツール（Stage 10X・開発限定・読み取り専用）。**既存の検索の部品（`SearchProvider`＝店舗所在地エージェントが使う、交換可能な検索）を最小限だけ流用**する。新しい検索APIや契約は追加しない。
 * 本番の通常収集・cron・DBには接続しない。実際の検索（Anthropic の web_search。既存の開発専用キー・検索1,000回あたり10ドル＋結果を読むトークン）を使うかどうかは、**費用の承認が出るまで接続しない**
 * （このファイルは、渡された provider を呼ぶだけ。実プロバイダの生成・実行は評価の承認後の実行側が行う）。
 * 守ること: 検索語に個人情報・URL・認証情報を入れない（redact で変化したら拒否）／結果は https のURLと短い抜粋だけ（候補＝データ。証拠ではない）／費用が不明なら概算を計上（0円にしない）。
 */
import { redact } from "@/lib/case-model/redact";
import type { ResearchTools } from "./research-loop";

/**
 * 渡される検索部品の形（既存の `SearchProvider`＝店舗所在地エージェントの検索と構造的に同じ）。住所調査AIの部品（lib/agent）を通常のコードから読み込まない原則を守るため、型は取り込まず形だけを定義する
 * （実際の部品は、開発専用の評価コードが渡す）。
 */
export interface SearchProviderLike {
  search(query: string): Promise<{ title: string; url: string; snippet: string }[] | { hits: { title: string; url: string; snippet: string }[]; costJpy?: number; cached?: boolean }>;
}

/** 検索1回の費用の概算（円）。web_search は 1,000回あたり10ドル（約¥1.5/回＝1ドル150円）＋結果を読むトークン。実測の報告が無いときに使う */
export const SEARCH_FALLBACK_JPY = 3;

export function makeSearchTool(provider: SearchProviderLike): NonNullable<ResearchTools["search"]> {
  return async (query) => {
    const q = query.trim();
    if (!q || q.length > 120) return { ok: false, reason: "invalid_query" };
    if (redact(q) !== q || /https?:\/\//i.test(q)) return { ok: false, reason: "query_contains_sensitive_or_url" }; // 個人情報・URL・認証情報は検索語にしない
    try {
      const raw = await provider.search(q);
      const hits = Array.isArray(raw) ? raw : raw.hits;
      const cost = Array.isArray(raw) || raw.costJpy === undefined ? SEARCH_FALLBACK_JPY : raw.costJpy;
      return {
        ok: true,
        hits: hits.filter((h) => typeof h.url === "string" && /^https:\/\//.test(h.url)).slice(0, 8).map((h) => ({ title: String(h.title ?? "").slice(0, 120), url: h.url.slice(0, 300), snippet: redact(String(h.snippet ?? "")).slice(0, 200) })),
        costJpy: cost,
      };
    } catch (e) {
      const x = e as { status?: number; name?: string };
      return { ok: false, reason: `search_failed:${typeof x?.status === "number" ? x.status : String(x?.name ?? "unknown").slice(0, 40)}` }; // 失敗の型だけ（メッセージは記録しない）
    }
  };
}
