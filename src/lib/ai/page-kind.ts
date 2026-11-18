/**
 * ページの主題の判定（Stage 9E）。「抽選」という単語が出てくるだけのページ（ナビゲーション・新着一覧・店舗案内・商品紹介・一般的な説明）を、
 * 実際に応募できる抽選の告知と区別する。純粋なルール（無料・オフライン）。単語の一致ではなく、ページの主題（タイトル）・応募の記載・告知の構造で決める。
 *
 *   lottery_announcement  応募できる（または予定の）抽選の告知。登録の対象
 *   announcement_index    複数の告知の見出しを並べた一覧（トップ・ニュース・店舗ブログ一覧）。1件の抽選として登録しない。個々の告知へのリンクをたどる
 *   lottery_explainer     抽選の一般的な説明（仕組み・注意事項・FAQ）。登録しない
 *   past_lottery          受付が終了した抽選の告知。新規登録しない（既存の抽選の更新材料にはなり得る）
 *   general               ナビゲーション・商品紹介・店舗案内など、抽選の告知ではないページ
 *
 * 判定の方針: 見出し（先頭の行＝ページのタイトル）が抽選の告知を示すこと、または本文に応募の具体的な記載（期間・方法・条件・当選の扱い）が複数あること。
 * 迷う（どちらとも言えない）ときは、抽選の告知側に倒す（見落とさない。登録の可否はその後の検証・安全条件が決める）。ただし「一覧」「説明」「ナビだけ」の構造が明確なものは除く。
 */
export type PageKind = "lottery_announcement" | "announcement_index" | "lottery_explainer" | "past_lottery" | "general";

export interface PageKindResult {
  kind: PageKind;
  /** 抽選の告知として扱う（登録の対象にできる）か */
  actionable: boolean;
  reasons: string[];
}

const LOTTERY = /抽選|エントリー受付|応募受付/g;
/** 見出し（タイトル）が、抽選の告知・受付を示す */
const TITLE_LOTTERY = /抽選\s*(販売|予約|受付|応募|のご案内|のお知らせ|について|開催|実施)|(再|追加)抽選|(エントリー|応募)受付|抽選.{0,12}(お知らせ|ご案内)/;
/** 本文中の見出し（タイトルが店名・サイト名だけのページ。例: 「抽選販売のご案内」「抽選販売受付ページです」） */
const BODY_HEADLINE = /抽選\s*(販売|予約販売|予約|受付|応募)\s*(の)?\s*(ご案内|お知らせ|受付ページ|受付|について)|(再|追加)抽選/g;
/** 応募の具体的な記載（期間・方法・条件・当選の扱い・受取）の種類 */
const PERIOD = /(応募|受付|エントリー|抽選|申し\s*込み|申込|お申込み|お申し込み)\s*(期間|期限|締切|締め切り|日時)\s*[:：]?\s*(内|は)?\s*(20\d{2}\s*[年/.]\s*)?\d{1,2}\s*[/月.]\s*\d{1,2}/;
const METHOD = /応募方法|お?申し\s*込み方法|応募(条件|資格|フォーム|ページ|URL)|ご応募(ください|いただ|は)|エントリー(方法|フォーム)|店舗を選択|受付ページ|お?申し?込み(条件|ください|をお願い)|抽選へのお?申し?込み/;
const WINNER = /当選(者|発表|連絡|通知|後|のみ|された|いたしました方)|抽選結果|落選/;
const CONDITION = /お?一人様|1人1回|ご本人様?につき|(1|１)点限り|転売|先着(順)?(販売)?(では|ではございません)/;
const RECEIVE = /(受取|受け取り|お渡し|引換|引き換え|お届け)(期間|方法|日|場所|時間)?\s*[:：]/;
const PLANNED = /(予定|実施いたします|実施します|開催いたします|行います|を開始|受付を開始)/;
const EXPLAINER_TITLE = /(抽選(の)?(仕組み|ルール|方法|とは)|よくある(ご)?(質問|お問い?合わせ|問い?合わせ)|FAQ|Q&A|ご利用ガイド|注意事項|利用規約)/;
const EXPLAINER_BODY = /抽選(の)?(仕組み|ルール|方法とは|とは)|抽選に関する(よくある)?(ご)?質問/;
const ENDED = /(受付|応募|エントリー|抽選)(は|を)?(すべて|全て)?\s*(終了(いたし)?ました|終了しました|締め切りました|締切しました)|(抽選|受付)\s*終了/;
/** 抽選が完了済み（当選者への連絡・当選後の手続きの案内）。新たに応募できる抽選ではない */
const COMPLETED = /抽選(作業|結果)?\s*(が|は|も)?\s*(すべて|全て)?\s*(完了|終了)\s*(い|し)(たし)?(ました|まして)|当選(者様?)?(へ|に)(は)?\s*当選\s*(メール|通知)を(順次)?\s*お?送り(し|いたし)ており/;
const DATESTAMP = /\b20\d{2}[./]\d{1,2}[./]\d{1,2}\b/g;

const count = (s: string, re: RegExp): number => (s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length;

/**
 * @param title 明示のタイトル（省略時は text の先頭の行をタイトルとみなす）
 */
export function classifyPage(input: { title?: string; text: string }): PageKindResult {
  const text = (input.text ?? "").normalize("NFKC");
  const firstLine = text.split("\n", 1)[0] ?? "";
  const title = (input.title ?? firstLine).normalize("NFKC").slice(0, 200);
  const mentions = count(text, LOTTERY);
  const titleHit = TITLE_LOTTERY.test(title);
  if (mentions === 0 && !titleHit) return { kind: "general", actionable: false, reasons: ["抽選に関する記載がない"] };

  const cues = { 期間: PERIOD.test(text), 方法: METHOD.test(text), 当選: WINNER.test(text), 条件: CONDITION.test(text), 受取: RECEIVE.test(text) };
  const cueNames = Object.entries(cues)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const bodyCues = cueNames.length;
  const dateStamps = new Set(text.match(DATESTAMP) ?? []).size;
  const headlines = count(text, BODY_HEADLINE);
  const reasons: string[] = [];

  // 一覧: ページの主題が抽選の告知ではなく、日付つきの見出し・告知の見出しが多数並び、応募の具体的な記載が乏しい
  if (!titleHit && (dateStamps >= 4 || headlines >= 4) && bodyCues <= 1) {
    reasons.push(`告知の見出しを並べた一覧（日付つき${dateStamps}件・抽選の見出し${headlines}件）で、ページ自体の主題は抽選の告知ではない`);
    return { kind: "announcement_index", actionable: false, reasons };
  }
  // 抽選の一般的な説明（タイトルが説明・FAQで、応募期間の記載がない）
  if (EXPLAINER_TITLE.test(title) && !cues.期間) {
    reasons.push("抽選の仕組み・注意事項の説明で、応募期間の記載がない");
    return { kind: "lottery_explainer", actionable: false, reasons };
  }
  // 受付が終了した告知（見出し付近で終了を明記）
  if ((titleHit || headlines > 0) && ENDED.test(text.slice(0, Math.min(text.length, title.length + 400))) && !cues.期間) {
    reasons.push("受付の終了が明記され、応募期間の記載がない");
    return { kind: "past_lottery", actionable: false, reasons };
  }
  // 抽選が完了済みで、応募期間の記載がない（当選者への手続き・問い合わせの案内など）
  if (COMPLETED.test(text) && !cues.期間) {
    reasons.push("抽選は完了済みで、当選者への手続きの案内（応募期間の記載がない）");
    return { kind: "past_lottery", actionable: false, reasons };
  }
  if (titleHit) {
    reasons.push("ページの主題（タイトル）が抽選の告知");
    if (bodyCues) reasons.push(`応募の記載あり（${cueNames.join("・")}）`);
    else if (PLANNED.test(text)) reasons.push("実施の予定の告知（日時は未記載）");
    return { kind: "lottery_announcement", actionable: true, reasons };
  }
  // タイトルが抽選を示さなくても、本文に抽選の見出し／応募の具体的な記載が複数あれば告知（店名だけのタイトルのページ・受付ページ・イベントページなど）
  if (bodyCues >= 2 && (headlines >= 1 || mentions >= 2)) {
    reasons.push(`本文に応募の記載が複数ある（${cueNames.join("・")}）`);
    return { kind: "lottery_announcement", actionable: true, reasons };
  }
  if (EXPLAINER_BODY.test(text) && !cues.期間) {
    reasons.push("抽選の一般的な説明にとどまり、応募の記載がない");
    return { kind: "lottery_explainer", actionable: false, reasons };
  }
  reasons.push(`「抽選」の語が${mentions}回出るが、ページの主題・応募の記載は抽選の告知ではない（ナビゲーション・関連記事など）`);
  return { kind: "general", actionable: false, reasons };
}
