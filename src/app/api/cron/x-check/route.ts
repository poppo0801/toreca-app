import { NextResponse, type NextRequest } from "next/server";
import { getExtractor } from "@/lib/ai/provider";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { createXClient } from "@/lib/server/collector/x-client";
import { enrichXPost } from "@/lib/server/collector/x-rich";
import { extractFromRequest } from "@/lib/server/lottery-extract-service";
import { X_COST_PER_POST_JPY } from "@/lib/collector/x-posts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 診断で使ってよいアカウント（固定。任意のアカウントでX APIを呼ばせない） */
const ALLOWED = ["OnchainOutlaw", "pokecachan"] as const;
const MAX_POSTS = 3;

/**
 * X API 接続の少数テスト（運用確認用）。CRON_SECRET による認証が必要。
 * 指定アカウント（固定の2件のみ）から最大3件の公開投稿を取得し、本文・画像・リンク先の取得状況と、AI解析結果の要点を返す。
 * 何も保存しない（候補・抽選・利用量にも記録しない）。定期収集の設定は変更しない。トークン等の秘密は返さない。
 * ?analyze=1 のとき、画像またはリンク先を持つ投稿だけAI解析する（AI予算は消費するため最大2件）。
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const client = createXClient();
  if (!client) return NextResponse.json({ ok: false, tokenConfigured: false, message: "X_BEARER_TOKEN が本番環境で読み込めません" });

  const analyze = req.nextUrl.searchParams.get("analyze") === "1";
  const requested = (req.nextUrl.searchParams.get("users") ?? ALLOWED.join(",")).split(",").map((s) => s.trim());
  const users = ALLOWED.filter((u) => requested.some((r) => r.toLowerCase() === u.toLowerCase()));
  const extractor = analyze ? getExtractor() : null;
  const now = new Date();
  let fetched = 0;
  let analyzed = 0;
  const accounts: unknown[] = [];

  for (const user of users) {
    const lu = await client.lookupUser(user);
    if (!lu.ok) {
      accounts.push({ user, ok: false, code: lu.code, message: lu.message });
      continue;
    }
    const r = await client.userPosts(lu.id, user, { max: MAX_POSTS });
    if (!r.ok) {
      accounts.push({ user, ok: false, code: r.code, message: r.message });
      continue;
    }
    const posts: unknown[] = [];
    for (const p of r.posts.slice(0, MAX_POSTS)) {
      fetched++;
      const rich = await enrichXPost(p, {});
      const item: Record<string, unknown> = {
        id: p.id,
        createdAt: p.createdAt,
        textChars: p.text.length,
        imagesFound: p.images.length,
        imagesFetched: rich.imagesUsed,
        imagePartsSent: rich.images.length,
        links: p.links.length,
        linkedPageFetched: rich.linkedPage,
        textHead: p.text.slice(0, 60).replace(/\s+/g, " "),
      };
      if (extractor && analyzed < 2 && (rich.images.length > 0 || rich.linkedPage)) {
        analyzed++;
        const res = await extractFromRequest({ kind: "x_url", text: rich.text, images: rich.images, sourceUrl: p.url, postedOn: p.createdAt.slice(0, 10), now }, "x_url", extractor, now, []);
        if (res.ok) {
          const e = res.extraction;
          item.ai = {
            ok: true,
            usage: res.usage,
            keys: Object.keys(e).length,
            summary: JSON.stringify({
              chain: e.chainName,
              store: e.storeName,
              items: e.items.map((i) => i.name),
              applyDeadline: `${e.applyDeadline.date} ${e.applyDeadline.time}`.trim(),
              resultDate: e.resultDate.date,
              receiveMethod: e.receiveMethod,
              evidenceSources: Object.fromEntries(Object.entries(e.evidence).map(([k, v]) => [k, v?.source ?? ""])),
            }).slice(0, 900),
          };
        } else item.ai = { ok: false, code: res.code, message: res.message };
      }
      posts.push(item);
    }
    accounts.push({ user, ok: true, posts });
  }
  return NextResponse.json({ ok: true, tokenConfigured: true, fetched, analyzed, estimatedCostJpy: Math.round(fetched * X_COST_PER_POST_JPY * 10) / 10, accounts });
}
