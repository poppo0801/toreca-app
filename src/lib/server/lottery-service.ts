import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { normalizeCardDisplay } from "@/lib/card-display";
import { normalizeProfileSettings } from "@/lib/profile-settings";
import { profileSeesChain } from "@/lib/profile-scope";
import { recordAiFeedback } from "@/lib/server/ai-feedback-service";
import { DEFAULT_DISTANCE_BANDS_KM, validBands } from "@/lib/geo";
import { manualPurchaseSchema, type ManualPurchaseInput } from "@/lib/purchase-input";
import { chainLogoUrl } from "@/lib/chain-logo";
import { isCondKind, isCondState, sanitizePurchaseParams, type CondKind, type CondState } from "@/lib/chain-conditions";
import { isAnnounceTarget, isRequirementLogic, isStoreKind, normalizeAnnounceMethods, normalizeRequirementTags, sanitizeRequirementDetails } from "@/lib/lottery-taxonomy";
import { buildLotteryPayload } from "@/lib/lottery-payload";
import { validateLink } from "@/lib/profile-link";
import { dbToFlex, lotteryInputSchema, validateMultiMode, type LotteryInput } from "@/lib/lottery-input";
import type { Database } from "@/types/database";
import type {
  AppData,
  BoxShrinkHint,
  EventState,
  FulfillmentStatus,
  ItemUnit,
  MultiMode,
  ProductKind,
  ProfileColor,
  ShrinkState,
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
      if (e.message.includes("fulfillment_status") || e.message.includes("already purchased")) return "購入済みの応募の結果は変更できません";
      if (e.message.includes("only one item can win")) return "この抽選は当選できる商品が1つまでです";
      if (e.message.includes("insufficient box stock")) return "BOXの所有数が足りません（売却・開封・数量の変更が所有数を超えています）";
      if (e.message.includes("append-only")) return "在庫の履歴は変更できません";
      if (e.message.includes("cost quantity exceeds")) return "この購入分の原価は既に他の売却に使われています（数量を超えています）";
      if (e.message.includes("single lottery") || e.message.includes("multi lottery")) return "抽選方式と商品数が一致していません";
      return "入力値が制約に違反しています";
    case "22023":
      if (e.message.includes("selected item")) return "応募時に選んだ商品のみ結果を登録できます";
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

// ------------------------------------------------------------------ サブユーザーの対象系列（更新処理側の制限）
/**
 * 操作するプロフィールがサブで、その系列が対象外なら、拒否メッセージを返す（メインは常に null）。
 * 画面で非表示にするだけでなく、更新処理でも同じ判定をする（系列の別名＝統合前の名前も同じ系列として扱う）。
 * 対象系列が未設定のサブは、すべての系列が対象外。
 */
export async function subScopeError(db: Db, actor: string | null, chainId: string | null | undefined): Promise<string | null> {
  if (!actor || !chainId) return null;
  const { data: prof } = await db.from("profiles").select("kind").eq("id", actor).maybeSingle();
  if (prof?.kind !== "sub") return null;
  const [{ data: rules }, { data: chains }, { data: aliases }] = await Promise.all([
    db.from("profile_target_rules").select("chain_id,store_id,mode").eq("profile_id", actor),
    db.from("chains").select("id,name"),
    db.from("chain_aliases").select("chain_id,alias"),
  ]);
  const allowed = (rules ?? []).filter((r) => r.mode === "allow" && r.store_id === null).map((r) => r.chain_id);
  const lite = (chains ?? []).map((c) => ({ id: c.id, name: c.name, aliases: (aliases ?? []).filter((a) => a.chain_id === c.id).map((a) => a.alias) }));
  return profileSeesChain({ kind: "sub", allowedChainIds: allowed }, lite, chainId) ? null : "このユーザーは対象外の系列の抽選を操作できません";
}

async function chainOfLottery(db: Db, lotteryId: string): Promise<string | null> {
  const { data } = await db.from("lotteries").select("chain_id").eq("id", lotteryId).maybeSingle();
  return data?.chain_id ?? null;
}

/**
 * 応募の記録（当落・購入・受取）の操作者の確認（Stage 6J）。
 *  - 記録は常に応募アカウントの所有プロフィールの行に保存される（操作者の履歴には書き込まない）。操作者が誰でも、所有者は変わらない。
 *  - サブユーザーが操作できるのは自分の記録だけ（他のユーザーの記録は不可）。メインは従来どおり（画面は本人＋紐づくサブの記録だけを出す）。
 */
export async function ownerScopeError(db: Db, actor: string | null, applicationId: string): Promise<string | null> {
  if (!actor) return null;
  const { data: app } = await db.from("applications").select("service_account_id").eq("id", applicationId).maybeSingle();
  if (!app) return null;
  const { data: acc } = await db.from("service_accounts").select("managed_by_profile_id").eq("id", app.service_account_id).maybeSingle();
  const ownerId = acc?.managed_by_profile_id;
  if (!ownerId || ownerId === actor) return null;
  const { data: me } = await db.from("profiles").select("kind").eq("id", actor).maybeSingle();
  if (me?.kind !== "sub") return null;
  return "サブユーザーは自分の記録だけ操作できます";
}

async function applicationAccessError(db: Db, actor: string | null, applicationId: string): Promise<string | null> {
  return (await ownerScopeError(db, actor, applicationId)) ?? (await subScopeError(db, actor, await chainOfApplication(db, applicationId)));
}

async function chainOfApplication(db: Db, applicationId: string): Promise<string | null> {
  const { data } = await db.from("applications").select("lottery_id").eq("id", applicationId).maybeSingle();
  return data ? chainOfLottery(db, data.lottery_id) : null;
}

/** DB の content_box（jsonb）を検証して読む。壊れた値は補正なし(null) */
function parseContentBox(v: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const n = (k: string) => (typeof b[k] === "number" && Number.isFinite(b[k]) ? (b[k] as number) : null);
  const [x, y, w, h] = [n("x"), n("y"), n("w"), n("h")];
  return x !== null && y !== null && w !== null && h !== null && x >= 0 && y >= 0 && w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** 認証済みユーザーの世帯ID（RLSにより自世帯のみ見える） */
export async function currentHouseholdId(db: Db): Promise<string | null> {
  const { data } = await db.from("households").select("id").maybeSingle();
  return data?.id ?? null;
}

// ------------------------------------------------------------------ 読み込み
/**
 * 後から追加したテーブル（対戦記録・世帯設定）。マイグレーション未適用の環境でも主要な画面を止めないよう、
 * 取得に失敗したら「未設定」(undefined) として扱う。自宅の住所の文字列はここでは読まない（設定画面だけが読む）。
 */
async function loadOptional(db: Db, householdId?: string): Promise<{ battles: AppData["battles"]; settings: AppData["settings"]; chainAliases: { chain_id: string; alias: string }[]; storeAliases: { store_id: string; alias: string }[]; profileSettings: AppData["profileSettings"]; chainConditions: AppData["chainConditions"]; chainConditionStates: AppData["chainConditionStates"] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新テーブルは生成型に無い環境でも動かす
  const from = (t: string): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (db as any).from(t);
    return q;
  };
  const scope = <T extends { eq: (c: string, v: string) => T }>(q: T): T => (householdId ? q.eq("household_id", householdId) : q);
  let battles: AppData["battles"];
  let settings: AppData["settings"];
  let chainAliases: { chain_id: string; alias: string }[] = [];
  let storeAliases: { store_id: string; alias: string }[] = [];
  try {
    const [c, st] = await Promise.all([scope(from("chain_aliases").select("chain_id,alias")), scope(from("store_aliases").select("store_id,alias"))]);
    if (!c.error) chainAliases = c.data;
    if (!st.error) storeAliases = st.data;
  } catch {
    /* 未適用 */
  }
  try {
    const b = await scope(from("battle_records").select("*").is("archived_at", null).order("played_on", { ascending: false }).limit(5000));
    if (!b.error) {
      battles = (b.data as Database["public"]["Tables"]["battle_records"]["Row"][]).map((r) => ({
        id: r.id,
        playedOn: r.played_on,
        profileId: r.profile_id,
        opponentProfileId: (r as unknown as { opponent_profile_id?: string | null }).opponent_profile_id ?? null,
        myDeck: r.my_deck,
        opponent: r.opponent,
        opponentDeck: r.opponent_deck,
        result: r.result as "win" | "lose" | "draw",
        turnOrder: r.turn_order as "first" | "second" | "",
        format: r.format,
        memo: r.memo,
      }));
    }
  } catch {
    /* 未適用 */
  }
  try {
    const r = await scope(from("household_settings").select("home_lat,home_lng,card_display,distance_bands_km,ai_monthly_budget_jpy,auto_ai_enabled,travel_review_needed")).maybeSingle();
    if (!r.error && r.data) {
      settings = {
        homeLat: r.data.home_lat === null ? null : Number(r.data.home_lat),
        homeLng: r.data.home_lng === null ? null : Number(r.data.home_lng),
        cardDisplay: normalizeCardDisplay(r.data.card_display),
        distanceBandsKm: validBands(r.data.distance_bands_km) ? r.data.distance_bands_km : [...DEFAULT_DISTANCE_BANDS_KM],
        aiMonthlyBudgetJpy: typeof r.data.ai_monthly_budget_jpy === "number" ? r.data.ai_monthly_budget_jpy : 3000,
        autoAiEnabled: r.data.auto_ai_enabled !== false,
        travelReviewNeeded: r.data.travel_review_needed === true,
      };
    }
  } catch {
    /* 未適用 */
  }
  let profileSettings: AppData["profileSettings"];
  try {
    const ps = await scope(from("profile_settings").select("profile_id,settings"));
    if (!ps.error) {
      profileSettings = Object.fromEntries((ps.data as { profile_id: string; settings: unknown }[]).map((r) => [r.profile_id, normalizeProfileSettings(r.settings)]));
    }
  } catch {
    /* 未適用 */
  }
  let chainConditions: AppData["chainConditions"];
  let chainConditionStates: AppData["chainConditionStates"];
  try {
    const [cc, cs] = await Promise.all([scope(from("chain_conditions").select("*").is("archived_at", null).order("sort_order")), scope(from("chain_condition_states").select("*"))]);
    if (!cc.error && !cs.error) {
      const rows = cc.data as { id: string; chain_id: string; kind: string; label: string; params: unknown; note: string; join_prev: string; sort_order: number }[];
      chainConditions = rows
        .filter((r) => isCondKind(r.kind))
        .map((r) => ({
          id: r.id, chainId: r.chain_id, kind: r.kind as CondKind, label: r.label, note: r.note, joinPrev: r.join_prev === "or" ? ("or" as const) : ("and" as const), sortOrder: r.sort_order,
          params: r.kind === "purchase" ? sanitizePurchaseParams(r.params) : {},
        }));
      const live = new Set(rows.map((r) => r.id));
      chainConditionStates = (cs.data as { id: string; condition_id: string; profile_id: string; state: string; confirmed_on: string | null; note: string }[])
        .filter((r) => live.has(r.condition_id) && isCondState(r.state))
        .map((r) => ({ id: r.id, conditionId: r.condition_id, profileId: r.profile_id, state: r.state as CondState, confirmedOn: r.confirmed_on, note: r.note }));
    }
  } catch {
    /* 未適用 */
  }
  return { battles, settings, chainAliases, storeAliases, profileSettings, chainConditions, chainConditionStates };
}
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
    sel("purchases").is("archived_at", null).limit(20000),
    sel("purchase_items").limit(50000),
    sel("skip_rules"),
    sel("skip_rule_exceptions"),
    sel("audit_logs").order("occurred_at", { ascending: false }).limit(50),
    sel("application_rules"),
    sel("limit_exemptions"),
    sel("chain_requirements").is("archived_at", null),
    sel("account_eligibilities").is("archived_at", null),
    sel("application_item_results").limit(50000),
    sel("sales").is("archived_at", null).limit(20000),
    sel("product_images"),
    sel("product_set_items"),
  ] as const);
  const failed = q.find((r) => r.error);
  if (failed?.error) throw new Error(`データの取得に失敗しました: ${failed.error.code ?? ""}`);

  const [profiles, rules, chains, stores, products, aliases, families, identities, accounts, campaigns, lotteries, items, mgmt, apps, purchases, pitems, skips, skipEx, audit, appRules, exemptions, reqs, elig, itemResults, sales, productImages, setItems] =
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
      Database["public"]["Tables"]["application_item_results"]["Row"][],
      Database["public"]["Tables"]["sales"]["Row"][],
      Database["public"]["Tables"]["product_images"]["Row"][],
      Database["public"]["Tables"]["product_set_items"]["Row"][],
    ];
  // Storage は非公開。画像は /api/product-image/<id> 経由（ログイン本人の権限で取得）。URLは画像の内容ハッシュで決まり、
  // 読み込みのたびに変わる期限付きURLと違って、ブラウザが長期間キャッシュできる（差し替えるとハッシュが変わり自動で更新される）
  const imageUrl = (i: { id: string; sha256: string }, size: "full" | "thumb") => `/api/product-image/${i.id}?v=${i.sha256.slice(0, 12)}&s=${size}`;

  const liveLotteryIds = new Set(lotteries.map((l) => l.id));
  const { battles, settings, chainAliases, storeAliases, profileSettings, chainConditions, chainConditionStates } = await loadOptional(db, householdId);
  // 購入記録の標準画像（Stage 7E）。取得できなくても他のデータは読み込む
  const defaultImages: NonNullable<AppData["defaultImages"]> = {};
  try {
    const di = await db.from("item_default_images").select("category,sha256");
    for (const r of di.data ?? []) if (r.category === "single_card" || r.category === "other") defaultImages[r.category] = { url: `/api/default-image/${r.category}?v=${r.sha256.slice(0, 12)}` };
  } catch {
    /* 標準画像なしで続行 */
  }

  return {
    profiles: profiles.map((p) => {
      const mine = rules.filter((r) => r.profile_id === p.id);
      const allowChains = mine.filter((r) => r.mode === "allow" && r.store_id === null).map((r) => r.chain_id);
      return {
        id: p.id,
        label: p.label,
        kind: p.kind === "sub" ? ("sub" as const) : ("main" as const),
        linkedMainId: p.main_profile_id ?? null,
        initial: p.initial,
        color: p.color as ProfileColor,
        colorHex: p.color_hex,
        iconMark: p.icon_mark,
        notifyRecipientIds: p.notify_recipient_ids,
        active: p.active,
        allowedChainIds: allowChains.length > 0 ? allowChains : null,
        allowedStoreIds: mine.filter((r) => r.mode === "allow" && r.store_id !== null).map((r) => r.store_id as string),
        blockedChainIds: mine.filter((r) => r.mode === "block" && r.store_id === null).map((r) => r.chain_id),
        blockedStoreIds: mine.filter((r) => r.mode === "block" && r.store_id !== null).map((r) => r.store_id as string),
      };
    }),
    chains: chains.map((c) => ({ id: c.id, name: c.name, provisional: c.is_provisional, archived: c.archived_at != null, logoSrc: c.logo_path && c.logo_sha256 ? chainLogoUrl(c.id, c.logo_sha256) : null, brandGroup: c.brand_group ?? null, operationKind: (c.operation_kind ?? null) as "direct" | "other" | "unconfirmed" | null, boxShrinkHint: (c.box_shrink_hint ?? null) as BoxShrinkHint | null, storeSelectDefault: !!c.store_select_default, aliases: chainAliases.filter((a) => a.chain_id === c.id).map((a) => a.alias) })),
    stores: stores.map((s) => ({ id: s.id, chainId: s.chain_id, name: s.name, prefecture: s.prefecture, provisional: s.is_provisional, archived: s.archived_at != null, aliases: storeAliases.filter((a) => a.store_id === s.id).map((a) => a.alias), address: s.address_optional || null, lat: s.latitude === null ? null : Number(s.latitude), lng: s.longitude === null ? null : Number(s.longitude), roundTripFare: s.round_trip_fare ?? null, memo: s.memo || null, salesKind: isStoreKind(s.sales_kind) ? s.sales_kind : "physical" })),
    products: products.map((p) => ({
      id: p.id,
      officialName: p.official_name,
      aliases: aliases.filter((a) => a.product_id === p.id).map((a) => a.alias),
      code: p.product_code ?? "",
      packsPerBox: p.packs_per_box,
      provisional: p.is_provisional,
      listPriceBox: p.list_price_box,
      listPricePack: p.list_price_pack,
      listPriceUnit: p.list_price_unit,
      memo: p.memo,
      sourceUrl: p.source_url,
      salesForm: p.sales_form as "pack_box" | "single_set" | null,
      productKind: (p.product_kind ?? null) as ProductKind | null,
      images: Object.fromEntries(
        productImages
          .filter((i) => i.product_id === p.id)
          .map((i) => [i.kind, { url: imageUrl(i, "full"), thumbUrl: i.thumb_path ? imageUrl(i, "thumb") : undefined, width: i.width, height: i.height, source: i.source as "import" | "manual", scale: i.display_scale != null ? Number(i.display_scale) : 1, offsetX: i.offset_x ?? 0, offsetY: i.offset_y ?? 0, contentBox: parseContentBox(i.content_box) }]),
      ),
      codeKind: p.product_code_kind as "official" | "custom" | null,
      archived: p.archived_at != null,
    })),
    productSetItems: setItems.map((s) => ({ id: s.id, setProductId: s.set_product_id, componentProductId: s.component_product_id, quantity: s.quantity })),
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
        .map((i) => ({ id: i.id, productId: i.product_id, quantity: i.quantity, unit: i.unit as ItemUnit })),
      multiMode: l.multi_mode as MultiMode,
      applyStart: dbToFlex(l.apply_start_precision, l.apply_start_date, l.apply_start_at),
      applyDeadline: dbToFlex(l.apply_deadline_precision, l.apply_deadline_date, l.apply_deadline_at),
      resultDate: dbToFlex(l.result_precision, l.result_date, l.result_at),
      resultEndDate: l.result_end_date ?? undefined,
      procedureStart: dbToFlex(l.procedure_start_precision, l.procedure_start_date, l.procedure_start_at),
      procedureDeadline: dbToFlex(l.procedure_deadline_precision, l.procedure_deadline_date, l.procedure_deadline_at),
      procedureSplit: l.procedure_split,
      receiveStart: dbToFlex(l.receive_start_precision, l.receive_start_date, l.receive_start_at),
      receiveDeadline: dbToFlex(l.receive_deadline_precision, l.receive_deadline_date, l.receive_deadline_at),
      kind: l.lottery_kind as "normal" | "ongoing" | "invite",
      validUntil: l.valid_until_date ?? undefined,
      receiveMethod: l.receive_method as "store" | "shipping" | "either" | "unknown",
      applyMethod: l.apply_method as "web" | "store" | "app" | "unknown",
      conditionsText: l.conditions_text,
      verificationText: l.verification_text,
      announcementMethod: l.announcement_method,
      announcementMethods: normalizeAnnounceMethods(l.announcement_methods ?? []),
      announcementTarget: isAnnounceTarget(l.announcement_target) ? l.announcement_target : "unknown",
      announcementInferred: l.announcement_inferred ?? false,
      requirementTags: normalizeRequirementTags(l.requirement_tags ?? []),
      requirementLogic: isRequirementLogic(l.requirement_logic) ? l.requirement_logic : "and",
      requirementDetails: sanitizeRequirementDetails(l.requirement_details),
      announcementUrl: l.announcement_url ?? undefined,
      sourceUrls: l.source_urls,
      eventState: l.event_state as EventState,
      limit: { basis: l.limit_basis as "account" | "person" | "family" | "address" | "unknown", maxCount: l.limit_max_count },
      sourceKind: l.source_kind as "manual" | "x_parse" | "auto" | "import",
      registrationPath: (l.registration_path ?? (l.source_kind === "auto" ? "auto" : "manual")) as "manual" | "manual_ai" | "auto" | "auto_confirmed",
      confirmedAt: l.confirmed_at ?? null,
      isNew: l.is_new,
      memo: l.memo,
      boxShrinkHint: (l.box_shrink_hint ?? null) as BoxShrinkHint | null,
      storeMode: (l.store_mode ?? "fixed") as "fixed" | "select_on_apply" | "none",
      selectableStores: Array.isArray(l.selectable_stores) ? (l.selectable_stores as { name?: unknown; prefecture?: unknown }[]).flatMap((x) => (typeof x?.name === "string" && x.name ? [{ name: x.name, prefecture: typeof x.prefecture === "string" ? x.prefecture : "" }] : [])) : [],
      createdAt: l.created_at,
      updatedAt: l.updated_at,
      unconfirmedFields: l.unconfirmed_fields ?? [],
      cautions: Array.isArray(l.cautions) ? (l.cautions as unknown as NonNullable<import("@/types/domain").Lottery["cautions"]>) : [],
      confidence: (l.confidence ?? null) as import("@/types/domain").Lottery["confidence"],
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
        itemResults: Object.fromEntries(itemResults.filter((r) => r.application_id === a.id).map((r) => [r.lottery_item_id, r.result_status as ResultStatus])),
        selectedItemId: a.selected_item_id,
        appliedStore: a.applied_store_id || a.applied_store_name ? { id: a.applied_store_id, name: a.applied_store_name, prefecture: a.applied_store_prefecture } : null,
        resultConfirmedAt: a.result_confirmed_at,
        fulfillment: a.fulfillment_status as FulfillmentStatus,
        createdAt: a.created_at,
      })),
    purchases: purchases.map((p) => ({
      id: p.id,
      applicationId: p.application_id,
      chainId: (p as { chain_id?: string | null }).chain_id ?? null,
      storeId: p.store_id,
      storeLabel: p.store_label,
      purchasedOn: dbToFlex(p.purchased_at ? "date_time" : p.purchased_date ? "date_only" : "unknown", p.purchased_date, p.purchased_at),
      channel: p.channel as "store" | "shipping" | "online" | "other",
      source: p.source_kind as "lottery" | "manual" | "import",
      buyerProfileId: p.buyer_profile_id,
      category: (p as { category?: string }).category ?? "pokemon_card",
      note: p.note,
      items: pitems
        .filter((i) => i.purchase_id === p.id)
        .map((i) => ({ id: i.id, productId: i.product_id, productLabel: i.product_label, lotteryItemId: i.lottery_item_id, quantity: i.quantity, unit: i.unit as ItemUnit, amountPaid: i.amount_paid })),
    })),
    sales: sales.map((x) => ({
      id: x.id,
      soldOn: x.sold_on,
      platform: x.platform,
      productId: x.product_id,
      productLabel: x.product_label,
      quantity: x.quantity,
      unit: x.unit as "box" | "pack" | "set" | "piece",
      boxState: ((x as { box_state?: string | null }).box_state ?? null) as ShrinkState | null,
      amount: x.amount,
      sellerProfileId: x.seller_profile_id,
      costAmount: x.cost_amount,
      costPurchaseItemId: x.cost_purchase_item_id,
      costQuantity: x.cost_quantity,
      fee: x.fee,
      shipping: x.shipping,
      memo: x.memo,
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
    battles,
    settings,
    profileSettings,
    defaultImages,
    chainConditions,
    chainConditionStates,
  };
}

// ------------------------------------------------------------------ 抽選の登録・編集

/**
 * 抽選の新規登録(id=null)／編集。系列・店舗・商品は既存マスターの選択でも未登録名の自由入力でもよく、
 * 未登録なら仮登録として自動作成する（名称照合で重複作成しない）。マスター・抽選・明細・★・応募状況は
 * DB関数 save_lottery_tx 内の1トランザクションで保存され、途中で失敗すると全体がロールバックされる。
 * 新規時は応募状況（応募済み/当選/落選）も同時登録でき、締切が過去でもエラーにしない。編集時は応募・当落に触れない。
 */
export async function saveLottery(
  db: Db,
  householdId: string,
  id: string | null,
  raw: LotteryInput,
  actor: string | null,
  /** 定期実行（ログインなし・service_role）からの新規登録。世帯を引数で指定して登録する */
  opts: { asService?: boolean } = {},
): Promise<ServiceResult<{ id: string }>> {
  const parsed = lotteryInputSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  const input = parsed.data;
  if (actor !== null && !uuid.safeParse(actor).success) return fail("リクエストが不正です");
  if (id !== null && !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const modeError = validateMultiMode(input.multiMode, input.items.length);
  if (modeError) return fail(modeError);
  if (input.multiMode === "choose_one" && input.applications.length > 0) {
    // 「どの商品に応募したか」はユーザーごとに必要なため、登録後にカード上で選択する
    return fail("希望商品を1つ選んで応募する方式では、登録後に応募するユーザーごとに希望商品を選択してください");
  }

  if (id !== null) {
    // 応募・当落の記録がある商品の削除・抽選方式の変更で、商品別の当落などを壊さない（画面でも止めるが、サーバーでも確認する）
    const [{ data: cur }, { data: existing }, { data: apps }] = await Promise.all([
      db.from("lotteries").select("multi_mode").eq("id", id).maybeSingle(),
      db.from("lottery_items").select("id").eq("lottery_id", id),
      db.from("applications").select("id,state,selected_item_id").eq("lottery_id", id),
    ]);
    const live = (apps ?? []).filter((a) => a.state === "applied");
    if (cur && cur.multi_mode !== input.multiMode && live.length > 0) return fail("応募の記録があるため、抽選方式は変更できません");
    const keep = new Set(input.items.map((i) => i.id).filter((x): x is string => !!x));
    const removed = (existing ?? []).map((e) => e.id).filter((x) => !keep.has(x));
    if (removed.length > 0 && (apps ?? []).length > 0) {
      const appIds = (apps ?? []).map((a) => a.id);
      const { data: results } = await db.from("application_item_results").select("lottery_item_id").in("application_id", appIds).in("lottery_item_id", removed);
      const referenced = (results ?? []).length > 0 || (apps ?? []).some((a) => a.selected_item_id && removed.includes(a.selected_item_id));
      if (referenced) return fail("応募・当落の記録がある商品は削除できません");
    }
  }

  const payload = buildLotteryPayload(input, id, actor);
  const { data, error } = opts.asService && id === null
    ? await db.rpc("save_lottery_tx_as", { p: payload as never, p_actor: actor as string, p_household: householdId })
    : await db.rpc("save_lottery_tx", { p: payload as never, p_actor: actor as string });
  if (error) return fail(mapDbError(error));
  // 初期値のまま（利用者が確認していない）項目を記録する。確認済みの項目は外す（応募方法・受取方法の「初期値」表示用）。
  // 保存は主処理とは別の更新だが、失敗しても抽選自体は保存済み（表示上の印が付かないだけ）なのでエラーにはしない。
  await db.from("lotteries").update({ unconfirmed_fields: input.unconfirmedFields }).eq("id", data as string);
  // 発表方法・応募条件の標準分類（save_lottery_tx は分類列を持たないため、同じ操作の直後に保存する。失敗は利用者に伝える）
  const tax = await db
    .from("lotteries")
    .update({
      announcement_methods: normalizeAnnounceMethods(input.announcementMethods),
      announcement_target: input.announcementTarget,
      announcement_inferred: input.announcementInferred,
      requirement_tags: normalizeRequirementTags(input.requirementTags),
      requirement_logic: input.requirementLogic,
      store_mode: input.storeMode,
      selectable_stores: input.storeMode === "select_on_apply" && input.selectableStores.length > 0 ? input.selectableStores : null,
      requirement_details: sanitizeRequirementDetails(input.requirementDetails) as unknown as Database["public"]["Tables"]["lotteries"]["Update"]["requirement_details"],
    })
    .eq("id", data as string);
  if (tax.error) return fail("抽選は保存しましたが、発表方法・応募条件の分類を保存できませんでした。もう一度保存してください");
  // 登録経路（新規）: 手動登録／AIを利用した手動登録。自動収集は収集処理が「自動収集」に上書きする
  if (id === null) await db.from("lotteries").update({ registration_path: input.aiFeedback ? "manual_ai" : "manual" }).eq("id", data as string);
  // AI読み取りから新規登録した場合: AIの抽出結果と最終内容の比較を1回だけ記録する（失敗しても登録自体は成功のまま）
  if (id === null && input.aiFeedback) {
    try {
      await recordAiFeedback(db, data as string, input, actor);
    } catch {
      /* 記録できなくても抽選の保存には影響しない */
    }
  }
  return ok({ id: data as string });
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
        result_precision: src.result_precision, result_date: src.result_date, result_at: src.result_at, result_end_date: src.result_end_date,
        procedure_start_precision: src.procedure_start_precision, procedure_start_date: src.procedure_start_date, procedure_start_at: src.procedure_start_at,
        procedure_deadline_precision: src.procedure_deadline_precision, procedure_deadline_date: src.procedure_deadline_date, procedure_deadline_at: src.procedure_deadline_at,
        procedure_split: src.procedure_split,
        receive_start_precision: src.receive_start_precision, receive_start_date: src.receive_start_date, receive_start_at: src.receive_start_at,
        receive_deadline_precision: src.receive_deadline_precision, receive_deadline_date: src.receive_deadline_date, receive_deadline_at: src.receive_deadline_at,
        lottery_kind: src.lottery_kind, valid_until_date: src.valid_until_date,
        receive_method: src.receive_method,
        apply_method: src.apply_method,
        conditions_text: src.conditions_text,
        verification_text: src.verification_text,
        announcement_method: src.announcement_method,
        announcement_methods: src.announcement_methods,
        announcement_target: src.announcement_target,
        announcement_inferred: src.announcement_inferred,
        requirement_tags: src.requirement_tags,
        requirement_logic: src.requirement_logic,
        requirement_details: src.requirement_details,
        announcement_url: src.announcement_url,
        source_urls: src.source_urls,
        event_state: ["cancelled", "closed"].includes(src.event_state) ? "open" : src.event_state,
        limit_basis: src.limit_basis,
        limit_max_count: src.limit_max_count,
        multi_mode: src.multi_mode,
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
  const denied = await subScopeError(db, actor, await chainOfLottery(db, lotteryId));
  if (denied) return fail(denied);
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

/**
 * 締切後などに、記録し忘れていた応募を後から記録する（履歴の補正）。実際の応募日時が不明なら appliedAt は null のまま保存し、
 * 現在日時を実際の応募日時として偽って保存しない。appliedAt は JST の "YYYY-MM-DDTHH:mm"。
 */
export interface ApplyOptions {
  backfill?: boolean;
  appliedAt?: string | null;
  /** 応募した店舗（店舗選択式の抽選。応募記録＝プロフィールごとに保存。Stage 6N） */
  appliedStore?: AppliedStoreInput | null;
}

export interface AppliedStoreInput {
  id: string | null;
  name: string;
  prefecture: string;
}

const appliedStoreSchema = z.object({ id: z.uuid().nullable(), name: z.string().trim().max(80), prefecture: z.string().trim().max(10).default("") });

/** 応募店舗の列。店舗マスターを選んだときは名前・都道府県をマスターから補い、未設定は空にする */
async function appliedStoreColumns(db: Db, chainId: string, raw: AppliedStoreInput | null | undefined): Promise<{ applied_store_id: string | null; applied_store_name: string; applied_store_prefecture: string } | null> {
  if (raw === undefined || raw === null) return null;
  const p = appliedStoreSchema.safeParse(raw);
  if (!p.success) return null;
  if (p.data.id) {
    const { data } = await db.from("stores").select("id,name,prefecture,chain_id").eq("id", p.data.id).maybeSingle();
    if (data && data.chain_id === chainId) return { applied_store_id: data.id, applied_store_name: data.name, applied_store_prefecture: data.prefecture ?? "" };
  }
  return { applied_store_id: null, applied_store_name: p.data.name, applied_store_prefecture: p.data.name ? p.data.prefecture : "" };
}

function backfillAppliedAt(opts: ApplyOptions): string | null {
  const v = opts.appliedAt;
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const t = new Date(`${v}:00+09:00`);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** 応募の記録／取消。抽選×アカウントで一意。取消しても行は残す。 */
async function setAppliedCore(
  db: Db,
  householdId: string,
  lotteryId: string,
  accountId: string,
  applied: boolean,
  actor: string | null,
  selectedItemId: string | null = null,
  opts: ApplyOptions = {},
): Promise<ServiceResult> {
  if (!uuid.safeParse(lotteryId).success || !uuid.safeParse(accountId).success) return fail("リクエストが不正です");
  if (selectedItemId !== null && !uuid.safeParse(selectedItemId).success) return fail("リクエストが不正です");
  const { data: mode } = await db.from("lotteries").select("multi_mode,chain_id").eq("id", lotteryId).maybeSingle();
  if (!mode) return fail("対象のデータが見つかりません");
  const storeCols = applied ? await appliedStoreColumns(db, mode.chain_id, opts.appliedStore) : null;
  const denied = await subScopeError(db, actor, mode.chain_id);
  if (denied) return fail(denied);
  // 応募状態を変えられるのは、操作中のプロフィール自身のアカウントだけ（他のプロフィールの応募状況は閲覧のみ）
  if (actor !== null) {
    const { data: own } = await db.from("service_accounts").select("managed_by_profile_id").eq("id", accountId).maybeSingle();
    if (!own) return fail("対象のデータが見つかりません");
    if (own.managed_by_profile_id !== actor) return fail("他のユーザーの応募状況は変更できません");
  }
  if (applied && mode.multi_mode === "choose_one") {
    if (!selectedItemId) return fail("応募する商品を選択してください");
    const { data: it } = await db.from("lottery_items").select("id").eq("id", selectedItemId).eq("lottery_id", lotteryId).maybeSingle();
    if (!it) return fail("選択した商品がこの抽選にありません");
  }
  const selected = mode.multi_mode === "choose_one" ? selectedItemId : null;
  const state = applied ? "applied" : "cancelled";
  const { data: existing } = await db.from("applications").select("id,state").eq("lottery_id", lotteryId).eq("service_account_id", accountId).maybeSingle();
  if (existing) {
    if (existing.state === state) return ok(undefined);
    const { error } = await db
      .from("applications")
      .update({ state, ...(storeCols ?? {}), ...(applied && selected ? { selected_item_id: selected } : {}), ...(applied && opts.backfill ? { applied_at: backfillAppliedAt(opts) } : {}), updated_by_profile_id: actor })
      .eq("id", existing.id);
    return error ? fail(mapDbError(error)) : ok(undefined);
  }
  if (!applied) return ok(undefined);
  const { data: lot } = await db.from("lotteries").select("chain_id").eq("id", lotteryId).maybeSingle();
  const { data: acc } = await db.from("service_accounts").select("chain_id,active").eq("id", accountId).maybeSingle();
  if (!lot || !acc || lot.chain_id !== acc.chain_id || !acc.active) return fail("この抽選に応募できるアカウントではありません");
  const { error } = await db.from("applications").insert({
    household_id: householdId, lottery_id: lotteryId, service_account_id: accountId, applied_at: opts.backfill ? backfillAppliedAt(opts) : nowIso(), state: "applied", selected_item_id: selected, updated_by_profile_id: actor, ...(storeCols ?? {}),
  });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

async function setResultCore(db: Db, applicationId: string, result: ResultStatus, actor: string | null): Promise<ServiceResult> {
  const r = z.enum(["pending", "won", "lost", "unknown"]).safeParse(result);
  if (!r.success || !uuid.safeParse(applicationId).success) return fail("リクエストが不正です");
  const denied = await applicationAccessError(db, actor, applicationId);
  if (denied) return fail(denied);
  // 複数商品抽選は商品別の当落(setItemResults)で登録する（集計値を直接書き換えない）
  const { data: target } = await db.from("applications").select("lotteries(multi_mode)").eq("id", applicationId).maybeSingle();
  const lot = target?.lotteries as { multi_mode: string } | { multi_mode: string }[] | null | undefined;
  const mode = Array.isArray(lot) ? lot[0]?.multi_mode : lot?.multi_mode;
  if (mode && mode !== "single") return fail("複数商品の抽選は商品ごとに当落を登録してください");
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
  const denied = await applicationAccessError(db, actor, applicationId);
  if (denied) return fail(denied);
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

/**
 * 直前に記録した購入手続き／受取の取り消し（スワイプ操作のUndo用）。受取済みで自動作成された購入記録も、直後（5分以内）で金額が未入力のときだけ戻す。
 * それ以外（時間が経った・金額を入力した・売却の原価に使われた）は取り消せず、履歴を保持する。
 */
export async function revertFulfillment(db: Db, applicationId: string, to: "none" | "procedure_done", actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(applicationId).success || !z.enum(["none", "procedure_done"]).safeParse(to).success) return fail("リクエストが不正です");
  const denied = await applicationAccessError(db, actor, applicationId);
  if (denied) return fail(denied);
  const { error } = await db.rpc("revert_fulfillment", { p_application_id: applicationId, p_actor: actor as string, p_to: to });
  if (!error) return ok(undefined);
  if (error.code === "23514") return fail("時間が経っているか、購入記録が編集されているため取り消せません。購入履歴から修正してください");
  return fail(mapDbError(error));
}

/** 「今回だけ」スルー。実行プロフィールにのみ作用し、他プロフィールへ伝播しない。 */
export async function setLotterySkip(db: Db, householdId: string, profileId: string, lotteryId: string, skip: boolean, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(lotteryId).success) return fail("リクエストが不正です");
  const denied = await subScopeError(db, profileId, await chainOfLottery(db, lotteryId));
  if (denied) return fail(denied);
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

// ------------------------------------------------------------------ 複数商品抽選: 商品別の当落
const itemResultsSchema = z
  .array(z.object({ itemId: z.uuid(), result: z.enum(["pending", "won", "lost", "unknown"]) }))
  .min(1)
  .max(20);

/**
 * 商品別の当落を登録する（B/C/D方式）。DB関数が方式のルール（Cは当選1商品まで、Dは選択商品のみ）を検証し、
 * 応募全体の当落（集計値）を再計算する。購入済みの応募は変更できない。
 */
async function setItemResultsCore(
  db: Db,
  applicationId: string,
  results: { itemId: string; result: ResultStatus }[],
  actor: string | null,
): Promise<ServiceResult> {
  const r = itemResultsSchema.safeParse(results);
  if (!r.success || !uuid.safeParse(applicationId).success) return fail("リクエストが不正です");
  const denied = await applicationAccessError(db, actor, applicationId);
  if (denied) return fail(denied);
  const { error } = await db.rpc("set_item_results", {
    p_application_id: applicationId,
    p_results: r.data.map((x) => ({ item_id: x.itemId, result: x.result })) as never,
    p_actor: actor as string,
  });
  return error ? fail(mapDbError(error)) : ok(undefined);
}


/**
 * 応募済み・当選にした抽選は、要チェックにする（Stage 5Y）。既に★なら何もしない（冪等・上書きしない）。
 * 応募の取消・落選・購入済み・受取済みでも★は自動では外さない（利用者が手動で外す）。★は抽選の設定で、プロフィール別の応募・当落とは独立。
 * ★の付与に失敗しても、応募・当落の記録は成功のまま（★は後から手動で付けられる）。
 */
async function autoManageLottery(db: Db, lotteryId: string, actor: string | null): Promise<void> {
  const { data: lot } = await db.from("lotteries").select("household_id").eq("id", lotteryId).maybeSingle();
  if (!lot) return;
  const { data: cur } = await db.from("lottery_management").select("is_managed").eq("lottery_id", lotteryId).maybeSingle();
  if (cur?.is_managed) return;
  await db.from("lottery_management").upsert({ lottery_id: lotteryId, household_id: lot.household_id, is_managed: true, managed_source: "manual", managed_at: nowIso(), reviewed_at: nowIso(), updated_by_profile_id: actor }, { onConflict: "lottery_id" });
  await db.from("lotteries").update({ is_new: false }).eq("id", lotteryId);
}

async function lotteryOfApplication(db: Db, applicationId: string): Promise<string | null> {
  const { data } = await db.from("applications").select("lottery_id").eq("id", applicationId).maybeSingle();
  return data?.lottery_id ?? null;
}

export async function setApplied(db: Db, householdId: string, lotteryId: string, accountId: string, applied: boolean, actor: string | null, selectedItemId: string | null = null, opts: ApplyOptions = {}): Promise<ServiceResult> {
  const r = await setAppliedCore(db, householdId, lotteryId, accountId, applied, actor, selectedItemId, opts);
  if (r.ok && applied) await autoManageLottery(db, lotteryId, actor).catch(() => undefined);
  return r;
}

/**
 * 応募店舗の変更（店舗選択式の抽選。応募後も変更できる）。この応募記録（プロフィール）の店舗だけを変え、他のプロフィールの応募店舗には触れない。
 * すでに作られた購入記録の店舗は変えない（受取時点の店舗を履歴として残す）。名前が空なら未設定に戻す。
 */
export async function setAppliedStore(db: Db, applicationId: string, store: AppliedStoreInput | null, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(applicationId).success) return fail("リクエストが不正です");
  const denied = await applicationAccessError(db, actor, applicationId);
  if (denied) return fail(denied);
  const { data: app } = await db.from("applications").select("id,service_account_id,lotteries(chain_id,store_mode)").eq("id", applicationId).maybeSingle();
  // 変更できるのは自分（操作中のプロフィール）の応募だけ。他のプロフィールの応募店舗は変えられない
  if (app && actor !== null) {
    const { data: own } = await db.from("service_accounts").select("managed_by_profile_id").eq("id", app.service_account_id).maybeSingle();
    if (!own || own.managed_by_profile_id !== actor) return fail("他のユーザーの応募店舗は変更できません");
  }
  const lot = app?.lotteries as { chain_id: string; store_mode: string } | { chain_id: string; store_mode: string }[] | null | undefined;
  const l = Array.isArray(lot) ? lot[0] : lot;
  if (!app || !l) return fail("対象のデータが見つかりません");
  if (l.store_mode !== "select_on_apply") return fail("この抽選は応募時に店舗を選ぶ方式ではありません");
  const cols = (await appliedStoreColumns(db, l.chain_id, store ?? { id: null, name: "", prefecture: "" })) ?? { applied_store_id: null, applied_store_name: "", applied_store_prefecture: "" };
  const { error } = await db.from("applications").update({ ...cols, updated_by_profile_id: actor }).eq("id", applicationId);
  return error ? fail(mapDbError(error)) : ok(undefined);
}

export async function setResult(db: Db, applicationId: string, result: ResultStatus, actor: string | null): Promise<ServiceResult> {
  const r = await setResultCore(db, applicationId, result, actor);
  if (r.ok && result === "won") {
    const lid = await lotteryOfApplication(db, applicationId);
    if (lid) await autoManageLottery(db, lid, actor).catch(() => undefined);
  }
  return r;
}

export async function setItemResults(db: Db, applicationId: string, results: { itemId: string; result: ResultStatus }[], actor: string | null): Promise<ServiceResult> {
  const r = await setItemResultsCore(db, applicationId, results, actor);
  if (r.ok && results.some((x) => x.result === "won")) {
    const lid = await lotteryOfApplication(db, applicationId);
    if (lid) await autoManageLottery(db, lid, actor).catch(() => undefined);
  }
  return r;
}

// ------------------------------------------------------------------ プロフィール（表示名・色・マーク・通知先）
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const profileSettingsSchema = z.object({
  label: z.string().trim().min(1, "表示名を入力してください").max(20, "表示名は20文字以内です"),
  color: z.enum(["blue", "green", "purple", "pink", "teal"]),
  colorHex: hex.nullable(),
  iconMark: z.string().trim().min(1).max(20),
  /** null=本人のみ / 空配列=通知なし */
  notifyRecipientIds: z.array(z.uuid()).max(10).nullable(),
  /** メイン／サブ。未指定=変更しない */
  kind: z.enum(["main", "sub"]).optional(),
  /** サブの対象系列。kind が sub のときだけ使い、指定した系列に置き換える（履歴は変えない）。未指定=変更しない */
  targetChainIds: z.array(z.uuid()).max(200).optional(),
  /** サブの紐づけ先メインユーザー（Stage 6J）。null=解除、未指定=変更しない。kind が main のときは常に解除される */
  mainProfileId: z.uuid().nullable().optional(),
});
export type ProfileSettingsInput = z.input<typeof profileSettingsSchema>;

/**
 * ユーザーの表示順を保存する（profiles.sort_order。プロフィールID・応募・当落には触れない）。
 * ids は有効なユーザー全員を並べた順。足りない・余計・重複があれば保存しない。無効なユーザーは末尾の番号に回す。
 */
export async function reorderProfiles(db: Db, ids: string[], actor: string | null): Promise<ServiceResult> {
  if (!Array.isArray(ids) || ids.some((i) => !uuid.safeParse(i).success) || new Set(ids).size !== ids.length) return fail("リクエストが不正です");
  const { data: all } = await db.from("profiles").select("id,active");
  const active = (all ?? []).filter((p) => p.active).map((p) => p.id);
  if (active.length !== ids.length || !active.every((i) => ids.includes(i))) return fail("ユーザーの一覧が最新ではありません。画面を開き直してください");
  for (const [i, id] of ids.entries()) {
    const { error } = await db.from("profiles").update({ sort_order: i + 1, updated_by_profile_id: actor }).eq("id", id);
    if (error) return fail(mapDbError(error));
  }
  return ok(undefined);
}

/** サブの対象系列（許可リストの系列行）を指定のものだけに置き換える。除外（block）と重なる系列は指定できない。店舗単位の設定には触れない */
async function replaceTargetChains(db: Db, profileId: string, chainIds: string[], actor: string | null): Promise<ServiceResult> {
  const want = [...new Set(chainIds)];
  const { data: existing, error } = await db.from("profile_target_rules").select("id,chain_id,store_id,mode,household_id").eq("profile_id", profileId);
  if (error) return fail(mapDbError(error));
  const rows = existing ?? [];
  if (rows.some((r) => r.store_id === null && r.mode === "block" && want.includes(r.chain_id))) return fail("除外に設定している系列は、サブの対象系列にできません");
  if (want.length > 0) {
    const { data: found } = await db.from("chains").select("id").in("id", want);
    if ((found ?? []).length !== want.length) return fail("系列が見つかりません");
  }
  const chainAllow = rows.filter((r) => r.store_id === null && r.mode === "allow");
  const remove = chainAllow.filter((r) => !want.includes(r.chain_id)).map((r) => r.id);
  if (remove.length > 0) {
    const { error: dErr } = await db.from("profile_target_rules").delete().in("id", remove);
    if (dErr) return fail(mapDbError(dErr));
  }
  const have = new Set(chainAllow.map((r) => r.chain_id));
  const householdId = rows[0]?.household_id ?? (await currentHouseholdId(db));
  if (!householdId) return fail("世帯が見つかりません");
  for (const chainId of want.filter((c) => !have.has(c))) {
    const { error: iErr } = await db.from("profile_target_rules").insert({ household_id: householdId, profile_id: profileId, chain_id: chainId, store_id: null, mode: "allow", updated_by_profile_id: actor });
    if (iErr) return fail(mapDbError(iErr));
  }
  return ok(undefined);
}

export async function updateProfileSettings(db: Db, profileId: string, raw: ProfileSettingsInput, actor: string | null): Promise<ServiceResult> {
  const p = profileSettingsSchema.safeParse(raw);
  if (!p.success || !uuid.safeParse(profileId).success) return fail(p.success ? "リクエストが不正です" : (p.error.issues[0]?.message ?? "入力内容を確認してください"));
  const v = p.data;
  const { data: all } = await db.from("profiles").select("id,active");
  const valid = new Set((all ?? []).filter((x) => x.active).map((x) => x.id));
  if (v.notifyRecipientIds?.some((id) => !valid.has(id))) return fail("通知先に無効なユーザーが含まれています");
  const initial = Array.from(v.label)[0] ?? "A";
  const { data: before } = await db.from("profiles").select("kind,main_profile_id").eq("id", profileId).maybeSingle();
  if (!before) return fail("対象のデータが見つかりません");
  const nextKind = v.kind ?? (before.kind === "sub" ? "sub" : "main");
  // メイン／サブの紐づけ: サブだけが、同一世帯の有効なメインに紐づけられる（サブ同士・自分自身は不可）。メインへ戻すと解除。紐づくサブがいるメインはサブにできない
  const { data: kinds } = await db.from("profiles").select("id,kind,active,label,main_profile_id");
  const lite = (kinds ?? []).map((k) => ({ id: k.id, kind: k.kind === "sub" ? ("sub" as const) : ("main" as const), active: k.active, label: k.label, linkedMainId: k.main_profile_id }));
  if (nextKind === "sub" && before.kind !== "sub" && lite.some((k) => k.linkedMainId === profileId)) return fail("紐づくサブユーザーがいるため、サブにできません。先にサブの紐づけを解除してください");
  let nextMain: string | null | undefined = undefined;
  if (nextKind === "main") nextMain = null;
  else if (v.mainProfileId !== undefined) {
    const chk = validateLink(lite.map((k) => (k.id === profileId ? { ...k, kind: "sub" as const } : k)), profileId, v.mainProfileId);
    if (!chk.ok) return fail(chk.error);
    nextMain = v.mainProfileId;
  }
  // 対象系列の置き換えは、応募・当落などの履歴には触れない（プロフィール単位の設定だけ）。メインへ戻すときは、対象系列の許可リストを外して全系列に戻す
  if (nextKind === "sub" && v.targetChainIds) {
    const r = await replaceTargetChains(db, profileId, v.targetChainIds, actor);
    if (!r.ok) return r;
  } else if (nextKind === "main" && before.kind === "sub") {
    const r = await replaceTargetChains(db, profileId, [], actor);
    if (!r.ok) return r;
  }
  const { data, error } = await db
    .from("profiles")
    .update({
      kind: nextKind,
      ...(nextMain !== undefined ? { main_profile_id: nextMain } : {}),
      label: v.label,
      initial,
      color: v.color,
      color_hex: v.colorHex,
      icon_mark: v.iconMark,
      notify_recipient_ids: v.notifyRecipientIds,
      updated_by_profile_id: actor,
    })
    .eq("id", profileId)
    .select("id")
    .maybeSingle();
  if (error) return fail(error.code === "23505" ? "同じ表示名のユーザーが既にいます" : mapDbError(error));
  return data ? ok(undefined) : fail("対象のデータが見つかりません");
}
