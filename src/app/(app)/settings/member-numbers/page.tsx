import { PageHeading } from "@/components/page-heading";
import Link from "next/link";
import { MemberNumbersView } from "@/components/member-numbers-view";
import type { MemberNumber } from "@/lib/member-number";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "会員番号 | トレマネ" };
export const dynamic = "force-dynamic";

export default async function MemberNumbersPage() {
  let rows: MemberNumber[] = [];
  if (isSupabaseMode) {
    const db = await createClient();
    const { data } = await db.from("member_numbers").select("id,profile_id,chain_id,member_no,note").limit(2000);
    rows = (data ?? []).map((r) => ({ id: r.id, profileId: r.profile_id, chainId: r.chain_id, memberNo: r.member_no, note: r.note }));
  }
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">会員番号</PageHeading>
      {isSupabaseMode ? <MemberNumbersView rows={rows} /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
