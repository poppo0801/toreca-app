/**
 * 応募ページの構造取得（Stage 10T・純関数）。人がブラウザで見る「受付枠（チケット）カード」「同じ販売元のイベント」「ページ全体の注意書き」を、
 * 本文の平文化（既存の抜粋）では失われる構造のまま取り出し、共通の観察データ（ApplyPageStructure）に正規化する。
 * - **観察だけ**を返す（応募単位・店舗の判断はしない。判断はAI）。サイト名だけで応募単位を確定しない。
 * - ページ自身の受付枠（slots）と、同じ販売元の別イベント（relatedEvents）は**別の構造**。関連イベントの表示だけで応募可否を確定しない。
 * - HTMLが想定の構造でない（JS描画で欠ける等）ときは recognized=false とし、欠落を推測で埋めない。
 */

export interface PageSlot {
  title: string;
  statusTags: string[];
  price: string | null;
  /** カード内の説明文（折りたたみの中身を含む） */
  description: string;
  /** 結果発表予定日などの「項目: 値」 */
  details: { label: string; value: string }[];
  /** カード内の注意書き（お1人様1回など） */
  notes: string[];
}

export interface RelatedEvent {
  title: string;
  href: string | null;
  status: string | null;
  dateText: string | null;
  place: string | null;
}

export interface FormChoice {
  /** select / radio / checkbox */
  kind: "select" | "radio" | "checkbox";
  label: string | null;
  options: string[];
}

export interface FormQuestion {
  title: string;
  /** short_text / paragraph / radio / dropdown / checkbox / other */
  kind: string;
  options: string[];
}

export interface ApplyPageStructure {
  /** 想定の構造（受付枠のカード等）を認識できたか。false のときは欠落を意味し、「無い」とは言えない */
  recognized: boolean;
  siteKind: "livepocket_like" | "google_form" | "generic";
  title: string | null;
  /** ページ全体の注意書き（お1人様1回のみ 等。適用範囲はページ/受付枠のどちらかをAIが解釈する） */
  pageNotes: string[];
  slots: PageSlot[];
  relatedEvents: RelatedEvent[];
  /** フォームの選択肢（select/radio/checkbox）。店舗選択欄の有無の観察 */
  formChoices: FormChoice[];
  /** 公開フォームの設問（Googleフォーム等。設問文・種類・選択肢だけ。回答・送信はしない） */
  formQuestions: FormQuestion[];
  /** 欠落の自己申告（人が見る画面との差を確認するため） */
  gaps: string[];
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENT[g] ?? m;
  });
/** タグを除去して平文に（改行は空白へ。NFKC） */
const text = (html: string): string => decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).normalize("NFKC").replace(/[ \t\r\n　]+/g, " ").trim();
const firstOf = (html: string, re: RegExp): string | null => {
  const m = re.exec(html);
  return m ? text(m[1]) || null : null;
};
const allOf = (html: string, re: RegExp): string[] => [...html.matchAll(re)].map((m) => text(m[1])).filter(Boolean);
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 受付枠カード（LivePocket系の構造）を抜き出す。 */
function parseSlots(html: string): PageSlot[] {
  const starts = [...html.matchAll(/<section class="event-detail-ticket-card"/g)].map((m) => m.index ?? 0);
  const slots: PageSlot[] = [];
  starts.forEach((s, i) => {
    const endBound = Math.min(starts[i + 1] ?? html.length, (() => { const j = html.indexOf("event-detail-other", s); return j < 0 ? html.length : j; })());
    const seg = html.slice(s, endBound);
    const title = firstOf(seg, /class="event-detail-ticket-card__title"[^>]*>([\s\S]*?)<\/h4>/);
    if (!title) return;
    const description = firstOf(seg, /class="event-detail-ticket-card__text[^"]*"[^>]*>([\s\S]*?)<\/p>/) ?? "";
    const details = [...seg.matchAll(/class="event-detail-ticket-body-list__title"[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => ({ label: text(m[1]), value: text(m[2]) }));
    slots.push({
      title,
      statusTags: allOf(seg, /<span class="tag-[a-z-]+">([\s\S]*?)<\/span>/g),
      price: firstOf(seg, /class="event-detail-ticket-card__price"[^>]*>([\s\S]*?)<\/p>/),
      description: cap(description, 1500),
      details,
      notes: allOf(seg, /class="text-note event-detail-ticket-note"[^>]*>([\s\S]*?)<\/p>/g),
    });
  });
  return slots;
}

function parseRelated(html: string): RelatedEvent[] {
  const i = html.indexOf("event-detail-other");
  if (i < 0) return [];
  const seg = html.slice(i);
  return [...seg.matchAll(/<a class="event-card event-card--other"[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => {
    const b = m[2];
    const hrefRaw = decode(m[1]);
    return {
      title: firstOf(b, /class="event-card__title"[^>]*>([\s\S]*?)<\/h3>/) ?? "",
      href: hrefRaw || null,
      status: firstOf(b, /class="[^"]*event-card__tag"[^>]*>([\s\S]*?)<\/span>/),
      dateText: (firstOf(b, /class="event-card__text event-card__text--date"[^>]*>([\s\S]*?)<\/p>/) ?? "").replace(/^日程\s*/, "") || null,
      place: (firstOf(b, /<p class="event-card__text">\s*<span class="event-card__place">[\s\S]*?<\/span>([\s\S]*?)<\/p>/) ?? null),
    };
  }).filter((r) => r.title);
}

/** select / radio / checkbox の選択肢（ラベル付き）。フォームを送信せず、HTMLの宣言だけを読む */
function parseFormChoices(html: string): FormChoice[] {
  const out: FormChoice[] = [];
  for (const m of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    const options = allOf(m[1], /<option\b[^>]*>([\s\S]*?)<\/option>/gi).filter((o) => !/^(選択|選んで|--)/.test(o));
    if (options.length) out.push({ kind: "select", label: null, options: options.slice(0, 60) });
  }
  const groups = new Map<string, { kind: "radio" | "checkbox"; options: string[] }>();
  for (const m of html.matchAll(/<input\b[^>]*type="(radio|checkbox)"[^>]*>(?:\s*<\/input>)?\s*(?:<label[^>]*>)?([^<]{1,80})/gi)) {
    const nm = /name="([^"]*)"/.exec(m[0])?.[1] ?? "?";
    const g = groups.get(nm) ?? { kind: m[1] as "radio" | "checkbox", options: [] };
    const label = text(m[2]);
    if (label) g.options.push(label);
    groups.set(nm, g);
  }
  for (const g of groups.values()) if (g.options.length >= 2) out.push({ kind: g.kind, label: null, options: g.options.slice(0, 60) });
  return out;
}

const GF_KIND: Record<number, string> = { 0: "short_text", 1: "paragraph", 2: "radio", 3: "dropdown", 4: "checkbox" };

/** Googleフォームの公開ページ内の設問データ（FB_PUBLIC_LOAD_DATA_）を読む。形式が想定と違えば null（欠落として扱う） */
export function parseGoogleForm(html: string): { title: string | null; questions: FormQuestion[] } | null {
  const m = /FB_PUBLIC_LOAD_DATA_\s*=\s*/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf(";</script>", start);
  if (end < 0) return null;
  try {
    const data = JSON.parse(html.slice(start, end)) as unknown[];
    const body = data[1] as unknown[];
    const items = body?.[1];
    if (!Array.isArray(items)) return null;
    const questions: FormQuestion[] = [];
    for (const it of items as unknown[][]) {
      const title = typeof it?.[1] === "string" ? text(it[1] as string) : "";
      if (!title) continue;
      const kind = GF_KIND[it[3] as number] ?? "other";
      const q = (it[4] as unknown[][] | undefined)?.[0];
      const opts = Array.isArray(q?.[1]) ? (q[1] as unknown[][]).map((o) => (typeof o?.[0] === "string" ? text(o[0] as string) : "")).filter(Boolean) : [];
      questions.push({ title: cap(title, 160), kind, options: opts.slice(0, 60) });
    }
    return { title: typeof body[8] === "string" ? text(body[8] as string) || null : null, questions };
  } catch {
    return null;
  }
}

export function parseApplyPage(html: string): ApplyPageStructure {
  const slots = parseSlots(html);
  const relatedEvents = parseRelated(html);
  const livepocketLike = /event-detail-ticket|event-detail-other/.test(html);
  const gaps: string[] = [];
  const declared = (html.match(/<section class="event-detail-ticket-card"/g) ?? []).length;
  if (livepocketLike && !slots.length) gaps.push("受付枠のカードを抽出できなかった（画面との差を人が確認）");
  if (declared !== slots.length) gaps.push(`受付枠のカード宣言 ${declared} 件のうち ${slots.length} 件のみ抽出`);
  if (/FB_PUBLIC_LOAD_DATA_|data-react-root|__NEXT_DATA__|window\.__NUXT__/.test(html) && !slots.length) gaps.push("JavaScriptで描画される可能性（通常のHTML取得では内容が欠ける）");
  if (!livepocketLike && !html.includes("<form") && !/<select|type="radio"|type="checkbox"/.test(html)) gaps.push("フォーム・選択肢の宣言が見つからない（画像・別ページ・JS描画の可能性）");
  const formChoices = parseFormChoices(html);
  const gf = livepocketLike ? null : parseGoogleForm(html);
  if (gf) {
    const i = gaps.findIndex((g) => g.startsWith("JavaScript"));
    if (i >= 0) gaps.splice(i, 1);
    const j = gaps.findIndex((g) => g.startsWith("フォーム・選択肢"));
    if (j >= 0) gaps.splice(j, 1);
  } else if (/FB_PUBLIC_LOAD_DATA_/.test(html)) gaps.push("Googleフォームの設問データを読めなかった（形式が想定と異なる）");
  return {
    recognized: livepocketLike ? slots.length > 0 : gf ? gf.questions.length > 0 : formChoices.length > 0,
    siteKind: livepocketLike ? "livepocket_like" : gf ? "google_form" : "generic",
    formQuestions: gf?.questions ?? [],
    title: gf?.title ?? firstOf(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/) ?? firstOf(html, /<title[^>]*>([\s\S]*?)<\/title>/),
    pageNotes: [...new Set(allOf(html.slice(0, html.indexOf("event-detail-other") > 0 ? html.indexOf("event-detail-other") : html.length), /class="text-note event-detail-ticket-note"[^>]*>([\s\S]*?)<\/p>/g))],
    slots,
    relatedEvents,
    formChoices,
    gaps,
  };
}

/** 「【店舗名】…」形式のタイトルから括弧内のラベルを観察として取り出す（店舗の確定ではない） */
export function bracketLabel(title: string): string | null {
  const m = /^[\s]*[【\[［]([^】\]］]{1,30})[】\]］]/.exec(title.normalize("NFKC"));
  return m ? m[1] : null;
}

/** 括弧ラベルと日付表記を除いた「商品の言い回し」（関連イベントとの同一商品の観察用。同一性の判断ではない） */
export function productPhrase(title: string): string {
  return title.normalize("NFKC").replace(/[【\[][^】\]]*[】\]]/g, "").replace(/\d{1,2}\/\d{1,2}(\([^)]*\))?(~\d{1,2}\/\d{1,2}(\([^)]*\))?)?/g, "").replace(/(発売|抽選受付|受付|応募|抽選)/g, "").replace(/[\s　「」『』"']/g, "").toLowerCase();
}

export interface RelatedObservation extends RelatedEvent {
  /** タイトル先頭の括弧ラベル（店舗名のことが多いが、確定ではない） */
  label: string | null;
  /** ページ本体の受付枠の商品の言い回しと同じ（観察の一致。別店舗の独立した応募ページがある「示唆」にとどまる） */
  samePhraseAsPage: boolean;
}

/** 関連イベントの観察（ページ本体のタイトル・受付枠と、商品の言い回し・括弧ラベルを突き合わせる） */
export function observeRelated(st: ApplyPageStructure): RelatedObservation[] {
  const base = new Set([st.title ?? "", ...st.slots.map((s) => s.title)].map(productPhrase).filter((p) => p.length >= 6));
  return st.relatedEvents.map((r) => {
    const p = productPhrase(r.title);
    const same = p.length >= 6 && [...base].some((b) => b.includes(p) || p.includes(b));
    return { ...r, label: bracketLabel(r.title), samePhraseAsPage: same };
  });
}

/** AIへ渡す観察（formObservations）。構造を失わない短い文にする。判断・結論は書かない */
export function structureToObservations(st: ApplyPageStructure, opts: { maxSlots?: number; maxRelated?: number } = {}): string[] {
  const out: string[] = [];
  const maxSlots = opts.maxSlots ?? 12;
  const maxRelated = opts.maxRelated ?? 10;
  if (st.title) out.push(`ページのタイトル: ${cap(st.title, 120)}`);
  if (st.siteKind === "livepocket_like") {
    out.push(`このページ自身の受付枠（カード）の数: ${st.slots.length}件${st.slots.length === 0 ? "（抽出できず。無いとは限らない）" : ""}`);
    st.slots.slice(0, maxSlots).forEach((s, i) => {
      const bits = [`受付枠${i + 1}「${cap(s.title, 100)}」`, s.statusTags.length ? `状態:${s.statusTags.join("/")}` : "", s.details.map((d) => `${d.label}:${d.value}`).join("、"), s.notes.join("／"), s.description ? `説明:${cap(s.description, 220)}` : ""].filter(Boolean);
      out.push(bits.join(" ・ "));
    });
    if (st.slots.length > maxSlots) out.push(`（受付枠は他に ${st.slots.length - maxSlots} 件。省略）`);
    if (st.pageNotes.length) out.push(`ページ全体の注意書き（適用範囲の解釈は別途）: ${st.pageNotes.join(" / ")}`);
    const rel = observeRelated(st);
    out.push(`「同じ販売元のイベント」（このページとは別のイベント。応募可否の根拠にはならない）: ${rel.length}件`);
    rel.slice(0, maxRelated).forEach((r) => out.push(`関連イベント「${cap(r.title, 100)}」${r.status ? ` 状態:${r.status}` : ""}${r.dateText ? ` 日程:${cap(r.dateText, 40)}` : ""}${r.place ? ` 会場:${cap(r.place, 40)}` : ""}${r.samePhraseAsPage ? "（商品の言い回しがこのページと一致）" : ""}`));
  }
  if (st.siteKind === "google_form") {
    out.push(`公開フォームの設問: ${st.formQuestions.length}件（回答・送信はしていない）`);
    st.formQuestions.slice(0, 20).forEach((q, i) => out.push(`設問${i + 1}（${q.kind}）「${cap(q.title, 100)}」${q.options.length ? ` 選択肢: ${q.options.slice(0, 30).join(" / ")}` : ""}`));
  } else if (st.formChoices.length) st.formChoices.forEach((c, i) => out.push(`フォームの選択欄${i + 1}（${c.kind}）の選択肢: ${c.options.slice(0, 40).join(" / ")}`));
  else out.push("フォームの選択欄（select/radio/checkbox）: 検出なし（無いとは限らない）");
  if (st.gaps.length) out.push(`取得上の欠落の可能性: ${st.gaps.join(" / ")}`);
  return out;
}
