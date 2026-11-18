/**
 * 情報源の同一性（Stage 8F-4）: 取得したページ・URLから、「同じイベント（企画）の識別子」と共通の文言を取り出す純粋な関数。
 * どの販売サイトにも共通する一般的な形（URLのクエリ/パスのイベントID・キャンペーンID、本文の「イベントID」等）だけを見る。特定の店舗・サイト専用の規則は持たない。
 * 判断（自動・候補・保留）は verify.ts。ここは事実の抽出だけ。
 */

/** 識別子の種類（同じ種類どうしだけ比べる） */
export type IdKind = "event" | "campaign";
export interface EventIdentifier {
  kind: IdKind;
  value: string;
  /** どこから見つけたか（記録用） */
  from: "url" | "text" | "link";
}

/** 取得した情報源（1ページ分）。実行中に作られる台帳の項目。AIの主張ではなく、取得した事実 */
export interface FetchedSource {
  lotteryId: string;
  /** 登録されていた情報源URL（取得を依頼したURL） */
  url: string;
  finalUrl: string;
  title: string;
  /** 本文（保存・比較用に切り詰め済み。個人情報を含みうるため最大 MAX_STORED_TEXT 文字） */
  text: string;
  identifiers: EventIdentifier[];
  fetchedAt: string;
  /** 本文のハッシュ（重複保存の防止・追跡用） */
  hash: string;
}

export const MAX_STORED_TEXT = 4000;

const ID_PARAM: { re: RegExp; kind: IdKind }[] = [
  { re: /^(event[_-]?id|eventid|event|e)$/i, kind: "event" },
  { re: /^(utm_campaign|campaign[_-]?id|campaignid|campaign|promotion[_-]?id|lottery[_-]?id)$/i, kind: "campaign" },
];
/** 識別子として扱える値: 数字5桁以上、または英数字（_-可）6文字以上で数字を含む。短い・一般的な値は除く */
function plausibleId(v: string): boolean {
  if (/^\d{5,}$/.test(v)) return true;
  return /^[A-Za-z0-9_-]{6,40}$/.test(v) && /\d/.test(v);
}

/** URL（クエリ・パス）から識別子を取り出す。パスは `/event/123456` `/events/123456` `/e/xxxx` のような「イベント」を示す部分の次の要素 */
export function identifiersFromUrl(u: string, from: EventIdentifier["from"] = "url"): EventIdentifier[] {
  const out: EventIdentifier[] = [];
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return out;
  }
  for (const [k, v] of url.searchParams) {
    const hit = ID_PARAM.find((p) => p.re.test(k));
    if (hit && plausibleId(v)) out.push({ kind: hit.kind, value: v, from });
  }
  const segs = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segs.length - 1; i++) {
    if (/^(events?|e)$/i.test(segs[i]) && plausibleId(segs[i + 1]) && /^\d{5,}$/.test(segs[i + 1])) out.push({ kind: "event", value: segs[i + 1], from });
  }
  return out;
}

const TEXT_ID = /(?:event[_\s-]?id|イベント\s*ID|イベントＩＤ|キャンペーン\s*ID|campaign[_\s-]?id)\s*[=:：]?\s*([A-Za-z0-9_-]{5,40})/gi;
/** 本文から識別子を取り出す（「event_id=1135507」「イベントID: 123456」など。ページ内のリンクのURLも渡せる） */
export function identifiersFromText(text: string): EventIdentifier[] {
  const out: EventIdentifier[] = [];
  for (const m of text.normalize("NFKC").matchAll(TEXT_ID)) {
    const kind: IdKind = /campaign|キャンペーン/i.test(m[0]) ? "campaign" : "event";
    if (plausibleId(m[1])) out.push({ kind, value: m[1], from: "text" });
  }
  return out;
}

export function extractIdentifiers(input: { urls: string[]; text: string; links?: string[] }): EventIdentifier[] {
  const all = [...input.urls.flatMap((u) => identifiersFromUrl(u)), ...(input.links ?? []).flatMap((u) => identifiersFromUrl(u, "link")), ...identifiersFromText(input.text)];
  const seen = new Set<string>();
  const uniq = all.filter((x) => (seen.has(`${x.kind}:${x.value}`) ? false : (seen.add(`${x.kind}:${x.value}`), true)));
  // 同じ種類の識別子が3種類以上ある（おすすめ・関連イベントのリンクなど）ページは、どれがそのページ自身のIDか分からないため、その種類は使わない
  const perKind = new Map<IdKind, number>();
  for (const x of uniq) perKind.set(x.kind, (perKind.get(x.kind) ?? 0) + 1);
  return uniq.filter((x) => (perKind.get(x.kind) ?? 0) <= 2);
}

/** 2つの情報源の識別子の関係: shared=同じ種類で同じ値／differs=同じ種類で別の値（かつ共有する値が無い）／none=比べられない */
export function compareIdentifiers(a: EventIdentifier[], b: EventIdentifier[]): { shared: EventIdentifier[]; differs: boolean } {
  const shared = a.filter((x) => b.some((y) => y.kind === x.kind && y.value === x.value));
  if (shared.length > 0) return { shared, differs: false };
  const kinds = new Set(a.map((x) => x.kind));
  const differs = b.some((y) => kinds.has(y.kind));
  return { shared: [], differs };
}

/** 2つの文章の最長の共通部分（正規化後）。共通の企画名・条件文の確認用。minLen 未満なら null */
export function longestCommonPhrase(a: string, b: string, minLen = 14): string | null {
  const x = a.normalize("NFKC").replace(/\s+/g, " ").slice(0, 3000);
  const y = b.normalize("NFKC").replace(/\s+/g, " ").slice(0, 3000);
  if (!x || !y) return null;
  let best = 0;
  let end = 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) {
          best = cur[j];
          end = i;
        }
      }
    }
    prev = cur;
  }
  return best >= minLen ? x.slice(end - best, end).trim() : null;
}

/** HTML全体（リンク先のURL・属性を含む）から識別子を取り出す。ページの末尾（お問い合わせのリンクなど）にあるIDも拾うため、本文の切り詰めの前に呼ぶ */
export function identifiersFromHtml(html: string): EventIdentifier[] {
  const urls = (html.slice(0, 600_000).match(/https?:\/\/[^"'\s<>\\]+/g) ?? []).slice(0, 400).map((u) => u.replace(/&amp;/g, "&"));
  return extractIdentifiers({ urls, text: html.slice(0, 600_000).replace(/&amp;/g, "&") });
}

/** 本文の、抽選の内容に近い部分を取り出す（先頭のサイトのメニュー・ナビゲーションを飛ばす）。キーワードが無ければ先頭から */
export function relevantExcerpt(text: string, max = MAX_STORED_TEXT): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const m = /(抽選|応募期間|申込期間|受付期間|販売日|当選発表|結果発表|購入権利|イベント詳細)/.exec(t);
  const start = m ? Math.max(0, m.index - 300) : 0;
  return t.slice(start, start + max);
}
