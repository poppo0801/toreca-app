import { describe, expect, it, vi } from "vitest";
import type { ExtractRequest, LotteryExtractor } from "@/lib/ai/provider";
import { makeXRichFetcher } from "@/lib/server/collector/x-rich";
import type { XClient } from "@/lib/server/collector/x-client";
import { runExtraction } from "@/lib/server/lottery-extract-service";
import type { Db } from "@/lib/server/lottery-service";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";

vi.mock("server-only", () => ({}));

/** collection_settings / collection_runs / collection_daily_stats だけを返す最小の模擬DB */
function fakeDb(settings: { x_enabled: boolean; x_monthly_budget_jpy: number } | null): Db {
  const chain = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.gte = () => Promise.resolve({ data: rows, error: null });
    q.maybeSingle = () => Promise.resolve({ data: settings, error: null });
    return q;
  };
  return { from: () => chain([]), rpc: () => Promise.resolve({ error: null }) } as unknown as Db;
}

const png = { mediaType: "image/png" as const, base64: "iVBORw0KGgo=", bytes: 8 };
const page = (body: string): SafeFetchResult => ({ ok: true, finalUrl: "https://shop.example.invalid/chusen", status: 200, contentType: "text/html", body, truncated: false });
const PAGE_HTML = `<html><body><p>サンプル電機 三宮店の抽選販売のご案内です。応募方法は店頭の専用フォームのみとなります。受取は店頭でお渡しします。</p></body></html>`;
const URL_ = "https://x.com/sample_shop/status/1234567890123456789";

const apiClient = (images: string[], links: string[]): XClient => ({
  async lookupUser() {
    return { ok: true, id: "1", username: "sample_shop" };
  },
  async userPosts() {
    return { ok: true, posts: [], newestId: null };
  },
  async getPost(id, username) {
    return { ok: true, post: { id, text: "抽選受付開始", createdAt: "2027-01-12T00:00:00.000Z", authorId: "1", url: `https://x.com/${username}/status/${id}`, images, links, refs: [] } };
  },
});

describe("X投稿の統合取得（本文＋複数画像＋リンク先）", () => {
  const enrich = (fetchImage: (u: string) => Promise<typeof png | null>) => ({ fetchPage: async () => page(PAGE_HTML), fetchImage: fetchImage as never });

  it("API利用可: 本文・複数画像・リンク先本文を1つにまとめる（画像取得成功）", async () => {
    const fetchImage = vi.fn(async () => png);
    const f = makeXRichFetcher({ db: fakeDb({ x_enabled: true, x_monthly_budget_jpy: 1000 }), householdId: "h", client: apiClient(["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"], ["https://shop.example.invalid/chusen"]), enrich: enrich(fetchImage) });
    const r = await f(URL_);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("api");
    expect(r.imageStatus).toBe("fetched");
    expect(r.imagesFound).toBe(2);
    expect(r.images.length).toBeGreaterThanOrEqual(2);
    expect(r.linkedPage).toBe(true);
    expect(r.text).toContain("抽選受付開始");
    expect(r.text).toContain("店頭の専用フォーム");
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("画像の取得に失敗したときは『画像未取得』として区別する（解析できたことにしない）", async () => {
    const f = makeXRichFetcher({ db: fakeDb({ x_enabled: true, x_monthly_budget_jpy: 1000 }), householdId: "h", client: apiClient(["https://pbs.twimg.com/media/a.jpg"], []), enrich: enrich(async () => null) });
    const r = await f(URL_);
    expect(r.ok && r.imageStatus).toBe("not_fetched");
    expect(r.ok && r.images.length).toBe(0);
    expect(r.ok && r.notices.join()).toContain("画像未取得");
  });

  it("APIキー未設定: 本文のみ（oEmbed）。画像のある投稿は『画像未取得』と明示し、リンク先の本文は統合する", async () => {
    const oembed = vi.fn(async () => ({ ok: true as const, text: "【Xの投稿】\n抽選受付開始 pic.x.com/abcd\n【投稿内のリンク】\nhttps://shop.example.invalid/chusen", author: "sample_shop", notice: [], postedOn: "2027-01-12" }));
    const f = makeXRichFetcher({ db: fakeDb(null), householdId: "h", client: null, oembed: oembed as never, enrich: enrich(async () => png) });
    const r = await f(URL_);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("oembed");
    expect(r.imageStatus).toBe("not_fetched");
    expect(r.images).toEqual([]);
    expect(r.notices.join()).toContain("画像未取得");
    expect(r.text).toContain("店頭の専用フォーム");
  });

  it("X APIが無効（利用者が有効にしていない）でも課金APIは呼ばない", async () => {
    const getPost = vi.fn();
    const client = { ...apiClient([], []), getPost } as unknown as XClient;
    const oembed = async () => ({ ok: true as const, text: "抽選のお知らせ", author: "a", notice: [], postedOn: "" });
    const f = makeXRichFetcher({ db: fakeDb({ x_enabled: false, x_monthly_budget_jpy: 1000 }), householdId: "h", client, oembed: oembed as never });
    const r = await f(URL_);
    expect(r.ok).toBe(true);
    expect(getPost).not.toHaveBeenCalled();
  });
});

describe("統合した入力がAIへ実際に渡る（単件・一括・自動収集・共有で共通の解析入口）", () => {
  it("画像・本文・リンク先がAIのリクエストに含まれ、画像由来の根拠は本文と照合されない", async () => {
    let captured: ExtractRequest | null = null;
    const extractor: LotteryExtractor = {
      engine: "mock",
      async extract(req) {
        captured = req;
        return {
          engine: "mock",
          raw: {
            is_lottery_announcement: true, chain_name: "サンプル電機", store_name: "三宮店", prefecture: "兵庫県", products: [{ name: "テスト商品", quantity: 1, unit: "box", code: "" }],
            apply_deadline: { year: 2027, month: 1, day: 20, hour: 23, minute: 59 }, receive_method: "store",
            evidence: { apply_deadline: "1/20 23:59まで" }, evidence_source: { apply_deadline: "画像1枚目" },
          },
        };
      },
    };
    const fetchXRich = makeXRichFetcher({
      db: fakeDb({ x_enabled: true, x_monthly_budget_jpy: 1000 }),
      householdId: "h",
      client: apiClient(["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"], ["https://shop.example.invalid/chusen"]),
      enrich: { fetchPage: async () => page(PAGE_HTML), fetchImage: (async () => png) as never },
    });
    const res = await runExtraction({ kind: "x_url", url: URL_ }, { extractor, now: new Date("2027-01-15T00:00:00+09:00"), fetchXRich });
    expect(captured).not.toBeNull();
    const req = captured as unknown as ExtractRequest;
    expect((req.images ?? []).length).toBeGreaterThanOrEqual(2);
    expect(req.text).toContain("抽選受付開始");
    expect(req.text).toContain("店頭の専用フォーム");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.extraction.evidence.applyDeadline?.verified).toBeNull();
  });
});
