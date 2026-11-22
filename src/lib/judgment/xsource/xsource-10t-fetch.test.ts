// @vitest-environment node
/** Stage 10T 調査用（有料ではない・公開ページの取得のみ・DB不要）: 生HTMLを Git管理外の eval/real-data/10t-html/ に保存する。JUDGMENT_10T_FETCH=1 のときだけ動く。 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { canonUrl } from "./normalize";

vi.mock("server-only", () => ({}));
const env = process.env;
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;

describe.skipIf(env.JUDGMENT_10T_FETCH !== "1")("10T 生HTMLの取得（調査）", () => {
  it("LivePocket等の公開ページを最大 N 件、生HTMLで保存", async () => {
    const { fetchRespectingRobots } = await import("@/lib/server/safe-fetch");
    const snap = JSON.parse(readFileSync(latest("backups/masters-9h3s", "snapshot-prod-"), "utf8")) as Record<string, Record<string, unknown>[]>;
    const max = Number(env.JUDGMENT_10T_MAX ?? 12);
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const c of snap.collection_candidates.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
      const u = c.source_url as string | undefined;
      if (!u || !(env.JUDGMENT_10T_FETCH_GF === "1" ? /^https:\/\/docs\.google\.com\/forms\//.test(u) : /^https:\/\/livepocket\.jp\//.test(u))) continue;
      const k = canonUrl(u).key;
      if (seen.has(k)) continue;
      seen.add(k);
      urls.push(u);
      if (urls.length >= max) break;
    }
    const pre = env.JUDGMENT_10T_FETCH_GF === "1" ? "gf" : "lp";
    mkdirSync("eval/real-data/10t-html", { recursive: true });
    const index: { n: number; url: string; ok: boolean; bytes: number; message?: string }[] = [];
    for (const [i, u] of urls.entries()) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await fetchRespectingRobots(u, { timeoutMs: 10_000, maxBytes: 1_000_000 });
      if (r.ok) { writeFileSync(`eval/real-data/10t-html/${pre}-${i + 1}.html`, r.body); index.push({ n: i + 1, url: u, ok: true, bytes: r.body.length }); }
      else index.push({ n: i + 1, url: u, ok: false, bytes: 0, message: r.message });
    }
    writeFileSync(`eval/real-data/10t-html/index-${pre}.json`, JSON.stringify(index, null, 1));
  }, 300_000);
});
