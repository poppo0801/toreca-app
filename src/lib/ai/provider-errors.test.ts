// @vitest-environment node
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { mapApiError } from "@/lib/ai/provider";

const apiErr = (status: number, message: string) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

describe("AI APIのエラーを利用者向けの案内に変換する", () => {
  it("認証失敗・権限なし・モデルなし・残高不足・混雑・上限・大きすぎる入力を区別する", () => {
    expect(mapApiError(apiErr(401, "invalid x-api-key")).message).toContain("APIキーが無効か失効");
    expect(mapApiError(apiErr(403, "forbidden")).message).toContain("許可されていません");
    expect(mapApiError(apiErr(404, "model: not found")).message).toContain("AI_MODEL");
    expect(mapApiError(apiErr(400, "Your credit balance is too low to access the Anthropic API.")).message).toContain("残高が不足");
    expect(mapApiError(apiErr(529, "Overloaded")).message).toContain("混み合っています");
    expect(mapApiError(apiErr(413, "too large")).message).toContain("大きすぎます");
    const rate = mapApiError(apiErr(429, "rate limit"));
    expect(rate.code).toBe("rate_limited");
  });

  it("通常の400や不明なエラーは状態だけを伝え、メッセージ本体（キーや入力を含みうる）は出さない", () => {
    const e = mapApiError(apiErr(400, "messages.0.content: sk-ant-SECRET-KEY-VALUE invalid"));
    expect(e.message).toContain("状態 400");
    expect(e.message).not.toContain("SECRET");
    expect(mapApiError(new Error("sk-ant-SECRET")).message).not.toContain("SECRET");
    expect(mapApiError(new Error("x")).code).toBe("api_error");
  });
});
