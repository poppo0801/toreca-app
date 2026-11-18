import { describe, expect, it } from "vitest";
import fs from "node:fs";
import cases from "../../../eval/collection-9c/cases.json";
import { findDuplicates, matchChain, matchProduct } from "@/lib/lottery-match";
import { judgeForm } from "@/lib/lottery-form";
import { knowledgeFor } from "@/lib/collector/knowledge/chain-knowledge";
import { planMultiProduct } from "@/lib/collector/multi-product";
import { corroborateAccount } from "@/lib/collector/account-evidence";
import type { Chain, Lottery, Product, Store } from "@/types/domain";

/**
 * Stage 9C の評価（架空・利用者報告の表記。実際の収集データ全体ではない）。
 *   通常: npm run eval:9c           → 新方式の結果を表示・検証
 *   旧方式: EVAL_OUT=<ファイル> を付け、変更前のコミットで実行して記録（multi / account は旧方式に機能が無いため対象外）
 * 件数は精度ではなく、型ごとの適合を示す。実データでの精度・発見率は未測定。
 */
const OLD = process.env.EVAL_MODE === "old";
const OUT = process.env.EVAL_OUT;
type R = { id: string; kind: string; p: string; ok: boolean; item?: number; got?: unknown; expect?: unknown };
const results: R[] = [];
const rec = (r: R) => results.push(r);

const mkChains = (names: string[]): Chain[] => names.map((n, i) => ({ id: `c${i}`, name: n, aliases: [], archived: false }) as unknown as Chain);
const flex = (d: string) => ({ precision: "date_only" as const, date: d, time: "" });
const jflex = (d: string) => ({ precision: "date_only" as const, date: d });

describe("Stage 9C 評価", () => {
  it("chain: 系列の認識", () => {
    for (const c of cases.chain) {
      const chains = mkChains(c.master);
      const m = matchChain(c.input, chains);
      const got = m.item && (m.kind === "exact" || m.kind === "alias" || m.kind === "partial") ? m.item.name : null;
      // 部分一致（候補止まり）は自動の確定とみなさない: 確実な一致（exact/alias）か、同等の長さの部分一致のみ
      rec({ id: c.id, kind: "chain", p: c.p, ok: got === c.expect, item: c.item, got, expect: c.expect });
    }
  });
  it("product: 商品マスターとの照合", () => {
    for (const c of cases.product) {
      const products = c.master.map((n, i) => ({ id: `p${i}`, officialName: n, aliases: [], code: "", archived: false })) as unknown as Product[];
      const m = matchProduct(c.input, "", products);
      const got = m.item && (m.kind === "exact" || m.kind === "alias" || m.kind === "partial") ? m.item.officialName : null;
      rec({ id: c.id, kind: "product", p: c.p, ok: got === c.expect, item: c.item, got, expect: c.expect });
    }
  });
  it("form: 抽選形態の判定", () => {
    for (const c of cases.form) {
      const j = judgeForm({ storeMode: "fixed", texts: c.texts, sourceUrls: [], knowledge: knowledgeFor(c.chain), perStorePages: c.perStorePages } as never);
      rec({ id: c.id, kind: "form", p: c.p, ok: j.form === c.expect, item: c.item, got: j.form, expect: c.expect });
    }
  });
  it("dup: 重複・新規の判断", () => {
    const chains = [{ id: "kd", name: "キデイランド" }] as unknown as Chain[];
    const stores = [
      { id: "ph", chainId: "kd", name: "応募時に店舗選択", salesKind: "physical" },
      { id: "s1", chainId: "kd", name: "原宿店", salesKind: "physical" },
      { id: "s2", chainId: "kd", name: "新宿店", salesKind: "physical" },
    ] as unknown as Store[];
    const idOf = (n?: string) => stores.find((s) => s.name === n)?.id ?? null;
    for (const c of cases.dup) {
      const e = c.existing as { mode: string; store?: string; selectable?: string[]; url: string; products: string[]; deadline: string };
      const i = c.input as { store: string; url: string; products: string[]; deadline: string };
      const lot = { id: "L1", chainId: "kd", storeId: e.mode === "select" ? "ph" : idOf(e.store), storeMode: e.mode === "select" ? "select_on_apply" : "fixed", selectableStores: (e.selectable ?? []).map((n) => ({ name: n, prefecture: "" })), items: e.products.map((p) => ({ productId: p, quantity: 1, unit: "box" })), sourceUrls: [e.url], applyStart: jflex("2026-11-09"), applyDeadline: jflex(e.deadline) } as unknown as Lottery;
      const input = { chain: { id: "kd", name: "キデイランド" }, store: { id: idOf(i.store), name: i.store, prefecture: "" }, storeMode: "fixed", items: i.products.map((p) => ({ product: { id: p, name: p }, quantity: 1, unit: "box" })), applyStart: flex("2026-11-09"), applyDeadline: flex(i.deadline), sourceUrls: [i.url], multiMode: "single" };
      const d = findDuplicates(input as never, [lot], i.url, { chains, stores }, { now: new Date("2026-11-10T03:00:00Z") });
      const got = d.some((x) => x.level === "high") ? "duplicate" : "new";
      rec({ id: c.id, kind: "dup", p: c.p, ok: got === c.expect, item: c.item, got, expect: c.expect });
    }
  });
  it.skipIf(OLD)("multi: 同一企画の複数商品（新方式のみ。旧方式は常に別カード）", () => {
    for (const c of cases.multi) {
      const ex = c.existing as { products: string[]; deadline: string; tags: string[] };
      const inn = c.input as { products: string[]; deadline: string; tags: string[] };
      const lot = { id: "L1", chainId: "rk", storeId: "on", sourceKind: "auto", requirementTags: ex.tags, items: ex.products.map((p) => ({ productId: p, quantity: 1, unit: "box" })), sourceUrls: ["https://b.example.invalid/1"], applyStart: jflex("2026-11-12"), applyDeadline: jflex(ex.deadline) } as unknown as Lottery;
      const input = { chain: { id: "rk", name: c.chain }, store: { id: "on", name: "オンライン", prefecture: "" }, items: inn.products.map((p) => ({ product: { id: p, name: p }, quantity: 1, unit: "box" })), applyStart: flex("2026-11-12"), applyDeadline: flex(inn.deadline), requirementTags: inn.tags, sourceUrls: ["https://b.example.invalid/2"] };
      const plan = planMultiProduct(input as never, [lot], { knowledge: knowledgeFor(c.chain), texts: c.texts });
      const got = plan ? "merge" : "separate";
      rec({ id: c.id, kind: "multi", p: c.p, ok: got === c.expect, item: c.item, got, expect: c.expect });
    }
  });
  it.skipIf(OLD)("account: アカウントからの系列・店舗の特定（新方式のみ）", () => {
    const chains = [{ id: "tc", name: "トレカキャピタル", aliases: [] }, { id: "kd", name: "キデイランド", aliases: [] }] as unknown as Chain[];
    const stores = [{ id: "t1", chainId: "tc", name: "渋谷店", prefecture: "東京都" }, { id: "t2", chainId: "tc", name: "梅田店", prefecture: "大阪府" }, { id: "k1", chainId: "kd", name: "原宿店", prefecture: "東京都" }] as unknown as Store[];
    for (const c of cases.account) {
      const r = corroborateAccount({ username: c.username, displayName: c.displayName, bio: c.bio, postText: c.postText, chains, stores });
      const ok = (r.chainName || null) === c.expectChain && (r.storeName || null) === c.expectStore;
      rec({ id: c.id, kind: "account", p: c.p, ok, got: [r.chainName || null, r.storeName || null], expect: [c.expectChain, c.expectStore] });
    }
  });
  it("集計", () => {
    const by = new Map<string, { n: number; ok: number }>();
    for (const r of results) {
      const k = `${r.kind}/${r.p}`;
      const v = by.get(k) ?? { n: 0, ok: 0 };
      v.n++;
      if (r.ok) v.ok++;
      by.set(k, v);
    }
    const summary = Object.fromEntries([...by.entries()].sort());
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ mode: OLD ? "old" : "new", summary, results }, null, 1));
    if (!OLD) {
      // 新方式: 利用者が報告した9項目の事象はすべて期待どおり。合成ケースも不一致が無いこと（精度の主張ではなく、仕様への適合の確認）
      expect(results.filter((r) => !r.ok), JSON.stringify(results.filter((r) => !r.ok))).toEqual([]);
    }
    console.log(JSON.stringify(summary));
  });
});
