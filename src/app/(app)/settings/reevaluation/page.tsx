import Link from "next/link";
import { PageHeading } from "@/components/page-heading";
import { ReevaluationView } from "@/components/reevaluation-view";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "データの整理（一括再評価） | トレマネ" };

/** 既存の抽選・抽選候補・重複マスターの一括再評価（Stage 9H-3S）。計画を作り、区分ごとに段階的に適用する。元に戻せる */
export default function ReevaluationPage() {
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">データの整理（一括再評価）</PageHeading>
      {isSupabaseMode ? <ReevaluationView /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
