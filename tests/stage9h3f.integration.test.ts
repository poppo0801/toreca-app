/**
 * Stage 9H-3F: 3方式の比較環境の動作確認（実Supabase・RLS適用下。**有料AI・実ネットワークなし**。調査は台本の結果）
 *  - 初期条件が揃う（同じ初期の読み取り）／BとCは同じ調査結果を使う（調査は1回だけ）／Cだけが同じ抽選の別の候補を統合する
 *  - 店舗ごとの独立した抽選は統合されない／通常の抽選は3方式で同じ
 *  npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyCase, type CaseFile, type EvidenceRef } from "@/lib/case-model/types";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";
import { makeThreeway, type PlanCase, type PlanMember } from "./helpers/threeway";
import type { Db } from "@/lib/server/lottery-service";

const M = (id: string, o: Partial<PlanMember["input"]>, url: string, status = "pending"): PlanMember => ({ id, status, url, title: `${o.chain ?? "系列"} ${o.products?.[0] ?? "商品"} 抽選`, input: { chain: "フルコンプ9F", store: "", storeMode: "fixed", selectable: [], products: ["ハドウシーカー9F"], applyStart: null, applyDeadline: "2026-11-15 12:00", resultDate: null, resultEnd: null, conditions: "会員登録が必要", receiveMethod: "unknown", applyMethod: "web", ...o } });
const ev = (url: string, quote: string, extra: Partial<EvidenceRef> = {}): EvidenceRef => ({ url, quote, kind: "platform", tier: "secondary", basis: "organizer_body", ...extra });
function investigation(f: (c: CaseFile) => void): CaseFile {
  const c = emptyCase("inv", "2026-11-15T00:00:00Z");
  f(c);
  return c;
}
const field = (c: CaseFile, k: keyof CaseFile["fields"], value: string, e: EvidenceRef) => {
  c.fields[k] = { value, state: "inferred", by: "investigation", evidence: [e], alternatives: [] };
};

describe.skipIf(!dbTestsEnabled)("Stage 9H-3F 3方式の比較環境（有料AIなし・台本の調査結果）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let tw: ReturnType<typeof makeThreeway>;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3f", 1);
    userIds.push(a.userId);
    const hid = (await a.db.rpc("bootstrap_household")).data as string;
    await a.db.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
    tw = makeThreeway({ sys, u1: a.db, hid });
  });
  afterAll(async () => {
    await tw?.clear();
    await cleanupTestUsers(admin, userIds);
  });

  const LP = "https://livepocket.jp/e/9f-test";
  const STORES = ["フルコンプ横浜店", "フルコンプ秋葉原店", "フルコンプ渋谷東口店"];
  const fullcomp: PlanCase = {
    caseId: "n-fullcomp", group: "store_select", patterns: ["store_select", "livepocket", "multi_source"], anchorId: "lp",
    target: { id: "n-fullcomp", chain: "フルコンプ9F", products: ["ハドウシーカー9F"] },
    members: [
      M("x1", { applyStart: "2026-11-11", applyDeadline: "2026-11-15 11:59", resultDate: "2026-11-16", conditions: "LivePocketの会員登録と携帯番号認証が必要。プレイヤーズクラブIDが必要（0を含む10桁）。アンケートへの回答が必要" }, "https://x.com/pokecachan/status/9001"),
      M("lp", { conditions: "LivePocketの会員登録と携帯番号認証が必要。アンケートへの回答が必要" }, LP),
    ],
  };
  const invFullcomp = () =>
    investigation((c) => {
      const body = ev(LP, "同一商品について複数店舗へのご応募をされた場合、該当する商品のご応募を全て無効とさせていただきます。");
      field(c, "form", "store_select", body);
      field(c, "selectableStores", STORES.join(" / "), body);
      field(c, "applyStart", "2026-11-11", ev(LP, "2026年11月11日"));
      field(c, "applyDeadline", "2026-11-15 11:59", ev(LP, "11月15日（日）11:59"));
      field(c, "resultStart", "2026-11-16", ev(LP, "2026年11月16日（月）～"));
      field(c, "resultEnd", "2026-11-21", ev(LP, "11月21日（土）"));
    });

  it("同じ抽選（LivePocket＋X）: 初期条件が同じで、Cだけが1件の最終候補に統合する。BとCは同じ調査結果を使い、調査は1回だけ", async () => {
    let calls = 0;
    const r = await tw.runCase(fullcomp, async () => {
      calls += 1;
      return { caseFile: invFullcomp(), stopReason: "scripted" };
    });
    expect(calls).toBe(1);
    expect(r.investigationCalls).toBe(1);
    const inp = (a: "A" | "B" | "C") => r.arms[a].input as { storeMode?: string; selectableStores?: unknown[]; applyStart: { date: string }; applyDeadline: { date: string; time: string }; resultEndDate?: string };
    // A: 従来: 調査なし。店舗選択式にならず、当選発表の期間もない
    expect(inp("A").storeMode).not.toBe("select_on_apply");
    expect(inp("A").resultEndDate ?? "").toBe("");
    // B・C: 同じ調査結果の店舗選択式・選べる店舗・当選発表の期間が反映される
    for (const a of ["B", "C"] as const) {
      expect(inp(a).storeMode, a).toBe("select_on_apply");
      expect((inp(a).selectableStores ?? []).length, a).toBe(STORES.length);
      expect(inp(a).resultEndDate, a).toBe("2026-11-21");
      expect(`${inp(a).applyDeadline.date} ${inp(a).applyDeadline.time}`, a).toBe("2026-11-15 11:59");
    }
    // Cだけが、同じ抽選の別の候補（Xの投稿）を統合: 応募開始（Xの投稿にだけあった）が入り、確認待ちのカードが1枚になる
    expect(inp("C").applyStart.date).toBe("2026-11-11");
    expect(r.arms.C.openCards).toBe(1);
    expect(r.arms.A.openCards).toBeGreaterThanOrEqual(1); // 従来の経路にも同じ抽選をまとめる処理がある。その実力は実データで測る
    expect(r.arms.B.openCards).toBeGreaterThanOrEqual(1);
    // 統合の記録（採用・不採用の理由）はCにだけ残る
    expect(r.arms.C.judgment?.integration?.members.length).toBeGreaterThanOrEqual(2);
    expect(r.arms.B.judgment?.integration ?? null).toBeNull();
  });

  it("店舗ごとの独立した抽選（新宿店・渋谷店）: Cでも統合しない。基準の候補の内容は別店舗の告知に影響されない", async () => {
    const sap = M("sap", { chain: "独立店9F", store: "新宿店", products: ["独立商品9F"], applyStart: "2026-11-04", applyDeadline: "2026-11-15" }, "https://shop.example.invalid/blog/shinjuku");
    const nam = M("nam", { chain: "独立店9F", store: "渋谷店", products: ["独立商品9F"], applyStart: "2026-11-13", applyDeadline: "2026-11-15" }, "https://shop.example.invalid/blog/shibuya");
    const c: PlanCase = { caseId: "n-indep", group: "store_independent", patterns: ["store_independent"], anchorId: "nam", target: { id: "n-indep", chain: "独立店9F", products: ["独立商品9F"] }, members: [sap, nam] };
    const r = await tw.runCase(c, async () => ({ caseFile: investigation(() => undefined), stopReason: "scripted" }));
    const inp = r.arms.C.input as { applyStart: { date: string }; store: { name: string } };
    expect(inp.applyStart.date).toBe("2026-11-13");
    expect(inp.store.name).toBe("渋谷店");
    expect(r.arms.C.openCards, JSON.stringify([r.arms.C.status, r.arms.C.reasons])).toBe(2); // 別々の独立した抽選のまま
    expect(r.arms.C.judgment?.integration?.members.every((m) => !m.label.includes("sap"))).not.toBe(false);
  });

  it("通常の抽選（調査で新しい情報がない）: 3方式の最終候補の主要項目が同じ（情報量が増えただけの差を作らない）", async () => {
    const n = M("n1", { chain: "通常店9F", store: "本店", products: ["通常商品9F"], applyStart: "2026-11-10", applyDeadline: "2026-11-20 23:59", resultDate: "2026-11-22", receiveMethod: "store" }, "https://normal.example.invalid/n1", "auto_registered");
    const c: PlanCase = { caseId: "n-normal", group: "normal", patterns: ["normal"], anchorId: "n1", target: { id: "n-normal", chain: "通常店9F", products: ["通常商品9F"] }, members: [n] };
    const r = await tw.runCase(c, async () => ({ caseFile: investigation(() => undefined), stopReason: "scripted" }));
    const pick = (a: "A" | "B" | "C") => {
      const i = r.arms[a].input as { chain: { name: string }; store: { name: string }; applyDeadline: unknown; applyStart: unknown; resultDate: unknown };
      return JSON.stringify([i.chain.name, i.store.name, i.applyDeadline, i.applyStart, i.resultDate]);
    };
    expect(pick("B")).toBe(pick("A"));
    expect(pick("C")).toBe(pick("A"));
  });
});
