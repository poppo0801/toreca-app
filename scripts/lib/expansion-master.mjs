// 収録パックマスター: 取得結果（data/expansion-master.json）→ 表の行。build / seed / sync で共通。
export const SERIES = [
  [/^M\d|^M-/, "MEGA"],
  [/^SV/, "スカーレット＆バイオレット"],
  [/^S\d|^S-/, "ソード＆シールド"],
  [/^SM/, "サン＆ムーン"],
];
export const seriesOf = (mark) => SERIES.find(([re]) => re.test(mark))?.[1] ?? "";
// 候補から外すマーク（基本エネルギー・プロモ。番号の自動補完には使わない）
const SKIP = new Set(["ENE", "SV-P", "M-P"]);
export const kindOf = (name) => (/^強化拡張パック/.test(name) ? "enhanced" : /^ハイクラスパック/.test(name) ? "high_class" : /^拡張パック/.test(name) ? "expansion" : "other");
/** 「拡張パック「超電ブレイカー」」→「超電ブレイカー」。かぎ括弧が無ければ商品名そのまま */
export const setNameOf = (name) => (name.match(/[「『]([^」』]+)[」』]/)?.[1]?.trim() || name.trim()).replace(/（[^）]*）$/, "").trim();
export function toRows(master) {
  const rows = [];
  for (const raw of master.products) {
    const p = { ...raw, name: raw.name.normalize("NFC") }; // 公式の表記に分解済みの濁点・半濁点が混じるため合成する
    for (const mark of p.marks) {
      if (SKIP.has(mark)) continue;
      const kind = kindOf(p.name);
      rows.push({ mark, productId: p.productId, productName: p.name, setName: setNameOf(p.name), series: seriesOf(mark), kind, active: kind !== "other", confirmedOn: master.fetchedAt });
    }
  }
  return rows;
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
export function toSql(master) {
  const rows = toRows(master);
  const values = rows.map((r) => `  (${q(r.mark)}, ${q(r.productId)}, ${q(r.productName)}, ${q(r.setName)}, ${q(r.series)}, ${q(r.kind)}, ${q("公式サイト カード検索")}, ${q("https://www.pokemon-card.com/card-search/")}, ${q(r.confirmedOn)}, ${r.active})`);
  return `insert into public.expansion_marks (mark, product_id, product_name, set_name, series, kind, source, source_url, last_confirmed_on, active) values\n${values.join(",\n")}\non conflict (mark, product_id) do nothing;\n`;
}
