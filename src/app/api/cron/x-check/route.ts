import { NextResponse, type NextRequest } from "next/server";
import { getExtractor } from "@/lib/ai/provider";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { createXClient } from "@/lib/server/collector/x-client";
import { enrichXPost } from "@/lib/server/collector/x-rich";
import { extractFromRequest } from "@/lib/server/lottery-extract-service";
import { X_COST_PER_POST_JPY } from "@/lib/collector/x-posts";
import { judgeXPost } from "@/lib/collector/x-relevance";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 診断で使ってよいアカウント（固定。任意のアカウントでX APIを呼ばせない） */
const ALLOWED = ["OnchainOutlaw", "pokecachan", "pokecayoyaku"] as const;
const DEFAULT_POSTS = 3;
const MAX_POSTS_LIMIT = 12;

/**
 * X API 接続の少数テスト（運用確認用）。CRON_SECRET による認証が必要。
 * 指定アカウント（固定の3件のみ）から最大 `max` 件（既定3・上限12）の公開投稿を取得し、本文・画像・引用元・リンク先の取得状況と、
 * 解析対象になるかの判定、AI解析結果の要点（画像から読み取れた項目と根拠）を返す。何も保存しない（候補・抽選・利用量にも記録しない）。
 * 定期収集の設定は変更しない。トークン等の秘密は返さない。X APIの費用は取得した投稿数ぶん発生する（返却値の estimatedCostJpy）。
 * ?analyze=1 のとき、解析対象の投稿をAI解析する（AI予算を消費するため最大 `analyzeMax` 件、既定2・上限4）。
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const client = createXClient();
  if (!client) return NextResponse.json({ ok: false, tokenConfigured: false, message: "X_BEARER_TOKEN が本番環境で読み込めません" });

  const sp = req.nextUrl.searchParams;
  const analyze = sp.get("analyze") === "1";
  const maxPosts = Math.min(MAX_POSTS_LIMIT, Math.max(1, Number(sp.get("max")) || DEFAULT_POSTS));
  const analyzeMax = Math.min(4, Math.max(1, Number(sp.get("analyzeMax")) || 2));
  // 何件目の解析対象から解析するか（60秒の実行時間内で、複数回に分けて別の投稿を検証するため）。解析しない投稿は画像のダウンロードもしない
  const analyzeFrom = Math.max(0, Number(sp.get("analyzeFrom")) || 0);
  let passSeen = 0;
  const requested = (sp.get("users") ?? ALLOWED.join(",")).split(",").map((s) => s.trim());
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
    const r = await client.userPosts(lu.id, user, { max: maxPosts });
    if (!r.ok) {
      accounts.push({ user, ok: false, code: r.code, message: r.message });
      continue;
    }
    const posts: unknown[] = [];
    for (const p of r.posts.slice(0, maxPosts)) {
      fetched++;
      const j = judgeXPost({ text: p.text, images: p.images, links: p.links, createdAt: p.createdAt, quoted: p.quoted ?? null }, now);
      const wouldAnalyze = !!extractor && j.pass && (p.images.length > 0 || (p.quoted?.images.length ?? 0) > 0 || p.links.length > 0 || !!p.quoted);
      const inWindow = wouldAnalyze && passSeen >= analyzeFrom && analyzed < analyzeMax;
      if (j.pass) passSeen++;
      const rich = inWindow || !extractor ? await enrichXPost(p, {}) : { text: p.text, images: [], linkedPage: false, imagesUsed: 0, stats: { found: p.images.length + (p.quoted?.images.length ?? 0), fetched: 0, sent: 0 }, quotedUsed: false };
      const item: Record<string, unknown> = {
        id: p.id,
        createdAt: p.createdAt,
        textChars: p.text.length,
        imagesFound: rich.stats.found,
        imagesFetched: rich.stats.fetched,
        imagePartsSent: rich.stats.sent,
        // 公開CDN（pbs.twimg.com）の画像URL。抽出結果を実際の画像と突き合わせて精度を検証するために返す（秘密を含まない）
        imageUrls: [...p.images, ...(p.quoted?.images ?? [])].slice(0, 12),
        quoted: p.quoted ? { user: p.quoted.username, textChars: p.quoted.text.length, images: p.quoted.images.length, links: p.quoted.links.length } : null,
        links: p.links.length,
        linkedPageFetched: rich.linkedPage,
        judge: j.pass ? { pass: true, basis: j.basis } : { pass: false, skip: j.skip },
        textHead: p.text.slice(0, 60).replace(/\s+/g, " "),
      };
      if (extractor && inWindow && (rich.images.length > 0 || rich.linkedPage || p.quoted)) {
        analyzed++;
        const kind = rich.images.length > 0 ? "image" : "x_url";
        const res = await extractFromRequest({ kind, text: rich.text, images: rich.images.length ? rich.images : undefined, sourceUrl: p.url, postedOn: p.createdAt.slice(0, 10), now }, kind, extractor, now, []);
        if (res.ok) {
          const e = res.extraction;
          const fromImage = Object.entries(e.evidence)
            .filter(([, v]) => (v?.source ?? "").startsWith("画像"))
            .map(([k, v]) => ({ field: k, source: v?.source, quote: (v?.quote ?? "").slice(0, 60), verified: v?.verified ?? null }));
          item.ai = {
            ok: true,
            usage: res.usage,
            imagesSentToAi: rich.images.length,
            summary: {
              chain: e.chainName,
              store: e.storeName,
              items: e.items.map((i) => i.name),
              applyStart: `${e.applyStart.date} ${e.applyStart.time}`.trim(),
              applyDeadline: `${e.applyDeadline.date} ${e.applyDeadline.time}`.trim(),
              resultDate: e.resultDate.date,
              receiveMethod: e.receiveMethod,
              applyMethod: e.applyMethod,
              applyUrl: e.applyUrl,
              conditionsText: e.conditionsText.slice(0, 200),
              verificationText: e.verificationText.slice(0, 120),
              warnings: e.warnings.slice(0, 4),
            },
            extractedFromImage: fromImage,
            evidenceSources: Object.fromEntries(Object.entries(e.evidence).map(([k, v]) => [k, v?.source ?? ""])),
          };
        } else item.ai = { ok: false, code: res.code, message: res.message, usage: res.usage };
      }
      posts.push(item);
    }
    accounts.push({ user, ok: true, posts });
  }
  return NextResponse.json({ ok: true, tokenConfigured: true, fetched, analyzed, estimatedCostJpy: Math.round(fetched * X_COST_PER_POST_JPY * 10) / 10, accounts });
}
