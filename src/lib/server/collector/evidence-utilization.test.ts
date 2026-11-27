// @vitest-environment node
/** EVIDENCE_UTILIZATION §1〜§3: 保存済みの全文の構造・版の選択・シャドーの原文ハッシュ（素材の変化）・待ち行列の優先度・再評価の間隔。架空データのみ */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { jobEvidenceRelation, jobHashDiff, materialHashOf, shadowJobHash } from "@/lib/collector/shadow-hash";
import { documentsFromCollected } from "@/lib/server/proposals/collected-store";
import { pickVersion } from "@/lib/server/proposals/evidence-store";
import { nextRunFor, queueDecision } from "@/lib/server/shadow/priority";
import { reevalUrgency } from "@/lib/server/shadow/worker";
import { researchViewOf } from "./page-view";

const HASH = "a".repeat(32);
const ev = (o: Partial<{ hash: string; linkedPages: { url: string; text: string; fetchedAt: string; fullChars?: number }[]; imageRefs: string[] }> = {}) => ({ hash: HASH, linkedPages: [], imageRefs: [], ...o });

describe("シャドーのジョブの原文ハッシュ（本文＋素材）", () => {
  it("新形式は40桁（本文24桁＋素材16桁）。DBの形式検査（16進8〜64桁）に合う", () => {
    const h = shadowJobHash(ev())!;
    expect(h).toMatch(/^[0-9a-f]{40}$/);
    expect(h.startsWith(HASH.slice(0, 24))).toBe(true);
  });
  it("本文が同じでも、リンク先の取得・画像の追加で別のハッシュになる（再調査の結果が新AIへ届く）", () => {
    const a = shadowJobHash(ev())!;
    const b = shadowJobHash(ev({ linkedPages: [{ url: "https://shop.example/l", text: "応募期間 12/1〜12/3", fetchedAt: "2026-11-27T00:00:00Z" }] }))!;
    const c = shadowJobHash(ev({ imageRefs: ["https://pbs.twimg.com/media/x.jpg"] }))!;
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it("表示の微差（残り日数・閲覧数）では変わらない。並び順にも依存しない", () => {
    const p1 = { url: "https://s.example/a", text: "抽選 残り3日 応募はこちら", fetchedAt: "x" };
    const p2 = { url: "https://s.example/b", text: "受付中", fetchedAt: "x" };
    const m1 = materialHashOf({ linkedPages: [p1, p2] });
    const m2 = materialHashOf({ linkedPages: [p2, { ...p1, text: "抽選 残り2日 応募はこちら" }] });
    expect(m1).toBe(m2);
  });
  it("旧形式（本文のハッシュ32桁）のジョブは本文で、新形式は本文と素材で、いまの証拠と照合する", () => {
    expect(jobEvidenceRelation(HASH, ev())).toBe("same");
    expect(jobEvidenceRelation("b".repeat(32), ev())).toBe("stale");
    const h = shadowJobHash(ev())!;
    expect(jobEvidenceRelation(h, ev())).toBe("same");
    expect(jobEvidenceRelation(h, ev({ imageRefs: ["https://pbs.twimg.com/media/y.jpg"] }))).toBe("material_changed");
    expect(jobEvidenceRelation(h, ev({ hash: "c".repeat(32) }))).toBe("stale");
  });
  it("2つのジョブの比較: 旧形式と新形式の間では素材の違いを判定しない（移行時に誤って急ぎの再評価をしない）", () => {
    const n1 = shadowJobHash(ev())!;
    const n2 = shadowJobHash(ev({ imageRefs: ["https://pbs.twimg.com/media/z.jpg"] }))!;
    expect(jobHashDiff(n1, n2)).toBe("material");
    expect(jobHashDiff(HASH, n1)).toBeNull();
    expect(jobHashDiff("d".repeat(32), n1)).toBe("content");
  });
});

describe("再評価の間隔（意味のある更新は12時間を待たない）", () => {
  const now = new Date("2026-11-27T03:00:00Z"); // 日本時間 11/27 12:00
  const n1 = shadowJobHash(ev())!;
  const n2 = shadowJobHash(ev({ imageRefs: ["https://pbs.twimg.com/media/q.jpg"] }))!;
  it("人の修正・締切が2日以内・本文の変化・素材の変化を区別する", () => {
    expect(reevalUrgency({ lastHash: n1, jobHash: n1, deadline: null, reviewedAfter: true, now })).toBe("human");
    expect(reevalUrgency({ lastHash: n1, jobHash: n1, deadline: "2026-11-29", reviewedAfter: false, now })).toBe("deadline");
    expect(reevalUrgency({ lastHash: n1, jobHash: n1, deadline: "2026-12-05", reviewedAfter: false, now })).toBeNull();
    expect(reevalUrgency({ lastHash: "e".repeat(32), jobHash: n1, deadline: null, reviewedAfter: false, now })).toBe("content");
    expect(reevalUrgency({ lastHash: n1, jobHash: n2, deadline: null, reviewedAfter: false, now })).toBe("material");
  });
  it("締切を過ぎた日付は急ぎにしない（待ち行列の側で閉じる）", () => {
    expect(reevalUrgency({ lastHash: n1, jobHash: n1, deadline: "2026-11-20", reviewedAfter: false, now })).toBeNull();
  });
  it("ワーカーは急ぎでも最短2時間の間隔を守る（無制限に再評価しない）", () => {
    const w = readFileSync("src/lib/server/shadow/worker.ts", "utf8");
    expect(w).toMatch(/REEVAL_URGENT_INTERVAL_MS = 2 \* H/);
    expect(w).toMatch(/why \? REEVAL_URGENT_INTERVAL_MS : REEVAL_MIN_INTERVAL_MS/);
  });
});

describe("シャドーの待ち行列の優先度（AIなし）", () => {
  const now = new Date("2026-11-27T03:00:00Z");
  it("締切を過ぎた候補は閉じる。締切が3日以内・確認待ち・未評価は先、旧方式で除外済みかつ評価済みは後", async () => {
    expect(queueDecision({ status: "excluded", deadline: "2026-11-26", evaluatedBefore: true }, now)).toEqual({ action: "skip", reason: "deadline_passed" });
    // 旧方式の締切は誤りのことがある（下の行）。全文のハッシュがあれば、抜粋の外（後半）の更新も素材の変化として検知する（CAPABILITY_CEILING）
    const { materialHashOf } = await import("@/lib/collector/shadow-hash");
    const pg = (fullHash?: string) => ({ linkedPages: [{ url: "https://a.example.invalid/e", text: "抜粋は同じ", fetchedAt: "x", fullChars: 20000, ...(fullHash ? { fullHash } : {}) }], imageRefs: [] });
    expect(materialHashOf(pg("aaaaaaaaaaaaaaaa") as never)).not.toBe(materialHashOf(pg("bbbbbbbbbbbbbbbb") as never));
    expect(materialHashOf(pg() as never)).toBe(materialHashOf(pg() as never));
    // 旧方式の締切は誤りのことがある: 新AIで未評価なら閉じず、後回しにして1回は評価する（CAPABILITY_CEILING）
    expect(queueDecision({ status: "excluded", deadline: "2026-11-26", evaluatedBefore: false }, now)).toEqual({ action: "keep", tier: 2 });
    expect(queueDecision({ status: "excluded", deadline: "2026-11-27", evaluatedBefore: true }, now)).toEqual({ action: "keep", tier: 0 });
    expect(queueDecision({ status: "auto_registered", deadline: null, evaluatedBefore: false }, now)).toEqual({ action: "keep", tier: 0 });
    expect(queueDecision({ status: "pending", deadline: null, evaluatedBefore: true }, now)).toEqual({ action: "keep", tier: 0 });
    expect(queueDecision({ status: "excluded", deadline: null, evaluatedBefore: true }, now)).toEqual({ action: "keep", tier: 2 });
    expect(queueDecision({ status: "auto_registered", deadline: "2026-12-20", evaluatedBefore: true }, now)).toEqual({ action: "keep", tier: 1 });
  });
  it("優先は作成時刻の1日前へ（古い通常のジョブより先）、後回しは6時間後へ。既に条件を満たすなら変えない", () => {
    const job = { created_at: "2026-11-26T10:00:00.000Z", next_run_at: "2026-11-26T10:00:00.000Z" };
    expect(nextRunFor(0, job, now)).toBe("2026-11-25T10:00:00.000Z");
    expect(nextRunFor(0, { ...job, next_run_at: "2026-11-20T00:00:00.000Z" }, now)).toBeNull();
    expect(nextRunFor(2, job, now)).toBe("2026-11-27T09:00:00.000Z");
    expect(nextRunFor(1, job, now)).toBeNull();
  });
  it("後回しは1回だけ（印をつける）・期限の来たジョブだけを扱う（予算で先送りしたジョブを空回りさせない）", () => {
    const s = readFileSync("src/lib/server/shadow/priority.ts", "utf8");
    expect(s).toMatch(/last_error === "low_priority"\) continue/);
    expect(s).toMatch(/\.lte\("next_run_at", now\.toISOString\(\)\)/);
  });
});

describe("保存する全文の構造と版", () => {
  const html = `<html><head><title>抽選販売のお知らせ</title><script>var x=1</script></head><body><nav><a href="/">トップ</a></nav><main><h1>抽選販売のお知らせ</h1><p>応募期間 2026年12月1日〜12月3日</p><p><a href="https://shop.example/apply">応募フォームはこちら</a></p></main><footer>株式会社サンプル 東京都千代田区</footer></body></html>`;
  it("収集時の取得から、新AIの実取得と同じ整形の本文と構造（ページ内リンクつき）を作る", () => {
    const v = researchViewOf(html, "https://shop.example/news/1", "抽選販売のお知らせ 応募期間", new Date("2026-11-27T00:00:00Z"))!;
    expect(v.text).toContain("応募期間");
    expect(v.text).not.toContain("var x=1");
    expect(v.text).toContain("東京都千代田区"); // フッターの所在地を落とさない
    expect(v.structure).not.toBeNull();
    expect(v.structure?.links?.some((l) => l.url === "https://shop.example/apply")).toBe(true);
    expect(v.structure?.chrome?.length).toBe(2); // nav と footer の位置（本文からは削らない）
  });
  it("HTMLが無ければ作らない（従来の本文だけを保存する）", () => {
    expect(researchViewOf("", "https://shop.example/", "x", new Date())).toBeUndefined();
  });
  it("保存文書は構造つき（以前は常に structure: null）", () => {
    const view = researchViewOf(html, "https://shop.example/news/1", "x", new Date("2026-11-27T00:00:00Z"))!;
    const [d] = documentsFromCollected({ pages: [{ url: "https://shop.example/news/1", finalUrl: "https://shop.example/news/1", title: "t", text: "収集用の本文".repeat(10), truncated: false, fetchedAt: "2026-11-27T00:00:00Z", depth: 0, origins: ["post"], view }], postUrl: "https://x.com/a/status/1", postText: null, postFetchedAt: "2026-11-27T00:00:00Z" });
    expect(d.structure).not.toBeNull();
    expect(d.text).toBe(view.text);
    const [old] = documentsFromCollected({ pages: [{ url: "https://shop.example/n", finalUrl: "https://shop.example/n", title: "t", text: "収集用の本文".repeat(10), truncated: false, fetchedAt: "2026-11-27T00:00:00Z", depth: 0, origins: ["post"] }], postUrl: "u", postText: null, postFetchedAt: "x" });
    expect(old.structure).toBeNull();
  });
  it("版の選択: 基準時刻以前で最も新しい版（長さではなく時点）。無ければ基準時刻後で最も早い版。切り詰めのない版を優先", () => {
    const vs = [
      { id: "old-long", fetchedAt: "2026-11-20T00:00:00.000Z", truncated: false, chars: 9000 },
      { id: "basis", fetchedAt: "2026-11-25T00:00:00.000Z", truncated: false, chars: 3000 },
      { id: "later", fetchedAt: "2026-11-27T00:00:00.000Z", truncated: false, chars: 500 },
      { id: "cut", fetchedAt: "2026-11-25T01:00:00.000Z", truncated: true, chars: 20000 },
    ];
    expect(pickVersion(vs, "2026-11-25T06:00:00.000Z")?.id).toBe("basis");
    expect(pickVersion(vs, "2026-11-28T00:00:00.000Z")?.id).toBe("later");
    expect(pickVersion(vs, "2026-11-10T00:00:00.000Z")?.id).toBe("old-long");
  });
});

describe("収集の本文の取り出し（属性値の「>」）", () => {
  it("data-action=\"click->header#menuopen\" のような属性値の「>」でタグを終えず、属性の断片を本文に混ぜない", async () => {
    const { extractPageText } = await import("@/lib/ai/page-text");
    const html = `<html><body><header data-action="resize@window->header#layout"><a href="/" data-action="click->header#menuopen">メニュー</a></header><main><p data-x='a>b'>受付期間：2026年11月26日～11月28日</p></main></body></html>`;
    const t = extractPageText(html, "https://shop.example/e/1").text;
    expect(t).not.toMatch(/header#|">|'>/);
    expect(t).toContain("受付期間：2026年11月26日～11月28日");
    expect(t).toContain("メニュー");
  });
});

describe("配線（本番の経路）", () => {
  it("再調査の成功は、素材つきのハッシュでシャドーのキューへ入る（本番で新AIへ届く）", () => {
    const s = readFileSync("src/lib/server/collector/link-recheck.ts", "utf8");
    expect(s).toMatch(/shadowJobHash\(merged\)/);
    expect(s).toMatch(/makeShadowEnqueuer\(a\.db, a\.householdId\)/);
  });
  it("収集の投入は素材つきのハッシュ。新AIは保存済みの全文をリンク先にも先に使う", () => {
    const r = readFileSync("src/lib/server/collector/run.ts", "utf8");
    expect(r).toMatch(/shadowJobHash\(evSaved\.evidence\)/);
    const g = readFileSync("src/lib/server/proposals/generate.ts", "utf8");
    expect(g).toMatch(/if \(!isSource\) \{\s*const saved = await loadBestDocument/);
    expect(g).toMatch(/withFullPostText/);
  });
});
