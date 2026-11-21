// ユーザーの「30件をざっと確認し問題なし」という**一括確認の申告**を、事実のまま記録する（Stage 10F）。
//   node scripts/record-bulk-review.mjs --attest="<申告の要旨>" --confirm=yes
// 個別30件の全文確認・送信可否の選択が済んだとは記録しない（mode=bulk）。送信対象は実行時に、伏せ字・漏洩検出の全件再実行と
// 公開告知の機械確認を通った行だけに絞られる（通らない行は送らない）。確認した30件と送信対象の同一性は scopeHash で検証し、不一致なら無効。
// 書き込み先は eval/real-data/reviewed.json（Git管理外）のみ。AIは人の操作を代行したことにしない（reviewedBy に申告者・方式を明記）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { bulkScopeHash } from "./lib/phase2-extract.mjs";

const DIR = "eval/real-data";
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
if (arg("confirm") !== "yes" || !arg("attest")) {
  console.error("使い方: node scripts/record-bulk-review.mjs --attest=\"<ユーザーの申告の要旨>\" --confirm=yes");
  process.exit(2);
}
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^extract-.*\.json$/.test(f)).sort() : [];
if (!files.length) {
  console.error("抽出ファイルがありません");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(`${DIR}/${files.at(-1)}`, "utf8")).rows.map((r) => ({ id: r.id, text: r.evidence_text }));
const at = new Date().toISOString().slice(0, 10);
writeFileSync(
  `${DIR}/reviewed.json`,
  JSON.stringify(
    {
      reviewedBy: "ユーザー（チャットでの一括確認の申告）",
      reviewedAt: at,
      mode: "bulk",
      attestation: arg("attest"),
      note: "個別30件の全文確認・各件の送信可否の選択ではない。送信前に伏せ字・漏洩検出の全件再実行と公開告知の機械確認を行い、通らない行は送らない",
      scopeHash: bulkScopeHash(rows),
      count: rows.length,
      ids: rows.map((r) => r.id),
    },
    null,
    2,
  ),
);
console.log(`一括確認の申告を記録しました（${rows.length}件・確認日 ${at}・mode=bulk。個別確認ではありません）`);
