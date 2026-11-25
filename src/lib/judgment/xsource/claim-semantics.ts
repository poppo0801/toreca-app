/**
 * 主張と引用の「意味の対応」の機械検証（純関数・AIを呼ばない・サイトや案件に依存しない）。
 *
 * 引用の検証には3つの段階がある（混同しない）:
 *   1. 実在: 引用が原文に一続きで存在する（research-loop の norm 照合）
 *   2. 出典・対象・時点: 引用が、その項目の対象（店舗・商品・応募の締切）についての記載で、評価時点と整合する
 *   3. 値との意味の対応: 引用の述べている内容が、AIの主張（値・除外理由）を実際に支える
 * このモジュールは 2・3 の「機械的に判別できる範囲」だけを担う。語彙は日本語の時制・役割を表す一般的な語で、特定の店舗・サイト・既知の案件を前提にしない。
 * 判別できないもの（未知の理由・役割が読み取れない引用）は「支持されていない／確認できない」として呼び出し側が保留にする。**検証済みと称さない**。
 */

export type ClaimClass = "closed" | "sold_out" | "ineligible" | "unknown";

const nf = (s: string): string => s.normalize("NFKC");

/** 除外理由（AIの自由文）の種類。語彙に当てはまらないものは unknown（機械的に支持できない → 保留） */
export function claimClassOf(value: string): ClaimClass {
  const v = nf(value);
  if (/完売|売り?切れ|売切|在庫(なし|無し|切れ)|品切れ|販売終了|終売/.test(v)) return "sold_out";
  if (/受付終了|応募終了|募集終了|締め?切|〆切|期限切れ|期間外|終了/.test(v)) return "closed";
  if (/対象外|非対象|限定|不可|不要|資格|条件を満たさ|対象でない|違う/.test(v)) return "ineligible";
  return "unknown";
}

// 応募・受付の締切の役割を示す語 / 別の事象（当選発表・発送・販売・来店など）の役割を示す語
const DEADLINE_ROLE = /(締め?切|〆切|〆|期限|応募期間|受付期間|応募受付|エントリー期間|抽選期間|申込期間|応募終了|受付終了|まで|迄)/;
const OTHER_ROLE = /(当選発表|当選者|結果発表|発表日|発表|発送|お届け|配送|引換|引き換え|受取|受け取り|お渡し|購入期間|販売期間|販売開始|発売|開催|来店|店頭|営業時間|受付時間|開店|開場|入金|支払)/;
const OTHER_ROLE_G = new RegExp(OTHER_ROLE.source, "g");
/** 別の事象の語の直前で行を分ける（語の途中では分けない: 「当選発表」を「当選」と「発表」に割らない） */
function splitAtOtherRole(line: string): string[] {
  const cuts = [...line.matchAll(OTHER_ROLE_G)].map((m) => m.index ?? 0).filter((i) => i > 0);
  const out: string[] = [];
  let from = 0;
  for (const c of cuts) { out.push(line.slice(from, c)); from = c; }
  out.push(line.slice(from));
  return out;
}

export interface QuotePiece {
  role: "deadline" | "other_event" | "neutral";
  text: string;
}

/** 引用を、事象ごとの断片に分け、それぞれの役割（締切／別の事象／不明）を付ける */
export function quotePieces(quote: string): QuotePiece[] {
  const out: QuotePiece[] = [];
  for (const line of nf(quote).split(/[\n。]/)) {
    for (const raw of splitAtOtherRole(line)) {
      const text = raw.trim();
      if (!text) continue;
      const lead = text.match(OTHER_ROLE);
      const startsOther = !!lead && text.indexOf(lead[0]) <= 1;
      if (startsOther) {
        // 別の事象で始まる断片でも、後ろに締切の語（例: 「応募受付終了：…」）が続くなら、その締切の語から先は締切
        const j = text.slice(lead![0].length).search(/(応募|受付|エントリー)(期間|期限|終了|締切)|締め?切/);
        out.push(j >= 0 ? { role: "deadline", text: text.slice(lead![0].length + j) } : { role: "other_event", text });
      } else out.push({ role: DEADLINE_ROLE.test(text) ? "deadline" : "neutral", text });
    }
  }
  return out;
}

interface Ymd { y: number | null; m: number; d: number; end: boolean }
/** 文字列中の日付（年が書かれていればその年）。範囲は全て返す */
function datesIn(text: string): Ymd[] {
  const out: Ymd[] = [];
  let lastYear: number | null = null; // 範囲表記（2026年11月20日～11月22日）では、年は始点にしか書かれない。直前の日付の年を引き継ぐ
  for (const m of nf(text).matchAll(/(?:(20\d{2})\s*[/.\-年]\s*)?(?<!\d)(\d{1,2})\s*[/月.\-]\s*(\d{1,2})(?!\d)\s*日?/g)) {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const prev = out[out.length - 1];
    // 年を引き継ぐとき、終点の月が始点より小さければ翌年（12月～1月）
    const y: number | null = m[1] ? Number(m[1]) : lastYear !== null ? (prev && mo < prev.m ? lastYear + 1 : lastYear) : null;
    out.push({ y, m: mo, d, end: false });
    if (y !== null) lastYear = y;
  }
  return out;
}

/** 日本時間の今日（年・月・日・分） */
function jstNow(now: Date): { y: number; m: number; d: number; minutes: number } {
  const j = new Date(now.getTime() + 9 * 3600_000);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), minutes: j.getUTCHours() * 60 + j.getUTCMinutes() };
}
const dayNo = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

/** 年の書かれていない日付は、今日に最も近い年とみなす（推定であり、確定しない）。戻り値は通算日 */
function resolveDay(x: Ymd, today: { y: number; m: number; d: number }): { day: number; yearInferred: boolean } {
  if (x.y) return { day: dayNo(x.y, x.m, x.d), yearInferred: false };
  const t = dayNo(today.y, today.m, today.d);
  let best = dayNo(today.y, x.m, x.d);
  for (const dy of [-1, 1]) {
    const c = dayNo(today.y + dy, x.m, x.d);
    if (Math.abs(c - t) < Math.abs(best - t)) best = c;
  }
  return { day: best, yearInferred: true };
}

/** 断片の中の最も遅い日付（範囲の終端）。日付が無ければ null */
function latestDay(text: string, today: { y: number; m: number; d: number }): { day: number; yearInferred: boolean } | null {
  let best: { day: number; yearInferred: boolean } | null = null;
  for (const x of datesIn(text)) {
    const r = resolveDay(x, today);
    if (!best || r.day > best.day) best = r;
  }
  return best;
}

export type SemanticCode = "unsupported" | "contradicted" | "unverifiable";
export interface SemanticVerdict {
  ok: boolean;
  code?: SemanticCode;
  /** AIへ返す訂正用の説明（原文は含めない） */
  reason: string;
  /** 通ったが、機械的には完全に確認できていない点（検証済みと称さない） */
  unconfirmed?: string[];
}

// 「受付は終了しました」のような、現在すでに終了していることの記述（締切日時のラベル「応募受付終了：11/22」は含めない）
const STATUS_CLOSED = /((受付|応募|販売|抽選|募集|エントリー|申込|予約)[^。\n]{0,10}(は|を)?(すでに|既に|既)?(終了|締め切)(いた)?(し)?(まし)?(た|ました)|終了いたしました|終了しました|受付を?終了|締め切りました|締切済|受付期間外)/;
const LABEL_END = /(受付|応募|エントリー)?(終了|締切|〆切)(日時|日|期限)?\s*[:：]\s*\d/;

/** 締切の日付を含む断片だけから、「応募が終わっている」ことの支持を判定する。今日 = now（評価時点） */
function closedSupport(quote: string, now: Date | undefined): SemanticVerdict & { future?: boolean } {
  const t = nf(quote);
  const hasStatus = STATUS_CLOSED.test(t.replace(new RegExp(LABEL_END.source, "g"), ""));
  if (hasStatus) return { ok: true, reason: "引用が、受付がすでに終了していると述べている" };
  const pieces = quotePieces(quote);
  const dl = pieces.filter((p) => p.role === "deadline" && datesIn(p.text).length > 0);
  if (dl.length === 0) {
    const onlyOther = pieces.length > 0 && pieces.every((p) => p.role === "other_event");
    return { ok: false, code: "unsupported", reason: onlyOther ? "引用は、応募・受付の締切ではなく別の事象（当選発表・発送・販売・来店など）の記載で、応募が終了した根拠にならない" : "引用に、応募・受付が終了している記述も、応募の締切の日付も無い（受付終了の根拠にならない）" };
  }
  if (!now) return { ok: false, code: "unverifiable", reason: "評価時点（今日）が分からないため、締切を過ぎたかを判定できない" };
  const today = jstNow(now);
  const todayNo = dayNo(today.y, today.m, today.d);
  let latest: { day: number; yearInferred: boolean } | null = null;
  for (const p of dl) {
    const r = latestDay(p.text, today);
    if (r && (!latest || r.day > latest.day)) latest = r;
  }
  if (!latest) return { ok: false, code: "unsupported", reason: "引用から締切の日付を読み取れない" };
  if (latest.day < todayNo) return { ok: true, reason: "締切日が評価時点より前", ...(latest.yearInferred ? { unconfirmed: ["締切の年が書かれておらず、今日に最も近い年と推定した"] } : {}) };
  return { ok: false, code: "contradicted", future: true, reason: latest.day === todayNo ? "引用の締切日は評価時点と同じ日で、時刻まで確認できない（まだ受付中の可能性）" : "引用の締切日は評価時点よりも先で、まだ受付期間内（終了とは言えない）" };
}

/**
 * 除外理由の意味検証。claim は AIの exclude_reason の値、quote はその引用。otherDeadlines は同じ出力の別の締切の主張（値）。
 * - closed: 引用が「すでに終了」と述べるか、応募締切の日付が評価時点より前であること。当選発表など別の事象の日時では支持しない。別に未来の締切があれば矛盾（保留）
 * - sold_out / ineligible: 引用にその状態を表す語があること
 * - unknown（語彙に無い理由）: 機械的に支持できない
 */
export function checkExcludeSemantics(a: { claim: string; quote: string; now?: Date; otherDeadlines?: readonly string[] }): SemanticVerdict {
  const cls = claimClassOf(a.claim);
  const q = nf(a.quote);
  if (cls === "unknown") return { ok: false, code: "unverifiable", reason: "除外理由の種類を機械的に判別できず、引用が支持するか確認できない（人が確認するまで保留）" };
  if (cls === "sold_out") return /完売|売り?切れ|売切|在庫(なし|無し|切れ)|品切れ|販売終了|終売|終了/.test(q) ? { ok: true, reason: "引用に売り切れ・終了を表す語がある" } : { ok: false, code: "unsupported", reason: "引用に、売り切れ・終了を表す記述が無い" };
  if (cls === "ineligible") return /対象外|非対象|限定|不可|できません|お受けできません|対象となりません|ご利用いただけません|対象でない|対象外となり/.test(q) ? { ok: true, reason: "引用に対象外・制限を表す語がある" } : { ok: false, code: "unsupported", reason: "引用に、対象外・応募不可を表す記述が無い" };
  const s = closedSupport(a.quote, a.now);
  if (!s.ok) return s;
  // 別の項目に、評価時点より先の締切があれば矛盾（応募の機会を消さない）
  if (a.now) {
    const today = jstNow(a.now);
    const todayNo = dayNo(today.y, today.m, today.d);
    for (const d of a.otherDeadlines ?? []) {
      const l = latestDay(d, today);
      if (l && l.day >= todayNo) return { ok: false, code: "contradicted", reason: "同じ出力の別の締切は評価時点より先で、受付終了と矛盾する" };
    }
  }
  return { ok: true, reason: s.reason, ...(s.unconfirmed ? { unconfirmed: s.unconfirmed } : {}) };
}

/**
 * 締切の値と引用の役割の対応。値の日付が、当選発表・発送などの別の事象の日付ではなく、応募・受付の締切の記載にあること。
 * 役割を示す語が無い断片は、役割を確認できない（unconfirmed。通すが検証済みと称さない）。
 */
export function checkDeadlineRole(value: string, quote: string): SemanticVerdict {
  const want = datesIn(value);
  if (want.length === 0) return { ok: true, reason: "値に日付が無い" };
  const key = (x: Ymd): string => `${x.m}/${x.d}`;
  const wantKeys = new Set(want.map(key));
  const holders = quotePieces(quote).filter((p) => datesIn(p.text).some((x) => wantKeys.has(key(x))));
  if (holders.length === 0) return { ok: true, reason: "（日付の存在は別の検査で確認する）" };
  if (holders.some((p) => p.role === "deadline")) return { ok: true, reason: "値の日付が、応募・受付の締切の記載にある" };
  if (holders.every((p) => p.role === "other_event")) return { ok: false, code: "unsupported", reason: "値の日付が、応募の締切ではなく別の事象（当選発表・発送・販売・来店など）の記載にある" };
  return { ok: true, reason: "値の日付の役割（締切か）を引用から確認できない", unconfirmed: ["締切の日付の役割を、引用の語から確認できていない"] };
}

/** 店舗・商品など、値が引用に語として対応しているか（2文字の連なりの被覆。表記の揺れは許し、無関係な引用を弾く）。短い値は判定しない */
export function checkValueCorrespondence(value: string, quote: string): SemanticVerdict {
  const norm = (s: string): string => nf(s).replace(/[\s　【】「」『』()（）・、,。.\-_]/g, "").toLowerCase();
  const v = norm(value);
  const q = norm(quote);
  if (v.length < 3) return { ok: true, reason: "短い値は判定しない" };
  if (q.includes(v)) return { ok: true, reason: "値が引用に含まれる" };
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= v.length; i++) grams.add(v.slice(i, i + 2));
  const hit = [...grams].filter((g) => q.includes(g)).length;
  return grams.size > 0 && hit / grams.size >= 0.5 ? { ok: true, reason: "値の大半が引用に対応する" } : { ok: false, code: "unsupported", reason: "値が引用に対応していない（引用は別の事柄の記載）" };
}

/** 応募単位の値の引用に、応募の回数・範囲を述べる語があるか（対象者・範囲・回数の語）。無ければ、単位の根拠として確認できない */
export function checkUnitQuote(quote: string): SemanticVerdict {
  return /(\d+\s*(人|名|回|口|点|アカウント|店舗|店|フォーム|件|枚)|一人|1人|お一人|ひとり|各店|店舗ごと|店舗別|店舗を選|店舗選択|フォーム|ごとに|につき|あたり|アカウント|会員|重複|複数|のみ)/.test(nf(quote)) ? { ok: true, reason: "引用に応募の回数・範囲を示す語がある" } : { ok: false, code: "unsupported", reason: "引用に、応募の回数・対象・範囲を述べる記述が無い（応募単位の根拠にならない）" };
}
