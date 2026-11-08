/**
 * 注意付きで登録した抽選の自動補完（Stage 7A・純関数）。同じ抽選について新しい情報が取得できたとき、不足項目・相違を再評価する。
 *  - 不足していた項目（未確認の日付・受取方法・応募方法）は、新しい情報で埋める。埋まった注意は解除する
 *  - すでに値がある項目は上書きしない（利用者が確認・編集した可能性があるため）。例外は応募締切の暫定採用:
 *      ・公式情報で締切が確認できたとき、暫定（相違の注意がある）の締切を公式の値に更新する
 *      ・公式でない情報で締切が食い違い、2週間以内なら、応募漏れ防止のため早い方を暫定採用する（注意付き）
 *  - 値が食い違う項目は上書きせず、新しい相違の注意を追加する
 * 手動で編集された抽選は呼び出し側で除外する（server/collector/complete.ts）。
 */
import type { Caution } from "@/lib/collector/attention";
import type { LotteryInput } from "@/lib/lottery-input";

export type CompletionFields = Pick<LotteryInput, "resultDate" | "applyDeadline" | "procedureStart" | "procedureDeadline" | "receiveStart" | "receiveDeadline" | "receiveMethod" | "applyMethod">;
export type CompletionKey = keyof CompletionFields;

type Flex = { precision: string; date?: string | null; time?: string | null } | undefined;
const known = (f: Flex) => !!f && f.precision !== "unknown" && !!f.date;
const dateOf = (f: Flex) => (known(f) ? (f!.date as string) : "");
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export interface CompletionPlan {
  /** 更新する項目と新しい値（空なら更新なし） */
  patch: Partial<CompletionFields>;
  /** 補った項目（履歴・表示用の日本語） */
  filled: string[];
  /** 更新後の注意 */
  cautions: Caution[];
  /** 注意が変わったか（解除・追加） */
  cautionsChanged: boolean;
}

const LABEL: Record<CompletionKey, string> = { resultDate: "当選発表日", applyDeadline: "応募締切", procedureStart: "購入開始", procedureDeadline: "購入期限", receiveStart: "受取開始", receiveDeadline: "受取期限", receiveMethod: "受取方法", applyMethod: "応募方法" };

export function planCompletion(cur: CompletionFields, inc: CompletionFields, cautions: Caution[], opts: { official: boolean; now: string }): CompletionPlan {
  const patch: Partial<CompletionFields> = {};
  const filled: string[] = [];
  let next = [...cautions];
  const drop = (...codes: string[]) => {
    next = next.filter((c) => !codes.includes(c.code));
  };
  const add = (c: Caution) => {
    next = [...next.filter((x) => x.code !== c.code), c];
  };

  // ---- 日付: 不足は補う。食い違いは上書きせず、注意を追加する
  for (const k of ["resultDate", "procedureStart", "procedureDeadline", "receiveStart", "receiveDeadline"] as const) {
    if (!known(inc[k])) continue;
    if (!known(cur[k])) {
      (patch as Record<string, unknown>)[k] = inc[k];
      filled.push(LABEL[k]);
    } else if (k === "resultDate" && dateOf(cur[k]) !== dateOf(inc[k])) {
      add({ code: "conflict_resultDate", field: "resultDate", message: `当選発表日に相違があります（${md(dateOf(cur[k]))} / ${md(dateOf(inc[k]))}）。確認できるまで採用中の値は暫定です`, values: [md(dateOf(cur[k])), md(dateOf(inc[k]))], at: opts.now });
    }
  }
  if (known(patch.resultDate ?? cur.resultDate)) drop("result_date_unknown");
  if (known(patch.procedureStart ?? cur.procedureStart) || known(patch.procedureDeadline ?? cur.procedureDeadline) || known(patch.receiveStart ?? cur.receiveStart) || known(patch.receiveDeadline ?? cur.receiveDeadline)) drop("receive_period_unknown");

  // ---- 受取方法・応募方法
  if (cur.receiveMethod === "unknown" && inc.receiveMethod !== "unknown") {
    patch.receiveMethod = inc.receiveMethod;
    filled.push(LABEL.receiveMethod);
    drop("receive_method_unknown");
  }
  if (cur.applyMethod === "unknown" && inc.applyMethod !== "unknown") {
    patch.applyMethod = inc.applyMethod;
    filled.push(LABEL.applyMethod);
    drop("apply_method_unclear");
  }

  // ---- 応募締切
  const cd = dateOf(cur.applyDeadline);
  const id = dateOf(inc.applyDeadline);
  if (id && !cd) {
    patch.applyDeadline = inc.applyDeadline;
    filled.push(LABEL.applyDeadline);
  } else if (id && cd && id !== cd) {
    const gap = Math.abs(Date.parse(cd) - Date.parse(id)) / 86_400_000;
    const hasProvisional = next.some((c) => c.code === "deadline_conflict");
    if (opts.official) {
      // 公式情報で確認できた締切: 暫定の値を公式の値に更新し、相違の注意を解除する（暫定でない確認済みの値は変えない）
      if (hasProvisional) {
        patch.applyDeadline = inc.applyDeadline;
        filled.push(`${LABEL.applyDeadline}（公式情報で更新）`);
        drop("deadline_conflict");
      }
    } else if (Number.isFinite(gap) && gap <= 14) {
      // 公式でない情報の食い違い: 早い方を暫定採用し、両方を注意に残す
      const early = id < cd ? id : cd;
      const late = id < cd ? cd : id;
      if (id < cd) {
        patch.applyDeadline = inc.applyDeadline;
        filled.push(`${LABEL.applyDeadline}（早い方を暫定採用）`);
      }
      add({ code: "deadline_conflict", field: "applyDeadline", message: `締切情報に相違があります。${md(early)}と${md(late)}の情報が確認されています（早い方の${md(early)}を暫定表示しています）`, values: [md(early), md(late)], at: opts.now });
    }
  } else if (id && id === cd && opts.official) {
    // 公式情報が同じ締切を示した: 相違の注意を解除（矛盾が解消された）
    drop("deadline_conflict");
  }

  const same = next.length === cautions.length && next.every((c, i) => c.code === cautions[i]?.code && c.message === cautions[i]?.message);
  return { patch, filled, cautions: next, cautionsChanged: !same };
}
