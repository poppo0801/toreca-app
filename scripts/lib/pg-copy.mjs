// pg_dump(--use-copy) 形式の SQL から、指定したテーブルの COPY ブロックだけを取り出す／行数を数える（復元・検証用）。
// COPY 形式は改行を \n にエスケープするため、ブロック内の1行 = 1レコード。

/** "schema"."table" 形式の名前（例: auth.users）ごとに { block, rows } を返す */
export function parseCopyBlocks(sql) {
  const out = {};
  let cur = null;
  let buf = [];
  for (const line of sql.split("\n")) {
    const m = /^COPY "([^"]+)"\."([^"]+)"/.exec(line);
    if (m && !cur) {
      cur = `${m[1]}.${m[2]}`;
      buf = [line];
      out[cur] = { block: "", rows: 0 };
    } else if (cur) {
      buf.push(line);
      if (line === "\\.") {
        out[cur].block = buf.join("\n") + "\n";
        cur = null;
      } else out[cur].rows++;
    }
  }
  return out;
}

/** 指定テーブルの COPY ブロックだけの復元用SQL（外部キー・トリガーを一時的に無効化するための replica 設定付き） */
export function extractCopySql(sql, names) {
  const blocks = parseCopyBlocks(sql);
  const missing = names.filter((n) => !blocks[n]);
  if (missing.length > 0) throw new Error(`ダンプに含まれないテーブル: ${missing.join(", ")}`);
  return `SET session_replication_role = replica;\n${names.map((n) => blocks[n].block).join("\n")}`;
}
