// Stage 9H-2: 検証対象の事例集（B方式＝自律調査の入力）を、9F-2で書き出した本番の事例集と人間の評価から組み立てる（ローカルファイルだけを読む。本番へは接続しない）。
//   node scripts/build-9h2-cases.mjs <review-set.json> <review-answers.json>
// 出力（Git管理外）: backups/eval-9h2/cases.json
//   A方式（従来）の結果 = 事例集の ai（本番の収集AIの当時の判断）。B方式の初期情報 = A方式の抽出結果（同じ初期情報）。
//   人間の評価（修正値・コメント）は「過去の既知の評価」として別項目に保持する。B方式のAIには渡さない（正解を渡さない）。
// 選定の理由は REASONS に記録する。過去の30件は既知の評価データのため、独立した精度評価には含めない（改善能力の確認用）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [setFile, ansFile] = process.argv.slice(2);
if (!setFile || !ansFile) throw new Error("使い方: node scripts/build-9h2-cases.mjs <review-set.json> <review-answers.json>");
const set = JSON.parse(readFileSync(setFile, "utf8"));
const ans = JSON.parse(readFileSync(ansFile, "utf8"));
if (set.setId !== ans.setId) throw new Error("事例集と評価結果の setId が一致しません");
const human = Object.fromEntries(ans.results.map((r) => [r.caseId, r.human]));

/** 区分（検証設計の構成）と選定理由。本番の事例を、既存の人間評価の内容から選んだ（実際の取得状況は実行時に記録する） */
const REASONS = {
  "k-c524e5ee": ["restricted", "ドラゴンスター: 抽選ページがロボット制限（人間評価のコメントで確認済み）。重点対象"],
  "k-1ca285c0": ["restricted", "カードラボ: 公式の情報ページがロボット制限（人間評価のコメントで確認済み）。重点対象"],
  "k-41748d32": ["restricted", "カードラボ大阪日本橋店: 同系列の公式サイト（c-labo.jp）。別の抽選で取得制限の影響を見る"],
  "k-4cb6a42a": ["restricted", "お宝創庫: 公式のお知らせ。取得可否は実行時に記録（制限されていなければ区分は結果で再分類）"],
  "k-1d2511ea": ["insufficient", "フルコンプ（LivePocket）: 応募開始・当選発表日が不足（本文に記載ありと人間が指摘）"],
  "k-b51d0b34": ["insufficient", "ふるいち（LivePocket）: 当選発表日の期間が不足"],
  "k-56f3fd88": ["insufficient", "Xの投稿: 系列・店舗が特定できていない"],
  "k-7ba01036": ["insufficient", "ガチャガチャマーケット: 応募開始・当選発表日が不足（A方式の判断は人間評価で正しい）"],
  "k-7845398c": ["conflict", "DANDAN（BASE）: 受付期間と応募期間が1分差で食い違う（人間評価で指摘）"],
  "k-9916ce22": ["conflict", "イトーヨーカドー: 11:59/12:00の境界表現と重複（人間評価で処理判断の誤り）"],
  "k-d8eb0a9b": ["conflict", "フルコンプ: 応募締切の時刻が食い違い、別投稿と重複（人間評価で処理判断の誤り）"],
  "k-9682f38b": ["sufficient", "ポケモンセンター: 全項目が揃い、人間評価で全面的に正しい"],
  "k-0b6afbd2": ["sufficient", "ヤマシロヤ: 全項目が揃い、人間評価で全面的に正しい"],
};
/** 系列のレベルで分かっている公式サイト（マスターの店舗URLに相当する、システムが持つ登録情報）。事例の情報源が公式でないときの登録済みの公式 */
const OFFICIAL_BY_CHAIN = { カードラボ: "https://www.c-labo.jp/", ドラゴンスター: "https://dorasuta.membercard.jp/lottery" };
const OFFICIAL_HOSTS = ["c-labo.jp", "dorasuta.membercard.jp", "dorasuta.com", "otakarasouko.com", "pokemoncenter-online.com"];
const AGG_HOSTS = ["pokeso.jp", "torecabiyori.com"];
const AGG_ACCOUNTS = ["onchainoutlaw", "pokecayoyaku", "tc_4145"];

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const inList = (h, l) => l.some((x) => h === x || h.endsWith(`.${x}`));
const kindOf = (url) => {
  const h = hostOf(url);
  if (inList(h, OFFICIAL_HOSTS)) return "organizer_official";
  if (inList(h, ["livepocket.jp", "docs.google.com", "forms.gle", "peatix.com"])) return "platform";
  if (inList(h, AGG_HOSTS)) return "aggregator";
  if (h === "x.com" || h === "twitter.com") return "social_other";
  return "unknown";
};
const isoLike = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(s) ? s : null);

const cases = [];
for (const [caseId, [group, why]] of Object.entries(REASONS)) {
  const c = set.cases.find((x) => x.caseId === caseId);
  if (!c) throw new Error(`事例が見つかりません: ${caseId}`);
  const e = c.ai.extracted ?? {};
  const chain = (e.chain ?? "").trim();
  const storeRaw = (e.store ?? "").trim();
  const select = /応募時に店舗を選択/.test(storeRaw);
  const store = !storeRaw || select || /通販|オンライン|未確認|不明/.test(storeRaw) ? undefined : storeRaw;
  const known = {};
  const items = (e.products ?? []).join(" / ");
  if (items) known.items = items;
  for (const [k, v] of [["applyStart", e.applyStart], ["applyDeadline", e.applyDeadline], ["resultDate", e.resultDate]]) if (isoLike(v)) known[k] = v;
  const knownSources = [];
  const url = c.source.url;
  if (url) knownSources.push({ url, kind: kindOf(url) });
  const off = OFFICIAL_BY_CHAIN[Object.keys(OFFICIAL_BY_CHAIN).find((k) => chain.includes(k)) ?? ""];
  if (off && !knownSources.some((s) => s.url === off)) knownSources.push({ url: off, kind: "organizer_official" });
  cases.push({
    caseId,
    group,
    known: true,
    why,
    target: { id: caseId, chain, ...(store ? { store } : {}), storeMode: select ? "select_on_apply" : store ? "fixed" : undefined, products: e.products ?? [], known, manualFields: [], knownSources },
    classify: { officialHosts: OFFICIAL_HOSTS, officialAccounts: [], aggregatorHosts: AGG_HOSTS, aggregatorAccounts: AGG_ACCOUNTS },
    // A方式（従来）の結果: 本番の収集AIの当時の判断（書き換えない）
    baseline: { decision: c.ai.decision, reasons: c.ai.reasons, extracted: c.ai.extracted, notices: c.ai.notices, warnings: c.ai.warnings, sourceUrl: url, sourceTitle: c.source.title },
    // 過去の人間の評価（既知）。B方式のAIには渡さない。結果の確認・採点の参考にだけ使う
    priorHuman: human[caseId] ? { verdict: human[caseId].verdict, corrections: human[caseId].corrections, comment: human[caseId].comment, unknownOnlyFields: human[caseId].unknownOnlyFields } : null,
  });
}
mkdirSync("backups/eval-9h2", { recursive: true });
const out = { format: "toremane-9h2-cases", builtAt: new Date().toISOString(), sourceSetId: set.setId, note: "既知の30件から選定。新規（未使用）事例は0件（本番からの追加書き出しが必要。export-review-set.mjs --exclude-evaluated）", cases };
writeFileSync("backups/eval-9h2/cases.json", JSON.stringify(out, null, 1));
const by = cases.reduce((m, c) => ((m[c.group] = (m[c.group] ?? 0) + 1), m), {});
console.log(`事例 ${cases.length}件`, JSON.stringify(by), "→ backups/eval-9h2/cases.json");
