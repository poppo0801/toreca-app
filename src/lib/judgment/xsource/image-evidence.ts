/**
 * 画像を一次情報として扱う（Phase 2・純関数＋注入されたビジョンクライアント）。
 *
 * 位置づけ:
 *  - X投稿・応募ページの画像に、応募期間・店・商品・応募単位が書かれていることがある（本文には無い／本文と矛盾する）。
 *  - 収集時に既に画像を解析した結果（ImageReading。AIの読み取りで原本と未照合）があれば**再利用**し、同じ画像を重ねて課金解析しない。
 *    読み取りの無い画像だけを、注入された VisionClient で解析する（実装は既定でモック。**有料のビジョン実行は別途の明示承認が必要**で、ここでは呼ばない）。
 *  - 画像から読んだ内容は**仮説**であり、原文の確認済み事実へ昇格させない（引用の根拠にしない・観察としてAIに渡す）。
 *    本文と一致すれば「本文でも確認」、本文と矛盾すれば**矛盾として残して未確定**にし（無言でどちらかを採用しない）、画像だけにある情報は「画像のみ・原本未照合」とする。
 *  - 読めなかった・解析できなかった・上限で解析しなかった画像も、状態として残す（画像の内容を「無い」と扱わない＝重要条件を無言で除外しない）。
 */
import type { ImageReading } from "@/lib/collector/evidence";

export interface VisionReading {
  field: string;
  text: string;
  /** 画像内の位置の記述（例: 「右下の注意書き」）。原本照合の手がかり。無ければ空 */
  region?: string;
  uncertainty?: "high" | "medium" | "low";
}
export interface VisionRequest {
  imageUrl: string;
  /** 1始まりの画像番号（収集時の画像参照の並び） */
  imageIndex: number;
  /** 読み取ってほしい項目（応募期間・店・商品・応募単位・購入条件 など） */
  wantFields: string[];
}
/** 注入されるビジョンクライアント。失敗・読み取れないときは null（例外を投げない）。実AIの実装はここでは作らない */
export type VisionClient = (req: VisionRequest) => Promise<{ readings: VisionReading[] } | null>;

export type ImageStatusKind = "reused" | "analyzed" | "unreadable" | "failed" | "skipped_limit" | "not_analyzed";
export interface ImageObservation {
  imageIndex: number;
  url: string;
  status: ImageStatusKind;
  /** この画像由来の読み取り（再利用・新規）。仮説であり、原文の事実ではない */
  readings: { field: string; text: string; uncertainty: "high" | "medium" | "low" | null; origin: "collector_reading" | "vision"; region?: string }[];
}

export type Reconcile = "confirmed_by_text" | "conflict" | "image_only" | "text_only_unverifiable";
export interface ReconciledReading {
  imageIndex: number;
  field: string;
  imageText: string;
  status: Reconcile;
  /** 矛盾したときの本文側の値（比較に使った日付・数値の表記） */
  textValues?: string[];
  uncertainty: "high" | "medium" | "low" | null;
}

export interface ImageAnalysisResult {
  observations: ImageObservation[];
  reconciled: ReconciledReading[];
  /** AIへ渡す注記（観察。引用の根拠にしない） */
  notes: string[];
  counts: { images: number; reused: number; analyzed: number; failed: number; skipped: number; conflicts: number };
}

export const DEFAULT_WANT_FIELDS = ["応募期間", "応募開始", "応募締切", "当選発表", "対象店舗", "対象商品", "応募単位（店舗選択・商品ごと）", "購入条件・会員条件", "受取方法"];
export const MAX_VISION_ANALYSES = 4;

const nfkc = (s: string): string => s.normalize("NFKC");
const DATE_FIELD = /(deadline|start|end|date|period|result|announce|期間|締切|開始|終了|発表|日)/i;

/** 文字列から日付（月/日）を集める。「11/30」「11月30日」「2026-11-30」など。年は無視して月日で比較（年またぎの誤判定を避けるため月日だけ） */
export function dateTokens(text: string): string[] {
  const t = nfkc(text);
  const out = new Set<string>();
  for (const m of t.matchAll(/(?:\d{4}[/.\-年])?\s*(?<!\d)(\d{1,2})\s*[/月.\-]\s*(\d{1,2})(?!\d)\s*日?/g)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.add(`${mo}/${d}`);
  }
  return [...out];
}

const compact = (s: string): string => nfkc(s).replace(/[\s　・、,。.\-ー_()（）「」『』【】]/g, "").toLowerCase();

/**
 * 画像の読み取りを、本文と突き合わせる。日付項目は月日の集合で比較（共通があれば一致、両方に日付があるのに共通が無ければ矛盾）。
 * その他の項目は、片方がもう片方を含めば本文でも確認、そうでなければ「画像のみ」（矛盾とは断定しない。表記の違いの可能性）。
 */
export function reconcileReading(field: string, imageText: string, postText: string): { status: Reconcile; textValues?: string[] } {
  if (DATE_FIELD.test(field) || dateTokens(imageText).length > 0) {
    const img = dateTokens(imageText);
    const txt = dateTokens(postText);
    if (img.length > 0 && txt.length > 0) {
      if (img.some((d) => txt.includes(d))) return { status: "confirmed_by_text" };
      return { status: "conflict", textValues: txt.slice(0, 6) };
    }
    return { status: img.length > 0 ? "image_only" : "text_only_unverifiable" };
  }
  const a = compact(imageText);
  const b = compact(postText);
  if (a.length >= 2 && b.includes(a)) return { status: "confirmed_by_text" };
  return { status: "image_only" };
}

export async function analyzeImages(a: {
  /** 画像の公開URL（投稿・引用元の添付。収集時の imageRefs） */
  imageRefs: readonly string[];
  /** 収集時の画像解析の読み取り（再利用する。画像番号が分かるものは、その画像の解析済みとして扱う） */
  existing: readonly ImageReading[];
  /** 比較に使う投稿・ページ本文 */
  postText: string;
  vision?: VisionClient;
  wantFields?: string[];
  maxAnalyses?: number;
}): Promise<ImageAnalysisResult> {
  const want = a.wantFields ?? DEFAULT_WANT_FIELDS;
  const max = a.maxAnalyses ?? MAX_VISION_ANALYSES;
  const refs = a.imageRefs.filter((u) => /^https:\/\//.test(u));
  const total = refs.length;
  // 画像番号が分からない読み取りは、画像が1枚だけのときだけ「その画像の読み取り」として扱う（複数枚のとき、どの画像か分からないものを全画像の解析済みにしない）
  const byIndex = (i: number): ImageReading[] => a.existing.filter((r) => r.imageIndex === i || (r.imageIndex === null && total === 1));
  const obs: ImageObservation[] = [];
  let analyzed = 0;
  for (let i = 1; i <= total; i++) {
    const url = refs[i - 1];
    const have = byIndex(i);
    if (have.length > 0) {
      obs.push({ imageIndex: i, url, status: "reused", readings: have.map((r) => ({ field: r.field, text: r.text, uncertainty: r.uncertainty, origin: "collector_reading" as const })) });
      continue;
    }
    if (!a.vision) {
      obs.push({ imageIndex: i, url, status: "not_analyzed", readings: [] });
      continue;
    }
    if (analyzed >= max) {
      obs.push({ imageIndex: i, url, status: "skipped_limit", readings: [] });
      continue;
    }
    analyzed++;
    const r = await a.vision({ imageUrl: url, imageIndex: i, wantFields: want }).catch(() => null);
    if (!r) obs.push({ imageIndex: i, url, status: "failed", readings: [] });
    else if (r.readings.length === 0) obs.push({ imageIndex: i, url, status: "unreadable", readings: [] });
    else obs.push({ imageIndex: i, url, status: "analyzed", readings: r.readings.slice(0, 20).map((x) => ({ field: x.field.slice(0, 40), text: x.text.slice(0, 300), uncertainty: x.uncertainty ?? null, origin: "vision" as const, ...(x.region ? { region: x.region.slice(0, 80) } : {}) })) });
  }
  const reconciled: ReconciledReading[] = obs.flatMap((o) =>
    o.readings.map((r) => {
      const c = reconcileReading(r.field, r.text, a.postText);
      return { imageIndex: o.imageIndex, field: r.field, imageText: r.text, status: c.status, ...(c.textValues ? { textValues: c.textValues } : {}), uncertainty: r.uncertainty };
    }),
  );
  const notes: string[] = [];
  for (const r of reconciled) {
    const head = `画像${r.imageIndex}枚目・${r.field}`;
    const unc = r.uncertainty ? `・確度${r.uncertainty}` : "";
    if (r.status === "conflict") notes.push(`【矛盾・未確定】${head}「${r.imageText.slice(0, 60)}」は本文の日付（${(r.textValues ?? []).join("・")}）と食い違う（どちらも確認済みとしない。人または別の一次情報で確認が必要${unc}）`);
    else if (r.status === "image_only") notes.push(`${head}「${r.imageText.slice(0, 80)}」は画像のみの情報（AIの読み取り・原本と未照合・事実として確定しない${unc}）`);
    else if (r.status === "confirmed_by_text") notes.push(`${head}「${r.imageText.slice(0, 60)}」は本文でも確認できる`);
  }
  const bad = obs.filter((o) => o.status === "failed" || o.status === "unreadable" || o.status === "skipped_limit" || o.status === "not_analyzed");
  if (bad.length) notes.push(`画像${bad.map((o) => o.imageIndex).join("・")}枚目は内容を確認できていない（${[...new Set(bad.map((o) => ({ failed: "解析に失敗", unreadable: "文字を読み取れない", skipped_limit: "解析の上限で未実施", not_analyzed: "未解析", reused: "", analyzed: "" })[o.status]))].join("・")}）。画像の内容は「無い」ではなく未確認`);
  return {
    observations: obs,
    reconciled,
    notes,
    counts: { images: total, reused: obs.filter((o) => o.status === "reused").length, analyzed: obs.filter((o) => o.status === "analyzed").length, failed: obs.filter((o) => o.status === "failed" || o.status === "unreadable").length, skipped: obs.filter((o) => o.status === "skipped_limit" || o.status === "not_analyzed").length, conflicts: reconciled.filter((r) => r.status === "conflict").length },
  };
}

/** テスト・開発用のモック（費用0）。画像URL→読み取りの固定表を返す。表に無い画像は読み取れない（unreadable）。実AIではない */
export function mockVision(table: Record<string, VisionReading[] | null>, calls?: VisionRequest[]): VisionClient {
  return async (req) => {
    calls?.push(req);
    const r = table[req.imageUrl];
    return r === undefined ? { readings: [] } : r === null ? null : { readings: r };
  };
}
