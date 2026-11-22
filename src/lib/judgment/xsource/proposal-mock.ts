/**
 * 費用ゼロモード（モック）の調査AI・登録判断（Stage 10Z）。**実AIではない**。開発環境で「収集候補→調査→登録案→人のレビュー」の経路を、課金なしで通して動作を確認するための決定論的な代役。
 * 登録案には mode=mock と記録され、画面にも「モック（実AIではない）」と表示される。ここで得られた値を、AIの判断精度として扱わない。
 *  - 調査: 項目自身のリンク（出所を確認済み）があれば1回取得し、なければ（またはURLが取得できなければ）止める。親投稿の共通リンクは取得しない（誤った流用をしない）。
 *  - 判断: 取得したページの題名・受付枠の構造から、引用つきの項目だけを observed にする。それ以外は inferred／unknown。**本登録（register）は返さない**（モックは暫定止まり）。
 *  - 意味判断の固定ルールを増やす目的ではない（実AIに差し替える前提の、経路確認用のスタブ）。
 */
import type { AgentTurnOutput, Evidence, JudgeOutput, RegistrationJudge, ResearchAgent } from "./research-loop";

const turn = (next: AgentTurnOutput["next"]): AgentTurnOutput => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], next, costJpy: 0 });

export const mockResearchAgent: ResearchAgent = async (i) => {
  const fetched = i.history.length > 0;
  const seed = i.evidence.find((e) => e.kind === "seed");
  const own = /この項目自身のリンク: (https:\/\/\S+)/.exec(seed?.excerpt ?? "");
  if (!fetched && own) return turn({ kind: "fetch", url: own[1], why: "項目自身のリンクの確認" });
  if (fetched && i.history.some((h) => h.outcome !== "ok")) return turn({ kind: "stop", reason: "unreachable", why: "取得できなかった" });
  return turn({ kind: "stop", reason: own ? "sufficient" : "no_progress", why: own ? "取得済み" : "項目自身のリンクが無い" });
};

type EvView = Parameters<RegistrationJudge>[0]["evidence"][number];

export const mockRegistrationJudge: RegistrationJudge = async (input) => {
  const page = input.evidence.find((e: EvView) => e.kind === "page" && e.scope?.verdict !== "mismatch");
  const seed = input.evidence.find((e: EvView) => e.kind === "seed");
  const fields: JudgeOutput["fields"] = {};
  const titleLine = page?.excerpt.split("\n").map((l) => l.trim()).find((l) => l.length >= 8 && /抽選|受付|【/.test(l));
  if (page && titleLine) {
    fields.product = { value: titleLine.replace(/^【[^】]*】/, "").trim() || titleLine, basis: "observed", evidenceId: page.id, quote: titleLine };
    const store = /【([^】]{2,40})】/.exec(titleLine)?.[1];
    fields.store = store ? { value: store, basis: "observed", evidenceId: page.id, quote: `【${store}】` } : { value: null, basis: "unknown" };
  } else {
    fields.product = { value: null, basis: "unknown" };
    fields.store = { value: null, basis: "unknown" };
  }
  const dl = /(\d{1,2}\/\d{1,2})[^\d]{0,6}(\d{1,2}:\d{2})?/.exec(seed?.excerpt ?? "");
  fields.deadline = dl ? { value: dl[1], basis: "inferred" } : { value: null, basis: "unknown" };
  // 応募単位: ページの構造（受付枠の数）から推論に留める。確証が無ければ unknown（観察とは書かない）
  const obs = page?.observations.join(" ") ?? "";
  const slots = /受付枠\s*(\d+)\s*件/.exec(obs)?.[1];
  fields.apply_unit = slots === "1" ? { value: "one_form_one", basis: "inferred" } : { value: null, basis: "unknown" };
  const observed = Object.values(fields).filter((f) => f.basis === "observed").length;
  const out: JudgeOutput = {
    decision: "tentative", // モックは本登録（register）を返さない
    fields,
    rationale: "モック（実AIではない）: 取得したページの題名と構造から、引用のある項目だけを観察とした",
    unresolvedImpact: observed >= 2 ? "minor" : "material",
    monitor: { continue: true, why: "モック" },
    costJpy: 0,
  };
  return out;
};

export type { Evidence };
