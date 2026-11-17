import { CARD_FIELDS, normalizeCardDisplay, type CardDisplay } from "@/lib/card-display";

/**
 * プロフィール別の設定（下部メニュー・抽選カードの表示・テーマ）。プロフィール単位で保存し、他のプロフィールへコピーできる。
 * ここに入れるのは「表示・操作の好み」だけ。通知先・担当ユーザー・応募履歴などプロフィール固有のデータは入れない（コピーの対象外）。
 * 保存値は必ずこのファイルの検証を通す（未知の項目・不正な値は捨てる）。
 */

export type CardView = "simple" | "detail";
export type ThemePref = "light" | "dark" | "system";
/** 抽選管理の横スワイプ（Stage 7B）: card=カード操作（従来）／tab=タブ切替 */
export type SwipeMode = "card" | "tab";
/** 抽選カードの日付表示（Stage 7B）: a=従来／b=2行（左=日付、右=受取方法・距離） */
export type DateLayout = "a" | "b";

/** コレクションの表示（列数・画像/テキスト・演出）。お気に入りの順位はここに含めない（個人の選択なのでコピーしない） */
export interface CollectionPrefs {
  cols: 3 | 4 | 5;
  view: "grid" | "list";
  /** 光沢などの演出（既定ON。OSの「視差効果を減らす」でも無効になる） */
  fx: boolean;
}
export const DEFAULT_COLLECTION_PREFS: CollectionPrefs = { cols: 4, view: "grid", fx: true };

export function normalizeCollectionPrefs(raw: unknown): CollectionPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    cols: r.cols === 3 || r.cols === 5 ? r.cols : 4,
    view: r.view === "list" ? "list" : "grid",
    fx: r.fx !== false,
  };
}

export interface ProfileSettings {
  /** 下部メニューの固定項目（機能IDの並び。A=5項目／B=4項目。余りは無視し、足りなければ補う） */
  nav?: string[];
  /** 下部メニューの構成: five=固定5項目／four_menu=固定4項目＋メニュー（未設定=four_menu） */
  navMode?: NavMode;
  /** 「メニュー」長押しのショートカット（機能IDの並び。最大6。下から上へ並ぶ） */
  quickNav?: string[];
  /** 抽選一覧のカード表示（シンプル／詳細） */
  cardView?: CardView;
  /** 抽選カードの表示項目（未設定なら世帯の設定を使う） */
  cardDisplay?: CardDisplay;
  theme?: ThemePref;
  collection?: CollectionPrefs;
  /** 抽選管理のスワイプ操作（未設定=カード操作） */
  swipeMode?: SwipeMode;
  /** 抽選カードの日付表示（未設定=Aタイプ） */
  dateLayout?: DateLayout;
}

export type ProfileSettingKey = keyof ProfileSettings;

/** コピーできる項目と、設定画面での表示名 */
export const COPY_ITEMS: { key: ProfileSettingKey; label: string; hint: string }[] = [
  { key: "nav", label: "下部メニューの固定項目・並び順", hint: "表示する機能と順序" },
  { key: "navMode", label: "下部メニューの構成", hint: "固定5項目／固定4項目＋メニュー" },
  { key: "quickNav", label: "長押しショートカット", hint: "メニュー長押しで開く機能と順序" },
  { key: "cardView", label: "抽選カードのシンプル／詳細表示", hint: "一覧の表示モード" },
  { key: "cardDisplay", label: "抽選カードの表示項目", hint: "締切・発表日・受取方法などの表示のON/OFF" },
  { key: "theme", label: "テーマ（ライト／ダーク）", hint: "画面の配色" },
  { key: "swipeMode", label: "抽選管理のスワイプ操作", hint: "カード操作／タブ切替" },
  { key: "dateLayout", label: "抽選カードの日付表示", hint: "Aタイプ／Bタイプ（2行）" },
  { key: "collection", label: "コレクションの表示（列数・画像/テキスト・演出）", hint: "お気に入りの順位は含みません" },
];
export const SETTING_KEYS: ProfileSettingKey[] = COPY_ITEMS.map((c) => c.key);

/**
 * 下部メニュー・メニュー画面・長押しショートカットに出せる機能の一覧（Stage UI-1）。
 * **将来の機能（151図鑑・相場調査メモなど）は、ここに1行足し、アイコン（page-heading.tsx の NAV_ICON）を1行足すだけで、
 * 下部メニューの選択肢・メニュー画面・長押しショートカットに現れる。** 画面（ページ）の権限制御は各ページ・サーバー側が持つ（ここは表示の絞り込みだけ）。
 */
export interface NavItem {
  id: string;
  href: string;
  label: string;
  /** 現在のアプリで使えるか。false の機能はどのメニューにも出さない（未実装の画面へ遷移させない） */
  available: boolean;
  /** 現在地の判定に使うパスの接頭辞（より長く一致した項目を現在地とする） */
  match?: string[];
  /** 管理者のプロフィールだけが使える機能（サーバー側の権限制御も別にある。ここは表示の絞り込み） */
  adminOnly?: boolean;
  /** ログイン・保存先のあるモード（Supabase）だけで使える機能 */
  supabaseOnly?: boolean;
}
export const NAV_ITEMS: NavItem[] = [
  { id: "lotteries", href: "/lotteries", label: "抽選管理", available: true, match: ["/lotteries", "/records"] },
  { id: "candidates", href: "/lotteries/candidates", label: "抽選候補", available: true, match: ["/lotteries/candidates"], adminOnly: true, supabaseOnly: true },
  { id: "purchases", href: "/purchases", label: "購入記録", available: true, match: ["/purchases"] },
  { id: "finance", href: "/finance", label: "収支", available: true, match: ["/finance"] },
  { id: "battles", href: "/battles", label: "対戦記録", available: true, match: ["/battles"] },
  { id: "collection", href: "/collection", label: "コレクション", available: true, match: ["/collection"] },
  { id: "member-numbers", href: "/settings/member-numbers", label: "会員番号", available: true, match: ["/settings/member-numbers"], supabaseOnly: true },
  { id: "conditions", href: "/settings/conditions", label: "抽選条件", available: true, match: ["/settings/conditions"], supabaseOnly: true },
  { id: "masters", href: "/settings/masters", label: "マスター管理", available: true, match: ["/settings/masters"], supabaseOnly: true },
  { id: "lottery-data", href: "/settings/lottery-data", label: "抽選データ", available: true, match: ["/settings/lottery-data"], supabaseOnly: true },
  { id: "collect", href: "/settings/collection", label: "自動収集", available: true, match: ["/settings/collection"], adminOnly: true, supabaseOnly: true },
  { id: "notifications", href: "/settings/notifications", label: "通知設定", available: true, match: ["/settings/notifications"], supabaseOnly: true },
  { id: "display", href: "/settings/display", label: "メニュー・表示", available: true, match: ["/settings/display"] },
  { id: "settings", href: "/settings", label: "設定", available: true, match: ["/settings"] },
];

/** 下部メニューの構成: five=固定5項目／four_menu=固定4項目＋右端に「メニュー」（既定。従来の「4項目＋その他」の操作感を保つ） */
export type NavMode = "five" | "four_menu";
export const DEFAULT_NAV_MODE: NavMode = "four_menu";
export const NAV_DIRECT_COUNT: Record<NavMode, number> = { five: 5, four_menu: 4 };
/** 既定の固定項目（従来の下部メニュー）。A（5項目）では、従来の4項目に「コレクション」を足した並び */
export const DEFAULT_NAV = ["lotteries", "purchases", "finance", "battles"];
export const DEFAULT_NAV_FIVE = [...DEFAULT_NAV, "collection"];
/** 長押しショートカットの既定（よく使う補助機能）と上限 */
export const DEFAULT_QUICK = ["candidates", "collection", "member-numbers", "masters", "notifications", "display"];
export const MAX_QUICK = 6;
/** 旧名（互換）: 下部メニューの最大枠 */
export const MAX_NAV_SLOTS = 5;

export interface NavContext {
  /** 現在のプロフィールが管理者か */
  isAdmin: boolean;
  /** ログイン・保存先のあるモードか */
  supabase: boolean;
}

/** このユーザー・このモードで使える機能（権限のない機能・未実装の機能は含めない） */
export const navItemsFor = (ctx: NavContext, items: NavItem[] = NAV_ITEMS): NavItem[] => items.filter((n) => n.available && (!n.adminOnly || ctx.isAdmin) && (!n.supabaseOnly || ctx.supabase));
/** 旧名（互換）: 使える機能すべて（権限は考慮しない） */
export const availableNav = () => NAV_ITEMS.filter((n) => n.available);

/** 保存値を検証して、使える項目だけにする（未知のキー・値は捨てる） */
export function normalizeProfileSettings(raw: unknown): ProfileSettings {
  const out: ProfileSettings = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.nav)) out.nav = r.nav.filter((x): x is string => typeof x === "string").slice(0, 12);
  if (r.navMode === "five" || r.navMode === "four_menu") out.navMode = r.navMode;
  if (Array.isArray(r.quickNav)) out.quickNav = r.quickNav.filter((x): x is string => typeof x === "string").slice(0, 12);
  if (r.cardView === "simple" || r.cardView === "detail") out.cardView = r.cardView;
  if (r.cardDisplay && typeof r.cardDisplay === "object") {
    const cd = r.cardDisplay as Record<string, unknown>;
    // 一部のキーだけでも受け付け、欠けは既定値で補う
    if (CARD_FIELDS.some((k) => typeof cd[k] === "boolean")) out.cardDisplay = normalizeCardDisplay(cd);
  }
  if (r.collection && typeof r.collection === "object") out.collection = normalizeCollectionPrefs(r.collection);
  if (r.swipeMode === "card" || r.swipeMode === "tab") out.swipeMode = r.swipeMode;
  if (r.dateLayout === "a" || r.dateLayout === "b") out.dateLayout = r.dateLayout;
  if (r.theme === "light" || r.theme === "dark" || r.theme === "system") out.theme = r.theme;
  return out;
}

export interface ResolvedNav {
  mode: NavMode;
  /** 下部メニューに直接出す機能（並び順どおり。A=5・B=4。使える機能が足りないときはそれ以下） */
  direct: NavItem[];
  /** 「メニュー」画面に出す全機能（このユーザーが使えるものすべて） */
  menu: NavItem[];
  /** 長押しクイックメニューの項目（最大 MAX_QUICK。下から上へ並べる順） */
  quick: NavItem[];
  /** 保存値に不整合（権限のない機能・存在しない機能・重複・不足）があり、補正した */
  corrected: boolean;
}

const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * 下部メニューの構成を決める。**保存値は信用せず、必ず補正する**:
 *  - 存在しない機能・未実装の機能・権限のない機能（管理者専用を一般ユーザーが選んでいた等）・重複は除く
 *  - 固定項目が足りなければ、既定の並び→残りの機能の順で補って、A=5・B=4にそろえる
 *  - 長押しショートカットは、使える機能だけ最大 MAX_QUICK。空になれば既定
 * 「メニュー」画面には、固定項目に含まれる機能も含め、使える全機能を出す（長押しを使わなくてもすべての機能に辿れる）。
 */
export function resolveNavConfig(s: { nav?: string[]; navMode?: NavMode; quickNav?: string[] }, ctx: NavContext, items: NavItem[] = NAV_ITEMS): ResolvedNav {
  const menu = navItemsFor(ctx, items);
  const byId = new Map(menu.map((n) => [n.id, n]));
  const mode: NavMode = s.navMode === "five" || s.navMode === "four_menu" ? s.navMode : DEFAULT_NAV_MODE;
  const count = NAV_DIRECT_COUNT[mode];
  const picked = dedupe(s.nav ?? (mode === "five" ? DEFAULT_NAV_FIVE : DEFAULT_NAV));
  const valid = picked.filter((id) => byId.has(id));
  const direct = valid.slice(0, count);
  // 足りない分を補う（既定の並び → 使える機能の並び）
  for (const id of [...DEFAULT_NAV_FIVE, ...menu.map((n) => n.id)]) {
    if (direct.length >= count) break;
    if (byId.has(id) && !direct.includes(id)) direct.push(id);
  }
  const quickIn = dedupe(s.quickNav ?? DEFAULT_QUICK).filter((id) => byId.has(id)).slice(0, MAX_QUICK);
  const quick = quickIn.length > 0 ? quickIn : dedupe(DEFAULT_QUICK).filter((id) => byId.has(id)).slice(0, MAX_QUICK);
  const corrected = (s.nav !== undefined && (picked.length !== valid.length || valid.length < Math.min(count, menu.length) || picked.length !== (s.nav ?? []).length)) || (s.quickNav !== undefined && (s.quickNav.length !== quickIn.length || quickIn.length === 0));
  return { mode, direct: direct.map((id) => byId.get(id)!), menu, quick: quick.map((id) => byId.get(id)!), corrected };
}

/** 現在地: パスの接頭辞が最も長く一致した項目（「/lotteries/candidates」は抽選管理ではなく抽選候補）。どれにも一致しなければ null */
export function activeNavId(pathname: string, items: NavItem[] = NAV_ITEMS): string | null {
  let best: { id: string; len: number } | null = null;
  for (const n of items) {
    if (!n.available) continue;
    for (const m of n.match ?? [n.href]) {
      if (pathname.startsWith(m) && (!best || m.length > best.len)) best = { id: n.id, len: m.length };
    }
  }
  return best?.id ?? null;
}

export const isNavActive = (item: NavItem, pathname: string) => (item.match ?? [item.href]).some((m) => pathname.startsWith(m));
