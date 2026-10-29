import type { EvidenceKey, ExtractedFlex, ExtractedLottery, ExtractionIssue, FieldKey } from "@/lib/ai/extraction";

/**
 * AIの抽出結果を、プログラム側で検証する（AIの出力を信用しない）。
 * 矛盾や原文に無い値を見つけても、正しい値を創作しない。該当項目を「要確認」（信頼度 low）にして理由を残す。
 * 例外: 原文に存在しないと確認できた時刻・URLは、取り除く（値を足すのではなく、根拠の無い値を外す）。
 */

/** 照合用の正規化（全角半角・空白・大文字小文字の違いを無視） */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 根拠の抜粋が原文にあるか。「…」で区切った抜粋は、各断片がすべて原文にあればよい */
export function quoteInSource(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote);
  const s = normalizeForMatch(source);
  if (q.length < 3) return false;
  if (s.includes(q)) return true;
  const parts = q.split(/[…⋯]|\.{3}|｜|\|/).filter((p) => p.length >= 3);
  return parts.length > 1 && parts.every((p) => s.includes(p));
}

const TIME_CUE = /\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*時|正午|午前|午後|深夜|零時|\bam\b|\bpm\b/i;
const QTY_IN_NAME = /\d+\s*(box|ＢＯＸ|ボックス|パック|セット|個|点)|[（(]\s*\d+\s*(パック|枚)\s*入り?\s*[）)]/i;
const PURCHASE_QTY = /(点|box|ボックス|個|枚|パック)\s*(まで|限り|以内)/i;
const APPLY_COUNT_WORDS = /(応募|エントリー|口|回|アカウント)/;
const GIVEAWAY = /(プレゼント|懸賞|当たる|当選者に.*(進呈|プレゼント)|ギフト)/;
const PURCHASE_WORDS = /(販売|購入|予約|定価|お支払い|決済)/;

const FIELD_OF_EVIDENCE: Partial<Record<EvidenceKey, FieldKey>> = {
  chain: "chain", store: "store", items: "items", multiMode: "multiMode", applyStart: "applyStart", applyDeadline: "applyDeadline",
  resultDate: "resultDate", procedureStart: "procedureStart", procedureDeadline: "procedureDeadline", announcement: "announcement", applyMethod: "applyMethod",
  receiveMethod: "receiveMethod", limit: "limit", conditions: "conditions",
};

const DATE_LABEL = { applyStart: "応募開始", applyDeadline: "応募締切", resultDate: "当選発表", procedureStart: "購入・受取開始", procedureDeadline: "購入・受取終了" } as const;
type DateKey = keyof typeof DATE_LABEL;

/** 「読み取れませんでした」「記載がありません」「不明」など、抽選の内容ではなく解析結果についての説明か */
const ANALYSIS_NOTE = new RegExp(
  [
    "(読み取れ|読み取り|判別|判断|確認|抽出|特定|把握)(でき)?(ませんでした|ません|なかった|不能|できず|できない)",
    "記載(が|は)?(ありません|ない|なし|見当たりません|されていません)",
    "(本文|投稿|告知|画像|文章|ページ)[^。\n]{0,15}(途中で切れ|切れて|欠けて|不足|見えない)",
    "^(不明|なし|特になし|未記載|—|-|－|n/a|null|none)[。.]?$",
  ].join("|"),
  "i",
);
export function isAnalysisNote(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 150 && ANALYSIS_NOTE.test(t);
}

const stamp = (f: ExtractedFlex) => `${f.date}T${f.time || "00:00"}`;
const known = (f: ExtractedFlex) => f.precision !== "unknown";

/**
 * @param sourceText 原文（貼り付けた文章、または取得したページ・投稿の本文）。画像など原文が無い入力は null（根拠は照合できない）
 */
export function validateExtraction(input: ExtractedLottery, sourceText: string | null): ExtractedLottery {
  const ex: ExtractedLottery = JSON.parse(JSON.stringify(input));
  const issues: ExtractionIssue[] = [...ex.issues];
  const flag = (field: ExtractionIssue["field"], message: string, lower?: FieldKey) => {
    if (!issues.some((i) => i.field === field && i.message === message)) issues.push({ field, message });
    if (lower) ex.confidence[lower] = "low";
  };

  // 0. 解析上の説明文（「応募条件を読み取れませんでした」など）が、抽選情報の欄に入っていないか。入力値には使わず、要確認の詳細に移す
  const TEXT_FIELDS: { key: "conditionsText" | "verificationText" | "announcementMethod" | "notes" | "purchaseLimitText"; field: ExtractionIssue["field"]; label: string }[] = [
    { key: "conditionsText", field: "conditions", label: "応募条件" },
    { key: "verificationText", field: "general", label: "本人確認・必要書類" },
    { key: "announcementMethod", field: "announcement", label: "発表方法" },
    { key: "notes", field: "general", label: "注意事項" },
    { key: "purchaseLimitText", field: "limit", label: "購入数量・上限" },
  ];
  for (const t of TEXT_FIELDS) {
    const text = ex[t.key];
    if (text && isAnalysisNote(text)) {
      ex[t.key] = "";
      flag(t.field, `${t.label}は告知から読み取れませんでした（AIの説明: ${text.slice(0, 120)}）`, t.field === "general" ? undefined : (t.field as FieldKey));
    }
  }

  // 1. 根拠の抜粋が原文にあるか（AIが作った根拠を信用しない）
  for (const [k, ev] of Object.entries(ex.evidence) as [EvidenceKey, NonNullable<ExtractedLottery["evidence"][EvidenceKey]>][]) {
    ev.verified = sourceText === null ? null : quoteInSource(ev.quote, sourceText);
    if (ev.verified === false) {
      const f = FIELD_OF_EVIDENCE[k];
      flag(k, "根拠として示された文章が原文に見当たりません", f);
    }
  }

  // 2. 原文に存在しない時刻を補っていないか（日付のみの情報を時刻つきにしない）
  for (const k of Object.keys(DATE_LABEL) as DateKey[]) {
    const f = ex[k];
    const ev = ex.evidence[k];
    if (f.precision === "date_time" && ev?.verified === true && !TIME_CUE.test(ev.quote)) {
      ex[k] = { ...f, precision: "date_only", time: "" };
      flag(k, `${DATE_LABEL[k]}: 告知に時刻の記載が見当たらないため、日付のみにしました`, k);
    }
  }

  // 3. 日付の前後関係（矛盾は値を直さず、要確認にする）
  const { applyStart: s, applyDeadline: d, resultDate: r, procedureStart: ps, procedureDeadline: p } = ex;
  if (known(s) && known(d) && stamp(s) > stamp(d)) {
    flag("applyStart", "応募開始が応募締切より後になっています", "applyStart");
    flag("applyDeadline", "応募開始が応募締切より後になっています", "applyDeadline");
  }
  if (known(d) && known(r) && r.date < d.date) flag("resultDate", "当選発表が応募締切より前になっています", "resultDate");
  if (known(r) && known(ps) && ps.date < r.date) flag("procedureStart", "購入・受取開始が当選発表より前になっています", "procedureStart");
  if (known(ps) && known(p) && stamp(ps) > stamp(p)) {
    flag("procedureStart", "購入・受取開始が終了より後になっています", "procedureStart");
    flag("procedureDeadline", "購入・受取開始が終了より後になっています", "procedureDeadline");
  }
  if (known(r) && known(p) && p.date < r.date) flag("procedureDeadline", "購入・受取終了が当選発表より前になっています", "procedureDeadline");
  if (known(d) && known(p) && p.date < d.date) flag("procedureDeadline", "購入・受取終了が応募締切より前になっています", "procedureDeadline");

  // 4. 商品名に数量・入数が混ざっていないか
  if (ex.items.some((i) => QTY_IN_NAME.test(i.name))) flag("items", "商品名に数量や入数の表記が含まれている可能性があります", "items");

  // 5. 複数商品なのに方式が「単一」になっていないか
  if (ex.items.length > 1 && ex.multiMode === "single") {
    ex.multiMode = "unknown";
    flag("multiMode", "複数商品なのに単一の抽選と読み取られたため、方式を未確認にしました", "multiMode");
  }

  // 6. 購入数量の上限（お一人様1点まで）を、応募回数の制限と取り違えていないか
  if (ex.limitBasis !== "unknown") {
    const text = ex.evidence.limit?.quote || ex.purchaseLimitText;
    if (PURCHASE_QTY.test(text) && !APPLY_COUNT_WORDS.test(text)) {
      if (!ex.purchaseLimitText) ex.purchaseLimitText = text;
      ex.limitBasis = "unknown";
      ex.limitMaxCount = null;
      flag("limit", "購入数量の上限と読み取れるため、応募回数の制限は未確認にしました", "limit");
    }
  }

  // 7. URL: 原文に存在しないURLは取り除く（形式の確認は正規化で済み）
  if (sourceText !== null) {
    for (const k of ["applyUrl", "announcementUrl"] as const) {
      const url = ex[k];
      if (url && !normalizeForMatch(sourceText).includes(normalizeForMatch(url).replace(/\/$/, ""))) {
        ex[k] = "";
        flag(k, `${k === "applyUrl" ? "応募" : "発表"}URLが原文に見当たらないため、取り除きました`);
      }
    }
  }

  // 8. 抽選販売ではなくプレゼント企画の可能性
  if (sourceText !== null && GIVEAWAY.test(sourceText) && !PURCHASE_WORDS.test(sourceText)) {
    flag("general", "抽選販売ではなく、プレゼント企画（懸賞）の告知の可能性があります");
  }

  ex.issues = issues;
  for (const i of issues) if (!ex.warnings.includes(i.message)) ex.warnings.push(i.message);
  return ex;
}
