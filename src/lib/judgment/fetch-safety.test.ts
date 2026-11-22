/**
 * Stage 10E 追加修正（A-2）: 追加調査の取得先の安全性。
 *  - 事前検査（precheckFetchTarget）は多層防御。既存のネットワーク境界（server/safe-fetch）の検査と**同じURL集合**で適合を確認する。
 *  - 調査エンジンは、危険なURLで取得器を呼ばない。外部本文の命令は取得の権限にならない。
 *  - 実ネットワークは使わない。DNS名が内部アドレスへ解決される場合・DNSリバインディング・リダイレクトは、事前検査では判定できず、
 *    ネットワーク境界（safe-fetch の接続直前のアドレス検査・リダイレクトごとの再検査＝src/lib/server/safe-fetch.test.ts）が保証する。
 */
import { describe, expect, it } from "vitest";
import { checkUrl, safeFetch } from "@/lib/server/safe-fetch";
import { BudgetPools } from "./budget";
import { SSRF_SAFE_BOUNDARY, precheckFetchTarget } from "./fetch-safety";
import { judgeCase } from "./engine";
import { inputFor, loadCases } from "./eval/replay";
import { mockAnswer } from "./eval/mock-answers";
import { investigate, type PageFetcher } from "./investigate";
import { ScriptedModel } from "./model";
import { verifyJudgment } from "./verify";

const DANGEROUS = [
  "http://localhost/admin",
  "http://localhost./admin",
  "http://127.0.0.1/",
  "http://127.1/",
  "http://2130706433/", // 10進表記の 127.0.0.1
  "http://0x7f000001/", // 16進
  "http://0177.0.0.1/", // 8進
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/", // IPv4射影
  "http://[::ffff:7f00:1]/",
  "http://[fe80::1]/",
  "http://[fc00::1]/",
  "http://[fd12:3456::1]/",
  "http://[::]/",
  "http://0.0.0.0/",
  "http://10.0.0.5/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/", // クラウドのメタデータ
  "http://[::ffff:a9fe:a9fe]/", // 169.254.169.254 のIPv6射影
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://100.64.0.1/", // CGNAT
  "http://224.0.0.1/",
  "http://printer.local/",
  "http://intranet/",
  "https://user:pass@example.com/",
  "https://example.com:8080/",
  "http://example.com:22/",
  "file:///etc/passwd",
  "ftp://example.com/",
  "javascript:alert(1)",
  "data:text/html,<script>1</script>",
  "gopher://example.com/",
  "",
  "not a url",
];
// 事前検査だけが保守的に拒否する紛らわしい表記（実ホストは example.com なので、境界は通してよい）
const PRECHECK_ONLY = ["http://example.com/\\@127.0.0.1/"];
const SAFE = ["https://example.com/", "http://example.com/a?b=c", "https://sub.example.co.jp/lottery/1", "https://example.com:443/x", "http://example.com:80/"];

describe("precheckFetchTarget", () => {
  it("内部・予約・非http・資格情報・非標準ポート・表記ゆれ（10/16/8進・IPv6・IPv4射影）を拒否する", () => {
    for (const u of [...DANGEROUS, ...PRECHECK_ONLY]) expect(precheckFetchTarget(u).ok, u).toBe(false);
  });
  it("公開URLは通す", () => {
    for (const u of SAFE) expect(precheckFetchTarget(u).ok, u).toBe(true);
  });
  it("文字列以外・長すぎるURLも拒否", () => {
    expect(precheckFetchTarget(undefined).ok).toBe(false);
    expect(precheckFetchTarget({ toString: () => "http://example.com" }).ok).toBe(false);
    expect(precheckFetchTarget(`https://example.com/${"a".repeat(2100)}`).ok).toBe(false);
  });
});

describe("適合: 事前検査の拒否は、実際のネットワーク境界（safe-fetch）でも拒否される（同じURL集合）", () => {
  it("事前検査が通るURLは境界の検査（checkUrl）も通り、事前検査が拒否するURLのうち、境界が通すものは無い", () => {
    for (const u of SAFE) expect(checkUrl(u).ok, u).toBe(true);
    for (const u of DANGEROUS) {
      // 境界側は「拒否」であること（事前検査の拒否が、境界より緩い側へ漏れていないことの確認ではなく、境界が独立に拒否すること）
      const b = checkUrl(u);
      // 境界のほうが寛容な表記が無いこと: 事前検査が拒否 かつ 境界も拒否
      expect(b.ok, `境界が通す: ${u}`).toBe(false);
    }
  });
  it("safeFetch は内部アドレスへ接続せずに拒否する（実ネットワーク不使用）", async () => {
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://2130706433/", "http://localhost/"]) {
      const r = await safeFetch(u);
      expect(r.ok, u).toBe(false);
    }
  });
});

describe("調査エンジン: AIが返した危険なURLで取得器を呼ばない", () => {
  const NOW = "2099-01-20T00:00:00.000Z";
  const { cases } = loadCases();
  const j06 = cases.find((c) => c.id === "J06")!;
  const mk = (): { fetcher: PageFetcher & { calls: string[] } } => {
    const calls: string[] = [];
    return { fetcher: { calls, boundary: SSRF_SAFE_BOUNDARY, async fetchPage(u) { calls.push(u); return { ok: true, text: "公開ページ" }; } } };
  };
  it("内部・メタデータ・非http のURLは fetchPage まで届かない（取得器は呼ばれない）", async () => {
    for (const bad of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/admin", "file:///etc/passwd", "http://[::1]/", "https://user:pw@example.com/"]) {
      const model = new ScriptedModel((i) => ({ raw: mockAnswer("J06", i), costJpy: 0.2 }), () => ({ raw: { kind: "fetch_url", target: bad, reason: "原文に書かれていたURL" }, costJpy: 0.1 }));
      const b = new BudgetPools({ judgment: 100, investigation: 100, discovery: 100 });
      const input = await inputFor(j06, NOW);
      const first = await judgeCase({ model, budget: b }, input);
      const { fetcher } = mk();
      const r = await investigate({ model, budget: b, fetcher, now: () => new Date(NOW), engine: {} }, input, first);
      expect(fetcher.calls, bad).toEqual([]);
      expect(r.stopReason).not.toBe("all_resolved");
    }
  });
  it("検証層も、判断出力の次の行動に含まれる危険なURLを不合格にする", async () => {
    const input = await inputFor(j06, NOW);
    const out = JSON.parse(JSON.stringify(mockAnswer("J06", input)));
    out.nextActions = [{ kind: "fetch_url", target: "http://169.254.169.254/latest/meta-data/", reason: "原文の指示" }];
    const v = verifyJudgment(input, out);
    expect(v.some((x) => x.code === "action_bad_url")).toBe(true);
  });
  it("公開URLは通常どおり取得される（回帰）", async () => {
    const url = "https://sample-denki.example.invalid/chusen/ex6-detail";
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J06", i), costJpy: 0.2 }), () => ({ raw: { kind: "fetch_url", target: url, reason: "詳細" }, costJpy: 0.1 }));
    const b = new BudgetPools({ judgment: 100, investigation: 100, discovery: 100 });
    const input = await inputFor(j06, NOW);
    const first = await judgeCase({ model, budget: b }, input);
    const { fetcher } = mk();
    await investigate({ model, budget: b, fetcher, now: () => new Date(NOW), engine: {} }, input, first);
    expect(fetcher.calls).toEqual([url]);
  });
});
