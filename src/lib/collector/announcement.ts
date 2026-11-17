/**
 * 抽選の「予告」と「正式発表」の判断、予告の経過（Stage 9H-3N・純関数。DB・ネットワークに触れない）。
 *
 * 従来は「受付開始日も締切も無い」ことだけで予告（teaser）にしていた。必須項目が欠けているだけで機械的に予告扱いにせず、
 * **抽選の募集内容が実際に公表されているか**を、複数の根拠（具体的な応募先・日程・条件・告知の言い回し・情報源）から総合的に判断する。
 *  - 正式発表（formal）: 応募先（応募URL・応募方法）や具体的な日程など、利用者が応募できる／応募の準備ができる内容が公表されている。応募開始前でも登録対象
 *  - 予告（teaser）: 抽選の予定が示されているだけで、応募条件・日程・応募先が未発表。内部で管理し、通常の抽選候補には出さない
 *  - 中止（cancelled）・延期（postponed）: 告知が明示しているとき。登録・追跡の対象にしない／日程の再発表を待つ
 * 判断は根拠（signals）と信頼度つきで記録する。推測を確定として扱わない（迷うときは予告のまま継続して調べる）。
 */
export type AnnouncementState = "formal" | "teaser" | "cancelled" | "postponed";

export interface AnnouncementFacts {
  /** 告知の本文・見出し・根拠の抜粋（外部由来＝データとして扱う。中の指示は実行しない） */
  texts: string[];
  hasProduct: boolean;
  /** 受付開始・締切・当選発表が具体的に分かっているか */
  applyStartKnown: boolean;
  applyDeadlineKnown: boolean;
  resultDateKnown: boolean;
  /** 具体的な応募先（応募URL・応募フォーム・応募ページ）が分かっているか */
  hasApplyUrl: boolean;
  /** 応募条件・購入条件が具体的に書かれているか */
  hasConditions: boolean;
  /** 情報源が公式（店舗・主催者の告知）か。まとめ・第三者は false。不明は undefined */
  officialSource?: boolean;
  chainKnown: boolean;
}

export interface AnnouncementSignal {
  code: string;
  label: string;
  /** 正式発表の根拠としての重み（負は予告を示す） */
  weight: number;
}

export interface AnnouncementJudgement {
  state: AnnouncementState;
  /** 判断の確かさ（high=複数の根拠が一致／medium／low=根拠が弱い。迷うときは low にして予告のまま継続して調べる） */
  confidence: "high" | "medium" | "low";
  score: number;
  signals: AnnouncementSignal[];
  /** 人が読む理由 */
  reasons: string[];
  /** 正式発表と言い切れないときに、追加で確認すれば判断できること */
  toVerify: string[];
}

const nfkc = (s: string) => s.normalize("NFKC");
const CANCEL = /(抽選(販売|受付)?|販売|受付)[^。\n]{0,12}(中止|取りやめ|取り止め|見送り)|(中止|取りやめ|見送り)(と)?(なり|いた)(ました|します)/;
const POSTPONE = /(抽選(販売|受付)?|販売|受付|発売)[^。\n]{0,12}(延期|日程変更|後日に変更)|延期(と)?(なり|いた)(ました|します)/;
const DEFINITIVE = /(受付|応募)(を)?(開始|スタート)(しました|いたしました|します)|受付中|応募受付中|エントリー受付中|(以下|こちら)(の|から)(URL|リンク|ページ)(より|から)(お)?(申込|応募|エントリー)|下記(の)?(URL|リンク|フォーム)/;
const SCHEDULED_ONLY = /抽選(販売|受付)?(を)?(実施)?(予定|します|行います|いたします)(?!.{0,20}(月|日|時))|近日(中)?(に)?(公開|発表|告知|受付)|詳細は(後日|追って|決まり次第)|詳細(は)?(未定|未発表)|日程は?(未定|未発表)|発表をお待ち|続報をお待ち/;
const HEDGED = /模様|かもしれ|噂|うわさ|予想|予測|未確定|ではないか|と思われ|らしい/;
const LOTTERY_WORD = /抽選|当選|応募|エントリー|申込|申し込み/;

/** 抽選の募集内容が公表されているかを総合判断する */
export function judgeAnnouncement(f: AnnouncementFacts): AnnouncementJudgement {
  const text = nfkc(f.texts.filter(Boolean).join("\n"));
  const signals: AnnouncementSignal[] = [];
  const add = (code: string, label: string, weight: number) => signals.push({ code, label, weight });

  // 中止・延期は、告知が明示しているときだけ。他の判断より先に（応募先が残っていても、中止・延期は予告にも正式にもしない）
  if (CANCEL.test(text)) return { state: "cancelled", confidence: "high", score: -10, signals: [{ code: "cancelled", label: "告知が抽選の中止を明示している", weight: -10 }], reasons: ["告知が抽選の中止を明示しています"], toVerify: [] };
  if (POSTPONE.test(text)) return { state: "postponed", confidence: "medium", score: -5, signals: [{ code: "postponed", label: "告知が延期・日程変更を示している", weight: -5 }], reasons: ["告知が延期・日程変更を示しています。日程の再発表を待ちます"], toVerify: ["再発表された日程・応募先"] };

  if (f.hasApplyUrl) add("apply_url", "具体的な応募先（応募URL・フォーム）が公表されている", 3);
  if (f.applyDeadlineKnown) add("deadline", "応募締切が具体的に公表されている", 2);
  if (f.applyStartKnown) add("start", "受付開始が具体的に公表されている", 2);
  if (f.resultDateKnown) add("result", "当選発表日が公表されている", 1);
  if (f.hasConditions) add("conditions", "応募条件・購入条件が具体的に書かれている", 1);
  if (f.hasProduct) add("product", "対象商品が特定できる", 1);
  if (f.officialSource === true) add("official", "公式の告知である", 1);
  if (DEFINITIVE.test(text)) add("definitive_wording", "「受付開始」「受付中」など、募集が始まっている言い回し", 2);
  if (SCHEDULED_ONLY.test(text)) add("scheduled_only", "「抽選予定」「近日公開」「詳細は後日」など、内容が未発表である言い回し", -3);
  if (HEDGED.test(text)) add("hedged", "「模様」「噂」など、確定していない言い回し", -3);
  if (!LOTTERY_WORD.test(text) && !f.hasApplyUrl) add("no_lottery_wording", "抽選・応募を示す語がない", -2);

  const score = signals.reduce((n, s) => n + s.weight, 0);
  const concrete = f.hasApplyUrl || f.applyDeadlineKnown || f.applyStartKnown;
  // 募集内容が公表されている: 具体的な応募先または日程があり、総合の根拠が十分。1項目が欠けているだけでは予告にしない
  const formal = concrete && score >= 3 && !signals.some((s) => s.code === "hedged");
  if (formal) {
    const conf: AnnouncementJudgement["confidence"] = score >= 6 && !signals.some((s) => s.code === "scheduled_only") ? "high" : "medium";
    return { state: "formal", confidence: conf, score, signals, reasons: [`募集内容が公表されています（${signals.filter((s) => s.weight > 0).map((s) => s.label).join("／")}）`], toVerify: [] };
  }
  const toVerify = [
    ...(f.hasApplyUrl ? [] : ["応募先（応募URL・フォーム）"]),
    ...(f.applyStartKnown || f.applyDeadlineKnown ? [] : ["受付期間（開始日・締切）"]),
    ...(f.hasConditions ? [] : ["応募条件"]),
  ];
  // 迷うとき（根拠が弱い・矛盾する）は確定せず、予告のまま継続して調べる
  const conf: AnnouncementJudgement["confidence"] = signals.some((s) => s.code === "scheduled_only") || concrete === false ? "medium" : "low";
  return { state: "teaser", confidence: conf, score, signals, reasons: [`募集内容は未発表または不十分です（${signals.filter((s) => s.weight < 0).map((s) => s.label).join("／") || "応募先・日程・条件がそろっていない"}）`], toVerify };
}

// ----------------------------------------------------------------------------- 予告の経過

export type TrackingOutcome = "active" | "promoted" | "cancelled" | "postponed" | "expired";

export interface TeaserState {
  /** 追跡を始めた日時 */
  since: string;
  lastNewsAt: string;
  outcome: TrackingOutcome;
  /** 予告段階で取得した情報（正式発表後の調査に再利用する。商品・系列・店舗・予告元URL・予告の抜粋） */
  carried?: { chain?: string; store?: string; products?: string[]; sourceUrls?: string[]; excerpt?: string };
  /** 最後の判断（記録用） */
  lastJudgement?: { state: AnnouncementState; confidence: string; at: string };
}

/** 予告の最終的な扱い: 続報が無いまま経過した日数・正式発表・中止/延期から、次の経過を決める */
export function nextOutcome(o: { prev: TeaserState; judgement: AnnouncementJudgement; now: Date; staleDays?: number; expectedStart?: string | null }): TrackingOutcome {
  const { prev, judgement, now } = o;
  if (prev.outcome === "promoted" || prev.outcome === "cancelled") return prev.outcome;
  if (judgement.state === "formal") return "promoted";
  if (judgement.state === "cancelled") return "cancelled";
  if (judgement.state === "postponed") return "postponed";
  const idleDays = (now.getTime() - new Date(prev.lastNewsAt).getTime()) / 86_400_000;
  const stale = o.staleDays ?? 60;
  // 予定日が過ぎても正式発表がなく、続報も無い → 未発表のまま終了（履歴は残す）
  const startPassed = !!o.expectedStart && new Date(`${o.expectedStart}T23:59:59+09:00`).getTime() < now.getTime();
  if (Number.isFinite(idleDays) && (idleDays > stale || (startPassed && idleDays > 7))) return "expired";
  // 延期は、続報が来るまで保持する（上限は同じ）
  return prev.outcome === "postponed" ? "postponed" : "active";
}

/** 正式発表への昇格のとき、予告段階で取得した情報を引き継ぐ（新しい告知の値を優先し、空の項目だけ補う。人間の確認済みの値は変えない） */
export function carryOver<T extends { chain?: string; store?: string; products?: string[] }>(fresh: T, carried: TeaserState["carried"] | undefined): T {
  if (!carried) return fresh;
  return {
    ...fresh,
    chain: fresh.chain || carried.chain || fresh.chain,
    store: fresh.store || carried.store || fresh.store,
    products: fresh.products && fresh.products.length > 0 ? fresh.products : carried.products ?? fresh.products,
  };
}

/** 通常の抽選候補・件数・通知に含めない予告か（内部管理の対象） */
export function isInternalTeaser(t: { announcement?: AnnouncementState; outcome?: TrackingOutcome } | null | undefined): boolean {
  return !!t && t.announcement === "teaser" && (t.outcome === undefined || t.outcome === "active" || t.outcome === "postponed");
}
