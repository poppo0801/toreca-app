/**
 * 通常収集から新AIの登録案プレビューへの接続口（開発専用）。**開発環境（TOREMANE_ENV=local）かつ PROPOSAL_PREVIEW=on かつ PROPOSAL_AUTO=on かつ ローカルのSupabase のときだけ動く**。既定OFF・本番では常に何もしない。
 *  - 旧方式の確定・保存の**後**に、保存済みの原文（last_good.evidence）から**費用ゼロのモック**で登録案を作る。**実AIは呼ばない**（実AIは評価入口だけ。ここは mode=mock を固定で渡す）。
 *    旧方式の処理・戻り値・保存内容・候補の状態は変えない。
 *  - 待ち時間の上限（既定3秒）を超えたら収集へ戻る。**超過したら協調的な中止フラグを立て**、バックグラウンドで残った処理は、次の項目の前で止まる（無制限に走り続けない）。
 *    実行中の1項目の処理は完了まで待つ（モックは費用0・外部アクセスなし）。
 *  - 失敗・超過は**無言で握りつぶさず、分類コードだけを記録**する（console.warn。原文・URL・ID・機密は含めない）。収集は止めない。
 *  - 書き込み先は registration_proposals だけ（lotteries・応募・購入・通知・履歴には書かない）。サービス権限のクライアントでないと保存できない（RLS）ため、利用者のセッションで呼ばれた場合は保存に失敗して何もしない。
 */
import type { Db } from "@/lib/server/lottery-service";
import { proposalAutoGenerateEnabled } from "@/lib/server/proposals/flag";
import { generateProposalsForCandidate, mockDeps } from "@/lib/server/proposals/generate";

const warn = (code: string): void => {
  try {
    console.warn(`[proposal-hook] ${code}`);
  } catch {
    /* ログの失敗は無視 */
  }
};

export async function proposalAfterCandidate(a: { db: Db; householdId: string; candidateId: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<void> {
  const env = a.env ?? process.env;
  if (!proposalAutoGenerateEnabled(env)) return; // 無効のときは追加のDB呼び出しも待ち時間もない
  let stop = false;
  try {
    const work = (async (): Promise<string> => {
      const row = await (a.db as unknown as { from: (n: string) => any }).from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("id", a.candidateId).eq("household_id", a.householdId).maybeSingle(); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (row.error) return "db_read_error";
      if (!row.data) return "candidate_not_found";
      const r = await generateProposalsForCandidate({ db: a.db, householdId: a.householdId, candidate: row.data, env, deps: mockDeps({ shouldStop: () => stop }) });
      return r.ok ? (r.stopped ? "stopped" : "done") : `generate_${r.reason}`;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), a.timeoutMs ?? 3000);
    });
    const outcome = await Promise.race([work, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      stop = true; // 協調的な中止: 残りの項目は処理しない
      warn("timeout_stop_requested");
      void work.catch(() => undefined); // 残った処理の例外が未処理にならないように
    } else if (outcome !== "done") warn(outcome);
  } catch (e) {
    warn(`error:${(e as Error)?.name ?? "unknown"}`);
  }
}
