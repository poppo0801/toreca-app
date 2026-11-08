import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 実行中のビルド識別（コミットの短縮ID）。ホーム画面から開いたアプリが新しいデプロイに更新されたかの確認用。秘密情報は含まない */
export function GET() {
  return NextResponse.json({ build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}
