/**
 * Stage 7F の結合テスト（実Supabase・RLS適用下・架空データのみ）:
 * 相場の取得状況（market_status）・更新履歴（market_update_runs）・BOXの照合の確定（box_market_links）・BOXの取得相場（box_market_prices）の
 * 世帯分離・制約・冪等な保存、商品の統合・削除での追従。
 *   npm run test:db   ※ マイグレーション 20261201000079 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeProducts, deleteProduct } from "@/lib/server/product-merge-service";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7F: 相場の取得状況・BOX相場・照合の確定", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;
  const mkProduct = async (name: string, over: Record<string, unknown> = {}) => (await u1.from("products").insert({ household_id: h1, official_name: name, packs_per_box: 30, ...over } as never).select("id").single()).data!.id as string;
  const price = (productId: string, over: Record<string, unknown> = {}) => ({ household_id: h1, product_id: productId, kind: "buyback", basis: "base", median_yen: 6000, low_yen: 5500, high_yen: 6500, sample_count: 2, shops: [], source: "ポケカ価格比較", match_method: "name", ...over });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7f", 1);
    const b = await signInTestUser(admin, "s7f", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    actor = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
  });
  afterAll(async () => {
    // purge_test_households はこの段階の新しい表を知らないため、先に自分の表を空にする（商品への参照が残ると世帯を掃除できない）
    const hs = (await admin.from("households").select("id").in("owner_auth_user_id", ids)).data ?? [];
    for (const t of ["box_market_prices", "box_market_links", "market_status", "market_update_runs"]) await admin.from(t as never).delete().in("household_id", hs.map((h) => h.id));
    await cleanupTestUsers(admin, ids);
  });

  it("取得状況は対象ごとに1行で、再保存（再取込）しても増えず、制約外の値は拒否される", async () => {
    const sid = crypto.randomUUID();
    const row = (status: string) => ({ household_id: h1, subject: "card", subject_id: sid, status, sale_ok: true, buyback_ok: false, reason: "", checked_at: new Date().toISOString() });
    expect((await x(u1).from("market_status").upsert(row("unlisted"), { onConflict: "subject,subject_id" })).error).toBeNull();
    expect((await x(u1).from("market_status").upsert(row("updated"), { onConflict: "subject,subject_id" })).error).toBeNull();
    const rows = (await x(u1).from("market_status").select("status").eq("subject_id", sid)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("updated");
    expect((await x(u1).from("market_status").insert({ ...row("updated"), subject_id: crypto.randomUUID(), status: "bogus" })).error).not.toBeNull();
    expect((await x(u1).from("market_status").insert({ ...row("updated"), subject_id: crypto.randomUUID(), subject: "pack" })).error).not.toBeNull();
    // 他の世帯からは読めず、作成もできない
    expect(((await x(u2).from("market_status").select("status").eq("subject_id", sid)).data ?? []).length).toBe(0);
    expect((await x(u2).from("market_status").insert(row("updated"))).error).not.toBeNull();
  });

  it("更新履歴は成功・失敗の分類つきで残り、世帯をまたいで見えない。履歴の書き換えはできない", async () => {
    const ins = await x(u1).from("market_update_runs").insert([
      { household_id: h1, ok: false, error_kind: "network", error_message: "通信エラー", source: "download", summary: {} },
      { household_id: h1, ok: true, error_kind: null, error_message: "", source: "upload", csv_rows: 2832, summary: { cards: { updated: 19 } } },
    ]);
    expect(ins.error).toBeNull();
    expect((await x(u1).from("market_update_runs").insert({ household_id: h1, ok: false, error_kind: "weird" })).error).not.toBeNull();
    const mine = (await x(u1).from("market_update_runs").select("ok,error_kind").order("created_at", { ascending: false })).data;
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(((await x(u2).from("market_update_runs").select("ok")).data ?? []).length).toBe(0);
    // 更新（改ざん）は許可しない
    await x(u1).from("market_update_runs").update({ ok: true }).eq("household_id", h1);
    expect((await x(u1).from("market_update_runs").select("ok").eq("ok", false)).data.length).toBeGreaterThanOrEqual(1);
  });

  it("BOXの取得相場は商品×販売/買取×状態の根拠で1行。再保存で上書きされ（増えず）、手動の box_prices には触れない", async () => {
    const p = await mkProduct("7F取得BOX");
    // 手動の相場
    expect((await x(u1).from("box_prices").insert({ household_id: h1, product_id: p, shrink_state: null, amount_yen: 12000, confirmed_on: "2026-11-01", source: "手動", updated_by_profile_id: actor })).error).toBeNull();
    const up = (over: Record<string, unknown> = {}) => x(u1).from("box_market_prices").upsert(price(p, over), { onConflict: "product_id,kind,basis" });
    expect((await up()).error).toBeNull();
    expect((await up({ median_yen: 6500, sample_count: 3 })).error).toBeNull();
    expect((await up({ basis: "no_shrink", median_yen: 4000, sample_count: 1 })).error).toBeNull();
    expect((await up({ kind: "sale", median_yen: 9000 })).error).toBeNull();
    const rows = (await x(u1).from("box_market_prices").select("kind,basis,median_yen,sample_count").eq("product_id", p)).data;
    expect(rows).toHaveLength(3);
    expect(rows.find((r: { kind: string; basis: string }) => r.kind === "buyback" && r.basis === "base")).toMatchObject({ median_yen: 6500, sample_count: 3 });
    // 制約
    expect((await up({ basis: "unknown" })).error).not.toBeNull();
    expect((await up({ match_method: "guess" })).error).not.toBeNull();
    expect((await up({ sample_count: 0 })).error).not.toBeNull();
    // 手動の相場は変わらない
    const manual = (await u1.from("box_prices").select("amount_yen").eq("product_id", p)).data!;
    expect(manual).toEqual([{ amount_yen: 12000 }]);
    // 他世帯の商品には書けず、読めない
    expect(((await x(u2).from("box_market_prices").select("kind").eq("product_id", p)).data ?? []).length).toBe(0);
    expect((await x(u2).from("box_market_prices").insert(price(p))).error).not.toBeNull();
  });

  it("照合の確定は、同じCSV名を1つの商品にだけ対応させる。複数の表記を同じ商品に対応させてよく、他世帯からは見えない", async () => {
    const p1 = await mkProduct("7F照合BOX1");
    const p2 = await mkProduct("7F照合BOX2");
    const link = (productId: string, key: string) => x(u1).from("box_market_links").upsert({ household_id: h1, product_id: productId, csv_key: key, csv_name: key }, { onConflict: "household_id,csv_key" });
    expect((await link(p1, "7fkeya")).error).toBeNull();
    expect((await link(p1, "7fkeyb")).error).toBeNull(); // 同じ商品に複数の表記
    expect((await link(p2, "7fkeya")).error).toBeNull(); // 利用者が選び直したら付け替わる（1つのCSV名は1商品）
    const rows = (await x(u1).from("box_market_links").select("csv_key,product_id").in("csv_key", ["7fkeya", "7fkeyb"])).data;
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { csv_key: string }) => r.csv_key === "7fkeya").product_id).toBe(p2);
    expect(((await x(u2).from("box_market_links").select("csv_key")).data ?? []).length).toBe(0);
    expect((await x(u2).from("box_market_links").insert({ household_id: h1, product_id: p1, csv_key: "other" })).error).not.toBeNull();
  });

  it("商品の統合で、確定した対応は統合先に付け替わり、取得相場は統合先に無い種類だけ引き継ぐ（手動の相場の扱いは従来どおり）", async () => {
    const from = await mkProduct("7F統合元");
    const into = await mkProduct("7F統合先");
    expect((await x(u1).from("box_market_links").insert({ household_id: h1, product_id: from, csv_key: "7fmergekey", csv_name: "x" })).error).toBeNull();
    await x(u1).from("box_market_prices").insert([price(from, { median_yen: 1111 }), price(from, { kind: "sale", median_yen: 2222 }), price(into, { median_yen: 9999 })]);
    const m = await mergeProducts(u1, from, into, actor);
    expect(m.ok, JSON.stringify(m)).toBe(true);
    const link = (await x(u1).from("box_market_links").select("product_id").eq("csv_key", "7fmergekey")).data;
    expect(link).toEqual([{ product_id: into }]);
    const rows = (await x(u1).from("box_market_prices").select("kind,basis,median_yen,product_id").in("product_id", [from, into])).data;
    expect(rows.filter((r: { product_id: string }) => r.product_id === from)).toHaveLength(0);
    const get = (kind: string) => rows.find((r: { kind: string; product_id: string }) => r.kind === kind && r.product_id === into);
    expect(get("buyback").median_yen).toBe(9999); // 統合先の取得相場を上書きしない
    expect(get("sale").median_yen).toBe(2222); // 統合先に無い種類は引き継ぐ
    // 再実行しても破損・重複しない
    const again = await mergeProducts(u1, from, into, actor);
    expect(again.ok).toBe(true);
    expect((await x(u1).from("box_market_prices").select("kind").eq("product_id", into)).data).toHaveLength(2);
  });

  it("参照の無い商品を削除すると、その取得相場と照合の確定も一緒に消える（派生データ）", async () => {
    const p = await mkProduct("7F削除対象");
    await x(u1).from("box_market_prices").insert(price(p));
    await x(u1).from("box_market_links").insert({ household_id: h1, product_id: p, csv_key: "7fdelkey", csv_name: "x" });
    const d = await deleteProduct(u1, p);
    expect(d.ok, JSON.stringify(d)).toBe(true);
    expect((await x(u1).from("box_market_prices").select("kind").eq("product_id", p)).data).toHaveLength(0);
    expect((await x(u1).from("box_market_links").select("csv_key").eq("csv_key", "7fdelkey")).data).toHaveLength(0);
  });
});
