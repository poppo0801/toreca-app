// Stage 8F-5: 実データ評価セット（8F-2/8F-3/8F-4）の正解を、新しい定義（同一系列・同一商品・同一応募期間・同一応募条件・同一抽選方式の別店舗の抽選をグループ化。
// 同一イベントID・同一URLは必須ではない。店舗選択式は原則対象外）で再分類して、新しい正解ファイル（gold*-d8f5.json）と凍結ハッシュを作る。
// 旧定義の正解（gold*.json）・入力（cases*.json）・台帳（pages*.json）は変更しない（元データを保持）。再分類の根拠は、各ケースの公式ページ由来の事実
// （応募期間・条件・方式・販売元）と、新定義の文言だけ。AIの出力・検証層の結果に合わせて書き換えない。
import { createHash } from "node:crypto";
import fs from "node:fs";

const DIR = "eval/lottery-grouping-real";
const sha = (s) => createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex");

/** 新定義で、旧ラベルから変える（または補足を付ける）ケース。他は、旧ラベルの根拠（期間・条件・方式・商品・店舗の相違）が新定義でもそのまま成り立つ（ラベル不変） */
const CHANGES = {
  "8f3": {
    M01: ["review", "公式ページは『お一人様につき対象店舗の中から１店舗のみご応募が可能』と、応募時に店舗を1つ選ぶ形（店舗選択式）の記載。新定義では店舗選択式は原則対象外のため、旧ラベル auto を review（候補提示のみ。自動にしない・利用者が確認）に再分類。店舗別に登録されているため、まとめるかは利用者の判断"],
    M02: ["review", "M01 と同じ理由（店舗選択式の記載）。登録の条件文に差があり（実在の登録と再構成の差）、条件の一致も確認しきれないため review"],
    M03: ["review", "M01 と同じ理由（同一ページ・店舗選択式の記載）で review"],
    M04: ["review", "1つのイベントページに22店舗を列挙し、応募時に店舗を選ぶ形（店舗選択式の可能性）。発表日が日付なし（不明）でもあるため review"],
    M05: ["review", "M01 と同じ理由（店舗選択式の記載）で review。評価ハーネスの不具合で8F-3の評価からは除外済み（exclusions.json）"],
    M06: ["review", "M04 と同じ理由。登録の情報源URLが別・文章なしで、発表日も日付なしのため review"],
  },
};

const sets = [["", "8f2"], ["-8f3", "8f3"], ["-8f4", "8f4"]];
const summary = {};
for (const [suffix, key] of sets) {
  const oldText = fs.readFileSync(`${DIR}/gold${suffix}.json`, "utf8");
  const old = JSON.parse(oldText);
  const labels = {};
  for (const [id, g] of Object.entries(old.labels)) {
    const ch = CHANGES[key]?.[id];
    const label = ch ? ch[0] : g.label;
    const note = ch ? ch[1] : `新定義（8F-5）でも旧ラベル ${g.label} を維持。${g.label === "none" ? "各店舗の応募期間・応募条件・方式・販売元が異なる（または商品が別）ことが公式ページ・登録内容から確認でき、イベントIDの異同に依らず対象外" : g.label === "review" ? "条件は概ね一致するが、登録の条件の記載差・店舗未特定・店舗選択式の記載があり、利用者の確認が必要（候補提示のみ）" : "一次情報で確認できず、unknown のまま（推測で確定しない）"}`;
    labels[id] = { ...g, label, oldLabel: g.label, definition: "8F-5", note: `${note}／旧: ${g.note ?? ""}`.slice(0, 900) };
  }
  const out = { version: 2, definition: "8F-5", note: "新定義（同一系列・同一商品・同一応募期間・同一応募条件・同一抽選方式の別店舗の抽選。同一イベントID・URLは必須でない。店舗選択式は原則対象外）での正解。旧定義の正解は gold" + suffix + ".json に保持（oldLabel で対応）。AIに渡さない", labels };
  const text = JSON.stringify(out, null, 2) + "\n";
  fs.writeFileSync(`${DIR}/gold${suffix}-d8f5.json`, text);
  const cases = fs.readFileSync(`${DIR}/cases${suffix}.json`, "utf8");
  fs.writeFileSync(`${DIR}/frozen${suffix}-d8f5.json`, JSON.stringify({ cases: sha(cases), gold: sha(text), frozenOn: new Date().toISOString().slice(0, 10), count: Object.keys(labels).length }, null, 2) + "\n");
  const by = {};
  for (const [id, v] of Object.entries(labels)) by[`${v.oldLabel}->${v.label}`] = (by[`${v.oldLabel}->${v.label}`] ?? 0) + 1;
  summary[key] = by;
}
console.log(JSON.stringify(summary));
