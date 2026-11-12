// 開発用テストデータ（Stage 8D-1）。すべて架空（実在の店舗・個人・住所は含まない）。本番データは複製しない。
// 構造はデータ駆動。dev-seed.mjs が冪等に投入する（系列=名前、店舗=系列+名前、商品=名前、抽選=import_key、候補=dedupe_key で既存判定）。
// 抽選の import_key は "dev-seed:L<番号>"。評価データ（eval/gold）の duplicateOf がこのキーを参照する。
// 日付は実行日からの相対日数（開発中に期限切れで一覧が空にならない）。

/** 名称の正規化（NFKC・小文字・空白除去）。別名テーブルの normalized_alias 用（開発データ用の簡易版） */
export const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

// 系列: [name, { operation_kind, brand_group, aliases }]
export const CHAINS = [
  ["テスト書店", { operation_kind: "direct", brand_group: "テスト書店" }],
  ["テスト家電", { operation_kind: "other" }],
  ["テストカード専門店", { operation_kind: "other", aliases: ["テストカードショップ"] }],
  ["テストBOOKS", { operation_kind: "other", aliases: ["テストブックス", "ＴＥＳＴ　ＢＯＯＫＳ"] }], // 表記ゆれ（全角・カナ・英字）
  ["テストモール", { operation_kind: "other" }], // 同名店舗（本店）が他系列にもある
  ["テスト通販ショップ", { operation_kind: "other" }], // 通販専業
  ["テスト百貨店", { operation_kind: "unconfirmed" }], // 運営形態が未確認
];

// 店舗: [chain, name, prefecture, extra]  extra: address/lat/lng（住所登録済み）, sales_kind, memo, location_review_needed, aliases
export const STORES = [
  ["テスト書店", "テスト書店 駅前店", "東京都", { address: "東京都架空区1-2-3（架空）", lat: 35.6, lng: 139.7, url: "https://test-bookstore.test/" }],
  ["テスト書店", "テスト書店 郊外店", "神奈川県", { url: "https://test-bookstore.test/" }], // 住所不明
  ["テスト書店", "テスト書店 港北店", "神奈川県", { address: "神奈川県架空市4-5-6（架空）", lat: 35.5, lng: 139.6, memo: "閉店の可能性あり（架空の注意）", location_review_needed: true }],
  ["テスト書店", "テスト書店 旧市街店", "埼玉県", { memo: "移転の可能性あり（架空）", location_review_needed: true }],
  ["テスト家電", "テスト家電 本店", "東京都", { address: "東京都架空区7-8-9（架空）", lat: 35.7, lng: 139.8 }],
  ["テスト家電", "テスト家電 西口店", "東京都", { aliases: ["テスト家電西口"] }],
  ["テストカード専門店", "テストカード 中央店", "埼玉県", {}],
  ["テストカード専門店", "テストカード 北店", "北海道", {}], // 地域外
  ["テストBOOKS", "テストBOOKS 本店", "千葉県", { aliases: ["テストブックス本店"] }],
  ["テストBOOKS", "テストBOOKS 沖縄店", "沖縄県", {}], // 地域外
  ["テストモール", "本店", "東京都", {}], // 同名店舗（系列が違えば別店舗）
  ["テスト家電", "本店", "神奈川県", {}], // 同名店舗
  ["テスト通販ショップ", "通販", "", { sales_kind: "online_only" }],
  ["テスト書店", "通販", "", { sales_kind: "online_only" }], // 実店舗系列の通販
  ["テスト百貨店", "テスト百貨店 中央館", "東京都", { url: "https://test-depart.test/", sales_kind: "both", address: "東京都架空区10-11-12（架空）", lat: 35.65, lng: 139.75 }],
];

// 商品: [name, { product_code, category, release_offset_days, list_price_box }]
export const PRODUCTS = [
  ["テストパック 第1弾", { category: "テストカードゲーム", release: 20, price: 5400 }],
  ["テストパック 第2弾", { category: "テストカードゲーム", release: 40, price: 5400 }],
  ["テスト拡張セット", { category: "テストカードゲーム", release: 60, price: 7980 }],
  ["テストスターターデッキ", { category: "テストカードゲーム2", release: 10, price: 1980 }],
];

// キャンペーン（同時開催グループ）: [chain, name]
export const CAMPAIGNS = [["テスト家電", "テスト家電 春の抽選キャンペーン"]];

// 抽選。key は import_key の番号。due=応募締切（日後。null=不明）、result=発表（日後。null=不明）
// 種別: kind(normal|ongoing)、mode(store_mode)、multi(multi_mode)、items=[商品名, 数量, 単位]
export const LOTTERIES = [
  { key: "L01", chain: "テスト書店", store: "テスト書店 駅前店", due: 5, result: 7, receive: "store", apply: "web", items: [["テストパック 第1弾", 1, "box"]], note: "通常の店舗抽選（店頭受取）", conditions: "会員登録が必要（架空）", tags: ["member_registration"] },
  { key: "L02", chain: "テスト通販ショップ", store: "通販", due: 4, result: 6, receive: "shipping", apply: "web", items: [["テストパック 第1弾", 1, "box"]], note: "通販抽選", conditions: "1口1BOX。配送のみ（架空）" },
  { key: "L03", chain: "テスト家電", store: "テスト家電 本店", due: 8, result: 10, receive: "store", apply: "app", campaign: "テスト家電 春の抽選キャンペーン", multi: "one_win", items: [["テストパック 第1弾", 1, "box"], ["テストパック 第2弾", 1, "box"]], note: "複数商品を対象とする抽選（どれか1つ当選）", conditions: "アプリ会員のみ（架空）", tags: ["app_member"] },
  { key: "L04", chain: "テスト家電", store: null, mode: "select_on_apply", selectable: ["テスト家電 本店", "テスト家電 西口店"], due: 9, result: 11, receive: "store", apply: "app", campaign: "テスト家電 春の抽選キャンペーン", items: [["テストスターターデッキ", 1, "box"]], note: "店舗選択式の抽選（応募時に店舗を選ぶ）", conditions: "受取店舗は応募時に選択（架空）" },
  { key: "L05", chain: "テストカード専門店", store: "テストカード 中央店", kind: "ongoing", due: null, result: null, receive: "store", apply: "store", items: [["テスト拡張セット", 1, "box"]], note: "継続抽選（毎週開催。締切は都度）", conditions: "毎週土曜に店頭で受付（架空）" },
  { key: "L06", chain: "テストBOOKS", store: "テストBOOKS 本店", due: null, result: null, receive: "unknown", apply: "unknown", items: [["テストパック 第2弾", 1, "box"]], note: "応募期間・発表日が不明な抽選", conditions: "", unconfirmed: ["applyMethod", "receiveMethod"] },
  { key: "L07", chain: "テストモール", store: "本店", due: 6, result: 8, receive: "store", apply: "web", items: [["テストパック 第1弾", 2, "box"]], note: "同名店舗（テストモールの本店）", conditions: "" },
  { key: "L08", chain: "テスト家電", store: "本店", due: 6, result: 8, receive: "store", apply: "web", items: [["テストパック 第1弾", 2, "box"]], note: "同名店舗（テスト家電の本店。L07とは別店舗の別抽選）", conditions: "" },
  { key: "L09", chain: "テスト書店", store: "テスト書店 郊外店", due: 3, result: 5, receive: "store", apply: "store", items: [["テストパック 第1弾", 1, "box"], ["テスト拡張セット", 1, "box"]], note: "応募条件が複雑な抽選（購入履歴＋本人確認＋アプリ）", conditions: "過去6か月に対象商品の購入履歴がある方、かつ本人確認書類を提示できる方。または、アプリ会員で来店済みの方（架空）", tags: ["purchase_history", "id_check", "app_member"], logic: "or", confidence: "single_source" },
  { key: "L10", chain: "テスト百貨店", store: "テスト百貨店 中央館", due: 7, result: 9, receive: "either", apply: "web", items: [["テスト拡張セット", 1, "box"]], note: "公式と第三者で日付が食い違う抽選（公式を採用）", conditions: "", confidence: "conflict", cautions: [{ kind: "date_conflict", text: "公式は締切7日後、第三者の投稿は5日後（架空）" }] },
  { key: "L11", chain: "テスト書店", store: "テスト書店 港北店", due: 4, result: 6, receive: "store", apply: "store", items: [["テストパック 第2弾", 1, "box"]], note: "閉店の可能性がある店舗の抽選", conditions: "" },
  { key: "L12", chain: "テストカード専門店", store: "テストカード 北店", due: 10, result: 12, receive: "store", apply: "store", items: [["テストパック 第1弾", 1, "box"]], note: "地域外の店舗の抽選", conditions: "" },
  { key: "L13", chain: "テスト家電", store: "テスト家電 西口店", due: 2, result: 3, receive: "store", apply: "store", items: [["テストパック 第1弾", 1, "box"]], note: "同一店舗・同一商品の別抽選（L03とは別の開催）", conditions: "店頭限定（架空）" },
  { key: "L14", chain: "テストBOOKS", store: "テストBOOKS 沖縄店", due: 12, result: 14, receive: "store", apply: "store", items: [["テストスターターデッキ", 1, "box"]], note: "地域外の店舗（沖縄）", conditions: "" },
  { key: "L15", chain: "テスト書店", store: "通販", due: 5, result: 7, receive: "shipping", apply: "web", items: [["テストパック 第2弾", 1, "box"]], note: "実店舗系列の通販抽選（通販と実店舗の混在）", conditions: "" },
];

// 収集元と候補（自動収集・AI解析・重複判定の入力側）。status は collection_candidates.status
export const SOURCES = [
  { key: "S1", kind: "web", name: "テスト書店 抽選情報ページ（架空）", url: "https://example.invalid/test-bookstore/lottery", adapter: "generic" },
  { key: "S2", kind: "x", name: "テスト家電 公式（架空）", x_username: "test_denki_x", adapter: "x" },
];
export const CANDIDATES = [
  { key: "C01", source: "S1", status: "auto_registered", lottery: "L01", title: "テストパック第1弾 抽選販売のお知らせ（架空）", triage: "auto_register" },
  { key: "C02", source: "S2", status: "duplicate", lottery: "L03", title: "【再掲】テスト家電 春の抽選（架空）", reasons: ["L03と同一"], triage: "auto_exclude" },
  { key: "C03", source: "S1", status: "pending", title: "テスト書店 郊外店 抽選（締切が読み取れない）", reasons: ["締切が不明"], triage: "manual", draft: { chain: "テスト書店", store: "テスト書店 郊外店", items: ["テストパック 第1弾"], applyDeadline: null } },
  { key: "C04", source: "S2", status: "pending", title: "店舗名が読み取れない抽選（架空）", reasons: ["店舗が未確定"], triage: "manual", draft: { chain: "テスト家電", store: null, items: ["テストパック 第2弾"] } },
  { key: "C05", source: "S1", status: "excluded", title: "地域外（北海道）の抽選（架空）", reasons: ["対象地域外"], triage: "auto_exclude" },
  { key: "C06", source: "S2", status: "failed", title: "取得に失敗した投稿（架空）", reasons: ["取得失敗"], fail_kind: "timeout" },
  { key: "C07", source: "S1", status: "pending", title: "公式と第三者で日付が食い違う候補（架空）", reasons: ["日付の食い違い"], triage: "manual", draft: { chain: "テスト百貨店", store: "テスト百貨店 中央館", applyDeadlineOfficial: "+7d", applyDeadlineThirdParty: "+5d" } },
  { key: "C08", source: "S2", status: "pending", title: "誤情報を含む可能性がある候補（架空）", reasons: ["情報源の信頼性が低い"], triage: "manual", draft: { chain: "テスト書店", store: "テスト書店 駅前店", note: "存在しない商品名を含む" } },
];
