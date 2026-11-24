/**
 * R1（複数リンクの旧方式 vs 新方式）の独立gold作成の支援（Phase 2・純関数）。**AIの出力・旧方式の結果・登録案から正解を作らない**。
 *
 * 背景: 保存済みの実投稿30件のうち、リンクを2件以上持つのは1件だけで、短縮URLは未展開のまま。複数リンクの実案件（リンク先の本文つき）は、保存済みの実データには無い。
 * 方針: 保存済みの**実在の公開ページ（LivePocket 12件）**を使い、
 *   (1) ページごとに、人が確認しやすい資料（原文の該当箇所・機械的に抽出した候補）を出す（候補は『機械抽出・未確認』。人が確認・訂正するまで正解ではない）
 *   (2) 人がページ単位で確認した gold（店舗・商品・締切・応募単位・根拠の引用）から、複数リンクの比較用の案件を**決定的に**組み立てる（投稿の文面は組み立てた合成。ページの本文は実在）
 * 合成であることは報告に明記する（実投稿の複数リンクではない）。ページを複数の案件で使い回すため、案件は独立ではない（検出力の目安は割り引いて読む）。
 */
import type { CompareCase, GoldCase, GoldOpportunity } from "./compare-eval";
import { dateTokens } from "./image-evidence";
import { parseApplyPage } from "./page-structure";
import { pageText } from "./html-text";

export interface PageCandidate {
  n: number;
  url: string;
  chars: number;
  title: string | null;
  recognized: boolean;
  /** 【…】の中（店舗名の候補）。機械抽出・未確認 */
  storeCandidate: string | null;
  productCandidate: string | null;
  /** 締切らしい日付の候補（月/日）と、その周辺の原文 */
  deadlineCandidates: { md: string; context: string }[];
  /** 「応募締切：M月D日」の形で明記されている場合の候補（年はページに無いため、記入時に人が確認する）と、その原文の引用。機械抽出・未確認 */
  applyEndGuess: { md: string; quote: string } | null;
  slots: { title: string; details: string[]; notes: string[] }[];
  pageNotes: string[];
  /** 人が見るべき点（複数の受付枠・店舗が読み取れない・締切の候補が複数 など） */
  attention: string[];
}

const deadlineContexts = (text: string): { md: string; context: string }[] => {
  const out: { md: string; context: string }[] = [];
  for (const m of text.matchAll(/(締切|〆|まで|期間|終了|受付)/g)) {
    const at = m.index ?? 0;
    const ctx = text.slice(Math.max(0, at - 40), at + 50).replace(/\s+/g, " ");
    for (const md of dateTokens(ctx)) if (!out.some((o) => o.md === md)) out.push({ md, context: ctx });
    if (out.length >= 8) break;
  }
  return out;
};

export function pageCandidate(p: { n: number; url: string; html: string }): PageCandidate {
  const st = parseApplyPage(p.html);
  const text = pageText(p.html);
  const title = st.title ?? null;
  const store = title ? (/【([^】]{2,40})】/.exec(title)?.[1] ?? null) : null;
  const product = title ? title.replace(/【[^】]*】/g, "").trim() || null : null;
  const deadlines = deadlineContexts(text);
  const attention: string[] = [];
  if (!st.recognized) attention.push("ページの構造を機械的に認識できなかった（全て人が確認）");
  if (st.slots.length > 1) attention.push(`受付枠が${st.slots.length}件ある（応募機会が複数になりうる。R1の合成では1ページ=1機会にするため、不向きなら除外する）`);
  if (!store) attention.push("店舗名の候補が見つからない");
  if (new Set(deadlines.map((d) => d.md)).size > 1) attention.push("締切らしい日付の候補が複数ある（どれが応募の締切か人が確認）");
  if (deadlines.length === 0) attention.push("締切らしい日付が見つからない（ページに無い・画像の中・JS描画の可能性）");
  const em = /応募締切\s*[：:]\s*(\d{1,2})月\s*(\d{1,2})日[^\n。]{0,20}/.exec(text.normalize("NFKC"));
  const applyEndGuess = em ? { md: `${Number(em[1])}/${Number(em[2])}`, quote: em[0].trim() } : null;
  return { n: p.n, url: p.url, chars: text.length, title, recognized: st.recognized, storeCandidate: store, productCandidate: product, deadlineCandidates: deadlines, applyEndGuess, slots: st.slots.map((s) => ({ title: s.title, details: s.details.map((d) => `${d.label}: ${d.value}`).slice(0, 6), notes: s.notes.slice(0, 4) })), pageNotes: st.pageNotes.slice(0, 5), attention };
}

/** 人が確認するための資料（Markdown）。原文の該当箇所と、機械抽出の候補（未確認）。AIの出力は含めない */
export function worksheetMarkdown(cands: readonly PageCandidate[]): string {
  const L: string[] = ["# R1 独立gold 確認資料（ページ単位）", "", "各ページについて、**ブラウザで公式ページを見て**、次を確認して `r1-gold-pages.local.json` に記入してください（AIの出力・旧方式の結果は見ない・写さない）。", "- 候補は機械抽出で**未確認**です。誤りがあれば訂正し、根拠の原文の引用（ページにある一字一句）を必ず付ける。", "- 1ページ=1応募機会として扱います。複数の受付枠など不向きなページは `exclude: true`。", ""];
  for (const c of cands) {
    L.push(`## ページ ${c.n}（${c.chars}字）`, `URL: ${c.url}`, `タイトル: ${c.title ?? "（取得できず）"}`);
    L.push(`- 店舗の候補（未確認）: ${c.storeCandidate ?? "なし"}`, `- 商品の候補（未確認）: ${c.productCandidate ?? "なし"}`);
    if (c.applyEndGuess) L.push(`- 「応募締切」の明記（未確認）: ${c.applyEndGuess.md}「${c.applyEndGuess.quote}」`);
    L.push(`- 締切の候補（未確認）: ${c.deadlineCandidates.length ? c.deadlineCandidates.map((d) => `${d.md}「…${d.context}…」`).join(" / ") : "なし"}`);
    if (c.slots.length) L.push(`- 受付枠: ${c.slots.map((s) => `${s.title}（${s.details.join("・")}）`).join(" | ")}`);
    if (c.pageNotes.length) L.push(`- ページ全体の注意書き: ${c.pageNotes.join(" / ")}`);
    if (c.attention.length) L.push(`- **要確認**: ${c.attention.join(" ／ ")}`);
    L.push("");
  }
  return L.join("\n");
}

// ------------------------------------------------------------------ 人が確認したページ単位の gold → 比較用の案件
export interface R1PageGold {
  n: number;
  exclude?: boolean;
  verified: { by: "human"; at: string; basis: string };
  store: string;
  product: string;
  applyEnd: string | null;
  applyUnit: Exclude<GoldOpportunity["applyUnit"], null> | null;
  region: string | null;
  /** 根拠の原文の引用（ページの本文にある一字一句）。必須 */
  evidence: { quote: string }[];
}

/** ページ単位の gold の検査: 人の確認・根拠の引用がページの本文に実在すること（機械的な突合せ。正しさの判断ではない） */
export function validatePageGold(g: readonly R1PageGold[], pages: readonly { n: number; html: string }[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byN = new Map(pages.map((p) => [p.n, pageText(p.html).normalize("NFKC").replace(/\s+/g, "")]));
  for (const x of g) {
    if (x.exclude) continue;
    if (x.verified?.by !== "human" || !x.verified.at || !x.verified.basis?.trim()) errors.push(`ページ${x.n}: 人による確認（by=human・日時・基準）が必要`);
    if (!x.store?.trim() || !x.product?.trim()) errors.push(`ページ${x.n}: 店舗・商品が必要`);
    if (x.applyEnd && !/^\d{4}-\d{2}-\d{2}$/.test(x.applyEnd)) errors.push(`ページ${x.n}: applyEnd は YYYY-MM-DD か null`);
    if (!x.evidence?.length) errors.push(`ページ${x.n}: 根拠の引用が必要`);
    const hay = byN.get(x.n);
    if (!hay) errors.push(`ページ${x.n}: 保存済みのページが無い`);
    else for (const e of x.evidence ?? []) if (!hay.includes(e.quote.normalize("NFKC").replace(/\s+/g, ""))) errors.push(`ページ${x.n}: 根拠の引用がページの本文に見つからない（「${e.quote.slice(0, 20)}…」）`);
  }
  return { ok: errors.length === 0, errors };
}

const codeOf = (n: number): string => `https://t.co/r1p${n.toString(36).padStart(3, "0")}`;
const md = (iso: string | null): string => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}(${"日月火水木金土"[new Date(`${iso}T00:00:00+09:00`).getDay()]})23:59〆` : "");

/**
 * 案件の組み立て（決定的）。案件 i は、有効なページのうち i 番目から linksPerCase 件（循環）を、順序を変えて使う。
 * 投稿の文面は `《店舗》 ・商品 抽選 締切 短縮URL` の形式（保存済みの実投稿と同じ書式）。gold には合言葉（canary）を付け、入力には含めない。
 */
export function composeR1Cases(a: { pages: readonly { n: number; url: string; html: string }[]; gold: readonly R1PageGold[]; cases: number; linksPerCase?: number; at: string }): { cases: CompareCase[]; gold: GoldCase[] } {
  const per = a.linksPerCase ?? 3;
  const ok = a.gold.filter((g) => !g.exclude);
  const pageBy = new Map(a.pages.map((p) => [p.n, p]));
  const cases: CompareCase[] = [];
  const golds: GoldCase[] = [];
  for (let i = 0; i < a.cases && ok.length > 0; i++) {
    const chosen = Array.from({ length: Math.min(per, ok.length) }, (_, k) => ok[(i + k * 5) % ok.length]); // 間隔を空けて選び、同じ組み合わせの繰り返しを避ける
    const uniq = chosen.filter((c, k) => chosen.findIndex((d) => d.n === c.n) === k);
    const ordered = i % 2 === 0 ? uniq : [...uniq].reverse(); // 順序を変える（先頭の1件だけ取る旧方式が、毎回同じページになるのを避ける）
    const items = ordered.map((g) => `《${g.store}${g.region ? `（${g.region}）` : ""} - 1件》 ・${g.product} 抽選 ${md(g.applyEnd)} ${codeOf(g.n)}`);
    const caseId = `r1c${String(i + 1).padStart(2, "0")}`;
    cases.push({
      caseId,
      postText: items.join(" "),
      links: [],
      linkMap: ordered.map((g) => ({ short: codeOf(g.n), url: pageBy.get(g.n)!.url })),
      pages: ordered.map((g) => ({ url: pageBy.get(g.n)!.url, text: pageText(pageBy.get(g.n)!.html) })),
      imageRefs: [],
      imageReadings: [],
    });
    golds.push({
      caseId,
      canary: `CANARY-${caseId.toUpperCase()}-${(a.at.replace(/\D/g, "") || "0").slice(0, 8)}-GOLD`,
      verified: { by: "human", at: ordered[0].verified.at, basis: `ページ単位の人の確認（${ordered.map((g) => `ページ${g.n}`).join("・")}）から組み立て` },
      opportunities: ordered.map((g, k) => ({ oppId: `p${g.n}`, store: g.store, product: g.product, applyEnd: g.applyEnd, region: g.region, url: pageBy.get(g.n)!.url, applyUnit: g.applyUnit, decision: "register" as const, evidenceIn: ["page" as const], pageIndex: k, evidence: g.evidence.map((e) => ({ where: `page:${k}`, quote: e.quote })) })),
    });
  }
  return { cases, gold: golds };
}
