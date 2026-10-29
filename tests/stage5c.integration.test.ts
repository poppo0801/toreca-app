/**
 * Stage 5C の結合テスト（実Supabase・RLS適用下）: 管理番号の採番、Excel取り込みの適用（原子性・競合・二重適用）、世帯の分離。
 *   npm run test:db   ※ マイグレーション 20261029000022 の適用後に実行する
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTemplate } from "@/lib/master-excel/workbook";
import { SHEET, type MasterKind } from "@/lib/master-excel/schema";
import { applyImport, exportMaster, previewImport } from "@/lib/server/master-import-service";
import { saveLottery, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

/** テンプレートに行を書いたxlsxを作る（行 = 列の並び順の文字列配列） */
async function xlsx(kind: MasterKind, rows: string[][], components: string[][] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildTemplate(kind)) as unknown as ExcelJS.Buffer);
  const put = (name: string, data: string[][]) => {
    const ws = wb.getWorksheet(name)!;
    data.forEach((r, i) => r.forEach((v, c) => (ws.getCell(i + 2, c + 1).value = v === "" ? null : v)));
  };
  put(kind === "products" ? SHEET.products : SHEET.stores, rows);
  if (components.length) put(SHEET.components, components);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
// 商品の列: 管理番号,コード,種別,正式名称,略称,グループ,発売日,カテゴリ,BOX入数,BOX定価,パック定価,メモ
const P = (o: Partial<Record<string, string>>) => ["management_no", "code", "kind", "name", "aliases", "group", "release", "category", "packs", "box", "pack", "memo"].map((k) => o[k] ?? "");
// 店舗の列: 管理番号,系列,店舗名,都道府県,住所,URL,交通費,応募方法,受取方法,メモ
const S = (o: Partial<Record<string, string>>) => ["management_no", "chain", "name", "pref", "address", "url", "fare", "apply", "receive", "memo"].map((k) => o[k] ?? "");

describe.skipIf(!dbTestsEnabled)("Stage 5C: 管理番号とExcel取り込み", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let profile: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い場合がある
  const rpc = (db: Db, fn: string, args?: Record<string, unknown>) => (db as any).rpc(fn, args);

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5c", 1);
    const b = await signInTestUser(admin, "s5c", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").limit(1)).data![0].id;
    await u1.from("chains").insert({ household_id: hid1, name: "5C電機" });
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("商品・店舗の挿入時に管理番号が自動で付く（世帯ごとの連番）。付いた番号は変更できない", async () => {
    const mk = (name: string) => u1.from("products").insert({ household_id: hid1, official_name: name }).select("id,management_no").single();
    const a = (await mk("採番A")).data!;
    const b = (await mk("採番B")).data!;
    expect(a.management_no).toBe("PR000001");
    expect(b.management_no).toBe("PR000002");
    // 別の世帯は独立して1から
    expect((await u2.from("products").insert({ household_id: hid2, official_name: "他世帯" }).select("management_no").single()).data!.management_no).toBe("PR000001");
    // 変更不可
    expect((await u1.from("products").update({ management_no: "PR000099" }).eq("id", a.id)).error).not.toBeNull();
    expect((await u1.from("products").update({ official_name: "採番A改" }).eq("id", a.id)).error).toBeNull();
    expect((await u1.from("products").select("management_no").eq("id", a.id).single()).data!.management_no).toBe("PR000001");
    // 形式の不正な番号は挿入できない。重複も不可
    expect((await u1.from("products").insert({ household_id: hid1, official_name: "不正", management_no: "XX1" })).error).not.toBeNull();
    expect((await u1.from("products").insert({ household_id: hid1, official_name: "重複", management_no: "PR000001" })).error).not.toBeNull();
    const chain = (await u1.from("chains").select("id").eq("name", "5C電機").single()).data!.id;
    expect((await u1.from("stores").insert({ household_id: hid1, chain_id: chain, name: "採番店" }).select("management_no").single()).data!.management_no).toBe("ST000001");
  });

  it("同時の挿入でも管理番号が重複しない・欠番にならない", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => u1.from("products").insert({ household_id: hid1, official_name: `並行${i}` }).select("management_no").single()));
    const nos = results.map((r) => r.data?.management_no);
    expect(nos.every(Boolean)).toBe(true);
    expect(new Set(nos).size).toBe(8);
    const all = (await u1.from("products").select("management_no")).data!.map((r) => r.management_no as string).sort();
    const max = Math.max(...all.map((n) => Number(n.slice(2))));
    expect(max).toBe(all.length); // 欠番なし
  });

  it("商品: 新規・更新・略称・セット構成を1回で適用。履歴が残り、同じ内容の二重適用は拒否される", async () => {
    const before = (await u1.from("products").select("id,management_no,official_name").order("management_no")).data!;
    const base = before[0]; // PR000001 (採番A改)
    const file = await xlsx(
      "products",
      [
        P({ name: "取込新規1", code: "IMP-1", kind: "独自", aliases: "取込略称|別名", release: "2026-12-05", packs: "30", box: "5400" }),
        P({ name: "取込新規2" }),
        P({ management_no: base.management_no!, memo: "更新メモ", pack: "180" }),
      ],
    );
    const pv = await previewImport(u1, "products", file);
    expect(pv.ok && pv.preview.counts).toEqual({ new: 2, update: 1, unchanged: 0, error: 0 });
    if (!pv.ok) return;
    expect(pv.preview.applicable).toBe(true);

    // 指紋が違うと拒否（プレビューしていない内容）
    expect((await applyImport(u1, "products", file, "t.xlsx", "0".repeat(64), profile))).toMatchObject({ ok: false, code: "stale" });
    const done = await applyImport(u1, "products", file, "t.xlsx", pv.preview.fingerprint, profile);
    expect(done.ok && done.created).toEqual([expect.stringMatching(/^PR\d{6}$/), expect.stringMatching(/^PR\d{6}$/)]);

    const rows = (await u1.from("products").select("management_no,official_name,product_code,product_code_kind,release_date,packs_per_box,list_price_box,list_price_pack,memo,updated_by_profile_id")).data!;
    const n1 = rows.find((r) => r.official_name === "取込新規1")!;
    expect(n1).toMatchObject({ product_code: "IMP-1", product_code_kind: "custom", release_date: "2026-12-05", packs_per_box: 30, list_price_box: 5400, updated_by_profile_id: profile });
    expect(rows.find((r) => r.management_no === base.management_no)).toMatchObject({ memo: "更新メモ", list_price_pack: 180, official_name: "採番A改" }); // 空欄の項目は変更されない
    const aliasRows = (await u1.from("product_aliases").select("alias,product_id").eq("alias", "取込略称")).data!;
    expect(aliasRows).toHaveLength(1);

    // 履歴（値は残さない）
    const hist = (await u1.from("master_import_history").select("*")).data!;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ kind: "products", created_count: 2, updated_count: 1, file_name: "t.xlsx", imported_by_profile_id: profile });
    expect(JSON.stringify(hist[0].details)).not.toContain("更新メモ");
    expect((await u1.from("master_import_history").update({ created_count: 9 }).eq("id", hist[0].id).select()).data ?? []).toHaveLength(0); // 更新不可
    expect((await u2.from("master_import_history").select("id")).data ?? []).toHaveLength(0); // 他世帯からは見えない

    // 二重適用: 同じ内容をもう一度（新規は既に存在するので、プレビューの段階でエラーになる）
    const again = await previewImport(u1, "products", file);
    expect(again.ok && again.preview.counts.error).toBe(2);
    // 同じ指紋のRPCを直接呼んでも履歴の一意制約で拒否される
    const dup = await rpc(u1, "apply_master_import", { p_kind: "products", p_ops: { rows: [], components: [] }, p_actor: profile, p_file_name: "x", p_file_sha: "a".repeat(64), p_fingerprint: pv.preview.fingerprint, p_unchanged: 0 });
    expect(dup.error).not.toBeNull();
  });

  it("エクスポート → そのまま取り込みで、全行が「変更なし」", async () => {
    const buf = await exportMaster(u1, "products");
    const pv = await previewImport(u1, "products", buf);
    expect(pv.ok).toBe(true);
    if (pv.ok) {
      expect(pv.preview.counts.new + pv.preview.counts.update + pv.preview.counts.error).toBe(0);
      expect(pv.preview.counts.unchanged).toBeGreaterThan(5);
    }
  });

  it("競合: プレビュー後に他の操作でデータが変わると、何も反映せずに拒否する（原子性）", async () => {
    const target = (await u1.from("products").select("id,management_no").eq("official_name", "取込新規2").single()).data!;
    const file = await xlsx("products", [P({ name: "競合で作られるはずの商品" }), P({ management_no: target.management_no!, memo: "競合テスト" })]);
    const pv = await previewImport(u1, "products", file);
    expect(pv.ok && pv.preview.applicable).toBe(true);
    if (!pv.ok) return;
    // 画面でプレビューしたあと、別の操作で同じ商品が更新された
    await u1.from("products").update({ memo: "別の操作" }).eq("id", target.id);
    const r = await applyImport(u1, "products", file, "c.xlsx", pv.preview.fingerprint, profile);
    expect(r).toMatchObject({ ok: false });
    expect((await u1.from("products").select("id").eq("official_name", "競合で作られるはずの商品")).data).toHaveLength(0); // 新規も作られていない
    expect((await u1.from("products").select("memo").eq("id", target.id).single()).data!.memo).toBe("別の操作");

    // RPC単体でも、古い updated_at を渡すと全体が取り消される
    const cur = (await u1.from("products").select("updated_at").eq("id", target.id).single()).data!;
    const ops = { rows: [{ no: null, expected: null, set: { official_name: "取り消されるはず" }, aliases: null }, { no: target.management_no, expected: "2000-01-01T00:00:00+00:00", set: { memo: "x" }, aliases: null }], components: [] };
    const bad = await rpc(u1, "apply_master_import", { p_kind: "products", p_ops: ops, p_actor: profile, p_file_name: "r", p_file_sha: "b".repeat(64), p_fingerprint: "c".repeat(64), p_unchanged: 0 });
    expect(bad.error?.code).toBe("PT409");
    expect((await u1.from("products").select("id").eq("official_name", "取り消されるはず")).data).toHaveLength(0);
    expect((await u1.from("master_import_history").select("id").eq("file_sha256", "b".repeat(64))).data).toHaveLength(0);
    expect(cur.updated_at).toBeTruthy();
  });

  it("エラーが1件でもあれば適用しない。存在しない管理番号・他世帯の番号は更新できない", async () => {
    const otherNo = (await u2.from("products").select("management_no").single()).data!.management_no; // 他世帯の PR000001（自世帯にも同じ番号がある）
    const file = await xlsx("products", [P({ name: "エラーと同居の新規" }), P({ management_no: "PR009999", memo: "x" })]);
    const pv = await previewImport(u1, "products", file);
    expect(pv.ok && pv.preview.counts.error).toBe(1);
    if (pv.ok) {
      expect(pv.preview.applicable).toBe(false);
      expect(await applyImport(u1, "products", file, "e.xlsx", pv.preview.fingerprint || "d".repeat(64), profile)).toMatchObject({ ok: false, code: "invalid" });
    }
    expect((await u1.from("products").select("id").eq("official_name", "エラーと同居の新規")).data).toHaveLength(0);
    // RPCに他世帯の商品IDは渡せない（管理番号で自世帯の中だけを探す）
    const other = await rpc(u1, "apply_master_import", { p_kind: "products", p_ops: { rows: [{ no: "PR009999", expected: "2000-01-01T00:00:00+00:00", set: { memo: "x" }, aliases: null }], components: [] }, p_actor: profile, p_file_name: "o", p_file_sha: "e".repeat(64), p_fingerprint: "f".repeat(64), p_unchanged: 0 });
    expect(other.error).not.toBeNull();
    expect(otherNo).toBe("PR000001");
    // 他人のプロフィールIDを操作者にはできない
    const otherProfile = (await u2.from("profiles").select("id").limit(1)).data![0].id;
    const forged = await rpc(u1, "apply_master_import", { p_kind: "products", p_ops: { rows: [], components: [] }, p_actor: otherProfile, p_file_name: "o", p_file_sha: "1".repeat(64), p_fingerprint: "2".repeat(64), p_unchanged: 0 });
    expect(forged.error).not.toBeNull();
  });

  it("セット構成: 追加と数量の更新のみで、既存の構成は削除されない", async () => {
    const ps = (await u1.from("products").select("id,management_no,official_name").in("official_name", ["採番A改", "採番B", "取込新規1"])).data!;
    const no = (n: string) => ps.find((p) => p.official_name === n)!.management_no!;
    const set = no("採番A改");
    const first = await xlsx("products", [], [[set, no("採番B"), "2"], [set, no("取込新規1"), "1"]]);
    const p1 = await previewImport(u1, "products", first);
    expect(p1.ok && p1.preview.components).toEqual({ new: 2, update: 0, unchanged: 0, error: 0 });
    if (!p1.ok) return;
    expect((await applyImport(u1, "products", first, "s.xlsx", p1.preview.fingerprint, profile)).ok).toBe(true);
    expect((await u1.from("product_set_items").select("quantity")).data).toHaveLength(2);

    // 1行だけ（数量変更）のファイルを取り込んでも、もう1つの構成は残る
    const second = await xlsx("products", [], [[set, no("採番B"), "5"]]);
    const p2 = await previewImport(u1, "products", second);
    if (!p2.ok) throw new Error("preview failed");
    expect(p2.preview.components).toEqual({ new: 0, update: 1, unchanged: 0, error: 0 });
    expect((await applyImport(u1, "products", second, "s2.xlsx", p2.preview.fingerprint, profile)).ok).toBe(true);
    const items = (await u1.from("product_set_items").select("quantity")).data!.map((r) => r.quantity).sort();
    expect(items).toEqual([1, 5]);
  });

  it("取り込みで更新しても、商品画像・商品ID・抽選の商品参照・セット構成の参照は変わらない", async () => {
    const chain = (await u1.from("chains").select("id").eq("name", "5C電機").single()).data!.id;
    const pr = (await u1.from("products").insert({ household_id: hid1, official_name: "保持確認商品", packs_per_box: 30 }).select("id,management_no").single()).data!;
    const img = { household_id: hid1, product_id: pr.id, kind: "box", storage_path: `${hid1}/${pr.id}/box.png`, sha256: "a".repeat(64), width: 100, height: 200, source: "manual" };
    expect((await u1.from("product_images").insert(img)).error).toBeNull();
    const lot = await saveLottery(
      u1, hid1, null,
      {
        chain: { id: chain, name: "" }, store: { id: null, name: "保持確認店", prefecture: "" }, multiMode: "single", campaignId: null, newCampaign: null,
        items: [{ id: null, product: { id: pr.id, name: "" }, quantity: 1, unit: "box" }],
        applyStart: { precision: "unknown", date: "", time: "" }, applyDeadline: { precision: "date_only", date: "2026-11-30", time: "" },
        resultDate: { precision: "unknown", date: "", time: "" }, procedureDeadline: { precision: "unknown", date: "", time: "" },
        receiveMethod: "store", applyMethod: "app", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [],
        eventState: "open", limitBasis: "person", limitMaxCount: 1, memo: "", applications: [], appliedAt: "",
      },
      profile,
    );
    expect(lot.ok).toBe(true);
    const snap = async () => ({
      images: (await u1.from("product_images").select("*").eq("product_id", pr.id)).data,
      items: (await u1.from("lottery_items").select("id,product_id,quantity,unit").eq("product_id", pr.id)).data,
      product: (await u1.from("products").select("id,management_no,created_at").eq("id", pr.id).single()).data,
    });
    const before = await snap();
    expect(before.items).toHaveLength(1);
    const file = await xlsx("products", [P({ management_no: pr.management_no!, name: "保持確認商品（改名）", memo: "取り込みで更新", box: "6000" })]);
    const pv = await previewImport(u1, "products", file);
    if (!pv.ok) throw new Error("preview failed");
    expect(pv.preview.counts.update).toBe(1);
    expect((await applyImport(u1, "products", file, "keep.xlsx", pv.preview.fingerprint, profile)).ok).toBe(true);
    const after = await snap();
    expect(after.images).toEqual(before.images); // 画像の行（パス・ハッシュ・サイズ・更新日時）が変わらない
    expect(after.items).toEqual(before.items); // 抽選の商品参照が変わらない
    expect(after.product).toEqual(before.product); // 内部IDも管理番号も変わらない
    expect((await u1.from("products").select("official_name,list_price_box").eq("id", pr.id).single()).data).toMatchObject({ official_name: "保持確認商品（改名）", list_price_box: 6000 });
  });

  it("店舗: 新規・更新を適用。住所を変えると位置の再確認フラグが立つ。系列は変更できない", async () => {
    const chain = (await u1.from("chains").select("id").eq("name", "5C電機").single()).data!.id;
    const st = (await u1.from("stores").select("id,management_no").eq("name", "採番店").single()).data!;
    await u1.from("stores").update({ latitude: 34.69, longitude: 135.19, address_optional: "旧住所" }).eq("id", st.id);
    const file = await xlsx("stores", [
      S({ chain: "5C電機", name: "取込店", pref: "兵庫県", fare: "800", apply: "アプリ", receive: "店頭", url: "https://example.invalid/s" }),
      S({ management_no: st.management_no!, address: "新住所", fare: "1,200" }),
    ]);
    const pv = await previewImport(u1, "stores", file);
    expect(pv.ok && pv.preview.counts).toEqual({ new: 1, update: 1, unchanged: 0, error: 0 });
    if (!pv.ok) return;
    expect(pv.preview.rows.find((r) => r.no === st.management_no)!.notes[0]).toContain("再確認");
    const done = await applyImport(u1, "stores", file, "st.xlsx", pv.preview.fingerprint, profile);
    expect(done.ok && done.created[0]).toMatch(/^ST\d{6}$/);
    const after = (await u1.from("stores").select("name,address_optional,round_trip_fare,location_review_needed,latitude,apply_method,receive_method,store_url,chain_id")).data!;
    expect(after.find((s) => s.name === "採番店")).toMatchObject({ address_optional: "新住所", round_trip_fare: 1200, location_review_needed: true, latitude: 34.69 }); // 位置は消さない
    expect(after.find((s) => s.name === "取込店")).toMatchObject({ chain_id: chain, apply_method: "app", receive_method: "store", round_trip_fare: 800, location_review_needed: false });

    // 系列の変更・未登録の系列はエラー。エクスポート→取り込みは変更なし
    await u1.from("chains").insert({ household_id: hid1, name: "5C別系列" });
    const bad = await previewImport(u1, "stores", await xlsx("stores", [S({ management_no: st.management_no!, chain: "5C別系列" }), S({ chain: "存在しない系列", name: "x" })]));
    expect(bad.ok && bad.preview.counts.error).toBe(2);
    const round = await previewImport(u1, "stores", await exportMaster(u1, "stores"));
    expect(round.ok && round.preview.counts.new + round.preview.counts.update + round.preview.counts.error).toBe(0);
  });

  it("他世帯のデータは出力にも取り込みにも現れない。操作履歴(audit)に更新が残る", async () => {
    const a = await previewImport(u2, "products", await exportMaster(u2, "products"));
    expect(a.ok && a.preview.counts.unchanged).toBe(1); // 他世帯の1件のみ
    const logs = (await u1.from("audit_logs").select("entity_type,action").eq("entity_type", "products").eq("action", "update")).data!;
    expect(logs.length).toBeGreaterThan(0);
  });

  it("未ログインの権限ではRPCを呼べない", async () => {
    const { anonClient } = await import("./helpers/db");
    const r = await (anonClient() as unknown as Db).rpc("apply_master_import" as never, { p_kind: "products", p_ops: { rows: [] }, p_actor: null, p_file_name: "x", p_file_sha: "a".repeat(64), p_fingerprint: "a".repeat(64), p_unchanged: 0 } as never);
    expect(r.error).not.toBeNull();
  });
});
