// @vitest-environment node
// 9H-3O: 保存済みの実データ（本番の候補プール 2026-11-17）で、予告／正式発表の判断と状態遷移を再現する（費用0・読み取りのみ。BUILD_9H3O=1）。
//  収集の実処理では「受付開始日・締切のどちらかが無い（stage=teaser/partial）」候補だけが予告の判断の対象になる。プールで同じ条件の候補（285件）を対象にする。
//  近似: プールには応募URLの項目が無いため、応募URLの有無は「根拠の抜粋に応募URLがある／情報源がLivePocket・フォームなどの応募ページ」で近似する（本番の処理は extraction.applyUrl）。
//  結果: backups/eval-9h3o/teaser-replay.json（人間が元URLと照合できる）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { carryOver, judgeAnnouncement, nextOutcome, type TeaserState } from "./announcement";

const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const ON = process.env.BUILD_9H3O === "1" && existsSync(POOL);

interface Cand {
  id: string;
  status: string;
  url?: string;
  title?: string;
  createdAt?: string;
  reasons?: string[];
  evidence?: { field: string; quote: string }[] | Record<string, never>;
  input?: { chain?: string; store?: string; products?: string[]; applyStart?: string | null; applyDeadline?: string | null; resultDate?: string | null; conditions?: string | null };
}

describe.skipIf(!ON)("9H-3O 予告／正式発表の判断と状態遷移（保存済みの実データ）", () => {
  it("再現する", () => {
    const pool = JSON.parse(readFileSync(POOL, "utf8")) as { candidates: Cand[] };
    const rows: Record<string, unknown>[] = [];
    const judged: { c: Cand; state: string; key: string }[] = [];
    for (const c of pool.candidates) {
      const i = c.input;
      if (!i || (i.applyStart && i.applyDeadline)) continue;
      const ev = Array.isArray(c.evidence) ? c.evidence : [];
      const texts = [c.title ?? "", ...ev.map((e) => e.quote), i.conditions ?? ""];
      const j = judgeAnnouncement({
        texts,
        hasProduct: !!i.products?.[0],
        applyStartKnown: !!i.applyStart,
        applyDeadlineKnown: !!i.applyDeadline,
        resultDateKnown: !!i.resultDate,
        hasApplyUrl: ev.some((e) => e.field === "applyUrl") || /livepocket\.jp\/e\/|forms\.gle|docs\.google\.com\/forms|\/entry|\/lottery/i.test(c.url ?? ""),
        hasConditions: !!(i.conditions ?? "").trim(),
        chainKnown: !!i.chain,
      });
      judged.push({ c, state: j.state, key: `${i.chain}|${i.store}|${i.products?.[0] ?? ""}` });
      rows.push({ id: c.id, status: c.status, state: j.state, confidence: j.confidence, score: j.score, chain: i.chain, store: i.store, product: i.products?.[0] ?? null, applyStart: i.applyStart ?? null, applyDeadline: i.applyDeadline ?? null, signals: j.signals.map((s) => `${s.label}(${s.weight})`), toVerify: j.toVerify, url: c.url ?? null, title: c.title ?? null, poolReasons: (c.reasons ?? []).slice(0, 2) });
    }
    const by = (f: (r: Record<string, unknown>) => boolean) => rows.filter(f).length;
    // 状態遷移の再現: 同じ系列・店舗・商品で、予告と判断した候補より後に、正式発表と判断した候補があるもの
    const transitions: Record<string, unknown>[] = [];
    const groups = new Map<string, typeof judged>();
    for (const x of judged) groups.set(x.key, [...(groups.get(x.key) ?? []), x]);
    // 日程が揃った候補（プールの全体）も後続の正式発表として扱う
    const complete = pool.candidates.filter((c) => c.input?.applyStart && c.input.applyDeadline);
    for (const [key, list] of groups) {
      const teasers = list.filter((x) => x.state === "teaser").sort((a, b) => String(a.c.createdAt).localeCompare(String(b.c.createdAt)));
      if (teasers.length === 0) continue;
      const first = teasers[0];
      const later = complete.filter((c) => `${c.input?.chain}|${c.input?.store}|${c.input?.products?.[0] ?? ""}` === key && String(c.createdAt) > String(first.c.createdAt));
      if (later.length === 0) continue;
      const f = later.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      const prev: TeaserState = { since: String(first.c.createdAt), lastNewsAt: String(first.c.createdAt), outcome: "active", carried: { chain: first.c.input?.chain, store: first.c.input?.store, products: first.c.input?.products } };
      const formal = judgeAnnouncement({ texts: [f.title ?? ""], hasProduct: !!f.input?.products?.[0], applyStartKnown: true, applyDeadlineKnown: true, resultDateKnown: !!f.input?.resultDate, hasApplyUrl: false, hasConditions: !!f.input?.conditions, chainKnown: true });
      const outcome = nextOutcome({ prev, judgement: formal, now: new Date(String(f.createdAt)) });
      const carried = carryOver({ chain: "", store: "", products: [] as string[] }, prev.carried);
      transitions.push({ key, teaserId: first.c.id, formalId: f.id, formalStatus: f.status, outcome, carriedFilled: !!carried.chain && !!carried.store && carried.products.length > 0, teaserUrl: first.c.url ?? null, formalUrl: f.url ?? null });
    }
    const out = {
      poolCandidates: pool.candidates.length,
      missingDate: rows.length,
      teaser: by((r) => r.state === "teaser"),
      formal: by((r) => r.state === "formal"),
      cancelled: by((r) => r.state === "cancelled"),
      postponed: by((r) => r.state === "postponed"),
      // 安全性: 現在、実際に登録済み（自動登録・利用者が登録）の候補を、予告と判断して隠してしまうか
      registeredButJudgedTeaser: rows.filter((r) => r.state === "teaser" && (r.status === "auto_registered" || r.status === "registered")).length,
      pendingJudgedTeaser: rows.filter((r) => r.state === "teaser" && r.status === "pending").length,
      transitions: transitions.length,
      transitionsPromoted: transitions.filter((t) => t.outcome === "promoted").length,
      transitionsCarried: transitions.filter((t) => t.carriedFilled).length,
      byStatus: rows.reduce<Record<string, number>>((m, r) => ((m[`${r.status}:${r.state}`] = (m[`${r.status}:${r.state}`] ?? 0) + 1), m), {}),
      rows,
      transitionRows: transitions,
    };
    mkdirSync("backups/eval-9h3o", { recursive: true });
    writeFileSync("backups/eval-9h3o/teaser-replay.json", JSON.stringify(out, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  });
});
