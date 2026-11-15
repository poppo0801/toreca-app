// Stage 9H-3D: 検証対象の事前確定（結果を見る前に凍結する）。読み取りのみ・費用なし。
//   node scripts/plan-9h3d.mjs         ... backups/eval-9h3d/plan.json を作る（既にあれば作り直さない＝凍結）
// 対象は、過去の人間評価30件・9H-2の13件から、区分の定義だけで選ぶ。結果を見て差し替えない。
//  区分の根拠: 登録済みの情報源の取得結果（9H-2で11/14に保存済みの記録）・A（従来方式）の保存済みの判断。
//  新規案件（過去の評価に使っていない案件）: 本番の読み取り書き出しが必要。手元の評価セットは30件すべてが評価済みのため 0件（件数を減らして実施）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT = "backups/eval-9h3d";
const FILE = `${OUT}/plan.json`;
if (existsSync(FILE)) {
  console.log(`既に凍結済み: ${FILE}（変更しません）`);
  process.exit(0);
}
const cases = JSON.parse(readFileSync("backups/eval-9h2/cases.json", "utf8")).cases;
const byId = Object.fromEntries(cases.map((c) => [c.caseId, c]));
const sets = JSON.parse(readFileSync("backups/review-sets/review-set-production-2026-11-14T10-50-19-931Z.json", "utf8")).cases;
const kd = sets.find((c) => c.caseId === "k-9e5d05dc");

/** キデイランド（9H-2では未調査）: 評価セットのAの抽出結果から事例定義を作る */
const kidyland = {
  caseId: "k-9e5d05dc",
  group: "select",
  known: true,
  why: "キデイランド: 同期間・同商品の複数店舗の抽選。応募できるのはいずれか1店舗＝店舗選択式（人間評価で確認済み）",
  target: { id: "k-9e5d05dc", chain: "キデイランド", products: kd.ai.extracted.products, known: { items: kd.ai.extracted.products.join(" / "), applyStart: kd.ai.extracted.applyStart, applyDeadline: kd.ai.extracted.applyDeadline, resultDate: kd.ai.extracted.resultDate }, manualFields: [], knownSources: [{ url: kd.source.url, kind: "social_other" }] },
  classify: { officialHosts: ["kiddyland.co.jp"], officialAccounts: [], aggregatorHosts: [], aggregatorAccounts: ["onchainoutlaw"] },
  baseline: { decision: { status: kd.ai.decision.status, label: kd.ai.decision.label }, extracted: kd.ai.extracted, sourceUrl: kd.source.url, sourceTitle: kd.source.title },
  priorHuman: { verdict: "partial" },
};

const pick = (id, group, why) => ({ ...byId[id], group, why });
const selection = [
  pick("k-c524e5ee", "unreachable", "公式ページ（ドラゴンスター）は取得できない（登録済みの情報源の取得に失敗: ログイン・制限）"),
  pick("k-1ca285c0", "unreachable", "カードラボ郡山: 公式ページはロボット制限で取得できない（登録済みの情報源の取得に失敗）"),
  pick("k-4cb6a42a", "unreachable", "お宝創庫: 公式告知が取得できない（登録済みの情報源が404）"),
  pick("k-7ba01036", "unreachable", "ガチャガチャマーケット: 登録済みの情報源（短縮URL）が取得できない"),
  pick("k-1d2511ea", "select", "フルコンプ（LivePocket）: 応募時に店舗を選ぶ抽選・対象店舗8店"),
  pick("k-56f3fd88", "select", "ガンリュウ: 系列・店舗が告知から特定しにくい（Xの投稿）"),
  kidyland,
  pick("k-7845398c", "conflict", "DANDAN: 抽選受付期間と応募期間が1分違い（日時の食い違い）"),
  pick("k-9916ce22", "conflict", "イトーヨーカドー: 系列・通販店舗の表記違い、人間評価で系列・店舗・重複の訂正あり"),
  pick("k-d8eb0a9b", "conflict", "フルコンプ: 同じ抽選の別の告知との重複（人間評価: 重複）"),
  pick("k-41748d32", "normal", "カードラボ大阪日本橋: 従来処理が正常と判断（人間評価: 正しい）"),
  pick("k-9682f38b", "normal", "ポケモンセンター: 従来処理が正常と判断（人間評価: 正しい）"),
  pick("k-0b6afbd2", "normal", "ヤマシロヤ: 従来処理が正常と判断（人間評価: 正しい）"),
];
const plan = {
  frozenAt: new Date().toISOString(),
  stage: "9H-3D",
  budget: { totalJpy: 100, perCaseJpy: 15, model: "claude-haiku-5-5", search: "anthropic web_search（既存）" },
  composition: { unreachable: 4, select: 3, conflict: 3, normal: 3, new: 0 },
  newCases: { requested: 2, available: 0, reason: "評価セット30件はすべて過去の人間評価に使用済み。新規案件には、利用者が本番から追加の書き出し（export-review-set.mjs --exclude-answers=…）を行う必要がある。件数を15→13に減らして実施" },
  timeDifference: "A（従来方式）は2026-11-04〜11-13の保存済みの判断。B（自律AI方式）は実行時点の公開情報を使う。掲載終了・更新による影響を受ける（結果の解釈に明示する）",
  leakagePolicy: "AIの参考情報（過去の人間の判断）には、この13件と同じ企画の兄弟事例（k-6336a920）の評価を含めない。正解（人間の訂正）はAIに渡さない",
  cases: selection,
};
mkdirSync(OUT, { recursive: true });
const digest = createHash("sha256").update(JSON.stringify(plan.cases.map((c) => c.caseId))).digest("hex").slice(0, 16);
writeFileSync(FILE, JSON.stringify({ ...plan, digest }, null, 1));
console.log(`凍結: ${FILE}（${selection.length}件・digest ${digest}）`);
