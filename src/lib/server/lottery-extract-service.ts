import "server-only";
import { hasAnyContent, normalizeExtraction, type ExtractedLottery } from "@/lib/ai/extraction";
import { extractPageText, pageToPrompt } from "@/lib/ai/page-text";
import { ExtractorError, type ExtractRequest, type InputKind, type LotteryExtractor } from "@/lib/ai/provider";
import { fetchRespectingRobots, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { fetchXPost, isXHost, type XFetchResult } from "@/lib/server/x-source";

/**
 * 入力（文章・画像・店舗URL・X投稿URL）→ 本文の取得 → AI読み取り → 検証済みの抽選情報、までの共通処理。
 * 取得（URL）と解析（AI）は分離してあり、Stage 4C の定期収集も `extractFromText` 相当をそのまま呼べる。
 */

export type ExtractInput =
  | { kind: "text"; text: string }
  | { kind: "image"; images: NonNullable<ExtractRequest["images"]> }
  | { kind: "url"; url: string }
  | { kind: "x_url"; url: string };

export type ExtractFailCode = "not_configured" | "empty_input" | "fetch_failed" | "ai_failed" | "rate_limited" | "not_lottery" | "nothing_found";

export type ExtractResult =
  | {
      ok: true;
      kind: InputKind;
      engine: "anthropic" | "mock";
      model?: string;
      usage?: { input: number; output: number };
      extraction: ExtractedLottery;
      sourceUrl?: string;
      /** 画面に出す補足（一部しか取得できなかった等） */
      notices: string[];
    }
  | {
      ok: false;
      kind: InputKind;
      code: ExtractFailCode;
      message: string;
      /** 取得できないときに案内する代替の入力方法 */
      suggest?: "text" | "image";
      engine?: "anthropic" | "mock" | "none";
      /** 解析は行われたが結果として失敗（抽選でない等）のとき、費用管理のために使用モデルとトークン数を返す */
      model?: string;
      usage?: { input: number; output: number };
    };

export interface ExtractDeps {
  extractor: LotteryExtractor | null;
  now: Date;
  fetchPage?: (url: string) => Promise<SafeFetchResult>;
  fetchX?: (url: string) => Promise<XFetchResult>;
}

export const MAX_TEXT_CHARS = 20_000;
export const MAX_IMAGES = 4;

export async function runExtraction(input: ExtractInput, deps: ExtractDeps): Promise<ExtractResult> {
  const fetchPage = deps.fetchPage ?? ((u: string) => fetchRespectingRobots(u));
  const fetchX = deps.fetchX ?? fetchXPost;
  let kind: InputKind = input.kind;
  const notices: string[] = [];
  let req: ExtractRequest;

  if (!deps.extractor) {
    return {
      ok: false,
      kind,
      code: "not_configured",
      engine: "none",
      message: "AI読み取りはまだ設定されていません。管理者がAI APIキーを設定するまでは、通常の手動登録をご利用ください",
    };
  }

  switch (input.kind) {
    case "text": {
      const text = input.text.trim();
      if (text.length < 10) return { ok: false, kind, code: "empty_input", message: "告知の文章を貼り付けてください（10文字以上）" };
      if (text.length > MAX_TEXT_CHARS) notices.push(`文章が長いため先頭${MAX_TEXT_CHARS.toLocaleString()}文字だけを読み取りました`);
      req = { kind, text: text.slice(0, MAX_TEXT_CHARS), now: deps.now };
      break;
    }
    case "image": {
      if (input.images.length === 0) return { ok: false, kind, code: "empty_input", message: "画像を選択してください" };
      if (input.images.length > MAX_IMAGES) return { ok: false, kind, code: "empty_input", message: `画像は${MAX_IMAGES}枚までです` };
      req = { kind, images: input.images, now: deps.now };
      break;
    }
    case "url":
    case "x_url": {
      // 入力欄と種類が食い違っても、URLを見て取得方法を選ぶ（Xの投稿URLは公式の埋め込み取得、それ以外は通常のページ取得）
      kind = isXHost(input.url) ? "x_url" : "url";
      if (kind === "x_url") {
        const x = await fetchX(input.url);
        if (!x.ok) return { ok: false, kind, code: "fetch_failed", message: x.message, suggest: "text" };
        notices.push(...x.notice);
        req = { kind, text: x.text.slice(0, MAX_TEXT_CHARS), sourceUrl: input.url.trim(), now: deps.now };
      } else {
        const page = await fetchPage(input.url);
        if (!page.ok) return { ok: false, kind, code: "fetch_failed", message: `${page.message}。告知の文章をコピーして貼り付けるか、スクリーンショットを読み取ってください`, suggest: "text" };
        const text = extractPageText(page.body, page.finalUrl);
        if (text.text.length < 30) {
          return {
            ok: false,
            kind,
            code: "fetch_failed",
            message: "ページから文章を取得できませんでした（JavaScriptで表示されるページの可能性があります）。告知の文章をコピーするか、スクリーンショットを読み取ってください",
            suggest: "text",
          };
        }
        if (text.truncated || page.truncated) notices.push("ページが長いため、前半部分だけを読み取りました");
        notices.push("取得したページ本文のみを読み取っています。画像内の文字は読み取れないため、告知が画像の場合はスクリーンショットを使ってください");
        req = { kind, text: pageToPrompt(text), sourceUrl: page.finalUrl, now: deps.now };
      }
      break;
    }
  }

  try {
    const out = await deps.extractor.extract(req);
    const extraction = normalizeExtraction(out.raw, deps.now);
    if (!extraction.isLotteryAnnouncement) {
      return { ok: false, kind, code: "not_lottery", engine: out.engine, model: out.model, usage: out.usage, message: "抽選販売の告知とは判断できませんでした。内容を確認してください" };
    }
    if (!hasAnyContent(extraction)) {
      return { ok: false, kind, code: "nothing_found", engine: out.engine, model: out.model, usage: out.usage, message: "抽選に関する情報を読み取れませんでした。画像が不鮮明でないか、文章に抽選の情報が含まれているか確認してください", suggest: kind === "image" ? "text" : "image" };
    }
    return { ok: true, kind, engine: out.engine, model: out.model, usage: out.usage, extraction, sourceUrl: req.sourceUrl, notices };
  } catch (e) {
    if (e instanceof ExtractorError) {
      return { ok: false, kind, code: e.code === "rate_limited" ? "rate_limited" : "ai_failed", engine: deps.extractor.engine, model: e.model, usage: e.usage, message: e.message };
    }
    return { ok: false, kind, code: "ai_failed", engine: deps.extractor.engine, message: "読み取り中にエラーが発生しました。時間をおいて再度お試しください" };
  }
}
