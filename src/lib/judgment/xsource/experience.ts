/**
 * 調査経験の蓄積と、次回の調査への反映（Phase 2 自律学習・純関数）。
 *
 * 方針（ユーザー方針）: サイト固有の固定ルールを増やさない。**ページの候補特徴を広く記録**し、
 *   「どの特徴の組み合わせのとき、重要な条件が本文のどの位置に見つかったか」を**過去の経験から統計的に発見**して、次の調査の「最初に見せる位置」を選ぶ。
 *   （例: 「LivePocket＋晴れる屋2」のような文言の組み合わせが、注意事項の後半に重要条件が多いという関連を、AI/統計が経験から見つける。これは例であり、コードに書かれたルールではない）
 *
 * 学習結果を無条件に信用しない（思い込みの自己強化の防止）:
 *  - 経験は検証の強さで区別する: human（人の確認・訂正）／gold（独立した正解データ）／ai_unverified（AIの観察だけ）。
 *    ai_unverified は重みが小さく、**検証済みの経験が一定量そろわない限り、ヒントを出さない**（AIの出力だけで自己強化しない）。
 *  - 反映は「最初に見せる位置の優先」だけ。**全文の参照可能性・目次・条件語の周辺・read は変わらない**（網羅性を維持）。ヒントの範囲に無いことを「記載なし」とは扱わない。
 *  - 古い経験は重みが下がる（ページ構造が変わっても適応）。取得日時・版・適用条件（支持した経験数・検証重み）をヒントに付ける。
 *  - 改善が測れないときは採用しない（shouldAdopt）。ヒントを出した調査・出さなかった調査の網羅性・人の修正率・費用を比較する。
 */
export const EXPERIENCE_VERSION = 1;
export const BUCKETS = 10;

export type Verification = "human" | "gold" | "ai_unverified";
const VERIFY_WEIGHT: Record<Verification, number> = { human: 1, gold: 1, ai_unverified: 0.15 };
/** ヒントを出すのに必要な、検証済み（human/gold）の実効重みの下限。AIの観察だけでは出さない */
export const MIN_VERIFIED_SUPPORT = 2;
/** ヒントを出すのに必要な、類似経験の実効重みの合計の下限 */
export const MIN_TOTAL_SUPPORT = 3;
const HALF_LIFE_DAYS = 120;
/** 特徴の類似度の下限（これ未満の経験は無視） */
const MIN_SIMILARITY = 0.25;

export interface ExperienceRecord {
  id?: string;
  /** ページの候補特徴（"host:..." "path:..." "len:..." "tok:..." など。広く記録し、どれが有用かは統計で決める） */
  features: string[];
  /** 全文の字数 */
  docChars: number;
  /** 重要な条件（検証できた根拠）が見つかった本文の相対位置の分布（BUCKETS 個の件数） */
  foundBuckets: number[];
  verification: Verification;
  /** 記録の日時（ISO） */
  at: string;
  /** 失敗の記録（見つけられなかった項目・人が直した項目）。ヒントの適用条件の検討・評価に使う */
  failedFields?: string[];
  version?: number;
}

const nfkc = (s: string): string => s.normalize("NFKC");

/** 語の抽出（ひらがな・カタカナ・漢字・英数の連なり。頻出しすぎる語は除くので、助詞の連なりは残らない） */
const TOKEN_RE = new RegExp("[\\u3040-\\u30FF\\u4E00-\\u9FFF]{2,8}|[A-Za-z][A-Za-z0-9]{2,15}", "g");

/** 本文の語（カタカナ・漢字・英数の連なり）から、候補の特徴語を取る。出現が多すぎる語は除く（広く記録し、有用性は統計で決める） */
function tokens(text: string, max: number): string[] {
  const counts = new Map<string, number>();
  for (const m of nfkc(text).matchAll(TOKEN_RE)) counts.set(m[0].toLowerCase(), (counts.get(m[0].toLowerCase()) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= 2 && n <= 12)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => `tok:${t}`);
}

const lenBucket = (n: number): string => `len:${Math.max(0, Math.round(Math.log2(Math.max(1, n))))}`;

/**
 * ページの候補特徴。固定ルールではなく、取得できる客観的な性質を**広く**記録する（ホスト・URLの形・長さ・構造の数・頻出語・画像の有無・リンクの深さ）。
 * どの特徴が有用かは、経験の蓄積から advise が統計で決める。
 */
export function discoverFeatures(a: { url: string | null; text: string; slots?: number; relatedEvents?: number; imageCount?: number; depth?: 0 | 1; maxTokens?: number }): string[] {
  const f = new Set<string>();
  try {
    if (a.url) {
      const u = new URL(a.url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      f.add(`host:${host}`);
      const parts = host.split(".");
      if (parts.length > 2) f.add(`domain:${parts.slice(-2).join(".")}`);
      f.add(`path:${u.pathname.split("/").filter(Boolean).slice(0, 3).map((s) => (/^\d+$/.test(s) ? "#" : /^[0-9a-f-]{16,}$/i.test(s) ? "id" : s.slice(0, 20))).join("/")}`);
    }
  } catch {
    /* URLが不正でも他の特徴は残す */
  }
  f.add(lenBucket(a.text.length));
  if (a.slots !== undefined) f.add(`slots:${Math.min(a.slots, 6)}`);
  if (a.relatedEvents !== undefined) f.add(`related:${Math.min(a.relatedEvents, 6)}`);
  if (a.imageCount !== undefined) f.add(`img:${Math.min(a.imageCount, 4)}`);
  if (a.depth !== undefined) f.add(`depth:${a.depth}`);
  for (const t of tokens(a.text, a.maxTokens ?? 40)) f.add(t);
  return [...f].slice(0, 80);
}

/** 特徴の重み付きの類似度（逆文書頻度で、どの経験にもある特徴は軽く、まれな共通特徴は重く） */
function similarity(a: readonly string[], b: ReadonlySet<string>, idf: Map<string, number>): number {
  let inter = 0;
  let uni = 0;
  const sa = new Set(a);
  for (const x of sa) {
    const w = idf.get(x) ?? 1;
    uni += w;
    if (b.has(x)) inter += w;
  }
  for (const x of b) if (!sa.has(x)) uni += idf.get(x) ?? 1;
  return uni === 0 ? 0 : inter / uni;
}

export interface ReadHint {
  from: number;
  to: number;
  /** 理由（人が読める。適用条件を含む） */
  why: string;
  /** 支持した経験の実効重みの合計 */
  support: number;
}
export interface Advice {
  hints: ReadHint[];
  /** ヒントを出さなかった理由（出したときは null）。「経験不足」「検証不足」を区別して人が確認できる */
  withheld: "no_experience" | "insufficient_verified" | "insufficient_support" | "no_pattern" | null;
  /** 参照した経験の数と検証済みの実効重み（監査用） */
  used: { experiences: number; verifiedWeight: number; totalWeight: number };
}

const daysBetween = (a: string, b: string): number => Math.max(0, (Date.parse(b) - Date.parse(a)) / 86_400_000);
const HINT_CHARS = 700;

/**
 * 類似した過去のページの経験から、この本文で**最初に見せるべき位置**を提案する。
 * 検証済みの経験が不足するときは何も出さない（withheld に理由）。出したヒントも「仮説」で、全文参照・目次・条件語の周辺は変わらない。
 */
export function advise(a: { features: readonly string[]; docChars: number; experiences: readonly ExperienceRecord[]; now: string; topBuckets?: number }): Advice {
  const empty = (withheld: NonNullable<Advice["withheld"]>, used = { experiences: 0, verifiedWeight: 0, totalWeight: 0 }): Advice => ({ hints: [], withheld, used });
  if (a.experiences.length === 0 || a.docChars <= 0) return empty("no_experience");
  // 逆文書頻度
  const df = new Map<string, number>();
  for (const e of a.experiences) for (const f of new Set(e.features)) df.set(f, (df.get(f) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [f, n] of df) idf.set(f, Math.log(1 + a.experiences.length / n));
  const mine = new Set(a.features);
  const dist = new Array<number>(BUCKETS).fill(0);
  let total = 0;
  let verified = 0;
  let used = 0;
  for (const e of a.experiences) {
    const sim = similarity(e.features, mine, idf);
    if (sim < MIN_SIMILARITY) continue;
    const w = sim * VERIFY_WEIGHT[e.verification] * Math.pow(0.5, daysBetween(e.at, a.now) / HALF_LIFE_DAYS);
    const sum = e.foundBuckets.reduce((s, x) => s + x, 0);
    if (w <= 0 || sum <= 0) continue;
    used++;
    total += w;
    if (e.verification !== "ai_unverified") verified += w;
    for (let i = 0; i < BUCKETS; i++) dist[i] += (w * (e.foundBuckets[i] ?? 0)) / sum;
  }
  const info = { experiences: used, verifiedWeight: Math.round(verified * 100) / 100, totalWeight: Math.round(total * 100) / 100 };
  if (used === 0) return empty("no_experience", info);
  if (verified < MIN_VERIFIED_SUPPORT) return empty("insufficient_verified", info);
  if (total < MIN_TOTAL_SUPPORT) return empty("insufficient_support", info);
  const mass = dist.reduce((s, x) => s + x, 0);
  // 一様より明らかに偏った位置だけを提案する（偏りが無いなら、ヒントにしない＝先頭からの通常の閲覧と同じ）
  const ranked = dist.map((v, i) => ({ i, p: v / mass })).filter((x) => x.p > 1.5 / BUCKETS).sort((x, y) => y.p - x.p).slice(0, a.topBuckets ?? 3);
  if (ranked.length === 0) return empty("no_pattern", info);
  const hints: ReadHint[] = ranked
    .sort((x, y) => x.i - y.i)
    .map((r) => {
      const centre = Math.floor(((r.i + 0.5) / BUCKETS) * a.docChars);
      const from = Math.max(0, centre - Math.floor(HINT_CHARS / 2));
      const to = Math.min(a.docChars, from + HINT_CHARS);
      return { from, to, why: `類似ページ${used}件の経験（検証済み重み${info.verifiedWeight}）で、重要な条件が本文の${r.i * 10}〜${(r.i + 1) * 10}%付近に${Math.round(r.p * 100)}%の割合で見つかった（仮説・全文は参照できる）`, support: info.totalWeight };
    });
  return { hints, withheld: null, used: info };
}

/** 本文の中で、検証できた根拠の引用が見つかる位置（相対位置の分布）。見つからない引用は数えない */
export function foundBucketsOf(text: string, quotes: readonly string[]): number[] {
  const out = new Array<number>(BUCKETS).fill(0);
  if (!text) return out;
  for (const q of quotes) {
    const at = text.indexOf(q.trim());
    if (q.trim().length < 6 || at < 0) continue;
    out[Math.min(BUCKETS - 1, Math.floor((at / text.length) * BUCKETS))]++;
  }
  return out;
}

export function buildExperience(a: { features: string[]; text: string; quotes: readonly string[]; verification: Verification; at: string; failedFields?: string[] }): ExperienceRecord | null {
  const found = foundBucketsOf(a.text, a.quotes);
  if (found.every((x) => x === 0)) return null; // 位置が分からない経験は、位置のヒントの材料にならない
  return { features: a.features.slice(0, 80), docChars: a.text.length, foundBuckets: found, verification: a.verification, at: a.at, ...(a.failedFields?.length ? { failedFields: a.failedFields.slice(0, 12) } : {}), version: EXPERIENCE_VERSION };
}

// ------------------------------------------------------------------ 評価: 改善が実証されないヒントは採用しない
export interface HintTrial {
  /** 検証済みの重要な条件の位置（字位置） */
  truth: number[];
  docChars: number;
  hinted: { from: number; to: number }[];
  /** ヒント無しで既に提示される範囲（先頭の抜粋・条件語の周辺） */
  baseline: { from: number; to: number }[];
}
const inAny = (x: number, r: readonly { from: number; to: number }[]): boolean => r.some((s) => x >= s.from && x < s.to);
/** 最初の提示範囲に重要条件が入っていた割合（ヒント無し/あり）。網羅性は read で担保されるため、ここは「最初の1回で届いたか」の効率の比較 */
export function evaluateHints(trials: readonly HintTrial[]): { points: number; baselineHit: number; hintedHit: number; gain: number } {
  let points = 0;
  let b = 0;
  let h = 0;
  for (const t of trials) {
    for (const x of t.truth) {
      points++;
      if (inAny(x, t.baseline)) b++;
      if (inAny(x, t.baseline) || inAny(x, t.hinted)) h++;
    }
  }
  const baselineHit = points ? b / points : 0;
  const hintedHit = points ? h / points : 0;
  return { points, baselineHit, hintedHit, gain: hintedHit - baselineHit };
}
/** 採用の条件: 十分な評価点があり、効率が実際に改善し、（比較のため）重大な悪化が無い。実証されない最適化は採用しない */
export function shouldAdopt(e: ReturnType<typeof evaluateHints>, o: { minPoints?: number; minGain?: number } = {}): boolean {
  return e.points >= (o.minPoints ?? 20) && e.gain >= (o.minGain ?? 0.05);
}
