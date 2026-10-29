import { FEEDBACK_FIELDS, type FeedbackField, type FieldStatus } from "@/lib/ai/feedback";

/**
 * AI解析の「修正状況」の集計（登録まで進んだ解析のフィードバックから）。
 * 注意: 修正率は、AIの誤認識率・正答率ではない。利用者が別の情報源で補った・好みで直した・正式名称へ変えた場合も含み、
 * 逆に、利用者が気づかなかった誤りは数えられない。誤認識として数えるのは「AIの読み取りが間違っていた」と明示された項目だけ。
 */

export interface FeedbackRow {
  engine: string;
  kind: string;
  prompt_version: string | null;
  field_results: Record<string, { status: FieldStatus; explicit?: boolean }>;
}

export interface Counts {
  adopted: number;
  modified: number;
  supplemented: number;
  normalized: number;
  explicit: number;
}

export interface Rate extends Counts {
  /** 比較した項目数（そのまま採用＋修正＋補完＋正規化） */
  total: number;
  /** 修正率 = 修正 ÷ 比較した項目。AIの誤認識率ではない */
  modifiedRate: number | null;
}

export interface QualitySummary {
  /** 実際のAIを呼んだ解析の数（モックを除く） */
  analyses: number;
  /** 登録まで進んだ解析の数 */
  registered: number;
  overall: Rate;
  byField: Partial<Record<FeedbackField, Rate>>;
  byKind: Record<string, Rate & { runs: number }>;
  byPromptVersion: Record<string, Rate & { runs: number }>;
}

const empty = (): Counts => ({ adopted: 0, modified: 0, supplemented: 0, normalized: 0, explicit: 0 });
const finish = (c: Counts): Rate => {
  const total = c.adopted + c.modified + c.supplemented + c.normalized;
  return { ...c, total, modifiedRate: total === 0 ? null : c.modified / total };
};

function add(c: Counts, status: FieldStatus, explicit: boolean) {
  c[status]++;
  if (explicit) c.explicit++;
}

/** @param analyses 実際のAIを呼んだ解析ログの件数（モック・未設定を除く） */
export function summarizeQuality(rows: FeedbackRow[], analyses: number): QualitySummary {
  const real = rows.filter((r) => r.engine === "anthropic");
  const overall = empty();
  const fields = new Map<FeedbackField, Counts>();
  const kinds = new Map<string, Counts & { runs: number }>();
  const prompts = new Map<string, Counts & { runs: number }>();
  for (const r of real) {
    const k = kinds.get(r.kind) ?? { ...empty(), runs: 0 };
    const pv = prompts.get(r.prompt_version ?? "（不明）") ?? { ...empty(), runs: 0 };
    k.runs++;
    pv.runs++;
    for (const f of FEEDBACK_FIELDS) {
      const res = r.field_results[f];
      if (!res) continue;
      const explicit = res.explicit === true;
      add(overall, res.status, explicit);
      add(fields.get(f) ?? fields.set(f, empty()).get(f)!, res.status, explicit);
      add(k, res.status, explicit);
      add(pv, res.status, explicit);
    }
    kinds.set(r.kind, k);
    prompts.set(r.prompt_version ?? "（不明）", pv);
  }
  const withRate = <T extends Counts & { runs: number }>(m: Map<string, T>) =>
    Object.fromEntries([...m.entries()].map(([key, c]) => [key, { ...finish(c), runs: c.runs }]));
  return {
    analyses,
    registered: real.length,
    overall: finish(overall),
    byField: Object.fromEntries([...fields.entries()].map(([f, c]) => [f, finish(c)])) as QualitySummary["byField"],
    byKind: withRate(kinds),
    byPromptVersion: withRate(prompts),
  };
}

export const FIELD_LABEL: Record<FeedbackField, string> = {
  chain: "系列",
  store: "店舗",
  items: "商品・数量",
  multiMode: "複数商品の方式",
  applyStart: "応募開始",
  applyDeadline: "応募締切",
  resultDate: "当選発表",
  procedureDeadline: "購入・受取期限",
  applyMethod: "応募方法",
  receiveMethod: "受取方法",
  limit: "応募制限",
  announcementMethod: "発表方法",
  announcementUrl: "発表URL",
  conditions: "応募条件",
  verification: "本人確認",
};
