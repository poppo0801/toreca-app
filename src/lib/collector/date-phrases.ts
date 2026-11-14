/**
 * 日時表現の解釈（Stage 9G・純関数）。AIの読み取りを置き換えず、固定ロジックで確実に言える範囲だけ補う。
 *  1. 締切の境界表現: 11:59 と 12:00、23:59 と翌 00:00 のような、意味が同じ表記の差を「矛盾」にしない。安全側（早い方）を採用できるようにする。
 *  2. 日付だけ／時刻つき: 同じ日の「11/6」と「11/6 22:00」は矛盾ではなく、情報の詳しさの違い。
 *  3. 当選発表の表現: 「販売開始日までにメール」（終わりだけ）・「11月16日～11月21日」（期間）・「11月26日を目途」（予定日）。
 * 応募期間・当選発表期間・購入期間・受取期間は混同しない（当選発表の語の近くの日付だけを見る）。
 */

export interface DateTime {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM（無ければ空） */
  time?: string | null;
}

const toMs = (d: string, t?: string | null): number => Date.parse(`${d}T${t && /^\d{2}:\d{2}$/.test(t) ? t : "00:00"}:00Z`);

/** 境界表現とみなす差（分）。11:59→12:00、23:59→翌00:00 など */
export const BOUNDARY_MINUTES = 2;

export interface DeadlineRelation {
  /** 意味として同じ（表記差・境界表現・詳しさの違い）で、矛盾として扱わない */
  same: boolean;
  /** same のときの理由 */
  reason?: "identical" | "boundary" | "refinement";
  /** same のときに採用する値（安全側＝早い方。詳しさの違いは時刻つきの方） */
  adopt?: DateTime;
}

/** 2つの日時が、意味として同じ締切・日時か。時刻が両方あるときだけ境界表現を見る。同じ日の日付のみと時刻つきは詳しさの違い */
export function relateDateTimes(a: DateTime, b: DateTime): DeadlineRelation {
  const ta = a.time || "";
  const tb = b.time || "";
  if (a.date === b.date && ta === tb) return { same: true, reason: "identical", adopt: { date: a.date, time: ta || null } };
  if (a.date === b.date && (!ta || !tb)) return { same: true, reason: "refinement", adopt: { date: a.date, time: ta || tb || null } };
  if (ta && tb) {
    const diff = Math.abs(toMs(a.date, ta) - toMs(b.date, tb)) / 60_000;
    if (diff <= BOUNDARY_MINUTES) {
      const earlier = toMs(a.date, ta) <= toMs(b.date, tb) ? a : b;
      return { same: true, reason: "boundary", adopt: { date: earlier.date, time: earlier.time ?? null } };
    }
  }
  return { same: false };
}

// ---------------------------------------------------------------- 当選発表の表現
export interface ResultPhrase {
  /** range=期間 / end_only=終わりだけ（「○日までにメール」）/ approx=目途・予定の日 */
  kind: "range" | "end_only" | "approx";
  /** 開始日（end_only・approx では空） */
  start: string;
  /** 終了日（range・end_only）／予定日（approx） */
  end: string;
  /** 確定した日ではなく目途・予定 */
  approximate: boolean;
  /** 根拠の原文（短い抜粋） */
  quote: string;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
/** 月日 → YYYY-MM-DD。年が書かれていないので、基準日から見て自然な年（基準日の6か月以上前なら翌年）を使う */
function resolve(refDate: string, m: number, d: number): string | null {
  const ry = Number(refDate.slice(0, 4));
  const rm = Number(refDate.slice(5, 7));
  const y = m < rm - 6 ? ry + 1 : ry;
  return valid(y, m, d) ? `${y}-${p2(m)}-${p2(d)}` : null;
}

const DAY = String.raw`(\d{1,2})月\s*(\d{1,2})日`;
const WD = String.raw`(?:\([月火水木金土日祝]\))?`;
const DASH = String.raw`\s*[〜~～\-－−―ー]\s*`;
const CONTEXT = String.raw`(?:当選|当落|抽選結果|結果|発表)`;

/**
 * 当選発表の日付の表現を読み取る。当選発表の語の近くにあるものだけを見る（応募期間・購入期間と混同しない）。
 * 読み取れなければ null。確定できる範囲だけ返し、推測で埋めない。
 * @param opts.saleStart 「販売開始日までに」の販売開始日（分かっているときだけ。無ければ end_only は作れない）
 */
export function parseResultPhrase(text: string, refDate: string, opts: { saleStart?: string } = {}): ResultPhrase | null {
  const t = (text ?? "").normalize("NFKC");
  // 1) 期間: 「当選発表は11月16日(月)～11月21日(土)」「…11/16～21」
  const range = new RegExp(`${CONTEXT}[^。\\n]{0,24}?${DAY}${WD}${DASH}(?:${String.raw`(\d{1,2})月\s*`})?(\\d{1,2})日?${WD}`).exec(t);
  if (range) {
    const sm = Number(range[1]);
    const sd = Number(range[2]);
    const em = range[3] ? Number(range[3]) : sm;
    const ed = Number(range[4]);
    const s = resolve(refDate, sm, sd);
    const e = resolve(refDate, em, ed);
    if (s && e && e > s) return { kind: "range", start: s, end: e, approximate: false, quote: range[0].slice(0, 80) };
  }
  // 2) 終わりだけ: 「販売開始日までにメール」「11月20日までにご連絡」
  const sale = new RegExp(String.raw`販売開始(?:日)?(?:まで|よりも?前)に[^。\n]{0,12}(?:メール|連絡|通知|発表)`).exec(t);
  if (sale && opts.saleStart) return { kind: "end_only", start: "", end: opts.saleStart, approximate: false, quote: sale[0].slice(0, 80) };
  const until = new RegExp(`${DAY}${WD}までに[^。\\n]{0,12}(?:メール|連絡|通知|発表)`).exec(t);
  if (until && /当選|当落|結果|抽選/.test(t.slice(Math.max(0, until.index - 30), until.index + until[0].length))) {
    const e = resolve(refDate, Number(until[1]), Number(until[2]));
    if (e) return { kind: "end_only", start: "", end: e, approximate: false, quote: until[0].slice(0, 80) };
  }
  // 3) 目途・予定: 「当選発表は11月26日を目途」
  const approx = new RegExp(`${CONTEXT}[^。\\n]{0,24}?${DAY}${WD}[^。\\n]{0,4}(?:を目途|を目処|頃|ごろ|予定)`).exec(t);
  if (approx) {
    const e = resolve(refDate, Number(approx[1]), Number(approx[2]));
    if (e) return { kind: "approx", start: "", end: e, approximate: true, quote: approx[0].slice(0, 80) };
  }
  return null;
}
