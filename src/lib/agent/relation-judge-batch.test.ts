// @vitest-environment node
import { describe, expect, it } from "vitest";
import { JUDGE_BATCH, judgeRelations, type RelFacts } from "./relation-judge";

/** 組の数が多いと応答が途中で切れて判断が1件も得られなかった不具合（9H-3S-3の実AI検証で発見）の再発防止: 少数ずつ分けて判断し、切れた回数を報告する */
const lot = (id: string, store: string): RelFacts => ({ id, chain: "系列", store, storeMode: "fixed", products: ["商品"], applyStart: null, applyDeadline: "2026-11-30", resultDate: null, urls: [], humanConfirmed: false });

describe("関係判定の分割", () => {
  it("組を JUDGE_BATCH 件ずつに分けて呼び出し、結果を合わせる。切れた応答は truncated に数える", async () => {
    const lots = Array.from({ length: 6 }, (_, i) => lot(`l${i}`, `店${i}`));
    const pairs: [string, string][] = [];
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) pairs.push([`l${i}`, `l${j}`]);
    const calls: number[] = [];
    let n = 0;
    const client = {
      messages: {
        create: async (req: { messages: { content: string }[] }) => {
          const asked = JSON.parse(req.messages[0].content.split("判断する組: ")[1]) as [string, string][];
          calls.push(asked.length);
          n++;
          return { stop_reason: n === 2 ? "max_tokens" : "tool_use", content: [{ type: "tool_use", id: "t", name: "report_relations", input: { judgments: n === 2 ? [] : asked.map(([a, b]) => ({ a, b, relation: "same_series_other_store", rationale: "別店舗", cites: ["店舗"] })) } }], usage: { input_tokens: 10, output_tokens: 5 } };
        },
      },
    };
    const out = await judgeRelations(client as never, "m", lots, pairs);
    expect(Math.max(...calls)).toBeLessThanOrEqual(JUDGE_BATCH);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(pairs.length);
    expect(out.truncated).toBe(1);
    expect(out.judgments.length).toBe(pairs.length - calls[1]); // 切れた回の組だけ判断が無い（判断できないものとして扱う）
    expect(out.usage.inputTokens).toBe(10 * calls.length);
  });
});
