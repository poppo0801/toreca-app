/**
 * Stage 8F の結合テスト（実Supabase・RLS適用下・架空データのみ。有料APIなし）:
 *  抽選グループのAI判定（モックAI → 検証層 → DBの関数）。自動グループ化・承認・却下・手動解除の尊重・冪等・同時実行・権限・既存データの不変。
 *   npm run test:db   ※ マイグレーション 20261217000099 の適用後に実行する
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockGroupingBrain } from "@/lib/agent/lottery-grouping/mock";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { decideGroupProposal, dissolveLotteryGroup, groupLotteries, loadPendingGroupProposals, resolveProposal, saveLottery, ungroupLottery, type Db } from "@/lib/server/lottery-service";
import { loadGroupingWorld, runLotteryGrouping, scanLotteryGrouping } from "@/lib/server/agent/lottery-grouping-service";
import { afterCollectedRegistration } from "@/lib/server/collector/grouping-hook";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 8F", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let h2: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・関数は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;
  const careful = (over: { allowAuto?: boolean; asService?: boolean } = {}) => ({ llm: new MockGroupingBrain("careful"), allowAuto: true, asService: false, actor, ...over });
  const eager = (over: { allowAuto?: boolean } = {}) => ({ llm: new MockGroupingBrain("eager"), allowAuto: true, asService: false, actor, ...over });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8f", 1);
    const b = await signInTestUser(admin, "s8f", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    h2 = (await u2.rpc("bootstrap_household")).data as string;
    for (let i = 0; i < 10 && !actor; i++) {
      actor = (await u1.from("profiles").select("id").order("sort_order")).data?.[0]?.id as string;
      if (!actor) await new Promise((r) => setTimeout(r, 300));
    }
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  const mkChain = async (name: string) => (await u1.from("chains").insert({ household_id: h1, name } as never).select("id").single()).data!.id as string;
  const mkStore = async (chainId: string, name: string) => (await u1.from("stores").insert({ household_id: h1, chain_id: chainId, name, prefecture: "兵庫県" } as never).select("id").single()).data!.id as string;
  const mkProduct = async (name: string) => (await u1.from("products").insert({ household_id: h1, official_name: name, packs_per_box: 20 } as never).select("id").single()).data!.id as string;
  const input = (chain: string, product: string, store: { id: string | null; name: string }, over: Record<string, unknown> = {}) =>
    lotteryInputSchema.parse({
      chain: { id: chain, name: "" },
      store: { id: store.id, name: store.name, prefecture: "" },
      campaignId: null,
      newCampaign: null,
      items: [{ product: { id: product, name: "" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "date_only", date: "2099-01-01", time: "" },
      applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" },
      resultDate: { precision: "date_only", date: "2099-01-15", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" },
      receiveMethod: "store",
      applyMethod: "web",
      conditionsText: "共通の条件",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: ["https://example.invalid/8f/common-campaign"],
      eventState: "open",
      limitBasis: "account",
      limitMaxCount: 1,
      memo: "",
      ...over,
    });
  const mkLottery = async (chain: string, product: string, store: string, name: string, over: Record<string, unknown> = {}) => {
    const r = await saveLottery(u1, h1, null, input(chain, product, { id: store, name }, over), actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.ok ? r.value.id : "";
  };
  /** 同じ企画の抽選を n 店舗ぶん作る */
  const mkSet = async (label: string, n: number, over: Record<string, unknown> = {}) => {
    const chain = await mkChain(`8F${label}電機`);
    const product = await mkProduct(`8F${label}商品`);
    const lots: string[] = [];
    for (let i = 0; i < n; i++) lots.push(await mkLottery(chain, product, await mkStore(chain, `8F${label}店${i + 1}`), `8F${label}店${i + 1}`, over));
    return { chain, product, lots };
  };
  const apply = async (chain: string, lotteryId: string, result: "pending" | "won" = "pending") => {
    const acc =
      (await u1.from("service_accounts").select("id").eq("chain_id", chain).limit(1)).data?.[0]?.id ??
      (await u1.from("identities").insert({ household_id: h1, display_label: "8F本人" } as never).select("id").single().then(async (i) => (await u1.from("service_accounts").insert({ household_id: h1, chain_id: chain, identity_id: i.data!.id, login_label: "8F" } as never).select("id").single()).data!.id));
    const r = await u1.from("applications").insert({ household_id: h1, lottery_id: lotteryId, service_account_id: acc, state: "applied", result_status: result, fulfillment_status: "none" } as never).select("id").single();
    return r.data!.id as string;
  };
  const groupOf = async (id: string) => (await x(u1).from("lotteries").select("bulk_group_id").eq("id", id).single()).data?.bulk_group_id as string | null;
  const proposals = async (subject: string) => ((await x(u1).from("lottery_group_proposals").select("*").eq("subject_lottery_id", subject)).data ?? []) as Record<string, unknown>[];
  const snapshot = async (lotIds: string[]) => ({
    lots: (await u1.from("lotteries").select("id,chain_id,store_id,apply_deadline_date,apply_method,event_state,archived_at,memo,conditions_text").in("id", lotIds).order("id")).data,
    apps: (await u1.from("applications").select("id,lottery_id,state,result_status,fulfillment_status").in("lottery_id", lotIds).order("id")).data,
  });

  it("同一系列・同一商品・同一期間・同じ情報源 → 自動でグループ化（origin=ai）。店舗ごとの抽選・応募・当選は変わらない。理由と根拠が残る", async () => {
    const { chain, lots } = await mkSet("自動", 3);
    const appId = await apply(chain, lots[0], "won");
    const before = await snapshot(lots);
    const r = await runLotteryGrouping(u1, h1, lots[2], careful());
    expect(r.status, r.message).toBe("applied");
    expect(r.tier).toBe("auto");
    const g = await groupOf(lots[2]);
    expect(g).toBeTruthy();
    expect(await groupOf(lots[0])).toBe(g);
    expect(await groupOf(lots[1])).toBe(g);
    // 変わらないもの: 抽選ID・店舗・締切・方式・状態・メモ・応募・当選（履歴を含む）
    expect(await snapshot(lots)).toEqual(before);
    expect((await u1.from("applications").select("result_status").eq("id", appId).single()).data?.result_status).toBe("won");
    const grp = (await x(u1).from("lottery_bulk_groups").select("origin,basis,store_count").eq("id", g).single()).data;
    expect(grp.origin).toBe("ai");
    expect(grp.store_count).toBe(3);
    expect(grp.basis).toMatchObject({ by: "ai_auto", lotteryCount: 3, engine: "mock-grouping:careful" });
    expect(String(grp.basis.rationale).length).toBeGreaterThan(5);
    expect(grp.basis.common).toEqual(expect.arrayContaining(["対象商品", "応募期間", "同じ情報源"]));
    const evs = (await x(u1).from("lottery_group_events").select("action,origin,detail").eq("group_id", g)).data as { action: string; origin: string }[];
    expect(evs.filter((e) => e.origin === "ai").length).toBeGreaterThanOrEqual(4); // 作成1＋追加3
    // 提案の記録（自動で実行済み。AIの自己申告ではなく検証層の信頼度）
    const p = (await proposals(lots[2]))[0];
    expect(p).toMatchObject({ status: "applied", tier: "auto", kind: "new_group", applied_group_id: g, engine: "mock-grouping:careful" });
    expect(p.confidence as number).toBeGreaterThanOrEqual(90);
    // 一覧のデータにもグループとして出る
    const world = await loadGroupingWorld(u1, h1, lots[2]);
    expect(world?.groups.find((x2) => x2.id === g)?.origin).toBe("ai");
  });

  it("再収集・重複投稿・再実行: 同じ組を繰り返しグループ化しない／AIを再び呼ばない", async () => {
    const { lots } = await mkSet("再収集", 2);
    const first = await runLotteryGrouping(u1, h1, lots[1], careful());
    expect(first.status).toBe("applied");
    const again = await runLotteryGrouping(u1, h1, lots[1], careful());
    expect(again.status).toBe("skipped"); // すでにグループ所属（または同じ組の記録）
    expect(again.ranAgent === false || again.skipReason !== null || again.message.length > 0).toBe(true);
    expect((await proposals(lots[1])).length).toBe(1);
    expect((await x(u1).from("lottery_bulk_groups").select("id").eq("id", (await groupOf(lots[0]))!)).data).toHaveLength(1);
  });

  it("【8F-5】応募期間が異なる: eager（無理にまとめたがる）でも対象外（まとめない・候補にもしない）", async () => {
    const chain = await mkChain("8F期間電機");
    const product = await mkProduct("8F期間商品");
    const s1 = await mkLottery(chain, product, await mkStore(chain, "8F期間店1"), "8F期間店1");
    const s2 = await mkLottery(chain, product, await mkStore(chain, "8F期間店2"), "8F期間店2", { applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" } });
    const r = await runLotteryGrouping(u1, h1, s2, eager());
    expect(r.status, r.message).toBe("dismissed");
    expect(r.tier).toBe("single");
    expect(await groupOf(s1)).toBeNull();
    expect(await groupOf(s2)).toBeNull();
    expect((await loadPendingGroupProposals(u1, h1)).find((p) => p.subjectId === s2)).toBeUndefined();
  });

  it("応募条件の文面が一部だけ異なる: eager でも自動にならず、承認待ちの候補。承認でグループ化・却下で記録（応募・当選・期限は変わらない）", async () => {
    const chain = await mkChain("8F条件電機");
    const product = await mkProduct("8F条件商品");
    const base = "会員登録が必要です。1人1口まで。店頭受取のみ。";
    const s1 = await mkLottery(chain, product, await mkStore(chain, "8F条件店1"), "8F条件店1", { conditionsText: base });
    const s2 = await mkLottery(chain, product, await mkStore(chain, "8F条件店2"), "8F条件店2", { conditionsText: base + "ただし本人確認書類をお持ちください。" });
    const r = await runLotteryGrouping(u1, h1, s2, eager());
    expect(r.status, r.message).toBe("pending");
    expect(r.tier).toBe("suggest");
    expect(await groupOf(s1)).toBeNull();
    expect(await groupOf(s2)).toBeNull(); // 候補だけ。まだグループ化されていない
    const pending = await loadPendingGroupProposals(u1, h1);
    const mine = pending.find((p) => p.subjectId === s2)!;
    expect(mine.mismatches.some((m) => m.field === "requirements" && m.severity === "soft")).toBe(true);
    // 承認 → グループ化（利用者が承認した記録）。応募・当選・期限は変わらない
    const before = await snapshot([s1, s2]);
    const ok = await decideGroupProposal(u1, mine.id, "approve", "店舗ごとの期間差で同じ企画", actor);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(await groupOf(s1)).toBe(await groupOf(s2));
    expect(await snapshot([s1, s2])).toEqual(before);
    const row = (await proposals(s2))[0];
    expect(row).toMatchObject({ status: "approved", decided_by_profile_id: actor });
    expect((await x(u1).from("lottery_bulk_groups").select("basis").eq("id", await groupOf(s2)).single()).data.basis).toMatchObject({ by: "ai_approved", proposalId: mine.id });
    // 承認の再実行は、同じ結果を返す（二重にグループ化しない）
    const replay = await resolveProposal(u1, mine.id, "approve", null, actor);
    expect(replay.ok && replay.value.replayed).toBe(true);
  });

  it("却下: 同じ組は再提案されない（記録が残り、今後の判断に使われる）。別の組は対象", async () => {
    const chain = await mkChain("8F却下電機");
    const product = await mkProduct("8F却下商品");
    const base = "会員登録が必要です。1人1口まで。店頭受取のみ。";
    const a = await mkLottery(chain, product, await mkStore(chain, "8F却下店1"), "8F却下店1", { conditionsText: base });
    const b = await mkLottery(chain, product, await mkStore(chain, "8F却下店2"), "8F却下店2", { conditionsText: base + "ただし本人確認書類をお持ちください。" });
    const r = await runLotteryGrouping(u1, h1, b, eager());
    expect(r.status).toBe("pending");
    const rej = await decideGroupProposal(u1, r.proposalId!, "reject", "別の企画だった", actor);
    expect(rej.ok).toBe(true);
    expect((await proposals(b))[0]).toMatchObject({ status: "rejected", decision_note: "別の企画だった" });
    const again = await runLotteryGrouping(u1, h1, b, eager());
    expect(["skipped", "dismissed"]).toContain(again.status);
    expect(await groupOf(a)).toBeNull();
    expect((await proposals(b)).filter((p) => p.kind === "new_group")).toHaveLength(1);
    // 却下済みの組は、自動の実行でも使われない（DBが拒否）
    const row = (await proposals(b))[0];
    const forced = await resolveProposal(u1, row.id as string, "approve", null, actor);
    expect(forced.ok && forced.value.status).toBe("rejected");
  });

  it("手動で解除した内容を尊重する: 解除の理由を記録し、同じ組を自動でまとめ直さない（提案は『実行後に解除』として記録）", async () => {
    const { lots } = await mkSet("手動解除", 3);
    const r = await runLotteryGrouping(u1, h1, lots[2], careful());
    expect(r.status).toBe("applied");
    const g = (await groupOf(lots[0]))!;
    // 1件を理由つきで外す
    const un = await x(u1).rpc("ungroup_lottery_tx", { p_lottery: lots[2], p_actor: actor, p_reason: "different_campaign", p_note: "実は別の企画" });
    expect(un.error).toBeNull();
    const ev = (await x(u1).from("lottery_group_events").select("detail").eq("group_id", g).eq("lottery_id", lots[2]).eq("action", "removed")).data[0].detail;
    expect(ev).toMatchObject({ reason: "different_campaign", note: "実は別の企画" });
    expect((ev.wasWith as string[]).sort()).toEqual([lots[0], lots[1]].sort());
    const p = (await proposals(lots[2]))[0];
    expect(p).toMatchObject({ status: "reverted" });
    expect(String(p.revert_reason)).toContain("different_campaign");
    // 再判定しても、外した抽選は元のグループに戻らない
    const again = await runLotteryGrouping(u1, h1, lots[2], careful());
    expect(again.status).not.toBe("applied");
    expect(await groupOf(lots[2])).toBeNull();
    // 全体を解除した場合も同様（理由を記録）
    const g2 = (await groupOf(lots[0])) ?? null;
    if (g2) {
      const d = await dissolveLotteryGroup(u1, g2, actor);
      expect(d.ok).toBe(true);
    }
    const world = await loadGroupingWorld(u1, h1, lots[0]);
    expect(world!.separated.size).toBeGreaterThan(0);
  });

  it("手動の解除は、旧い呼び出し（理由なし）のままでも動く（旧アプリとの互換）", async () => {
    const chain = await mkChain("8F互換電機");
    const product = await mkProduct("8F互換商品");
    const a = await mkLottery(chain, product, await mkStore(chain, "8F互換店1"), "8F互換店1");
    const b = await mkLottery(chain, product, await mkStore(chain, "8F互換店2"), "8F互換店2");
    const c = await mkLottery(chain, product, await mkStore(chain, "8F互換店3"), "8F互換店3");
    const g = await groupLotteries(u1, [a, b, c], {}, actor);
    expect(g.ok).toBe(true);
    expect((await x(u1).rpc("ungroup_lottery_tx", { p_lottery: c, p_actor: actor })).error).toBeNull();
    expect((await x(u1).rpc("dissolve_lottery_group_tx", { p_group: g.ok ? g.value.groupId : "", p_actor: actor })).error).toBeNull();
    expect((await ungroupLottery(u1, a, actor)).ok).toBe(true); // 所属なしは何もしない
  });

  it("既存グループへの新店舗の追加: 一括登録・複製のグループへは自動、手動で作ったグループへは承認が必要", async () => {
    // 手動で作ったグループ（origin=manual）に追加する候補 → 承認待ち（手動の内容を勝手に変えない）
    const m = await mkSet("追加手動", 3);
    const manual = await groupLotteries(u1, [m.lots[0], m.lots[1]], {}, actor);
    expect(manual.ok).toBe(true);
    const r1 = await runLotteryGrouping(u1, h1, m.lots[2], careful());
    expect(r1.kind).toBe("add_to_group");
    expect(r1.tier).toBe("suggest");
    expect(r1.status).toBe("pending");
    expect(await groupOf(m.lots[2])).toBeNull();
    // 複製・一括登録のグループ（origin=duplicate）へは自動で追加される
    const d = await mkSet("追加複製", 3);
    const dup = await groupLotteries(u1, [d.lots[0], d.lots[1]], {}, actor);
    const gid = dup.ok ? dup.value.groupId : "";
    await x(u1).from("lottery_bulk_groups").update({ origin: "duplicate" }).eq("id", gid);
    const r2 = await runLotteryGrouping(u1, h1, d.lots[2], careful());
    expect(r2.status, r2.message).toBe("applied");
    expect(r2.kind).toBe("add_to_group");
    expect(await groupOf(d.lots[2])).toBe(gid);
    expect((await x(u1).from("lottery_bulk_groups").select("store_count,origin").eq("id", gid).single()).data).toMatchObject({ store_count: 3, origin: "duplicate" }); // 既存グループの出所は変えない
  });

  it("同時実行・再試行: 同じ抽選を同時に判定しても、提案もグループも1つだけ。同じ提案の決定を同時に行っても二重にならない", async () => {
    const { lots } = await mkSet("同時", 3);
    const rs = await Promise.all([runLotteryGrouping(u1, h1, lots[2], careful()), runLotteryGrouping(u1, h1, lots[2], careful()), runLotteryGrouping(u1, h1, lots[2], careful())]);
    expect(rs.filter((r) => r.status === "applied").length).toBe(1);
    expect((await proposals(lots[2])).length).toBe(1);
    const groups = new Set([await groupOf(lots[0]), await groupOf(lots[1]), await groupOf(lots[2])]);
    expect(groups.size).toBe(1);
    expect([...groups][0]).toBeTruthy();
    // 重なる別の組の提案を同時に自動実行しても、同じ抽選が二重にグループ化されない
    const { lots: l2 } = await mkSet("同時2", 3);
    const both = await Promise.all([runLotteryGrouping(u1, h1, l2[0], careful()), runLotteryGrouping(u1, h1, l2[1], careful()), runLotteryGrouping(u1, h1, l2[2], careful())]);
    expect(both.filter((r) => r.status === "applied").length).toBeGreaterThanOrEqual(1);
    const g2 = new Set([await groupOf(l2[0]), await groupOf(l2[1]), await groupOf(l2[2])]);
    expect(g2.size).toBe(1);
    expect((await x(u1).from("lottery_bulk_groups").select("id").in("id", [...g2].filter(Boolean) as string[])).data).toHaveLength(1);
  });

  it("状況の変化: 実行前に対象が除外・グループ化されたら、自動実行せず無効（superseded）にする。既存データは変えない", async () => {
    const { lots } = await mkSet("変化", 3);
    // 判定は auto になるが、実行の直前に別の操作でグループ化された状況を作る
    const world = await loadGroupingWorld(u1, h1, lots[2]);
    expect(world).toBeTruthy();
    const pre = await groupLotteries(u1, [lots[0], lots[1]], {}, actor);
    expect(pre.ok).toBe(true);
    const r = await runLotteryGrouping(u1, h1, lots[2], careful());
    // 手動グループ（origin=manual）が既にあるため、追加は承認待ちの候補になる（自動では動かさない）
    expect(r.status).toBe("pending");
    expect(await groupOf(lots[2])).toBeNull();
    // 承認の前に、対象が除外されたら、承認しても実行されない
    await u1.from("lotteries").update({ archived_at: new Date().toISOString() } as never).eq("id", lots[2]);
    const dec = await decideGroupProposal(u1, r.proposalId!, "approve", null, actor);
    expect(dec.ok).toBe(false);
    expect((await proposals(lots[2]))[0]).toMatchObject({ status: "superseded" });
  });

  it("service_role（自動収集）の入口: 世帯を指定して自動グループ化できる。他の世帯の抽選は扱えない", async () => {
    const { lots } = await mkSet("収集", 3);
    const r = await runLotteryGrouping(admin as unknown as Db, h1, lots[2], careful({ asService: true }));
    expect(r.status, r.message).toBe("applied");
    expect(await groupOf(lots[0])).toBe(await groupOf(lots[2]));
    expect((await proposals(lots[2]))[0]).toMatchObject({ status: "applied", tier: "auto" });
    // 別の世帯を指定しても、この世帯の抽選は読み込めない（世帯の境界）
    expect(await loadGroupingWorld(admin as unknown as Db, h2, lots[0])).toBeNull();
  });

  it("権限: 別の世帯の利用者は、提案を読めず・決定できず・作れない。匿名は何もできない。自動の入口は一般利用者から呼べない", async () => {
    const { lots } = await mkSet("権限", 2);
    const r = await runLotteryGrouping(u1, h1, lots[1], eager({ allowAuto: false }));
    expect(["pending", "dismissed"]).toContain(r.status);
    const pid = (await proposals(lots[1]))[0].id as string;
    expect((await x(u2).from("lottery_group_proposals").select("id").eq("id", pid)).data).toHaveLength(0);
    const cross = await resolveProposal(u2, pid, "reject", null, null);
    expect(cross.ok).toBe(false);
    const ins = await x(u2).from("lottery_group_proposals").insert({ household_id: h1, proposal_key: "x:evil:1234", kind: "single", tier: "single", subject_lottery_id: lots[1] });
    expect(ins.error).not.toBeNull();
    expect((await x(u1).rpc("resolve_lottery_group_proposal_as", { p_id: pid, p_action: "reject", p_note: null, p_actor: null, p_household: h1 })).error).not.toBeNull(); // service_role 専用
    // 自動の実行は、検証層が auto と判定していない提案（tier != auto）には使えない
    const auto = await x(u1).rpc("resolve_lottery_group_proposal_tx", { p_id: pid, p_action: "auto_apply", p_note: null, p_actor: actor });
    expect(auto.error).not.toBeNull();
  });

  it("一意キー・形式の制約: 同じ組のキーは世帯内で一意。不正な種類・状態・信頼度は拒否される", async () => {
    const { lots } = await mkSet("制約", 2);
    const base = { household_id: h1, proposal_key: `new_group:test-${randomUUID().slice(0, 8)}:2`, kind: "new_group", tier: "suggest", subject_lottery_id: lots[0], lottery_ids: [lots[0], lots[1]] };
    expect((await x(u1).from("lottery_group_proposals").insert(base)).error).toBeNull();
    expect((await x(u1).from("lottery_group_proposals").insert(base)).error?.code).toBe("23505");
    for (const bad of [{ kind: "merge_all" }, { status: "done" }, { confidence: 101 }, { tier: "maybe" }]) {
      expect((await x(u1).from("lottery_group_proposals").insert({ ...base, proposal_key: `k:${randomUUID()}`, ...bad })).error).not.toBeNull();
    }
  });

  it("既存データへの影響なし: 判定・グループ化・解除を通して、店舗ごとの抽選・応募・当選・購入は変わらない（物理削除もない）", async () => {
    const { chain, lots } = await mkSet("不変", 3);
    await apply(chain, lots[0], "won");
    await apply(chain, lots[1]);
    const before = await snapshot(lots);
    const purchasesBefore = (await u1.from("purchases").select("id")).data?.length ?? 0;
    await runLotteryGrouping(u1, h1, lots[2], careful());
    await x(u1).rpc("ungroup_lottery_tx", { p_lottery: lots[1], p_actor: actor, p_reason: "other", p_note: "" });
    expect(await snapshot(lots)).toEqual(before);
    expect((await u1.from("purchases").select("id")).data?.length ?? 0).toBe(purchasesBefore);
    expect((await u1.from("lotteries").select("id").in("id", lots)).data).toHaveLength(3);
  });

  it("収集との連携（登録直後のフック）: 開発環境では既存グループとの関係を判定する。本番相当の環境では何もしない。失敗しても例外を出さない", async () => {
    const { lots } = await mkSet("フック", 3);
    const saved = process.env.TOREMANE_ENV;
    try {
      process.env.TOREMANE_ENV = "production"; // 本番相当: 何もしない
      await afterCollectedRegistration(u1, h1, lots[2], { asService: false, actor });
      expect(await groupOf(lots[2])).toBeNull();
      expect(await proposals(lots[2])).toHaveLength(0);
      delete process.env.TOREMANE_ENV;
      await afterCollectedRegistration(u1, h1, lots[2], { asService: false, actor });
      expect(await groupOf(lots[2])).toBeNull();
      process.env.TOREMANE_ENV = "local"; // 開発環境: 判定してグループ化
      await expect(afterCollectedRegistration(u1, h1, "00000000-0000-4000-8000-000000000000", { asService: false, actor })).resolves.toBeUndefined(); // 存在しない抽選でも例外なし
      await afterCollectedRegistration(u1, h1, lots[2], { asService: false, actor });
      expect(await groupOf(lots[2])).toBeTruthy();
      expect(await groupOf(lots[2])).toBe(await groupOf(lots[0]));
    } finally {
      if (saved === undefined) delete process.env.TOREMANE_ENV;
      else process.env.TOREMANE_ENV = saved;
    }
  });

  it("一括判定（scan）: AIの実行回数に上限がある。グループ所属・単独の抽選は対象外。結果の集計を返す", async () => {
    const { lots } = await mkSet("スキャン", 4);
    const solo = await mkSet("スキャン単独", 1);
    const sum = await scanLotteryGrouping(u1, h1, { ...careful(), maxAiRuns: 1, chainId: undefined });
    expect(sum.aiRuns).toBeLessThanOrEqual(1);
    expect(["done", "max_ai_runs", "max_evaluations"]).toContain(sum.stoppedBy);
    expect(await groupOf(solo.lots[0])).toBeNull();
    void lots;
  });
});
