// ポケモン公式絵の整理（純関数）。ファイル名 `【公式絵No.0001】フシギダネ.png` から、番号ごとに採用する1枚を決める。
//  - 括弧付きの姿違い（（キョダイマックスのすがた）等）は、括弧なしの通常版がある限り無視する。
//  - 番号が151以内: 図鑑マスターの名称と完全一致するファイルだけを通常版とする（メガ・リージョン等の別名ファイルは採用しない）。
//  - 番号が152以降: 名称のマスターが無いため、括弧なしの候補のうち最も短い名称を通常版の推定とし、候補が複数あれば ambiguous=true で報告する（確認用）。
// 保存キーは安定した形式 `official/0001.webp`（日本語・括弧を含まない）。
const FILE = /^【公式絵No\.(\d{4})】(.+)\.png$/;

/** @param {string[]} files ファイル名の一覧  @param {string[]} masterNames 図鑑番号1〜Nの名称（1番目が No.0001） */
export function buildManifest(files, masterNames) {
  /** @type {Map<number, {file:string,name:string,variant:boolean}[]>} */
  const byNo = new Map();
  const unparsed = [];
  for (const f of files) {
    const m = FILE.exec(f);
    if (!m) {
      unparsed.push(f);
      continue;
    }
    const no = Number(m[1]);
    const name = m[2];
    const list = byNo.get(no) ?? [];
    list.push({ file: f, name, variant: /[（(]/.test(name) });
    byNo.set(no, list);
  }
  const entries = [];
  const missingMaster = [];
  let ambiguous = 0;
  let variantsSkipped = 0;
  for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
    const cands = byNo.get(no);
    let pick;
    let amb = false;
    if (no <= masterNames.length) {
      pick = cands.find((c) => c.name === masterNames[no - 1]);
      if (!pick) missingMaster.push(no);
    } else {
      const plain = cands.filter((c) => !c.variant).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name, "ja"));
      pick = plain[0];
      amb = plain.length > 1;
    }
    if (!pick) continue;
    if (amb) ambiguous++;
    variantsSkipped += cands.length - 1;
    entries.push({ no, key: `official/${String(no).padStart(4, "0")}.webp`, file: pick.file, name: pick.name, ambiguous: amb });
  }
  const maxNo = Math.max(0, ...byNo.keys());
  const gaps = [];
  for (let n = 1; n <= maxNo; n++) if (!byNo.has(n)) gaps.push(n);
  return { entries, stats: { files: files.length, parsed: files.length - unparsed.length, unparsed, numbers: byNo.size, selected: entries.length, variantsSkipped, ambiguous, missingMaster, gapNumbers: gaps, maxNo } };
}
