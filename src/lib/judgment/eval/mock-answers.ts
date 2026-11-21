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
    case "J13":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "multi_independent_per_submit", basis: "fact", rationale: "1回の送信で3商品に応募され、当落は商品ごとに独立", citations: [cite("当選・落選は商品ごとに独立して判定し")] },
        opportunities: ["デルタ", "イプシロン", "ゼータ"].map((n, i) => ({
          key: `O${i + 1}`,
          label: `商品${n}`,
          store: fact("渋谷店", "渋谷店"),
          products: { value: [`商品${n}`], basis: "fact", citations: [cite(`商品${n}`)] },
          applyDeadline: fact("2099-03-25", "応募期間 2099-03-20〜2099-03-25"),
        })),
      };
    case "J14":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "希望順位つきの1回の応募で、当選は1名1商品のみ（応募機会は1つ）", citations: [cite("当選は1名につき1商品のみ")] },
        opportunities: [{ key: "O1", label: "新宿店の抽選（3商品から希望順位）", store: fact("新宿店", "新宿店"), applyDeadline: fact("2099-03-26", "応募期間 2099-03-20〜2099-03-26") }],
      };
    case "J15":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "per_round", basis: "fact", rationale: "第1弾・第2弾は応募期間・当落が独立（別々に申し込む）", citations: [cite("各弾の当落は独立で")] },
        opportunities: [
          { key: "O1", label: "池袋店 第1弾", store: fact("池袋店", "池袋店"), applyDeadline: fact("2099-02-05", "応募 2099-02-01〜2099-02-05") },
          { key: "O2", label: "池袋店 第2弾", store: fact("池袋店", "池袋店"), applyDeadline: fact("2099-02-19", "応募 2099-02-15〜2099-02-19") },
        ],
      };
    case "J16":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売を実施します"),
        structure: { kind: "one_form_one", basis: "inference", rationale: "対象店舗での抽選（地域の限定あり）", citations: [] },
        opportunities: [{ key: "O1", label: "サンプル電機 抽選（東京都・神奈川県の店舗のみ）", applyDeadline: fact("2099-03-05", "応募期間 2099-03-01〜2099-03-05"), conditions: fact("対象は東京都・神奈川県の店舗のみ", "対象は東京都・神奈川県の店舗のみです") }],
      };
    case "J17":
      return {
        ...base,
        caseType: fact("lottery_announcement", "オンライン抽選販売"),
        structure: { kind: "one_form_one", basis: "inference", rationale: "オンラインの抽選（配送地域の除外あり）", citations: [] },
        opportunities: [{ key: "O1", label: "サンプル電機 オンライン抽選", applyDeadline: fact("2099-03-12", "応募期間 2099-03-08〜2099-03-12"), conditions: fact("北海道・沖縄県および離島への配送は対象外", "北海道・沖縄県および離島への配送は対象外です") }],
      };
    case "J18":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "store_select", basis: "fact", rationale: "受取店舗は応募時に選ぶ。対象店舗は未発表のため店舗は未確定", citations: [cite("受取店舗は応募時に選択していただきます")] },
        opportunities: [{ key: "O1", label: "サンプル電機 抽選（店舗は後日発表）", applyDeadline: fact("2099-03-05", "応募期間 2099-03-01〜2099-03-05") }],
        unresolved: [{ id: "q1", question: "対象店舗の一覧（後日発表）", importance: "medium" }],
        nextActions: [{ kind: "wait", reason: "対象店舗は後日発表される" }],
      };
    case "J19":
      return {
        ...base,
        caseType: fact("update", "応募締切を"),
        structure: { kind: "one_form_one", basis: "inference", rationale: "既存の抽選の締切短縮の告知", citations: [] },
        opportunities: [{ key: "O1", label: "渋谷店の抽選（締切短縮）", store: fact("渋谷店", "渋谷店"), applyDeadline: fact("2099-03-15", "2099-03-20 から 2099-03-15 に短縮") }],
        relations: [{ opportunityKey: "O1", lotteryId: "L-J19-A", relation: "same", basis: "fact", citations: [cite("渋谷店")], rationale: "同じ抽選の締切短縮" }],
        nextActions: [{ kind: "ask_human", reason: "登録の締切は人が確定した値で応募記録もあるため、短縮の反映は人の確認に回す" }],
      };
    case "J20":
      return {
        ...base,
        caseType: fact("update", "中止いたします"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "中止された抽選とは別に、期間をあらためた再開催の抽選が1つ", citations: [cite("あらためて 2099-03-10〜2099-03-14 の応募期間で")] },
        opportunities: [{ key: "O1", label: "新宿店の再開催の抽選", store: fact("新宿店", "新宿店"), applyDeadline: fact("2099-03-14", "2099-03-10〜2099-03-14 の応募期間") }],
        relations: [{ opportunityKey: "O1", lotteryId: "L-J20-A", relation: "same_campaign_other", basis: "fact", citations: [cite("中止いたします")], rationale: "中止された抽選と、再開催の抽選は別の応募機会（応募は引き継がれない）" }],
        plannedChanges: [{ lotteryId: "L-J20-A", op: "link_case", reason: "同じ企画の別機会として関連づけのみ" }],
      };
    case "J21":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選を継続実施します"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "今回は第3週分の抽選（週ごとに別の応募機会）", citations: [cite("今回は第3週分")] },
        opportunities: [{ key: "O1", label: "渋谷店 第3週分", store: fact("渋谷店", "渋谷店"), applyDeadline: fact("2099-02-26", "応募 2099-02-20〜2099-02-26") }],
        relations: [{ opportunityKey: "O1", lotteryId: "L-J21-A", relation: "same_campaign_other", basis: "fact", citations: [cite("第1・2週に落選した方も今回応募できます")], rationale: "前週分とは別の応募機会" }],
        plannedChanges: [{ lotteryId: "L-J21-A", op: "link_case", reason: "継続企画の別の週として関連づけのみ" }],
      };
    default:
      throw new Error(`台本なし: ${caseId}`);
  }
}
