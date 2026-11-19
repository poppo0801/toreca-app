// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeNames, nameSearchQueries, verifyNameJudgment, type NameJudgment, type NameQuery } from "./name-judge";
import { decideAliasLearning } from "@/lib/master-identity/learning";
import { resolveName, type MasterEntry } from "@/lib/master-identity/resolve";

const q: NameQuery = { kind: "chain", observed: "GIRAFULL", candidateId: "m1", candidateName: "ジラフル", candidateAliases: [] };
const hits = [
  { title: "GIRAFULL（ジラフル）トレカ通販", url: "https://girafull.example.com/about", snippet: "GIRAFULL（ジラフル）は秋葉原のトレカ専門店です" },
  { title: "ジラフル 秋葉原 | GIRAFULL", url: "https://news.example.org/a", snippet: "ジラフル（GIRAFULL）の新店舗がオープン" },
  { title: "その他", url: "https://blog.example.net/x", snippet: "GIRAFULLという店に行ってきました" },
];
const j = (over: Partial<NameJudgment> = {}): NameJudgment => ({ observed: "GIRAFULL", candidateId: "m1", relation: "same", rationale: "併記", cites: [{ url: hits[0].url, quote: "GIRAFULL（ジラフル）は秋葉原のトレカ専門店です" }, { url: hits[1].url, quote: "ジラフル（GIRAFULL）の新店舗がオープン" }], ...over });

describe("系列名・商品名の同一性判定（9H-3S-3）", () => {
  it("両方の名称が併記された原文が独立した2ドメインで実在すれば、別名学習の根拠（independent_sources）になる", () => {
    const v = verifyNameJudgment(j(), q, hits);
    expect(v.relation).toBe("same");
    expect(v.independentDomains).toBe(2);
    expect(v.evidence[0]).toMatchObject({ kind: "independent_sources", sources: 2 });
  });
  it("引用が検索結果に実在しない・片方の名称しかない引用は根拠にならず、同一とは扱わない", () => {
    expect(verifyNameJudgment(j({ cites: [{ url: hits[0].url, quote: "捏造された引用 GIRAFULL ジラフル" }] }), q, hits).relation).toBe("undetermined");
    expect(verifyNameJudgment(j({ cites: [{ url: hits[2].url, quote: "GIRAFULLという店に行ってきました" }] }), q, hits).relation).toBe("undetermined");
  });
  it("併記の原文が1つのサイトだけのとき: 読み・音が近い名称（ジラフル⇔GIRAFULL）は、その2つが揃ったことを根拠にする。音が離れた名称は、別名の自動学習の根拠にならない", () => {
    const v = verifyNameJudgment(j({ cites: [j().cites[0]] }), q, hits);
    expect(v.relation).toBe("same");
    expect(v.evidence[0]).toMatchObject({ kind: "reading_with_source" });
    const far: NameQuery = { kind: "chain", observed: "古本市場", candidateId: "m2", candidateName: "ふるいち", candidateAliases: [] };
    const fh = [{ title: "古本市場・ふるいち【公式】", url: "https://furu1.example.test/", snippet: "古本市場・ふるいち【公式】アカウント" }];
    const fv = verifyNameJudgment({ observed: "古本市場", candidateId: "m2", relation: "same", rationale: "x", cites: [{ url: fh[0].url, quote: "古本市場・ふるいち【公式】アカウント" }] }, far, fh);
    expect(fv.relation).toBe("same");
    expect(fv.evidence).toEqual([]); // 1サイトだけ・音が離れている → 関連候補止まり
  });
  it("独立管理の系列・商品の型番や版の食い違いは、AIが同一と言っても同一にしない", () => {
    const ind: NameQuery = { kind: "chain", observed: "イオンオンライン", candidateId: "a", candidateName: "イオン", candidateAliases: [] };
    const h = [{ title: "t", url: "https://a.example.com/", snippet: "イオンオンライン（イオン）" }, { title: "t", url: "https://b.example.com/", snippet: "イオンオンライン（イオン）" }];
    const jj: NameJudgment = { observed: "イオンオンライン", candidateId: "a", relation: "same", rationale: "x", cites: h.map((x) => ({ url: x.url, quote: "イオンオンライン（イオン）" })) };
    expect(verifyNameJudgment(jj, ind, h).relation).toBe("different");
    const pq: NameQuery = { kind: "product", observed: "ポケモンカード 拡張パック M2 BOX", candidateId: "p", candidateName: "ポケモンカード 拡張パック M3 BOX", candidateAliases: [] };
    const ph = [{ title: "t", url: "https://a.example.com/", snippet: "ポケモンカード 拡張パック M2 BOX ポケモンカード 拡張パック M3 BOX" }];
    const pj: NameJudgment = { observed: pq.observed, candidateId: "p", relation: "same", rationale: "x", cites: [{ url: ph[0].url, quote: ph[0].snippet }] };
    expect(verifyNameJudgment(pj, pq, ph).relation).toBe("different");
  });
  it("検証を通った同一判定が、別名学習の判断（add_alias・AI推定）へつながる。根拠が1ドメインなら関連候補止まり", () => {
    const masters: MasterEntry[] = [{ id: "m1", name: "ジラフル" }];
    const res = resolveName("chain", "GIRAFULL", masters);
    expect(res.status).toBe("candidate"); // 音が近い候補
    const strong = verifyNameJudgment(j(), q, hits);
    expect(decideAliasLearning({ kind: "chain", observedName: "GIRAFULL", resolution: res, evidence: strong.evidence, origin: "ai", masters }).action).toBe("add_alias");
    // 根拠が全く無い（併記の原文なし）なら、読みが近くても関連候補止まり
    expect(decideAliasLearning({ kind: "chain", observedName: "GIRAFULL", resolution: res, evidence: [], origin: "ai", masters }).action).toBe("hold_candidate");
    // 併記の原文1件＋読みの近さ → 別名（AI推定）
    const weak = verifyNameJudgment(j({ cites: [j().cites[0]] }), q, hits);
    expect(decideAliasLearning({ kind: "chain", observedName: "GIRAFULL", resolution: res, evidence: weak.evidence, origin: "ai", masters }).action).toBe("add_alias");
  });
  it("実際のクライアント経路: 強制ツール呼び出しの結果を検証して返す", async () => {
    const client = { messages: { create: async () => ({ content: [{ type: "tool_use", id: "t", name: "report_name_relations", input: { judgments: [j()] } }], usage: { input_tokens: 10, output_tokens: 5 } }) } };
    const out = await judgeNames(client as never, "m", [{ query: q, hits }]);
    expect(out.judgments).toHaveLength(1);
    expect(out.judgments[0].relation).toBe("same");
    expect(nameSearchQueries(q)).toHaveLength(2);
  });
});
