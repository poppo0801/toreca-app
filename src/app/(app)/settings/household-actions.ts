"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { budgetStatus, DEFAULT_AI_MODEL, DEFAULT_BUDGET_JPY, emptySummary, summarizeUsage, type AiLogRow, type BudgetStatus, type UsageSummary } from "@/lib/ai-cost";
import { CARD_FIELDS, normalizeCardDisplay, type CardDisplay } from "@/lib/card-display";
import { prefectureOf, validBands } from "@/lib/geo";
import { createClient } from "@/lib/supabase/server";

/**
 * 世帯の設定（自宅の位置・カード表示・距離区分・AI予算）とAI利用状況。
 * 位置情報は家族内のプライベートな情報: 保存はRPC（自世帯のみ・検証つき）、住所の文字列は設定画面が明示的に読むときだけ返す。
 * 住所や座標はログ・エラーメッセージに出さない。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const actorSchema = z.uuid().nullable();

async function authed() {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user ? supabase : null;
  } catch {
    return null; // 接続設定が無い環境（モック）では未ログイン扱い
  }
}

// ------------------------------------------------------------------ 住所 → 位置（国土地理院の住所検索）
const GSI_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch";
const gsiSchema = z.array(
  z.object({
    geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
    properties: z.object({ title: z.string() }),
  }),
);

export interface GeoCandidate {
  title: string;
  lat: number;
  lng: number;
  prefecture: string | null;
}

/**
 * 住所から緯度経度の候補を取得する。利用者が「住所から位置を取得」を押したときだけ呼ぶ。
 * 送信先は国土地理院の住所検索API（無料・APIキー不要）。送るのは入力された住所の文字列だけで、結果は候補として返し、
 * 利用者が選んで保存する。取得できない場合は座標の手動入力に切り替えられる。住所はログに出さない。
 */
export async function geocodeAddress(addressRaw: string): Promise<R<{ candidates: GeoCandidate[] }>> {
  const address = z.string().trim().min(3, "住所を入力してください").max(200, "住所は200文字以内で入力してください").safeParse(addressRaw);
  if (!address.success) return fail(address.error.issues[0]?.message ?? "住所を入力してください");
  if (!(await authed())) return fail("ログインが必要です");
  try {
    const res = await fetch(`${GSI_URL}?q=${encodeURIComponent(address.data)}`, { signal: AbortSignal.timeout(8000), cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) {
      console.error("geocode failed", res.status);
      return fail("住所検索サービスに接続できませんでした。時間をおくか、緯度・経度を手入力してください");
    }
    const parsed = gsiSchema.safeParse(await res.json());
    if (!parsed.success) return fail("住所検索の結果を読み取れませんでした。緯度・経度を手入力してください");
    const candidates = parsed.data
      .slice(0, 5)
      .map((c) => ({ title: c.properties.title, lng: c.geometry.coordinates[0], lat: c.geometry.coordinates[1], prefecture: prefectureOf(c.properties.title) }))
      .filter((c) => Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180);
    if (candidates.length === 0) return fail("該当する住所が見つかりませんでした。住所を変えるか、緯度・経度を手入力してください");
    return { ok: true, candidates };
  } catch {
    console.error("geocode error");
    return fail("住所検索サービスに接続できませんでした。時間をおくか、緯度・経度を手入力してください");
  }
}

// ------------------------------------------------------------------ 自宅の位置
const homeSchema = z.object({
  address: z.string().trim().max(200, "住所は200文字以内で入力してください"),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  actor: actorSchema,
});

/** 自宅の住所・位置を保存（家族共通）。位置が変わったら、店舗の往復交通費の見直しを促すフラグが立つ */
export async function saveHomeLocation(raw: z.input<typeof homeSchema>): Promise<R> {
  const p = homeSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  if ((p.data.lat === null) !== (p.data.lng === null)) return fail("緯度と経度は両方入力してください");
  const supabase = await authed();
  if (!supabase) return fail("ログインが必要です");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い
  const { error } = await (supabase as any).rpc("save_home_location", { p_address: p.data.address || null, p_lat: p.data.lat, p_lng: p.data.lng, p_actor: p.data.actor });
  if (error) {
    console.error("save_home_location failed", error.code);
    return fail("自宅の位置を保存できませんでした");
  }
  revalidatePath("/settings");
  return { ok: true };
}

/** 自宅の住所の文字列。設定画面が開かれたときだけ読む（通常のデータ取得には含めない） */
export async function getHomeAddress(): Promise<R<{ address: string }>> {
  const supabase = await authed();
  if (!supabase) return fail("ログインが必要です");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("get_home_address");
  if (error) return fail("自宅の住所を取得できませんでした");
  return { ok: true, address: typeof data === "string" ? data : "" };
}

export async function ackTravelReview(actorRaw: string | null): Promise<R> {
  const actor = actorSchema.safeParse(actorRaw);
  const supabase = await authed();
  if (!actor.success || !supabase) return fail("リクエストが不正です");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc("ack_travel_review", { p_actor: actor.data });
  if (error) return fail("保存できませんでした");
  revalidatePath("/settings");
  return { ok: true };
}

// ------------------------------------------------------------------ カード表示・距離区分・AI予算
const settingsSchema = z.object({
  cardDisplay: z.record(z.enum(CARD_FIELDS), z.boolean()),
  distanceBandsKm: z.array(z.number()).refine(validBands, "距離の区分は、小さい順に4つの正の数で指定してください").refine((a) => a.every((n) => n <= 5000), "距離は5,000km以下で指定してください"),
  aiMonthlyBudgetJpy: z.number().int("予算は整数で入力してください").min(0).max(1_000_000),
  autoAiEnabled: z.boolean(),
  actor: actorSchema,
});

export async function saveHouseholdSettings(raw: z.input<typeof settingsSchema>): Promise<R> {
  const p = settingsSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const supabase = await authed();
  if (!supabase) return fail("ログインが必要です");
  const display: CardDisplay = normalizeCardDisplay(p.data.cardDisplay);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc("save_household_settings", {
    p_card_display: display,
    p_bands: p.data.distanceBandsKm,
    p_budget: p.data.aiMonthlyBudgetJpy,
    p_auto_ai: p.data.autoAiEnabled,
    p_actor: p.data.actor,
  });
  if (error) {
    console.error("save_household_settings failed", error.code);
    return fail("設定を保存できませんでした");
  }
  revalidatePath("/lotteries");
  revalidatePath("/settings");
  return { ok: true };
}

// ------------------------------------------------------------------ AI利用状況
export interface AiUsageView {
  /** 当月 */
  current: UsageSummary;
  /** 過去月（当月を除く、新しい順） */
  past: UsageSummary[];
  budget: BudgetStatus;
  autoAiEnabled: boolean;
  /** 使用するモデル（環境設定 AI_MODEL。未指定は標準） */
  model: string;
  /** APIキーが設定されているか（キーの値は返さない） */
  configured: boolean;
  /** 推定は概算である旨 */
  note: string;
}

const NOTE = "料金は推定額です（トークン数×公式の単価×概算為替レート）。実際の請求額は Anthropic Console のデータが正です。";

/** 当月・過去月のAI利用状況と、予算に対する使用率・警告。ログは自世帯のものだけ（RLS）。本文・画像・キーは保存していない */
export async function loadAiUsage(): Promise<R<{ usage: AiUsageView }>> {
  const supabase = await authed();
  if (!supabase) return fail("ログインが必要です");
  const since = new Date(Date.now() - 400 * 86400_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model 列は後から追加
  const logs = await (supabase as any).from("ai_extraction_logs").select("created_at,kind,status,engine,model,input_tokens,output_tokens").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  if (logs.error) return fail("利用状況を取得できませんでした");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const st = await (supabase as any).from("household_settings").select("ai_monthly_budget_jpy,auto_ai_enabled").maybeSingle();
  const budgetJpy: number = !st.error && st.data && typeof st.data.ai_monthly_budget_jpy === "number" ? st.data.ai_monthly_budget_jpy : DEFAULT_BUDGET_JPY;
  const autoAiEnabled = !st.error && st.data ? st.data.auto_ai_enabled !== false : true;

  const months = summarizeUsage(logs.data as AiLogRow[]);
  const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const current = months.find((m) => m.month === thisMonth) ?? emptySummary(thisMonth);
  return {
    ok: true,
    usage: {
      current,
      past: months.filter((m) => m.month !== thisMonth),
      budget: budgetStatus(current.costJpy, budgetJpy),
      autoAiEnabled,
      model: process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      note: NOTE,
    },
  };
}
