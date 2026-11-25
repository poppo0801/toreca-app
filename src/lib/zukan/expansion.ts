/**
 * 収録パックマスター（エキスパンションマーク → 収録商品名）の利用側の純関数。
 * マスターは公式サイトのカード検索から取得した参照データ（DB: expansion_marks）。同じマークが複数商品に対応し得るので、**一意に決まるときだけ自動補完**し、複数なら利用者に選ばせる。
 * 既に入力済みの収録セットと矛盾するときは上書きしない（注意の表示のみ）。マスターに無い番号は自由入力（推測で補完しない）。
 * 画面上の呼称は「番号」（開発中の呼称は使わない）。
 */
export interface ExpansionMark {
  mark: string;
  productName: string;
  /** 入力欄に入れる短い収録セット名（例: 超電ブレイカー） */
  setName: string;
  series: string;
  kind: "expansion" | "enhanced" | "high_class" | "other";
  /** 商品IDの数値（新しい商品ほど大きい）。並び順に使う */
  productId?: string;
  active: boolean;
}

const norm = (v: string): string => v.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** 番号の文字列からエキスパンションマークを取り出す（"SV8"・"SV8 100/106"・"sv2a"）。マークらしくなければ null（"100/106" など） */
export function markOfNumber(v: string): string | null {
  const m = v.normalize("NFKC").trim().match(/^([A-Za-z]{1,3}\d{1,2}[A-Za-z]{0,2})(?=$|[\s/・,、-])/);
  return m ? m[1] : null;
}

const sameMark = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** マークに対応する収録セットの候補（有効なものだけ。同じ収録セット名は1つにまとめる） */
export function setsForMark(masters: readonly ExpansionMark[], mark: string): ExpansionMark[] {
  const seen = new Set<string>();
  return masters.filter((m) => m.active && sameMark(m.mark, mark)).filter((m) => (seen.has(norm(m.setName)) ? false : (seen.add(norm(m.setName)), true)));
}

export type SetResolution =
  | { status: "none" }
  /** 一意に決まった（収録セットが空のとき自動入力してよい） */
  | { status: "unique"; setName: string }
  /** 複数の候補（利用者に選ばせる） */
  | { status: "multiple"; choices: string[] }
  /** すでに入力されている収録セットがマスターと食い違う（上書きしない） */
  | { status: "conflict"; choices: string[] }
  /** 入力済みの収録セットがマスターと一致 */
  | { status: "match"; setName: string };

/**
 * 番号から収録セットを解決する。currentSet が空なら unique／multiple、入力済みなら一致（match）か食い違い（conflict）。マスターに無い番号・マークでない番号は none。
 */
export function resolveSet(masters: readonly ExpansionMark[], cardNumber: string, currentSet: string): SetResolution {
  const mark = markOfNumber(cardNumber);
  if (!mark) return { status: "none" };
  const cands = setsForMark(masters, mark);
  if (cands.length === 0) return { status: "none" };
  const names = cands.map((c) => c.setName);
  const cur = norm(currentSet);
  if (cur) return names.some((n) => norm(n) === cur || cur.includes(norm(n)) || norm(n).includes(cur)) ? { status: "match", setName: currentSet } : { status: "conflict", choices: names };
  return names.length === 1 ? { status: "unique", setName: names[0] } : { status: "multiple", choices: names };
}

/** 番号の候補（番号単独） */
export interface NumberChoice {
  value: string;
  /** 補足（対応する収録セット。複数あれば「N件の収録セット」） */
  hint: string;
  source: "known" | "master";
}

/** 番号の候補。これまで入力された番号（最近使った順）→マスターのマーク（新しい商品から）。入力の先頭で絞り込み（全角・半角・大小・空白の揺れを吸収） */
export function numberChoices(masters: readonly ExpansionMark[], known: readonly { cardNumber: string; setName: string; usedAt?: string }[], query: string, limit = 10): NumberChoice[] {
  const q = norm(query);
  const out = new Map<string, NumberChoice & { usedAt: string }>();
  for (const k of known) {
    const v = k.cardNumber.trim();
    if (!v || (q && !norm(v).startsWith(q))) continue;
    const key = norm(v);
    const cur = out.get(key);
    const usedAt = k.usedAt ?? "";
    const mk = markOfNumber(v);
    const sets = mk ? setsForMark(masters, mk).map((s) => s.setName) : [];
    const hint = sets.length === 1 ? sets[0] : sets.length > 1 ? `${sets.length}件の収録セット` : k.setName.trim();
    if (!cur) out.set(key, { value: v, hint, source: "known", usedAt });
    else if (usedAt > cur.usedAt) out.set(key, { ...cur, usedAt });
  }
  const recent = [...out.values()].sort((a, b) => b.usedAt.localeCompare(a.usedAt) || a.value.localeCompare(b.value, "ja", { numeric: true }));
  const marks = new Map<string, ExpansionMark[]>();
  for (const m of masters) if (m.active && (!q || norm(m.mark).startsWith(q))) marks.set(m.mark, [...(marks.get(m.mark) ?? []), m]);
  const fromMaster: NumberChoice[] = [...marks.entries()]
    .filter(([mark]) => !out.has(norm(mark)))
    .sort((a, b) => Math.max(...b[1].map((m) => Number(m.productId) || 0)) - Math.max(...a[1].map((m) => Number(m.productId) || 0)))
    .map(([mark]) => {
      const sets = setsForMark(masters, mark);
      return { value: mark, hint: sets.length === 1 ? sets[0].setName : `${sets.length}件の収録セット`, source: "master" as const };
    });
  return [...recent.map((c) => ({ value: c.value, hint: c.hint, source: c.source })), ...fromMaster].slice(0, limit);
}

/** マークでない番号（100/106 など）を持つ既知のカードの収録セット（重複なし）。2種類以上あるときは利用者に選ばせる */
export function setsForKnownNumber(known: readonly { cardNumber: string; setName: string }[], cardNumber: string): string[] {
  const n = norm(cardNumber);
  if (!n) return [];
  return [...new Set(known.filter((k) => norm(k.cardNumber) === n && k.setName.trim()).map((k) => k.setName.trim()))];
}
