/**
 * 確認待ち（保留・要手動確認）になった理由の分類（Stage 7A・純関数）。収集結果の分析（日別の推移・主な確認待ち理由）に使う。
 * 1件に複数の原因があれば、それぞれ数える。どれにも当たらないものは other。
 */
export const REVIEW_REASON_LABEL: Record<string, string> = {
  region: "対象地域外・地域不明",
  deadline: "締切・発表日の情報不足",
  conflict: "複数情報源の内容不一致",
  product: "商品名の判別失敗",
  chain_store: "系列・店舗の判別失敗",
  duplicate: "同一抽選か判定できない",
  apply: "応募URL・応募方法の不足",
  receive: "受取方法・応募条件の不明",
  fetch: "取得失敗（ページを読めない）",
  mode: "複数商品の応募方式が不明",
  lowinfo: "情報が少ない",
  tracking: "抽選予告として追跡中",
  other: "その他",
};

const RULES: [string, RegExp][] = [
  ["region", /対象外の地域|地域.*対象外|対象地域.*(外|不明)|都道府県が不明|店舗の位置が未設定/],
  ["tracking", /抽選予告として|受付前の抽選として|として追跡しています|一部判明|予告/],
  ["deadline", /応募締切が不明|締切.*(不明|未発表)|発表日|応募の日時が未発表|締切が近い|必要な情報を取得できていません/],
  ["conflict", /矛盾|食い違|相違/],
  ["product", /商品.*(確実に判別|マスターに未登録|判別できません|を特定できません)|商品確認待ち|商品を確実/],
  ["chain_store", /系列を確実|店舗を確実|店舗.*特定できません|系列.*特定できません/],
  ["duplicate", /重複の疑い|同一の抽選か|同じ抽選か|似た抽選/],
  ["apply", /応募先|応募方法|情報源URLがありません|情報源（確認できるURL）がありません|応募URL/],
  ["receive", /受取方法|応募条件が分からない|居住地域/],
  ["fetch", /取得できません|robots|画像未取得|解析できていません|取得に失敗/],
  ["mode", /応募方式/],
  ["lowinfo", /識別できる情報が少ない|情報が少ない/],
];

export function classifyReviewReasons(texts: (string | null | undefined)[]): string[] {
  const hit = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const [id, re] of RULES) if (re.test(t)) hit.add(id);
  }
  return hit.size > 0 ? [...hit] : ["other"];
}
