/**
 * 日時の意味と正規化（Stage 10P・純関数）。
 *  - 意味（役割）を区別する: 受付開始／締切／当選発表／購入・販売期間／受取期間／予約／注文対象期間。**注文対象期間（「ご注文分」）や販売期間を応募期間として扱わない**。
 *  - 原文・文脈・タイムゾーン（JST）・年の推定根拠・精度（日付のみ／時刻あり／月日のみ）を保持する。**根拠のない年・時刻の補完はしない**。
 *  - 年が無い表記: 曜日が書かれていれば、曜日が一致する年だけを採用（yearBasis=inferred_weekday_confirmed）。曜日も無ければ、基準日（投稿・取得の日）に最も近い年を「推定」とし（inferred_reference）、通知には使わない。曜日が合わなければ年を決めない（ambiguous）。
 *  - 24:00 は翌日 0:00 へ繰り上げ（rollover を記録）。0:00 の締切は境界の曖昧さを注記。開始が締切より後なら reversed。
 *  - 通知に使えるのは、**役割が締切で、年が明示または曜日で確認でき、原文の根拠が確認済み**の値だけ（isNotifiableDeadline）。
 */
export type DateRole = "apply_start" | "apply_deadline" | "result_announce" | "purchase_window" | "pickup_window" | "order_period" | "reservation" | "unknown";
export type YearBasis = "explicit" | "inferred_weekday_confirmed" | "inferred_reference" | "ambiguous" | "none";
export type Precision = "datetime" | "date" | "month_day" | "unparsed";

export interface NormalizedDateTime {
  role: DateRole;
  raw: string;
  /** 役割の判断に使った文脈（原文の近傍。保存・表示は短く） */
  context: string;
  tz: "Asia/Tokyo";
  /** YYYY-MM-DD（年が決まっているときだけ） */
  date: string | null;
  /** HH:mm（時刻が書かれているときだけ） */
  time: string | null;
  month: number | null;
  day: number | null;
  precision: Precision;
  yearBasis: YearBasis;
  weekdayMismatch: boolean;
  rollover: boolean;
  notes: string[];
}

const z = (s: string): string => s.normalize("NFKC");
const WD = "日月火水木金土";
const pad = (n: number): string => String(n).padStart(2, "0");
const dow = (y: number, m: number, d: number): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const valid = (y: number, m: number, d: number): boolean => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** 文脈から日時の役割を決める（優先: 当選発表 ＞ 受取 ＞ 注文対象・購入・販売 ＞ 予約 ＞ 応募の開始/締切）。決められなければ unknown */
export function classifyDateContext(context: string, hint?: "start" | "end" | null): DateRole {
  const c = z(context);
  if (/当選(結果)?(発表|通知)|抽選(結果)?(発表|日)|結果発表|当落/.test(c)) return "result_announce";
  if (/お?受け?取り|引き取り|引渡|店頭受取|お渡し/.test(c)) return "pickup_window";
  if (/ご?注文(分|期間|対象)|ご購入分|購入期間|販売期間|発売日|販売開始|販売日/.test(c)) return /ご?注文(分|対象)/.test(c) ? "order_period" : "purchase_window";
  if (/予約(期間|受付|開始)?/.test(c) && !/応募|抽選|エントリー/.test(c)) return "reservation";
  if (/応募|受付|エントリー|申込|申し込み|抽選/.test(c)) return hint === "start" ? "apply_start" : hint === "end" ? "apply_deadline" : /締切|〆|まで|終了|期限/.test(c) ? "apply_deadline" : /開始|から|より/.test(c) ? "apply_start" : "unknown";
  return "unknown";
}

interface Raw {
  y: number | null;
  m: number;
  d: number;
  wd: number | null;
  hh: number | null;
  mm: number | null;
}
function readRaw(raw: string): Raw | null {
  const s = z(raw);
  const time = /(\d{1,2})[:：](\d{2})|(\d{1,2})時(?:(\d{1,2})分)?/.exec(s);
  const hh = time ? (time[1] != null ? +time[1] : +time[3]) : null;
  const mm = time ? (time[2] != null ? +time[2] : time[4] != null ? +time[4] : 0) : null;
  const wdM = /[（(]([日月火水木金土])[曜]?[)）]/.exec(s) ?? /([日月火水木金土])曜/.exec(s);
  const wd = wdM ? WD.indexOf(wdM[1]) : null;
  let m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/.exec(s);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], wd, hh, mm };
  m = /(\d{1,2})[/月](\d{1,2})日?/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return { y: null, m: +m[1], d: +m[2], wd, hh, mm };
  return null;
}

export function normalizeDateTime(raw: string, opt: { role?: DateRole; context?: string; reference: Date }): NormalizedDateTime {
  const context = (opt.context ?? raw).slice(0, 120);
  const role = opt.role ?? classifyDateContext(context);
  const base: NormalizedDateTime = { role, raw: raw.slice(0, 80), context, tz: "Asia/Tokyo", date: null, time: null, month: null, day: null, precision: "unparsed", yearBasis: "none", weekdayMismatch: false, rollover: false, notes: [] };
  const r = readRaw(raw);
  if (!r) return base;
  base.month = r.m;
  base.day = r.d;
  let hh = r.hh;
  let mm = r.mm;
  let dayShift = 0;
  if (hh != null && mm != null) {
    if (hh === 24 && mm === 0) {
      hh = 0;
      dayShift = 1;
      base.rollover = true;
      base.notes.push("24:00_rolled_to_next_day");
    }
    if (hh > 23 || mm > 59) {
      base.notes.push("invalid_time");
      hh = null;
      mm = null;
    }
  }
  const ref = opt.reference;
  const refY = ref.getUTCFullYear();
  let year: number | null = r.y;
  let basis: YearBasis = "none";
  if (r.y != null) {
    basis = "explicit";
    if (!valid(r.y, r.m, r.d)) {
      base.notes.push("invalid_date");
      return base;
    }
    if (r.wd != null && dow(r.y, r.m, r.d) !== r.wd) {
      base.weekdayMismatch = true;
      base.notes.push("weekday_mismatch");
    }
  } else {
    const cands = [refY - 1, refY, refY + 1].filter((y) => valid(y, r.m, r.d));
    const within = (y: number): boolean => {
      const t = Date.UTC(y, r.m - 1, r.d);
      return t >= ref.getTime() - 120 * 86_400_000 && t <= ref.getTime() + 300 * 86_400_000;
    };
    if (r.wd != null) {
      const ok = cands.filter((y) => dow(y, r.m, r.d) === r.wd && within(y));
      if (ok.length === 1) {
        year = ok[0];
        basis = "inferred_weekday_confirmed";
      } else {
        basis = "ambiguous";
        base.weekdayMismatch = ok.length === 0;
        base.notes.push(ok.length === 0 ? "weekday_matches_no_year" : "weekday_matches_multiple_years");
      }
    } else {
      const near = cands.filter(within).sort((a, b) => Math.abs(Date.UTC(a, r.m - 1, r.d) - ref.getTime()) - Math.abs(Date.UTC(b, r.m - 1, r.d) - ref.getTime()));
      if (near.length) {
        year = near[0];
        basis = "inferred_reference";
        base.notes.push("year_inferred_from_reference_date");
      } else basis = "ambiguous";
    }
  }
  base.yearBasis = basis;
  if (year == null) {
    base.precision = "month_day";
    base.time = hh != null && mm != null ? `${pad(hh)}:${pad(mm)}` : null;
    return base;
  }
  let t = new Date(Date.UTC(year, r.m - 1, r.d + dayShift));
  base.date = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  if (hh != null && mm != null) {
    base.time = `${pad(hh)}:${pad(mm)}`;
    base.precision = "datetime";
    if (hh === 0 && mm === 0 && !base.rollover) base.notes.push("midnight_boundary_ambiguous");
  } else base.precision = "date";
  t = new Date(0);
  return base;
}

/** 範囲の表記（「11月13日(金)～11月15日(日)」「11/5～11/7」「11月5日～7日」）を開始・終了の原文に分ける。月・年は前の側から引き継ぐ */
export function splitRange(text: string): { start: string; end: string } | null {
  const s = z(text);
  const m = /^(.*?)\s*[〜～~\-－–—]\s*(.+)$/.exec(s.replace(/から/g, "〜"));
  if (!m) return null;
  const a = m[1].trim();
  let b = m[2].trim();
  if (!/\d/.test(a) || !/\d/.test(b)) return null;
  const am = /(\d{4}[年/-])?(\d{1,2})[月/](\d{1,2})/.exec(a);
  if (am && !/[月/]/.test(b.split(/[日(（\s]/)[0] ?? "") && /^\d{1,2}日?/.test(b)) b = `${am[1] ?? ""}${am[2]}月${b}`;
  else if (am?.[1] && !/\d{4}/.test(b)) b = `${am[1].replace(/[年/-]$/, "年")}${b}`;
  return { start: a, end: b };
}

export function validatePeriod(start: NormalizedDateTime | null, end: NormalizedDateTime | null): "ok" | "reversed" | "unknown" {
  if (!start?.date || !end?.date) return "unknown";
  const a = `${start.date} ${start.time ?? "00:00"}`;
  const b = `${end.date} ${end.time ?? "23:59"}`;
  return b < a ? "reversed" : "ok";
}

/** 既存の登録の形式（JSTの "YYYY-MM-DD HH:mm"、日付のみなら "YYYY-MM-DD"）へ。年が決まらない・曖昧なものは null（根拠のない補完をしない） */
export function toRegistrationFormat(n: NormalizedDateTime): string | null {
  if (!n.date || n.weekdayMismatch || n.yearBasis === "ambiguous" || n.yearBasis === "none") return null;
  return n.time ? `${n.date} ${n.time}` : n.date;
}

/** 通知に使える締切か: 役割が締切、年が明示または曜日で確認、曜日の不一致なし、原文の根拠が確認済み、時刻まで分かる */
export function isNotifiableDeadline(n: NormalizedDateTime, quoteVerified: boolean): boolean {
  return n.role === "apply_deadline" && quoteVerified && n.precision === "datetime" && (n.yearBasis === "explicit" || n.yearBasis === "inferred_weekday_confirmed") && !n.weekdayMismatch;
}

/** 締切が基準日時より前か（JST）。年が決まらない値は判定しない（false） */
export function deadlineIsPast(n: NormalizedDateTime, now: Date): boolean {
  if (!n.date) return false;
  const [y, m, d] = n.date.split("-").map(Number);
  const [hh, mi] = (n.time ?? "23:59").split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mi) - 9 * 3600_000 < now.getTime();
}
