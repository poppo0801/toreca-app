// @vitest-environment node
/**
 * Stage 10V: 保存済みの実在の公開投稿（本番収集の保存原文。Git管理外のローカルの書き出し）を、X起点の接続（項目分割→項目ごとの応募先リンクの出所）に通した**実測**（AIは呼ばない・無料）。
 * 「URLが各項目に対応づいて保存されているか」を測る: 保存データには展開結果（linkMap）が無いため、項目の応募先URLは復元できない（10S）。その実態を数える。
 * 出力: eval/real-data/xsource-10v-provenance.json（集計のみ・原文を含まない・Git管理外）。ファイルが無ければスキップ。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { planXPost } from "./x-origin";

const dir = "backups/refresh-10g";
const file = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("evidence-")).sort().at(-1) : undefined;
describe.skipIf(!file)("X起点の接続: 保存済みの実投稿の項目別リンクの出所（実測・AIなし）", () => {
  it("一覧投稿・単独投稿ごとに、項目の応募先URLの状態を集計する", () => {
    const rows = (JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { rows: { id: string; links?: string[]; text: string }[] }).rows;
    let posts = 0;
    let lists = 0;
    const status: Record<string, number> = {};
    const methods: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    let items = 0;
    let recoveredPosts = 0;
    for (const r of rows) {
      const p = planXPost({ postId: r.id.slice(0, 8), text: r.text, links: (r.links ?? []).filter((u) => /^https:\/\//.test(u)), recordedAt: null });
      posts++;
      if (p.isList) lists++;
      if (p.items.some((it) => it.linkEvidence.some((e) => e.method === "stored_unique_pair"))) recoveredPosts++;
      for (const it of p.items) {
        items++;
        status[it.status] = (status[it.status] ?? 0) + 1;
        for (const e of it.linkEvidence) {
          methods[e.method] = (methods[e.method] ?? 0) + 1;
          outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
        }
      }
    }
    writeFileSync("eval/real-data/xsource-10v-provenance.json", JSON.stringify({ note: "保存済みの実投稿（原文は含まない）。改善前（10V）: url_from_item 0 / short_unexpanded 298 / url_missing 84。改善後: 一意に決まる対応だけを既存の保存情報から復元（stored_unique_pair）。展開結果（linkMap）は保存されていないため x_api_entity は 0", posts, listPosts: lists, items, status, linkEvidenceMethods: methods, linkEvidenceOutcomes: outcomes, postsWithRecoveredLink: recoveredPosts }, null, 1));
  });
});
