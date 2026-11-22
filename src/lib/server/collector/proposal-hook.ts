/**
 * 通常収集から新AIの登録案プレビューへの接続口（Stage 10Z）。**開発環境（TOREMANE_ENV=local）かつ PROPOSAL_PREVIEW=on かつ PROPOSAL_AUTO=on のときだけ動く**。既定OFF・本番では常に何もしない。
 *  - 旧方式の確定・保存の**後**に、保存済みの原文（last_good.evidence）から費用ゼロのモックで登録案を作る。旧方式の処理・戻り値・保存内容・候補の状態は変えない。
 *  - 失敗しても・遅くても収集を止めない（待ち時間の上限つき・例外は飲み込む）。書き込み先は registration_proposals だけ（lotteries・応募・購入・通知・履歴には書かない）。
 *  - 実AIは呼ばない（注入しない限り、モック）。サービス権限のクライアントでないと保存できない（RLS）ため、利用者のセッションで呼ばれた場合は保存に失敗して何もしない。
 */
import type { Db } from "@/lib/server/lottery-service";
import { proposalAutoGenerateEnabled } from "@/lib/server/proposals/flag";
import { generateProposalsForCandidate } from "@/lib/server/proposals/generate";

export async function proposalAfterCandidate(a: { db: Db; householdId: string; candidateId: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<void> {
  const env = a.env ?? process.env;
  if (!proposalAutoGenerateEnabled(env)) return; // 無効のときは追加のDB呼び出しも待ち時間もない
  try {
    const work = (async () => {
      const row = await (a.db as unknown as { from: (n: string) => any }).from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("id", a.candidateId).eq("household_id", a.householdId).maybeSingle(); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!row.data) return;
      await generateProposalsForCandidate({ db: a.db, householdId: a.householdId, candidate: row.data, env });
    })();
    await Promise.race([work, new Promise<void>((res) => setTimeout(res, a.timeoutMs ?? 3000))]);
  } catch {
    /* 登録案の生成の失敗は無視する（収集に影響させない） */
  }
}
