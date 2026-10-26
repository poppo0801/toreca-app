import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { manualPurchaseSchema, type ManualPurchaseInput } from "@/lib/purchase-input";
import { dbToFlex, flexInputToDb, lotteryInputSchema, type LotteryInput } from "@/lib/lottery-input";
import type { Database } from "@/types/database";
import type {
  AppData,
  EventState,
  FulfillmentStatus,
  ProfileColor,
  ResultStatus,
} from "@/types/domain";

/**
 * 抽選まわりのDB操作。Server Action から呼ぶ薄い層で、結合テストからも直接呼べるよう
 * 認証済み（RLS適用）の SupabaseClient を引数に取る。service_role は使わない。
 */
export type Db = SupabaseClient<Database>;
export type ServiceResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });

interface PgError {
  code?: string;
  message: string;
}

export function mapDbError(e: PgError): string {
  switch (e.code) {
    case "23505":
      return "同じ内容のデータが既に登録されています";
    case "23503":
      return "参照先が存在しない、または他の世帯のデータです";
    case "23514":
      return e.message.includes("fulfillment_status")
        ? "購入手続き済みの応募の結果は変更できません"
        : "入力値が制約に違反しています";
    case "22023":
      return "当選した応募のみ操作できます";
    case "P0002":
      return "対象のデータが見つかりません";
    case "42501":
      return "この操作は許可されていません";
    default:
      console.error("lottery service error", e.code);
      return "保存に失敗しました。時間をおいて再度お試しください";
  }
}

const uuid = z.uuid();
const nowIso = () => new Date().toISOString();

/** 認証済みユーザーの世帯ID（RLSにより自世帯のみ見える） */
export async function currentHouseholdId(db: Db): Promise<string | null> {
  const { data } = await db.from("households").select("id").maybeSingle();
  return data?.id ?? null;
}

// ------------------------------------------------------------------ 読み込み
/**
 * 世帯の全データを読み込む。householdId を指定すると、その世帯だけに絞る
 * （service_role で複数世帯を扱う通知ジョブ用。通常のユーザー接続はRLSで自世帯のみ）。
 */
export async function loadAppData(db: Db, householdId?: string): Promise<AppData> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テーブル名ごとの型を問わない共通の取得ヘルパー
  const sel = (table: string): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (db as any).from(table).select("*");
    return householdId ? q.eq("household_id", householdId) : q;
  };
  const q = await Promise.all([
    sel("profiles").order("sort_order").order("created_at"),
    sel("profile_target_rules"),
    sel("chains").order("created_at"),
    sel("stores").order("created_at"),
    sel("products").order("created_at"),
    sel("product_aliases"),
    sel("family_groups"),
    sel("identities"),
    sel("service_accounts"),
    sel("campaigns"),
    sel("lotteries").is("archived_at", null).limit(5000),
    sel("lottery_items").limit(20000),
    sel("lottery_management").limit(5000),
    sel("applications").limit(20000),
    sel("purchases").limit(20000),
    sel("purchase_items").limit(50000),
    sel("skip_rules"),
    sel("skip_rule_exceptions"),
    sel("audit_logs").order("occurred_at", { ascending: false }).limit(50),
    sel("application_rules"),
    sel("limit_exemptions"),
    sel("chain_requirements").is("archived_at", null),
    sel("account_eligibilities").is("archived_at", null),
  ] as const);
  const failed = q.find((r) => r.error);
  if (failed?.error) throw new Error(`データの取得に失敗しました: ${failed.error.code ?? ""}`);

  const [profiles, rules, chains, stores, products, aliases, families, identities, accounts, campaigns, lotteries, items, mgmt, apps, purchases, pitems, skips, skipEx, audit, appRules, exemptions, reqs, elig] =
    q.map((r) => r.data ?? []) as unknown as [
      Database["public"]["Tables"]["profiles"]["Row"][],
      Database["public"]["Tables"]["profile_target_rules"]["Row"][],
      Database["public"]["Tables"]["chains"]["Row"][],
      Database["public"]["Tables"]["stores"]["Row"][],
      Database["public"]["Tables"]["products"]["Row"][],
      Database["public"]["Tables"]["product_aliases"]["Row"][],
      Database["public"]["Tables"]["family_groups"]["Row"][],
      Database["public"]["Tables"]["identities"]["Row"][],
      Database["public"]["Tables"]["service_accounts"]["Row"][],
      Database["public"]["Tables"]["campaigns"]["Row"][],
      Database["public"]["Tables"]["lotteries"]["Row"][],
      Database["public"]["Tables"]["lottery_items"]["Row"][],
      Database["public"]["Tables"]["lottery_management"]["Row"][],
      Database["public"]["Tables"]["applications"]["Row"][],
      Database["public"]["Tables"]["purchases"]["Row"][],
      Database["public"]["Tables"]["purchase_items"]["Row"][],
      Database["public"]["Tables"]["skip_rules"]["Row"][],
      Database["public"]["Tables"]["skip_rule_exceptions"]["Row"][],
      Database["public"]["Tables"]["audit_logs"]["Row"][],
      Database["public"]["Tables"]["application_rules"]["Row"][],
      Database["public"]["Tables"]["limit_exemptions"]["Row"][],
      Database["public"]["Tables"]["chain_requirements"]["Row"][],
      Database["public"]["Tables"]["account_eligibilities"]["Row"][],
    ];

  const liveLotteryIds = new Set(lotteries.map((l) => l.id));

  return {
    profiles: profiles.map((p) => {
      const mine = rules.filter((r) => r.profile_id === p.id);
      const allowChains = mine.filter((r) => r.mode === "allow" && r.store_id === null).map((r) => r.chain_id);
      return {
        id: p.id,
        label: p.label,
        initial: p.initial,
        color: p.color as ProfileColor,
        active: p.active,
        allowedChainIds: allowChains.length > 0 ? allowChains : null,
        allowedStoreIds: mine.filter((r) => r.mode === "allow" && r.store_id !== null).map((r) => r.store_id as string),
        blockedChainIds: mine.filter((r) => r.mode === "block" && r.store_id === null).map((r) => r.chain_id),
        blockedStoreIds: mine.filter((r) => r.mode === "block" && r.store_id !== null).map((r) => r.store_id as string),
      };
    }),
    chains: chains.map((c) => ({ id: c.id, name: c.name, archived: c.archived_at != null })),
    stores: stores.map((s) => ({ id: s.id, chainId: s.chain_id, name: s.name, prefecture: s.prefecture, archived: s.archived_at != null })),
    products: products.map((p) => ({
      id: p.id,
      officialName: p.official_name,
      aliases: aliases.filter((a) => a.product_id === p.id).map((a) => a.alias),
      code: p.product_code ?? "",
      packsPerBox: p.packs_per_box,
      archived: p.archived_at != null,
    })),
    familyGroups: families.map((f) => ({ id: f.id, label: f.label })),
    identities: identities.map((i) => ({
      id: i.id,
      label: i.display_label,
      familyGroupId: i.family_group_id,
      addressGroupId: i.address_group_id,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      profileId: a.managed_by_profile_id,
      identityId: a.identity_id,
      chainId: a.chain_id,
      label: a.account_label,
      membership: a.membership_state as "eligible" | "ineligible" | "unknown",
      active: a.active,
    })),
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, chainId: c.chain_id, storeRule: c.store_rule as "one_store" | "multi" })),
    lotteries: lotteries.map((l) => ({
      id: l.id,
      campaignId: l.campaign_id ?? undefined,
      chainId: l.chain_id,
      storeId: l.store_id,
      items: items
        .filter((i) => i.lottery_id === l.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((i) => ({ productId: i.product_id, quantity: i.quantity, unit: i.unit as "box" | "pack" | "set" })),
      applyStart: dbToFlex(l.apply_start_precision, l.apply_start_date, l.apply_start_at),
      applyDeadline: dbToFlex(l.apply_deadline_precision, l.apply_deadline_date, l.apply_deadline_at),
      resultDate: dbToFlex(l.result_precision, l.result_date, l.result_at),
      procedureDeadline: dbToFlex(l.procedure_deadline_precision, l.procedure_deadline_date, l.procedure_deadline_at),
      receiveMethod: l.receive_method as "store" | "shipping" | "either" | "unknown",
      applyMethod: l.apply_method as "web" | "store" | "app" | "unknown",
      conditionsText: l.conditions_text,
      verificationText: l.verification_text,
      announcementMethod: l.announcement_method,
      announcementUrl: l.announcement_url ?? undefined,
      sourceUrls: l.source_urls,
      eventState: l.event_state as EventState,
      limit: { basis: l.limit_basis as "account" | "person" | "family" | "address" | "unknown", maxCount: l.limit_max_count },
      sourceKind: l.source_kind as "manual" | "x_parse" | "auto" | "import",
      isNew: l.is_new,
      memo: l.memo,
      createdAt: l.created_at,
    })),
    management: mgmt
      .filter((m) => liveLotteryIds.has(m.lottery_id))
      .map((m) => ({
        lotteryId: m.lottery_id,
        isManaged: m.is_managed,
        managedSource: m.managed_source as "manual" | "ai",
        managedAt: m.managed_at ?? undefined,
      })),
    applications: apps
      .filter((a) => liveLotteryIds.has(a.lottery_id))
      .map((a) => ({
        id: a.id,
        lotteryId: a.lottery_id,
        accountId: a.service_account_id,
        appliedAt: a.applied_at,
        state: a.state as "applied" | "cancelled",
        result: a.result_status as ResultStatus,
        resultConfirmedAt: a.result_confirmed_at,
        fulfillment: a.fulfillment_status as FulfillmentStatus,
        createdAt: a.created_at,
      })),
    purchases: purchases.map((p) => ({
      id: p.id,
      applicationId: p.application_id,
      storeId: p.store_id,
      purchasedOn: dbToFlex(p.purchased_at ? "date_time" : p.purchased_date ? "date_only" : "unknown", p.purchased_date, p.purchased_at),
      channel: p.channel as "store" | "shipping" | "online" | "other",
      source: p.source_kind as "lottery" | "manual" | "import",
      note: p.note,
      items: pitems
        .filter((i) => i.purchase_id === p.id)
        .map((i) => ({ productId: i.product_id, quantity: i.quantity, unit: i.unit as "box" | "pack" | "set", amountPaid: i.amount_paid })),
    })),
    skipRules: skips.map((s) => ({
      id: s.id,
      profileId: s.profile_id,
      scope: s.scope_type as "lottery" | "store" | "chain",
      scopeId: (s.lottery_id ?? s.store_id ?? s.chain_id) as string,
      exceptionLotteryIds: skipEx.filter((e) => e.skip_rule_id === s.id).map((e) => e.lottery_id),
    })),
    applicationRules: appRules.map((r) => ({
      id: r.id,
      scope: r.scope_type as "chain" | "campaign" | "lottery",
      scopeId: (r.chain_id ?? r.campaign_id ?? r.lottery_id) as string,
      basis: r.basis as "account" | "person" | "family" | "address",
      maxCount: r.max_count,
      across: r.counts_across as "lottery" | "campaign",
      confidence: r.confidence as "confirmed" | "unconfirmed",
    })),
    limitExemptions: exemptions.map((e) => ({ lotteryId: e.lottery_id, accountId: e.service_account_id, reason: e.reason })),
    requirements: reqs.map((r) => ({
      id: r.id,
      chainId: r.chain_id,
      kind: r.kind as "membership" | "point_card" | "purchase_history" | "id_verification" | "other",
      label: r.label,
      validMonths: r.valid_months,
    })),
    eligibilities: elig.map((e) => ({
      id: e.id,
      accountId: e.service_account_id,
      requirementId: e.requirement_id,
      state: e.state as "eligible" | "ineligible" | "unknown",
      verifiedOn: e.verified_on,
      validFrom: e.valid_from,
      validUntil: e.valid_until,
    })),
    audit: audit.map((a) => ({
      id: a.id,
      actorProfileId: a.actor_profile_id ?? "",
      at: a.occurred_at,
      entityType: a.entity_type,
      entityId: a.entity_id ?? "",
      action: a.action,
      before: a.before_json,
      after: a.after_json,
    })),
  };
}

// ------------------------------------------------------------------ 抽選の登録・編集
type LotteryInsert = Database["public"]["Tables"]["lotteries"]["Insert"];

async function loadStore(db: Db, storeId: string) {
  const { data } = await db.from("stores").select("id,chain_id,name").eq("id", storeId).maybeSingle();
  return data;
}

function lotteryRow(input: z.output<typeof lotteryInputSchema>, actor: string | null) {
  const s = flexInputToDb(input.applyStart);
  const d = flexInputToDb(input.applyDeadline);
  const r = flexInputToDb(input.resultDate);
  const p = flexInputToDb(input.procedureDeadline);
  return {
    apply_start_precision: s.precision, apply_start_date: s.date, apply_start_at: s.at,
    apply_deadline_precision: d.precision, apply_deadline_date: d.date, apply_deadline_at: d.at,
    result_precision: r.precision, result_date: r.date, result_at: r.at,
    procedure_deadline_precision: p.precision, procedure_deadline_date: p.date, procedure_deadline_at: p.at,
    receive_method: input.receiveMethod,
    apply_method: input.applyMethod,
    conditions_text: input.conditionsText,
    verification_text: input.verificationText,
    announcement_method: input.announcementMethod,
    announcement_url: input.announcementUrl === "" ? null : input.announcementUrl,
    source_urls: input.sourceUrls,
    event_state: input.eventState,
    limit_basis: input.limitBasis,
    limit_max_count: input.limitMaxCount,
    memo: input.memo,
    updated_by_profile_id: actor,
  } satisfies Partial<LotteryInsert>;
}

/**
 * 抽選の新規登録(id=null)／編集。新規時は応募状況（応募済み/当選/落選）も同時登録でき、
 * 応募開始・締切が過去でもエラーにしない。編集時は応募・当落には触れない。
 */
export async function saveLottery(
  db: Db,
  householdId: string,
  id: string | null,
  raw: LotteryInput,
  actor: string | null,
): Promise<ServiceResult<{ id: string }>> {
  const parsed = lotteryInputSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  const input = parsed.data;
  if (actor !== null && !uuid.safeParse(actor).success) return fail("リクエストが不正です");
  if (id !== null && !uuid.safeParse(id).success) return fail("リクエストが不正です");

  const store = await loadStore(db, input.storeId);
  if (!store) return fail("店舗が見つかりません");
  if (store.chain_id !== input.chainId) return fail("店舗が選択した系列に属していません");

  // キャンペーン（既存選択 or 新規作成）
  let campaignId = input.campaignId;
  if (input.newCampaign) {
    const { data, error } = await db
      .from("campaigns")
      .insert({ household_id: householdId, chain_id: input.chainId, name: input.newCampaign.name, store_rule: input.newCampaign.storeRule, updated_by_profile_id: actor })
      .select("id")
      .single();
    if (error) return fail(mapDbError(error));
    campaignId = data.id;
  } else if (campaignId) {
    const { data } = await db.from("campaigns").select("chain_id").eq("id", campaignId).maybeSingle();
    if (!data || data.chain_id !== input.chainId) return fail("キャンペーンが選択した系列に属していません");
  }

  const base = {
    ...lotteryRow(input, actor),
    campaign_id: campaignId,
    chain_id: input.chainId,
    store_id: input.storeId,
  };

  let lotteryId: string;
  if (id === null) {
    const { data, error } = await db
      .from("lotteries")
      .insert({ ...base, household_id: householdId })
      .select("id")
      .single();
    if (error) return fail(mapDbError(error));
    lotteryId = data.id;
  } else {
    const { data, error } = await db.from("lotteries").update(base).eq("id", id).select("id").maybeSingle();
    if (error) return fail(mapDbError(error));
    if (!data) return fail("対象のデータが見つかりません");
    lotteryId = data.id;
  }

  // 失敗時に中途半端な抽選を残さない（新規のみ。削除はせずアーカイブで退避）
  const abort = async (message: string) => {
    if (id === null) await db.from("lotteries").update({ archived_at: nowIso() }).eq("id", lotteryId);
    return fail(message);
  };

  // 商品明細: 先に新規を入れてから旧明細を除去（途中失敗でも明細が0件にならない）
  const { data: oldItems } = await db.from("lottery_items").select("id").eq("lottery_id", lotteryId);
  const { error: itemError } = await db.from("lottery_items").insert(
    input.items.map((i) => ({
      household_id: householdId,
      lottery_id: lotteryId,
      product_id: i.productId,
      quantity: i.quantity,
      unit: i.unit,
      updated_by_profile_id: actor,
    })),
  );
  if (itemError) return abort(mapDbError(itemError));
  if (oldItems && oldItems.length > 0) {
    const { error } = await db.from("lottery_items").delete().in("id", oldItems.map((o) => o.id));
    if (error) return fail(mapDbError(error));
  }

  if (id === null) {
    const { error: mErr } = await db.from("lottery_management").insert({
      lottery_id: lotteryId,
      household_id: householdId,
      is_managed: input.isManaged ?? true,
      managed_source: "manual",
      managed_at: nowIso(),
      updated_by_profile_id: actor,
    });
    if (mErr) return abort(mapDbError(mErr));

    // 応募状況の同時登録（締切後の過去抽選でも可）
    if (input.applications.length > 0) {
      const { data: accounts } = await db
        .from("service_accounts")
        .select("id,chain_id,active")
        .in("id", input.applications.map((a) => a.accountId));
      const okIds = new Set((accounts ?? []).filter((a) => a.chain_id === input.chainId && a.active).map((a) => a.id));
      if (input.applications.some((a) => !okIds.has(a.accountId))) {
        return abort("この系列で有効な応募アカウントのみ指定できます");
      }
      const appliedAt = input.appliedAt ? new Date(`${input.appliedAt}:00+09:00`).toISOString() : null;
      const { error } = await db.from("applications").insert(
        input.applications.map((a) => ({
          household_id: householdId,
          lottery_id: lotteryId,
          service_account_id: a.accountId,
          applied_at: appliedAt,
          state: "applied",
          result_status: a.status === "applied" ? "pending" : a.status,
          updated_by_profile_id: actor,
        })),
      );
      if (error) return abort(mapDbError(error));
    }
  }
  return ok({ id: lotteryId });
}

/** 同系列の他店舗へ複製。店舗ごとに独立した抽選を作り、同じキャンペーンに関連づける（応募・当落は複製しない）。 */
export async function duplicateLottery(
  db: Db,
  householdId: string,
  lotteryId: string,
  storeIds: string[],
  actor: string | null,
): Promise<ServiceResult<{ ids: string[] }>> {
  const ids = z.array(uuid).min(1, "複製先の店舗を選択してください").max(30).safeParse(storeIds);
  if (!ids.success || !uuid.safeParse(lotteryId).success) return fail(ids.success ? "リクエストが不正です" : ids.error.issues[0].message);

  const { data: src } = await db.from("lotteries").select("*").eq("id", lotteryId).maybeSingle();
  if (!src) return fail("複製元の抽選が見つかりません");
  const { data: items } = await db.from("lottery_items").select("product_id,quantity,unit").eq("lottery_id", lotteryId);
  const { data: stores } = await db.from("stores").select("id,chain_id").in("id", ids.data);
  if ((stores ?? []).length !== new Set(ids.data).size || (stores ?? []).some((s) => s.chain_id !== src.chain_id)) {
    return fail("複製先は同じ系列の店舗のみ選択できます");
  }

  // 元がキャンペーン未所属なら、元と複製先をまとめる新規キャンペーンを作る
  let campaignId = src.campaign_id;
  if (!campaignId) {
    const { data: chain } = await db.from("chains").select("name").eq("id", src.chain_id).maybeSingle();
    const { data, error } = await db
      .from("campaigns")
      .insert({ household_id: householdId, chain_id: src.chain_id, name: `${chain?.name ?? "系列"} 抽選`, store_rule: "multi", updated_by_profile_id: actor })
      .select("id")
      .single();
    if (error) return fail(mapDbError(error));
    campaignId = data.id;
    const { error: e2 } = await db.from("lotteries").update({ campaign_id: campaignId, updated_by_profile_id: actor }).eq("id", lotteryId);
    if (e2) return fail(mapDbError(e2));
  }

  const created: string[] = [];
  for (const storeId of new Set(ids.data)) {
    const { data, error } = await db
      .from("lotteries")
      .insert({
        household_id: householdId,
        campaign_id: campaignId,
        chain_id: src.chain_id,
        store_id: storeId,
        apply_start_precision: src.apply_start_precision, apply_start_date: src.apply_start_date, apply_start_at: src.apply_start_at,
        apply_deadline_precision: src.apply_deadline_precision, apply_deadline_date: src.apply_deadline_date, apply_deadline_at: src.apply_deadline_at,
        result_precision: src.result_precision, result_date: src.result_date, result_at: src.result_at,
        procedure_deadline_precision: src.procedure_deadline_precision, procedure_deadline_date: src.procedure_deadline_date, procedure_deadline_at: src.procedure_deadline_at,
        receive_method: src.receive_method,
        apply_method: src.apply_method,
        conditions_text: src.conditions_text,
        verification_text: src.verification_text,
        announcement_method: src.announcement_method,
        announcement_url: src.announcement_url,
        source_urls: src.source_urls,
        event_state: ["cancelled", "closed"].includes(src.event_state) ? "open" : src.event_state,
        limit_basis: src.limit_basis,
        limit_max_count: src.limit_max_count,
        source_kind: "manual",
        memo: src.memo,
        updated_by_profile_id: actor,
      })
      .select("id")
      .single();
    if (error) return fail(mapDbError(error));
    created.push(data.id);
    const { error: iErr } = await db.from("lottery_items").insert(
      (items ?? []).map((i) => ({ household_id: householdId, lottery_id: data.id, product_id: i.product_id, quantity: i.quantity, unit: i.unit, updated_by_profile_id: actor })),
    );
    if (iErr) return fail(mapDbError(iErr));
    const { error: mErr } = await db.from("lottery_management").insert({
      lottery_id: data.id, household_id: householdId, is_managed: true, managed_source: "manual", managed_at: nowIso(), updated_by_profile_id: actor,
    });
    if (mErr) return fail(mapDbError(mErr));
  }
  return ok({ ids: created });
}

export async function setEventState(db: Db, lotteryId: string, state: EventState, actor: string | null): Promise<ServiceResult> {
  const s = z.enum(["before", "open", "cancelled", "postponed"]).safeParse(state);
  if (!s.success || !uuid.safeParse(lotteryId).success) return fail("リクエストが不正です");
  const { data, error } = await db.from("lotteries").update({ event_state: s.data, updated_by_profile_id: actor }).eq("id", lotteryId).select("id").maybeSingle();
  if (error) return fail(mapDbError(error));
  return data ? ok(undefined) : fail("対象のデータが見つかりません");
}

/** 誤登録の退避。物理削除はしない（応募・購入履歴を保持）。 */
export async function archiveLottery(db: Db, lotteryId: string, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(lotteryId).success) return fail("リクエストが不正です");
  const { data, error } = await db.from("lotteries").update({ archived_at: nowIso(), updated_by_profile_id: actor }).eq("id", lotteryId).select("id").maybeSingle();
  if (error) return fail(mapDbError(error));
  return data ? ok(undefined) : fail("対象のデータが見つかりません");
}

// ------------------------------------------------------------------ ★・応募・当落・購入・スルー
export async function setManaged(db: Db, householdId: string, lotteryId: string, isManaged: boolean, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(lotteryId).success) return fail("リクエストが不正です");
  const { error } = await db.from("lottery_management").upsert(
    {
      lottery_id: lotteryId, household_id: householdId, is_managed: isManaged, managed_source: "manual",
      managed_at: isManaged ? nowIso() : undefined, reviewed_at: nowIso(), updated_by_profile_id: actor,
    },
    { onConflict: "lottery_id" },
  );
  if (error) return fail(mapDbError(error));
  if (isManaged) await db.from("lotteries").update({ is_new: false }).eq("id", lotteryId);
  return ok(undefined);
}

/** 応募の記録／取消。抽選×アカウントで一意。取消しても行は残す。 */
export async function setApplied(db: Db, householdId: string, lotteryId: string, accountId: string, applied: boolean, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(lotteryId).success || !uuid.safeParse(accountId).success) return fail("リクエストが不正です");
  const state = applied ? "applied" : "cancelled";
  const { data: existing } = await db.from("applications").select("id,state").eq("lottery_id", lotteryId).eq("service_account_id", accountId).maybeSingle();
  if (existing) {
    if (existing.state === state) return ok(undefined);
    const { error } = await db.from("applications").update({ state, updated_by_profile_id: actor }).eq("id", existing.id);
    return error ? fail(mapDbError(error)) : ok(undefined);
  }
  if (!applied) return ok(undefined);
  const { data: lot } = await db.from("lotteries").select("chain_id").eq("id", lotteryId).maybeSingle();
  const { data: acc } = await db.from("service_accounts").select("chain_id,active").eq("id", accountId).maybeSingle();
  if (!lot || !acc || lot.chain_id !== acc.chain_id || !acc.active) return fail("この抽選に応募できるアカウントではありません");
  const { error } = await db.from("applications").insert({
    household_id: householdId, lottery_id: lotteryId, service_account_id: accountId, applied_at: nowIso(), state: "applied", updated_by_profile_id: actor,
  });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

export async function setResult(db: Db, applicationId: string, result: ResultStatus, actor: string | null): Promise<ServiceResult> {
  const r = z.enum(["pending", "won", "lost", "unknown"]).safeParse(result);
  if (!r.success || !uuid.safeParse(applicationId).success) return fail("リクエストが不正です");
  const { data, error } = await db
    .from("applications")
    .update({ result_status: r.data, result_confirmed_at: r.data === "pending" ? null : nowIso(), updated_by_profile_id: actor })
    .eq("id", applicationId)
    .select("id")
    .maybeSingle();
  if (error) return fail(mapDbError(error));
  return data ? ok(undefined) : fail("対象のデータが見つかりません");
}

/** 購入手続き済み／購入済み。購入済みは DB 関数が原子的・冪等に購入記録を1件だけ作る。 */
export async function setFulfillment(db: Db, applicationId: string, fulfillment: FulfillmentStatus, actor: string | null): Promise<ServiceResult> {
  const f = z.enum(["procedure_done", "purchased"]).safeParse(fulfillment);
  if (!f.success || !uuid.safeParse(applicationId).success) return fail("リクエストが不正です");
  if (f.data === "purchased") {
    const { error } = await db.rpc("mark_purchased", { p_application_id: applicationId, p_actor: actor as string });
    return error ? fail(mapDbError(error)) : ok(undefined);
  }
  const { data, error } = await db
    .from("applications")
    .update({ fulfillment_status: "procedure_done", procedure_completed_at: nowIso(), updated_by_profile_id: actor })
    .eq("id", applicationId)
    .eq("result_status", "won")
    .eq("fulfillment_status", "none")
    .select("id")
    .maybeSingle();
  if (error) return fail(mapDbError(error));
  return ok(void data);
}

/** 「今回だけ」スルー。実行プロフィールにのみ作用し、他プロフィールへ伝播しない。 */
export async function setLotterySkip(db: Db, householdId: string, profileId: string, lotteryId: string, skip: boolean, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(lotteryId).success) return fail("リクエストが不正です");
  const { data: existing } = await db.from("skip_rules").select("id").eq("profile_id", profileId).eq("scope_type", "lottery").eq("lottery_id", lotteryId).maybeSingle();
  if (skip && !existing) {
    const { error } = await db.from("skip_rules").insert({ household_id: householdId, profile_id: profileId, scope_type: "lottery", lottery_id: lotteryId, updated_by_profile_id: actor });
    return error ? fail(mapDbError(error)) : ok(undefined);
  }
  if (!skip && existing) {
    const { error } = await db.from("skip_rules").delete().eq("id", existing.id);
    return error ? fail(mapDbError(error)) : ok(undefined);
  }
  return ok(undefined);
}

// ------------------------------------------------------------------ 購入履歴（抽選外も入力可）

export async function addManualPurchase(db: Db, householdId: string, raw: ManualPurchaseInput, actor: string | null): Promise<ServiceResult<{ id: string }>> {
  const p = manualPurchaseSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const v = p.data;
  if (v.time && !v.date) return fail("時刻を入れる場合は日付も入力してください");
  const { data, error } = await db
    .from("purchases")
    .insert({
      household_id: householdId,
      store_id: v.storeId || null,
      buyer_profile_id: actor,
      purchased_at: v.date && v.time ? new Date(`${v.date}T${v.time}:00+09:00`).toISOString() : null,
      purchased_date: v.date && !v.time ? v.date : null,
      channel: v.channel,
      source_kind: "manual",
      note: v.note,
      updated_by_profile_id: actor,
    })
    .select("id")
    .single();
  if (error) return fail(mapDbError(error));
  const { error: iErr } = await db.from("purchase_items").insert(
    v.items.map((i) => ({
      household_id: householdId,
      purchase_id: data.id,
      product_id: i.productId || null,
      quantity: i.quantity,
      unit: i.unit,
      amount_paid: i.amountPaid,
      updated_by_profile_id: actor,
    })),
  );
  if (iErr) return fail(mapDbError(iErr));
  return ok({ id: data.id });
}
