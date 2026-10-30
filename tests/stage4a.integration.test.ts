/**
 * Stage 4A の結合テスト（実Supabase・RLS適用下）: 商品コード、セット構成、画像ストレージのアクセス制御。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { loadAppData, saveLottery, setFulfillment, setResult, type Db } from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// 1x1 の透過PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe.skipIf(!dbTestsEnabled)("Stage 4A: 商品マスター・セット・画像ストレージ", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let profA: string;
  const prod: Record<string, string> = {};

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s4a", 1);
    const b = await signInTestUser(admin, "s4a", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profA = ((await u1.from("profiles").select("id,label")).data ?? []).find((p) => p.label === "A")!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  const insertProduct = (db: Db, hid: string, code: string, extra: Record<string, unknown> = {}) =>
    db.from("products").insert({ household_id: hid, official_name: `商品${code}`, product_code: code, product_code_kind: "custom", ...extra }).select("id").single();

  it("商品コードは大文字小文字を区別せず重複不可。入数なし（単品・セット）でも登録でき、30と補われない", async () => {
    const m6 = await insertProduct(u1, hid1, "M6", { packs_per_box: 30, list_price_box: 6000, list_price_pack: 200, sales_form: "pack_box" });
    expect(m6.error).toBeNull();
    prod.m6 = m6.data!.id;
    const dup = await insertProduct(u1, hid1, "m6");
    expect(dup.error?.code).toBe("23505");
    // 別世帯なら同じコードも使える
    expect((await insertProduct(u2, hid2, "M6")).error).toBeNull();

    const set1 = await insertProduct(u1, hid1, "30TH-01", { list_price_unit: 1200, sales_form: "single_set" });
    expect(set1.error).toBeNull();
    prod.s1 = set1.data!.id;
    const all = await insertProduct(u1, hid1, "30TH-SET", { list_price_unit: 10800, sales_form: "single_set" });
    prod.all = all.data!.id;
    const row = (await u1.from("products").select("packs_per_box,is_provisional").eq("id", prod.s1).single()).data!;
    expect(row.packs_per_box).toBeNull();
    // 空のURLは形式チェックで拒否（アプリ側は空欄をNULLにして保存する）
    expect((await u1.from("products").update({ source_url: "" }).eq("id", prod.s1)).error).not.toBeNull();
    expect((await u1.from("products").update({ source_url: "https://example.invalid/x" }).eq("id", prod.s1)).error).toBeNull();
  });

  it("セット構成は構造のみ。自己参照・重複は拒否、他世帯の商品は参照できない。構成商品は購入に加算されない", async () => {
    const link = (set: string, comp: string) => u1.from("product_set_items").insert({ household_id: hid1, set_product_id: set, component_product_id: comp, quantity: 1 });
    expect((await link(prod.all, prod.s1)).error).toBeNull();
    expect((await link(prod.all, prod.s1)).error?.code).toBe("23505");
    expect((await link(prod.all, prod.all)).error).not.toBeNull();
    const foreign = (await insertProduct(u2, hid2, "X-OTHER")).data!.id;
    expect((await link(prod.all, foreign)).error).not.toBeNull();
    expect((await u2.from("product_set_items").select("id")).data).toHaveLength(0);

    // セット商品を2セット購入 → 購入はセット商品の1明細のみ（構成商品の分は二重計上されない）。金額は単品・セット定価×数量の仮入力
    const lot = await saveLottery(
      u1, hid1, null,
      {
        chain: { id: null, name: "4A電機" }, store: { id: null, name: "4A店", prefecture: "" }, multiMode: "single", campaignId: null, newCampaign: null,
        items: [{ product: { id: prod.all, name: "" }, quantity: 2, unit: "set" }],
        applyStart: EMPTY_FLEX, applyDeadline: EMPTY_FLEX, resultDate: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
        receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "",
        sourceUrls: [], eventState: "open", limitBasis: "person", limitMaxCount: 1, memo: "", applications: [{ profileId: profA, status: "applied" }], appliedAt: "",
      },
      profA,
    );
    expect(lot.ok).toBe(true);
    const d = await loadAppData(u1);
    const app = d.applications[0];
    expect((await setResult(u1, app.id, "won", profA)).ok).toBe(true);
    expect((await setFulfillment(u1, app.id, "purchased", profA)).ok).toBe(true);
    const p = (await loadAppData(u1)).purchases.filter((x) => x.applicationId === app.id);
    expect(p).toHaveLength(1);
    expect(p[0].items).toHaveLength(1);
    expect(p[0].items[0]).toMatchObject({ productId: prod.all, quantity: 2, unit: "set", amountPaid: 21600 });
  });

  it("商品画像は種類ごとに1件。ストレージは非公開で、自世帯のフォルダだけ読み書きできる（他世帯・未ログインは不可）", async () => {
    const path = `${hid1}/${prod.m6}/box-test.png`;
    const up = await u1.storage.from("product-images").upload(path, PNG, { contentType: "image/png" });
    expect(up.error).toBeNull();
    const rec = await u1.from("product_images").insert({ household_id: hid1, product_id: prod.m6, kind: "box", storage_path: path, sha256: "a".repeat(64), width: 1, height: 1, source: "import" });
    expect(rec.error).toBeNull();
    expect((await u1.from("product_images").insert({ household_id: hid1, product_id: prod.m6, kind: "box", storage_path: path, sha256: "b".repeat(64) })).error?.code).toBe("23505");
    expect((await u1.from("product_images").insert({ household_id: hid1, product_id: prod.m6, kind: "other", storage_path: path, sha256: "c".repeat(64) })).error).not.toBeNull();

    // 本人: 期限付きURLで表示できる。loadAppData が商品に紐づけて返す
    const signed = await u1.storage.from("product-images").createSignedUrl(path, 60);
    expect(signed.error).toBeNull();
    const res = await fetch(signed.data!.signedUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const img = (await loadAppData(u1)).products.find((p) => p.id === prod.m6)!.images?.box;
    expect(img).toMatchObject({ width: 1, height: 1, source: "import" });
    // 画像はアプリのURL（内容ハッシュ入り）で配信する。取得にはログインが必要で、期限付きURLは発行しない
    expect(img!.url).toMatch(/^\/api\/product-image\/[0-9a-f-]{36}\?v=[0-9a-f]{12}&s=full$/);
    expect(img!.url).not.toContain("token=");

    // 他世帯: 読めない・署名URLも作れない・自世帯でないフォルダへ書けない・画像記録も見えない
    expect((await u2.storage.from("product-images").createSignedUrl(path, 60)).error).not.toBeNull();
    expect((await u2.storage.from("product-images").download(path)).error).not.toBeNull();
    expect((await u2.storage.from("product-images").upload(`${hid1}/${prod.m6}/pack-evil.png`, PNG, { contentType: "image/png" })).error).not.toBeNull();
    expect((await u2.storage.from("product-images").upload("not-a-household/x.png", PNG, { contentType: "image/png" })).error).not.toBeNull();
    expect((await u2.from("product_images").select("id")).data).toHaveLength(0);

    // 未ログイン: 非公開バケットなので公開URLでも取得できない
    const anon = anonClient();
    expect((await anon.storage.from("product-images").download(path)).error).not.toBeNull();
    const pub = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/product-images/${path}`);
    expect(pub.status).not.toBe(200);
    // 形式・サイズの制限（バケット設定）: 許可外のMIMEは拒否
    expect((await u1.storage.from("product-images").upload(`${hid1}/${prod.m6}/x.txt`, Buffer.from("hello"), { contentType: "text/plain" })).error).not.toBeNull();

    await u1.storage.from("product-images").remove([path]); // 掃除（purge はDBのみのため）
  });
});
