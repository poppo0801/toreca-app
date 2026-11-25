// @vitest-environment node
/**
 * P2（実AIの通し試験）の結果を、人が確認できる比較資料にする（ローカル限定・読み取り専用・無課金。AI・Webに接続しない）。
 *   PROPOSAL_P2_REVIEW=1 npx vitest run src/lib/server/proposals/p2-review.local.test.ts
 * 入力: ローカルDBの登録案（eval-p 候補）＋ ローカルの保存ページ（10T）＋ 10S の回答（gold）。出力: eval/real-data/p2-review.{md,json}（Git管理外。原文・URL・値を含むのでGitに入れない）。
 * **gold がある事例だけ採点**。AIの出力・旧アプリの出力・検証通過を正解扱いしない。値の導出は「語の一致の粗い確認」であり正しさの判定ではない。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error plain JS module
import { classifyGold } from "../../../../scripts/lib/gold-c.mjs";
// @ts-expect-error plain JS module
import { currentOf } from "../../../../scripts/lib/groundtruth.mjs";
import { pageText } from "@/lib/judgment/xsource/html-text";
import { parseApplyPage } from "@/lib/judgment/xsource/page-structure";
import { valueSupport } from "@/lib/judgment/xsource/proposal";

const env = process.env;
const nf = (s: string): string => s.normalize("NFKC").replace(/[\s　「」『』【】()（）・:：、,，.。]+/g, "").toLowerCase();
/** 値の語（4文字の連続）が、本文にどれだけ含まれるか（0〜1）。書式・括弧・空白の違いを吸収した粗い近さ。数値・日付の一致は別（valueSupport） */
const coverage = (value: string, text: string): number => {
  const v = nf(value);
  const t = nf(text);
  if (v.length < 4) return t.includes(v) ? 1 : 0;
  let hit = 0;
  let n = 0;
  for (let i = 0; i + 4 <= v.length; i++) {
    n++;
    if (t.includes(v.slice(i, i + 4))) hit++;
  }
  return n ? hit / n : 0;
};

describe.skipIf(env.PROPOSAL_P2_REVIEW !== "1")("P2 比較資料（ローカル限定）", () => {
  it("登録案・保存ページ・gold から、人が確認する箇所を書き出す", async () => {
    const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("ローカルのSupabase以外には接続しません");
    const db = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: cands } = await db.from("collection_candidates").select("id,dedupe_key").like("dedupe_key", "https://eval-p.invalid/%");
    const keyOf = new Map((cands ?? []).map((c) => [c.id as string, (c.dedupe_key as string).replace("https://eval-p.invalid/", "")]));
    const { data: props } = await db.from("registration_proposals").select("candidate_id,decision,verified,apply_unit,apply_unit_basis,fields,unknowns,held_reasons,pages,end_reason,turns,cost_jpy,url_status").in("candidate_id", [...keyOf.keys()]).is("superseded_at", null);
    const idx = JSON.parse(readFileSync("eval/real-data/10t-html/index.json", "utf8")) as { n: number; url: string }[];
    const review = JSON.parse(readFileSync("eval/real-data/human-review-10s.json", "utf8")) as { cases: { id: string; real: boolean; aiUnit?: string; sourceText: string[] }[] };
    const gold = classifyGold(review.cases, JSON.parse(readFileSync("eval/real-data/human-review-10s-answers.json", "utf8")), currentOf);
    const goldBy = new Map((gold.rows as { id: string; category: string; gold: { unit: string; basis: string | null } | null; priorAiUnit: string | null }[]).map((r) => [r.id, r]));
    const out: string[] = ["# P2 比較資料（ローカル限定・Git管理外）", "", "AIの値・引用は実AIの出力です。**正しさは未確認**。『語の近さ』は4文字連続の一致率で、正しさの判定ではありません。", ""];
    const rows: unknown[] = [];
    const near = { total: 0, notFoundStrict: 0, nearAtLeast80: 0 };
    const resupport: Record<string, number> = {}; // 修正後の導出分類（同じ保存済みの値・引用・本文を、新しい分類で再計算。AIの再実行ではない）
    for (const p of (props ?? []).slice().sort((a, b) => String(keyOf.get(a.candidate_id)).localeCompare(String(keyOf.get(b.candidate_id)), "en", { numeric: true }))) {
      const k = keyOf.get(p.candidate_id)!;
      const fields = p.fields as Record<string, { value: string | null; basis: string; quote: string | null; support: string }>;
      let text = "";
      let slots: string[] = [];
      let oldSlots: number | null = null;
      let extra = "";
      if (k.startsWith("lp/")) {
        const n = Number(k.slice(3));
        const html = readFileSync(`eval/real-data/10t-html/lp-${n}.html`, "utf8");
        text = pageText(html);
        const st = parseApplyPage(html);
        oldSlots = st.slots.length;
        slots = st.slots.map((s) => `${s.title}${s.statusTags.length ? ` [${s.statusTags.join(",")}]` : ""}`);
        extra = `旧方式（決定論のページ構造解析）の読み取り: 受付枠 ${st.slots.length}／関連イベント ${st.relatedEvents.length}。ページ全体の注意: ${st.pageNotes.join(" / ") || "なし"}`;
        void idx;
      } else {
        const id = k.slice(5);
        const c = review.cases.find((x) => x.id === id);
        text = (c?.sourceText ?? []).join(" ");
        const g = goldBy.get(id);
        extra = `元の文言: ${text.slice(0, 300)}／**gold: ${g?.category === "gold" ? `${g.gold?.unit}（根拠: ${g.gold?.basis ?? "なし"}）` : "なし"}**／以前のAIの応募単位（旧方式。参考。正解ではない）: ${g?.priorAiUnit ?? "—"}`;
      }
      out.push(`## ${k}`, `- 判断: ${p.decision}（引用の検証 ${p.verified ? "通過" : "未通過"}${(p.held_reasons as string[]).length ? `: ${(p.held_reasons as string[]).join(",")}` : ""}）／終了: ${p.end_reason}／調査 ${p.turns}回／費用 ¥${p.cost_jpy}／応募単位: ${p.apply_unit}（${p.apply_unit_basis}）`, `- ${extra}`);
      if (slots.length) out.push(`- ページの受付枠: ${slots.join(" ／ ")}`);
      for (const [name, f] of Object.entries(fields)) {
        const cov = f.value ? coverage(f.value, text) : null;
        if (f.basis === "observed") {
          const isUnit = /apply_?unit/i.test(name) && ["one_form_one", "store_select", "per_store", "per_product"].includes(String(f.value));
          const re = isUnit ? "enum_value" : f.value ? valueSupport(f.value, f.quote, text) : "no_value";
          resupport[re] = (resupport[re] ?? 0) + 1;
          near.total++;
          if (f.support === "not_found") near.notFoundStrict++;
          if (f.support === "not_found" && cov !== null && cov >= 0.8) near.nearAtLeast80++;
        }
        out.push(`  - ${name} = ${f.value ?? "（なし）"} [${f.basis}／導出:${f.support}${cov !== null ? `／語の近さ ${Math.round(cov * 100)}%` : ""}] 引用: ${(f.quote ?? "").slice(0, 80)}`);
      }
      const unk = (p.unknowns as { what: string; why: string }[]).map((u) => `${u.what}（${u.why}）`).join("／");
      if (unk) out.push(`- 未確認: ${unk}`);
      out.push("- **人が確認すること**: 観察とされた各項目が、ページ/原文の記載と合うか（特に導出が not_found／語の近さが低いもの）。応募単位が unknown の事例は、ページの受付枠・注意書きで正しい方式を確認（gold 候補になりうる）。本登録案（register）は誤りの被害が大きいので優先して確認。", "");
      rows.push({ k, decision: p.decision, unit: p.apply_unit, basis: p.apply_unit_basis, cost: p.cost_jpy, oldSlots });
    }
    out.push("## 集計（導出の粗い確認）", `- 観察とされた項目 ${near.total}／保存時の導出が見つからない(not_found) ${near.notFoundStrict}／うち語の近さ80%以上 ${near.nearAtLeast80}（書式・言い換えによる不一致の可能性）`, `- 修正後の分類で再計算: ${JSON.stringify(resupport)}`);
    (near as unknown as Record<string, unknown>).resupport = resupport;
    writeFileSync("eval/real-data/p2-review.md", out.join("\n"));
    writeFileSync("eval/real-data/p2-review.json", JSON.stringify({ near, rows }, null, 1));
    console.log("P2REVIEW", JSON.stringify(near));
    expect(existsSync("eval/real-data/p2-review.md")).toBe(true);
  });
});
