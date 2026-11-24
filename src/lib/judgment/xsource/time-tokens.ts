// 日時表記の読み取り（純関数。画面・採点・gold検査で共有）。
// 方針: 不正・曖昧な時刻は**補正せず捨てる**（invalid に記録）。「原文に時刻がある」ことと「応募締切の時刻である」ことは別で、後者は deadlineTimeTokens（文脈）と人の判断が要る。

export interface ParsedTimes {
  /** 正しい時刻（HH:MM。24:00 だけは「翌日0時」として許可） */
  valid: string[];
  /** 不正・曖昧で採用しなかった表記（24:01〜・午後13時・午前12時・25時・60分 など）。自動補正しない */
  invalid: string[];
}

const hhmm = (h: number, m: number): string => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** 24時間表記: 0〜23時、および 24:00 だけ許可（24:01〜24:59 は不正） */
function ok24(h: number, m: number): boolean {
  if (!Number.isInteger(h) || !Number.isInteger(m) || m < 0 || m > 59) return false;
  return (h >= 0 && h <= 23) || (h === 24 && m === 0);
}

export function parseTimes(text: string): ParsedTimes {
  const t = text.normalize("NFKC");
  const valid = new Set<string>();
  const invalid: string[] = [];
  // 1) 日本語の午前/午後: 1〜11時は通常、0時は 午前0時=00:00・午後0時=12:00。12時は午前/午後で意味が割れる（正午か午前0時か）ため採用せず不正扱い。13時以上も不正
  const jp = /(午前|午後)\s*(\d{1,2})\s*(?::(\d{2})|時(?:\s*(\d{1,2})\s*分?)?)/g;
  let rest = t.replace(jp, (all, ap: string, hs: string, mc?: string, mj?: string) => {
    const h = Number(hs);
    const m = Number(mc ?? mj ?? 0);
    const pm = ap === "午後";
    if (m < 0 || m > 59 || h > 11 || (h === 12)) {
      invalid.push(all.trim());
      return " ";
    }
    valid.add(hhmm(h + (pm ? 12 : 0), m));
    return " ";
  });
  // 2) 英字 AM/PM: 1〜12時のみ。12:xx AM = 0:xx、12:xx PM = 12:xx
  const en = /(?<![A-Za-z])(\d{1,2})(?::(\d{2}))?\s*(AM|PM)(?![A-Za-z])/gi;
  rest = rest.replace(en, (all, hs: string, mc: string | undefined, ap: string) => {
    const h = Number(hs);
    const m = Number(mc ?? 0);
    if (h < 1 || h > 12 || m > 59) {
      invalid.push(all.trim());
      return " ";
    }
    const pm = /pm/i.test(ap);
    valid.add(hhmm((h % 12) + (pm ? 12 : 0), m));
    return " ";
  });
  const enPrefix = /(?<![A-Za-z])(AM|PM)\s*(\d{1,2})(?::(\d{2}))?(?!\d)/gi;
  rest = rest.replace(enPrefix, (all, ap: string, hs: string, mc?: string) => {
    const h = Number(hs);
    const m = Number(mc ?? 0);
    if (h < 1 || h > 12 || m > 59) {
      invalid.push(all.trim());
      return " ";
    }
    valid.add(hhmm((h % 12) + (/pm/i.test(ap) ? 12 : 0), m));
    return " ";
  });
  // 3) 24時間表記
  for (const m of rest.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g)) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (ok24(h, mm)) valid.add(hhmm(h, mm));
    else invalid.push(m[0]);
  }
  for (const m of rest.matchAll(/(?<!\d)(\d{1,2})時(?!間)(?:\s*(\d{1,2})\s*分)?/g)) {
    const h = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    if (ok24(h, mm)) valid.add(hhmm(h, mm));
    else invalid.push(m[0]);
  }
  return { valid: [...valid], invalid };
}

/** 文字列中の正しい時刻を HH:MM の集合にする（不正・曖昧な表記は含めない） */
export function timeTokens(text: string): string[] {
  return parseTimes(text).valid;
}

/** 締切の文脈を示す語 */
const DEADLINE_WORD = /(締切|締め切り|〆切|〆|応募期限|受付期限|応募終了|受付終了|エントリー終了|期限)/;
const UNTIL_WORD = /(応募|受付|エントリー)[^。\n]{0,30}(まで|迄)/;
/** 別の日時（当選発表・引換・販売など）の語。ここから後ろは別の項目の時刻として切り離す */
const OTHER_WORD = /(?=当選発表|当選者|発表日|発表|引換|引き換え|受取|受け取り|お渡し|販売開始|購入期間|来店|店頭|営業時間|受付時間|開店|開場)/;

const OTHER_START = /^\s*(当選発表|当選者|発表日|発表|引換|引き換え|受取|受け取り|お渡し|販売開始|購入期間|来店|店頭|営業時間|受付時間|開店|開場)/;

/**
 * **応募締切の文脈にある**時刻だけを返す（「受付時間 10:00〜20:00」「当選発表 12:00」などを除く）。
 * 原文に時刻があるだけでは締切の時刻と認めない。ただしこれは文脈の目安で、最終的な判断は人が公式ページで行う。
 */
export function deadlineTimeTokens(text: string): string[] {
  const out = new Set<string>();
  const t = text.normalize("NFKC");
  for (const line of t.split(/[\n。]/)) {
    for (const raw of line.split(OTHER_WORD)) {
      let seg = raw;
      // 別の項目（当選発表など）で始まる部分は、その項目の時刻。同じ部分に締切の語が続く場合は、締切の語より後ろだけを見る
      if (OTHER_START.test(seg)) {
        const i = seg.search(DEADLINE_WORD);
        if (i < 0) continue;
        seg = seg.slice(i);
      }
      if (DEADLINE_WORD.test(seg) || UNTIL_WORD.test(seg)) for (const x of timeTokens(seg)) out.add(x);
    }
  }
  return [...out];
}

/** 文字列中の西暦年（「2026年」「2026/」など）の集合 */
export function yearTokens(text: string): number[] {
  return [...new Set([...text.normalize("NFKC").matchAll(/(?<!\d)(20\d{2})\s*[年/.-]/g)].map((m) => Number(m[1])))];
}
