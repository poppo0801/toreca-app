/**
 * X投稿を、AI解析（有料）へ回すか判定する（Stage 6B・純関数）。
 * まとめアカウントの投稿は、抽選情報が画像・引用元・リンク先にあり、本文は短い（または絵文字だけ）ことが多い。
 * 本文のキーワードだけで画像付きの投稿を落とさない。ただし、すべての画像付き投稿を無条件に解析するわけではなく、
 * 他のTCGが主題のもの・抽選と無関係な長文・古い投稿は解析しない。
 */
import { judgeRelevance, looksLikeLottery } from "@/lib/collector/listing";

export type XPass = "text" | "image" | "quote" | "link";
export type XSkip = "other_tcg" | "no_signal" | "stale";

export interface XJudgeInput {
  text: string;
  images: string[];
  links: string[];
  createdAt?: string;
  quoted?: { text: string; images: string[]; links: string[] } | null;
}

/** 古い投稿は受付が終わっていることが多いので解析しない（既定は30日） */
export const X_STALE_DAYS = 30;
/** 画像中心とみなす本文の長さ（URL・空白を除く）。これより長く抽選の語も無い本文は、雑談・広告とみなす */
const IMAGE_CENTRIC_MAX = 60;

const bare = (s: string) => s.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "");

export function judgeXPost(p: XJudgeInput, now: Date): { pass: true; basis: XPass } | { pass: false; skip: XSkip } {
  if (p.createdAt) {
    const age = (now.getTime() - new Date(p.createdAt).getTime()) / 86_400_000;
    if (Number.isFinite(age) && age > X_STALE_DAYS) return { pass: false, skip: "stale" };
  }
  const q = p.quoted ?? null;
  const all = [p.text, q?.text ?? ""].join("\n");
  const rel = judgeRelevance(all, { fromPokemonList: false });
  // 他のTCGが主題（ポケモンカードの言及が無い）なら、画像があっても解析しない
  if (!rel.relevant && !rel.uncertain) return { pass: false, skip: "other_tcg" };
  if (rel.relevant) return { pass: true, basis: p.text && judgeRelevance(p.text, {}).relevant ? "text" : "quote" };
  // ポケモンカードの言及が本文に無い: 画像・引用・リンクがあり、抽選の語がある、または本文が短い（画像中心）ときだけ解析する
  const hasImg = p.images.length > 0 || (q?.images.length ?? 0) > 0;
  const lottery = looksLikeLottery(all);
  const short = bare(p.text).length <= IMAGE_CENTRIC_MAX;
  if (hasImg && (lottery || short)) return { pass: true, basis: "image" };
  if (q && (lottery || short)) return { pass: true, basis: "quote" };
  if (lottery && (p.links.length > 0 || (q?.links.length ?? 0) > 0)) return { pass: true, basis: "link" };
  return { pass: false, skip: "no_signal" };
}

export interface XFunnel {
  fetched: number;
  passed: Record<XPass, number>;
  skipped: Record<XSkip, number>;
  withImages: number;
  withQuote: number;
  withLinks: number;
  existing: number;
  saved: number;
  saveFailed: number;
}
export const emptyFunnel = (): XFunnel => ({ fetched: 0, passed: { text: 0, image: 0, quote: 0, link: 0 }, skipped: { other_tcg: 0, no_signal: 0, stale: 0 }, withImages: 0, withQuote: 0, withLinks: 0, existing: 0, saved: 0, saveFailed: 0 });

/** 収集元の1回の取得結果の要約（画面・記録用の1行） */
export function funnelLine(f: XFunnel): string {
  const passed = f.passed.text + f.passed.image + f.passed.quote + f.passed.link;
  const skipped = f.skipped.other_tcg + f.skipped.no_signal + f.skipped.stale;
  return `投稿${f.fetched}件（画像付き${f.withImages}・引用${f.withQuote}・リンク${f.withLinks}）→ 解析対象${passed}件（本文${f.passed.text}・画像${f.passed.image}・引用${f.passed.quote}・リンク${f.passed.link}）／対象外${skipped}件（他TCG${f.skipped.other_tcg}・関連なし${f.skipped.no_signal}・古い${f.skipped.stale}）／新規保存${f.saved}件${f.saveFailed ? `・保存失敗${f.saveFailed}件` : ""}`;
}
