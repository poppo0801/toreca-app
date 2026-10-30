import { CARD_FIELDS, normalizeCardDisplay, type CardDisplay } from "@/lib/card-display";

/**
 * プロフィール別の設定（下部メニュー・抽選カードの表示・テーマ）。プロフィール単位で保存し、他のプロフィールへコピーできる。
 * ここに入れるのは「表示・操作の好み」だけ。通知先・担当ユーザー・応募履歴などプロフィール固有のデータは入れない（コピーの対象外）。
 * 保存値は必ずこのファイルの検証を通す（未知の項目・不正な値は捨てる）。
 */

export type CardView = "simple" | "detail";
export type ThemePref = "light" | "dark" | "system";

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
  /** 下部メニューに直接表示する機能IDの並び（最大5枠。「その他」を出す場合は4つまで） */
  nav?: string[];
  /** 抽選一覧のカード表示（シンプル／詳細） */
  cardView?: CardView;
  /** 抽選カードの表示項目（未設定なら世帯の設定を使う） */
  cardDisplay?: CardDisplay;
  theme?: ThemePref;
  collection?: CollectionPrefs;
}

export type ProfileSettingKey = keyof ProfileSettings;

/** コピーできる項目と、設定画面での表示名 */
export const COPY_ITEMS: { key: ProfileSettingKey; label: string; hint: string }[] = [
  { key: "nav", label: "下部メニューの表示項目・並び順", hint: "表示する機能と順序" },
  { key: "cardView", label: "抽選カードのシンプル／詳細表示", hint: "一覧の表示モード" },
  { key: "cardDisplay", label: "抽選カードの表示項目", hint: "締切・発表日・受取方法などの表示のON/OFF" },
  { key: "theme", label: "テーマ（ライト／ダーク）", hint: "画面の配色" },
  { key: "collection", label: "コレクションの表示（列数・画像/テキスト・演出）", hint: "お気に入りの順位は含みません" },
];
export const SETTING_KEYS: ProfileSettingKey[] = COPY_ITEMS.map((c) => c.key);

/** 下部メニュー・「その他」に出せる機能（将来の機能は、ここに1行足して available を true にするだけで追加できる） */
export interface NavItem {
  id: string;
  href: string;
  label: string;
  /** 現在のアプリで使えるか。false の機能はメニューにも「その他」にも出さない（未実装の画面へ遷移させない） */
  available: boolean;
  /** 現在地の判定に使うパスの接頭辞 */
  match?: string[];
}
export const NAV_ITEMS: NavItem[] = [
  { id: "lotteries", href: "/lotteries", label: "抽選管理", available: true, match: ["/lotteries", "/records"] },
  { id: "finance", href: "/finance", label: "収支", available: true, match: ["/finance"] },
  { id: "purchases", href: "/purchases", label: "購入記録", available: true, match: ["/purchases"] },
  { id: "battles", href: "/battles", label: "対戦記録", available: true, match: ["/battles"] },
  { id: "collection", href: "/collection", label: "コレクション", available: true, match: ["/collection"] },
];
export const DEFAULT_NAV = ["lotteries", "purchases", "finance", "battles"];
export const MAX_NAV_SLOTS = 5;

export const availableNav = () => NAV_ITEMS.filter((n) => n.available);

/** 保存値を検証して、使える項目だけにする（未知のキー・値は捨てる） */
export function normalizeProfileSettings(raw: unknown): ProfileSettings {
  const out: ProfileSettings = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.nav)) out.nav = r.nav.filter((x): x is string => typeof x === "string").slice(0, 12);
  if (r.cardView === "simple" || r.cardView === "detail") out.cardView = r.cardView;
  if (r.cardDisplay && typeof r.cardDisplay === "object") {
    const cd = r.cardDisplay as Record<string, unknown>;
    // 一部のキーだけでも受け付け、欠けは既定値で補う
    if (CARD_FIELDS.some((k) => typeof cd[k] === "boolean")) out.cardDisplay = normalizeCardDisplay(cd);
  }
  if (r.collection && typeof r.collection === "object") out.collection = normalizeCollectionPrefs(r.collection);
  if (r.theme === "light" || r.theme === "dark" || r.theme === "system") out.theme = r.theme;
  return out;
}

export interface ResolvedNav {
  /** 下部メニューに直接出す機能（並び順どおり） */
  direct: NavItem[];
  /** 「その他」から開く機能。空なら「その他」は出さない */
  more: NavItem[];
}

/**
 * 下部メニューの構成を決める。使えない機能・重複は除き、「その他」を含めて最大5枠に収める。
 * 隠れた機能があれば必ず「その他」を出す（機能や設定へ辿れなくならないようにする）。
 */
export function resolveNav(selected: string[] | undefined): ResolvedNav {
  const avail = availableNav();
  const byId = new Map(avail.map((n) => [n.id, n]));
  let direct: NavItem[] = [];
  const seen = new Set<string>();
  for (const id of selected ?? DEFAULT_NAV) {
    const n = byId.get(id);
    if (n && !seen.has(id)) {
      seen.add(id);
      direct.push(n);
    }
  }
  if (direct.length === 0) direct = avail.slice(0, 1); // すべて外れた設定でも、最低1つは出す
  const rest = (d: NavItem[]) => avail.filter((n) => !d.some((x) => x.id === n.id));
  // 最大5枠。隠れる機能があるなら「その他」の枠を確保する（直接表示は4つまで）
  if (direct.length > MAX_NAV_SLOTS) direct = direct.slice(0, MAX_NAV_SLOTS);
  if (rest(direct).length > 0 && direct.length > MAX_NAV_SLOTS - 1) direct = direct.slice(0, MAX_NAV_SLOTS - 1);
  const more = rest(direct);
  // 隠れる機能が1つだけで枠に余裕があれば、「その他」ではなくその機能を直接出す（並び順は選んだ順の末尾）
  if (more.length === 1 && direct.length < MAX_NAV_SLOTS) return { direct: [...direct, more[0]], more: [] };
  return { direct, more };
}

export const isNavActive = (item: NavItem, pathname: string) => (item.match ?? [item.href]).some((m) => pathname.startsWith(m));
