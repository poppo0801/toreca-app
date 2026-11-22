// @vitest-environment node
/**
 * Stage 10Y: 実際の公開ページの安全な取得の実測（**AI・検索・課金なし**。開発限定・明示許可）。
 * 保存済みの応募ページのURL（Stage 10T の12件＋B2の評価例4件）を「候補」として与え、実ページを既存の安全な取得（robots・SSRF・間隔1.5秒・サイズ/時間・失敗ホスト抑制）で1回ずつ取得し、
 * 現行ページか・終了イベントか・404か・ロボット/ログイン制限か・通信失敗かを分類する。結果は eval/real-data/xsource-10y-live.json（Git管理外。URL・原文は含めずホスト名と件数のみ）。
 * 実行: JUDGMENT_10Y_LIVE=1 JUDGMENT_LIVE_FETCH=allow TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/research-10y-live.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { replayCandidatesLive, type BExample } from "./eval-b";
import { liveFetchAllowed, makeLivePublicFetch } from "./live-fetch";

vi.mock("server-only", () => ({}));
const env = process.env;
const DIR = "eval/real-data/10t-html";
const B2 = "eval/real-data/xsource-10x-b2-examples.json";

describe.skipIf(env.JUDGMENT_10Y_LIVE !== "1" || !liveFetchAllowed(env).ok || !existsSync(`${DIR}/index.json`))("10Y 実ページの安全な取得（無課金・AIなし）", () => {
  it("保存済み応募ページのURLを候補として、実ページを分類する（取得の経路・失敗の種類を区別）", async () => {
    const index = JSON.parse(readFileSync(`${DIR}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const lp: BExample[] = index.filter((x) => x.ok).map((x) => ({ id: `lp-${x.n}`, post: { postId: `lp-${x.n}`, text: "（候補の取得確認）", links: [], recordedAt: null }, pages: { [x.url]: readFileSync(`${DIR}/lp-${x.n}.html`, "utf8") } }));
    const b2: BExample[] = existsSync(B2) ? (JSON.parse(readFileSync(B2, "utf8")) as { examples: BExample[] }).examples : [];
    const f = makeLivePublicFetch({ env, maxFetches: 40 });
    const r = await replayCandidatesLive({ examples: [...lp, ...b2], fetchPage: f.fetchPage, lastLog: () => f.log[f.log.length - 1] });
    writeFileSync("eval/real-data/xsource-10y-live.json", JSON.stringify({ condition: "候補（保存済みURL）を実ページで取得・分類（AI・検索なし）", counts: r.counts, fetches: f.fetchCount(), hostLog: f.log.map((l) => ({ host: l.host, outcome: l.outcome, status: l.status ?? null, endedPage: l.endedPage ?? null, redirects: l.redirects })), rows: r.rows }, null, 1));
    expect(f.fetchCount()).toBeLessThanOrEqual(40);
    expect(r.rows.length).toBeGreaterThan(0);
  }, 300_000);
});
