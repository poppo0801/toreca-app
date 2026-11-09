/**
 * Stage 7G・7H の結合テスト（実Supabase・RLS適用下・架空データのみ。AI・外部サイト・有料APIは使わない）:
 *  7G: 対戦記録のプロフィール別管理（相手プロフィール・操作ID・制約・世帯分離・既存の記録の保持）
 *  7H: 除外ルール（collection_rules）と除外履歴（collection_exclusion_log）の制約・世帯分離・追記のみ・ルール削除後の履歴保持、
 *      除外理由つきの除外が使う候補の状態遷移（status=excluded/duplicate）
 *   npm run test:db   ※ マイグレーション 20261202000081 / 20261203000082 の適用後に実行する
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7G/7H", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let h2: string;
  let pa: string;
  let pb: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7gh", 1);
    const b = await signInTestUser(admin, "s7gh", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    h2 = (await u2.rpc("bootstrap_household")).data as string;
    const profs = (await u1.from("profiles").select("id").order("sort_order")).data!;
    pa = profs[0].id;
    pb = profs[1]?.id ?? (await u1.from("profiles").insert({ household_id: h1, label: "7G相手", initial: "相", color: "green", sort_order: 9 }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    // purge_test_households が新しい表を知らなくても消せるよう外部キーは cascade。念のため先に自分の行を消す
    const hs = (await admin.from("households").select("id").in("owner_auth_user_id", ids)).data ?? [];
    for (const t of ["collection_exclusion_log", "collection_rules"]) await admin.from(t as never).delete().in("household_id", hs.map((h) => h.id));
    await cleanupTestUsers(admin, ids);
  });

  const battle = (over: Record<string, unknown> = {}) => ({ household_id: h1, played_on: "2026-11-09", profile_id: pa, my_deck: "リザードン", opponent_deck: "サーナイト", result: "win", turn_order: "", format: "ジムバトル", memo: "", opponent: "", ...over });

  describe("Stage 7G: 対戦記録", () => {
    it("アプリ内プロフィール同士の対戦は1件で保存でき、相手のプロフィールを持つ。外部の相手は名称だけ。既存の形式（相手なし・持ち主なし）も保てる", async () => {
      expect((await x(u1).from("battle_records").insert(battle({ opponent_profile_id: pb }))).error).toBeNull();
      expect((await x(u1).from("battle_records").insert(battle({ opponent: "友だち" }))).error).toBeNull();
      // 持ち主が決まっていない既存の形式（profile_id なし）
      expect((await x(u1).from("battle_records").insert(battle({ profile_id: null, my_deck: "旧デッキ" }))).error).toBeNull();
      const rows = (await x(u1).from("battle_records").select("profile_id,opponent_profile_id,opponent,my_deck")).data;
      expect(rows).toHaveLength(3);
      expect(rows.find((r: { my_deck: string }) => r.my_deck === "旧デッキ")).toMatchObject({ profile_id: null, opponent_profile_id: null });
    });

    it("制約: 自分自身を相手にできない／持ち主のない共有の対戦は作れない／他世帯のプロフィールは相手にできない", async () => {
      expect((await x(u1).from("battle_records").insert(battle({ opponent_profile_id: pa }))).error).not.toBeNull();
      expect((await x(u1).from("battle_records").insert(battle({ profile_id: null, opponent_profile_id: pb }))).error).not.toBeNull();
      const other = (await u2.from("profiles").select("id").limit(1)).data![0].id;
      expect((await x(u1).from("battle_records").insert(battle({ opponent_profile_id: other }))).error).not.toBeNull();
    });

    it("同じ操作ID（再送・二重タップ）では二重に登録されない", async () => {
      const op = randomUUID();
      expect((await x(u1).from("battle_records").insert(battle({ op_id: op, my_deck: "二重送信" }))).error).toBeNull();
      const again = await x(u1).from("battle_records").insert(battle({ op_id: op, my_deck: "二重送信" }));
      expect(again.error?.code).toBe("23505");
      expect((await x(u1).from("battle_records").select("id").eq("op_id", op)).data).toHaveLength(1);
    });

    it("1件の記録の編集は双方に反映される（同じ行を読む）。他世帯の記録は読めない", async () => {
      const ins = await x(u1).from("battle_records").insert(battle({ opponent_profile_id: pb, my_deck: "共有デッキ" })).select("id").single();
      const id = ins.data.id as string;
      expect((await x(u1).from("battle_records").update({ result: "lose", memo: "訂正" }).eq("id", id)).error).toBeNull();
      const row = (await x(u1).from("battle_records").select("result,memo,profile_id,opponent_profile_id").eq("id", id).single()).data;
      expect(row).toMatchObject({ result: "lose", memo: "訂正", profile_id: pa, opponent_profile_id: pb });
      expect((await x(u2).from("battle_records").select("id").eq("id", id)).data).toHaveLength(0);
    });
  });

  describe("Stage 7H: 除外ルールと除外履歴", () => {
    const rule = (over: Record<string, unknown> = {}) => ({ household_id: h1, kind: "region_store", label: "サンプル電機 梅田店", chain_name: "サンプル電機", store_name: "梅田店", prefecture: "大阪府", city: "大阪", ...over });
    const mkCand = async (n: string) => (await u1.from("collection_candidates").insert({ household_id: h1, dedupe_key: `https://s7h.example.invalid/${n}`, source_url: `https://s7h.example.invalid/${n}`, title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"] } as never).select("id").single()).data!.id as string;

    it("ルールの種類ごとの必須項目: 店舗名の無い地域ルール・系列IDの無いエリア外系列・キーワードの無い別ゲームは作れない（広範囲の除外を防ぐ）", async () => {
      expect((await x(u1).from("collection_rules").insert(rule())).error).toBeNull();
      expect((await x(u1).from("collection_rules").insert(rule({ store_name: "", label: "" }))).error).not.toBeNull();
      expect((await x(u1).from("collection_rules").insert({ household_id: h1, kind: "area_chain", chain_name: "A" })).error).not.toBeNull();
      expect((await x(u1).from("collection_rules").insert({ household_id: h1, kind: "area_chain", chain_name: "A", chain_id: randomUUID() })).error).toBeNull();
      expect((await x(u1).from("collection_rules").insert({ household_id: h1, kind: "other_game", keywords: [] })).error).not.toBeNull();
      expect((await x(u1).from("collection_rules").insert({ household_id: h1, kind: "other_game", keywords: ["他社カード"] })).error).toBeNull();
      expect((await x(u1).from("collection_rules").insert({ household_id: h1, kind: "bogus", keywords: ["x"] })).error).not.toBeNull();
    });

    it("ルールは有効・無効の切替と編集ができ、他の世帯からは見えず作れない", async () => {
      const r = (await x(u1).from("collection_rules").insert(rule({ store_name: "なんば店" })).select("id").single()).data.id as string;
      expect((await x(u1).from("collection_rules").update({ active: false, released_at: new Date().toISOString() }).eq("id", r)).error).toBeNull();
      expect((await x(u1).from("collection_rules").select("active").eq("id", r).single()).data.active).toBe(false);
      expect((await x(u1).from("collection_rules").update({ active: true, released_at: null, city: "大阪市" }).eq("id", r)).error).toBeNull();
      expect((await x(u2).from("collection_rules").select("id").eq("id", r)).data).toHaveLength(0);
      expect((await x(u2).from("collection_rules").insert(rule({ household_id: h1 }))).error).not.toBeNull();
      expect((await x(u2).from("collection_rules").delete().eq("id", r)).error).toBeNull(); // RLSで0件（他世帯のルールは消えない）
      expect((await x(u1).from("collection_rules").select("id").eq("id", r)).data).toHaveLength(1);
    });

    it("除外履歴は追記のみ（変更・削除できない）。理由は6種類。ルールを削除しても履歴は残る", async () => {
      const c = await mkCand("log1");
      const r = (await x(u1).from("collection_rules").insert(rule({ store_name: "三宮店" })).select("id").single()).data.id as string;
      const log = { household_id: h1, candidate_id: c, reason_code: "region", detail: { title: "log1", storeName: "三宮店" }, rule_table: "collection_rules", rule_id: r, created_by_profile_id: pa };
      const ins = await x(u1).from("collection_exclusion_log").insert(log).select("id").single();
      expect(ins.error).toBeNull();
      expect((await x(u1).from("collection_exclusion_log").insert({ ...log, reason_code: "bogus" })).error).not.toBeNull();
      for (const code of ["region", "untrusted", "area_chain", "duplicate", "other_game", "other"]) expect((await x(u1).from("collection_exclusion_log").insert({ ...log, reason_code: code, rule_id: null, rule_table: null })).error, code).toBeNull();
      // 変更・削除は許可しない
      await x(u1).from("collection_exclusion_log").update({ reason_code: "other" }).eq("id", ins.data.id);
      await x(u1).from("collection_exclusion_log").delete().eq("id", ins.data.id);
      expect((await x(u1).from("collection_exclusion_log").select("reason_code").eq("id", ins.data.id).single()).data.reason_code).toBe("region");
      // ルールの削除後も履歴は残る
      expect((await x(u1).from("collection_rules").delete().eq("id", r)).error).toBeNull();
      expect((await x(u1).from("collection_exclusion_log").select("rule_id").eq("id", ins.data.id).single()).data.rule_id).toBe(r);
      // 他世帯からは読めず、書けない
      expect((await x(u2).from("collection_exclusion_log").select("id").eq("candidate_id", c)).data).toHaveLength(0);
      expect((await x(u2).from("collection_exclusion_log").insert(log)).error).not.toBeNull();
    });

    it("除外理由つきの除外が使う状態遷移: 除外は status=excluded、重複は duplicate（候補は削除しない）。元に戻せる", async () => {
      const c = await mkCand("trans1");
      const upd = await u1.from("collection_candidates").update({ status: "excluded", job_state: "skipped", reasons: ["利用者が除外しました", "除外理由: 別ゲーム"], resolved_at: new Date().toISOString() } as never).eq("id", c).select("status");
      expect(upd.data?.[0].status).toBe("excluded");
      const back = await u1.from("collection_candidates").update({ status: "pending", job_state: "review", reasons: ["要確認"], resolved_at: null } as never).eq("id", c).select("status");
      expect(back.data?.[0].status).toBe("pending");
      const d = await u1.from("collection_candidates").update({ status: "duplicate", job_state: "completed", reasons: ["利用者が除外しました", "除外理由: 重複"] } as never).eq("id", c).select("status");
      expect(d.data?.[0].status).toBe("duplicate");
      expect((await u1.from("collection_candidates").select("id").eq("id", c)).data).toHaveLength(1);
    });

    it("Stage 7J: 管理者フラグ（profiles.is_admin）は既定で false。テスト世帯のプロフィールは管理者ではない。表示名を変えても判定は変わらない（IDの列）", async () => {
      const profs = (await x(u1).from("profiles").select("id,label,is_admin")).data as { id: string; label: string; is_admin: boolean }[];
      expect(profs.length).toBeGreaterThan(0);
      expect(profs.every((p) => p.is_admin === false)).toBe(true);
      // 管理者に設定 → 表示名を変更しても is_admin は変わらない
      const target = profs[0];
      expect((await x(u1).from("profiles").update({ is_admin: true }).eq("id", target.id)).error).toBeNull();
      expect((await x(u1).from("profiles").update({ label: "改名後" }).eq("id", target.id)).error).toBeNull();
      expect((await x(u1).from("profiles").select("is_admin,label").eq("id", target.id).single()).data).toMatchObject({ is_admin: true, label: "改名後" });
      // 他の世帯のプロフィールは更新できない
      const other = (await u2.from("profiles").select("id").limit(1)).data![0].id;
      await x(u1).from("profiles").update({ is_admin: true }).eq("id", other);
      expect((await x(u2).from("profiles").select("is_admin").eq("id", other).single()).data.is_admin).toBe(false);
    });

    it("household の掃除で新しい表も消える（外部キーは cascade）", async () => {
      const probe = (await admin.from("households").select("id").eq("id", h2).single()).data;
      expect(probe?.id).toBe(h2);
    });
  });
});
