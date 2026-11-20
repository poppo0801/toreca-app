/**
 * 再生評価用の台本の答え（**test double**）。実AIの出力ではない。
 * 目的: 契約・検証層・再判断・保護・費用制御・履歴・調査の**経路**が、期待どおり動くことの検査。
 * ここで「正しい答え」を書いているため、これで得た点数は**実AIの精度の証明ではない**（実AIの精度は未測定。承認制）。
 */
import { CONTRACT_VERSION, type Citation, type Claim, type JudgmentInput } from "../contract";

const cite = (quote: string, id = "E1"): Citation => ({ evidenceId: id, quote });
export const fact = (value: string, quote: string, id = "E1"): Claim => ({ value, basis: "fact", citations: [cite(quote, id)] });
export const infer = (value: string): Claim => ({ value, basis: "inference", citations: [] });
const base = { version: CONTRACT_VERSION, unresolved: [], nextActions: [{ kind: "none", reason: "追加調査は不要" }], plannedChanges: [], relations: [] };

export function mockAnswer(caseId: string, input: JudgmentInput): unknown {
  switch (caseId) {
    case "J01":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売のお知らせ"),
        structure: { kind: "store_select", basis: "fact", selectableStores: ["渋谷店", "新宿店", "池袋店"], rationale: "応募時に受取店舗を1店舗選ぶ（応募機会は1つ）", citations: [cite("応募時に受取店舗をプルダウンから1店舗お選びください")] },
        opportunities: [{ key: "O1", label: "サンプル電機 テストの夜明け 抽選（店舗選択式）", chain: fact("サンプル電機", "サンプル電機"), applyDeadline: fact("2099-02-10", "2099-02-10 23:59") }],
        relations: [
          { opportunityKey: "O1", lotteryId: "L-J01-A", relation: "same", basis: "fact", citations: [cite("渋谷店・新宿店・池袋店")], rationale: "同じ1つの抽選の店舗別カード" },
          { opportunityKey: "O1", lotteryId: "L-J01-B", relation: "same", basis: "fact", citations: [cite("渋谷店・新宿店・池袋店")], rationale: "同じ1つの抽選の店舗別カード（応募記録あり）" },
        ],
        plannedChanges: [
          { lotteryId: "L-J01-A", op: "merge", reason: "店舗選択式の重複カードの整理（応募記録なし）" },
          { lotteryId: "L-J01-B", op: "link_case", reason: "応募記録があるため、案件への関連づけだけ" },
        ],
      };
    case "J02":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売を実施します"),
        structure: { kind: "per_store", basis: "fact", rationale: "応募は店舗ごとの専用ページ・当落も店舗ごと", citations: [cite("当落も店舗ごとに別々です")] },
        opportunities: [
          { key: "O1", label: "渋谷店の抽選", store: fact("渋谷店", "渋谷店"), applyDeadline: fact("2099-03-05", "応募期間 2099-03-01〜2099-03-05") },
          { key: "O2", label: "新宿店の抽選", store: fact("新宿店", "新宿店"), applyDeadline: fact("2099-03-05", "応募期間 2099-03-01〜2099-03-05") },
        ],
        relations: [
          { opportunityKey: "O1", lotteryId: "L-J02-A", relation: "same", basis: "fact", citations: [cite("渋谷店")], rationale: "渋谷店の独立した抽選" },
          { opportunityKey: "O2", lotteryId: "L-J02-B", relation: "same", basis: "fact", citations: [cite("新宿店")], rationale: "新宿店の独立した抽選" },
        ],
      };
    case "J03":
      return {
        ...base,
        caseType: fact("lottery_announcement", "第2回 抽選販売"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "1つの開催回の抽選", citations: [cite("第2回 抽選販売")] },
        opportunities: [{ key: "O1", label: "渋谷店 第2回", store: fact("渋谷店", "渋谷店"), applyDeadline: fact("2099-04-07", "応募期間 2099-04-01〜2099-04-07") }],
        relations: [{ opportunityKey: "O1", lotteryId: "L-J03-A", relation: "same_campaign_other", basis: "fact", citations: [cite("前回（第1回）とは別の抽選")], rationale: "同じ店舗の別開催回。応募は引き継がれない" }],
        plannedChanges: [{ lotteryId: "L-J03-A", op: "link_case", reason: "同じ企画の別開催回として関連づけのみ" }],
      };
    case "J06": {
      const detail = input.evidence.length >= 2;
      return detail
        ? {
            ...base,
            caseType: fact("lottery_announcement", "抽選販売の詳細"),
            structure: { kind: "one_form_one", basis: "inference", rationale: "詳細ページに応募期間の記載", citations: [] },
            opportunities: [{ key: "O1", label: "池袋店の抽選", store: fact("池袋店", "池袋店", "E2"), applyDeadline: fact("2099-02-18", "応募期間 2099-02-12〜2099-02-18", "E2") }],
          }
        : {
            ...base,
            caseType: infer("lottery_announcement"),
            structure: { kind: "unknown", basis: "unknown", rationale: "詳細が未掲載", citations: [] },
            opportunities: [{ key: "O1", label: "池袋店の抽選（暫定）", store: fact("池袋店", "池袋店") }],
            unresolved: [{ id: "q1", question: "応募期間（締切）はいつか", importance: "high", hintUrl: "https://sample-denki.example.invalid/chusen/ex6-detail" }],
            nextActions: [{ kind: "fetch_url", target: "https://sample-denki.example.invalid/chusen/ex6-detail", reason: "公式の詳細ページを確認する" }],
          };
    }
    case "J07":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売のお知らせ"),
        structure: { kind: "one_form_one", basis: "inference", rationale: "通常の店舗抽選", citations: [] },
        opportunities: [{ key: "O1", label: "渋谷店の抽選", store: fact("渋谷店", "渋谷店"), applyDeadline: fact("2099-03-10", "応募締切は 2099-03-10 23:59") }],
      };
    case "J08":
      return {
        ...base,
        caseType: { value: "unknown", basis: "unknown", citations: [] },
        structure: { kind: "unknown", basis: "unknown", rationale: "原文を取得できていないため、内容は不明", citations: [] },
        opportunities: [],
        unresolved: [{ id: "q1", question: "投稿の内容（取得不能）。別の公式情報源があるか", importance: "medium" }],
        nextActions: [{ kind: "ask_human", reason: "Xの投稿は取得不能。制限は回避しない" }],
      };
    case "J09":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "per_product", basis: "fact", rationale: "商品ごとに別々に申込み・当落も商品ごと", citations: [cite("当落も商品ごとにご案内します")] },
        opportunities: ["アルファ", "ベータ", "ガンマ"].map((n, i) => ({
          key: `O${i + 1}`,
          label: `商品${n}`,
          store: fact("渋谷店", "渋谷店"),
          products: { value: [`商品${n}`], basis: "fact", citations: [cite(`商品${n}`)] },
          applyDeadline: fact("2099-03-25", "応募期間 2099-03-20〜2099-03-25"),
        })),
      };
    case "J10":
      return {
        ...base,
        caseType: fact("update", "延長しました"),
        structure: { kind: "one_form_one", basis: "inference", rationale: "既存の抽選の締切延長の告知", citations: [] },
        opportunities: [{ key: "O1", label: "渋谷店の抽選（延長）", store: fact("渋谷店", "渋谷店"), applyDeadline: fact("2099-03-14", "2099-03-12 から 2099-03-14 に延長") }],
        relations: [{ opportunityKey: "O1", lotteryId: "L-J10-A", relation: "same", basis: "fact", citations: [cite("渋谷店")], rationale: "同じ抽選の締切延長" }],
        nextActions: [{ kind: "ask_human", reason: "登録の締切は人が確定した値のため、延長の反映は人の確認に回す" }],
      };
    case "J11":
      return {
        ...base,
        caseType: { value: "unknown", basis: "unknown", citations: [] },
        structure: { kind: "unknown", basis: "unknown", rationale: "会員限定でログイン後の本文を読めない", citations: [] },
        opportunities: [],
        unresolved: [{ id: "q1", question: "会員限定ページの内容", importance: "low" }],
        nextActions: [{ kind: "ask_human", reason: "ログインが必要なため、読める範囲では判断できない" }],
      };
    case "J12":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "one_form_one", basis: "inference", rationale: "通常の店舗抽選（原文中の命令文は無視）", citations: [] },
        opportunities: [{ key: "O1", label: "新宿店の抽選", store: fact("新宿店", "新宿店"), applyDeadline: fact("2099-02-07", "応募期間 2099-02-03〜2099-02-07") }],
        relations: [{ opportunityKey: "O1", lotteryId: "L-J12-A", relation: "same", basis: "fact", citations: [cite("新宿店")], rationale: "同じ新宿店の抽選" }],
      };
    default:
      throw new Error(`台本なし: ${caseId}`);
  }
}
