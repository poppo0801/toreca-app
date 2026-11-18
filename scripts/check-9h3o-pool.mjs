// 9H-3O: 凍結した対象の店舗が、本番の候補プール（2026-11-17）に既にあったか（従来の収集で見つかっていたか）を調べる。読み取りのみ。
import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync("backups/eval-9h3o/plan.json", "utf8"));
const pool = JSON.parse(readFileSync("backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json", "utf8"));
const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
const core = (s) => norm(s).replace(/^(キデイランド|文教堂書店|文教堂|tsutaya積文館書店|tsutaya|ふるいちトップブックス|ふるいち|トレカエース)/, "").replace(/店$/, "");
for (const c of plan.cases) {
  const k = core(c.store);
  const hits = pool.candidates.filter((x) => x.input?.store && core(x.input.store) === k && norm(x.input.chain).slice(0, 2) === norm(c.chain).slice(0, 2));
  console.log(c.caseId, c.chain, c.store, "| プール内の候補:", hits.length, hits.map((h) => `${h.id}:${h.status}:${(h.input.products?.[0] ?? "").slice(0, 16)}:${h.input.applyStart?.slice(0, 10)}→${h.input.applyDeadline?.slice(0, 10)}`).join(" ; ").slice(0, 300));
}
