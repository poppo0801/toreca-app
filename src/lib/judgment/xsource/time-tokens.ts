// 日時表記の読み取り（純関数。画面・採点・gold検査で共有）
/** 文字列中の時刻（「23:59」「23時59分」「23時」）を HH:MM の集合にする */
export function timeTokens(text: string): string[] {
  const t = text.normalize("NFKC");
  const out = new Set<string>();
  const add = (h: number, m: number) => {
    if (h >= 0 && h <= 24 && m >= 0 && m <= 59) out.add(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  };
  // 午前・午後（AM/PM）つきの表記を先に読み、読んだ部分は取り除く（「午後11時59分」を11:59と誤読しない）
  const mer = /(午前|午後|AM|PM)\s*(\d{1,2})(?::(\d{2})|時(?:\s*(\d{1,2})分)?)/gi;
  const rest = t.replace(mer, (_all, ap: string, h: string, mm?: string, mj?: string) => {
    const pm = /午後|pm/i.test(ap);
    const hh = Number(h) % 12 + (pm ? 12 : 0);
    add(hh, Number(mm ?? mj ?? 0));
    return " ";
  });
  for (const m of rest.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g)) add(Number(m[1]), Number(m[2]));
  for (const m of rest.matchAll(/(?<!\d)(\d{1,2})時(?:\s*(\d{1,2})分)?/g)) add(Number(m[1]), m[2] ? Number(m[2]) : 0);
  return [...out];
}
/** 文字列中の西暦年（「2026年」「2026/」など）の集合 */
export function yearTokens(text: string): number[] {
  return [...new Set([...text.normalize("NFKC").matchAll(/(?<!\d)(20\d{2})\s*[年/.-]/g)].map((m) => Number(m[1])))];
}
