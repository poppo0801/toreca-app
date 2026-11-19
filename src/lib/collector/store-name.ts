/**
 * 1つの「店舗名」に、複数の店舗名が並んで入っていないか（Stage 9X）。
 * 例: 「渋谷店、浜松店」「店舗・新星堂店舗・Ganryu店舗」。そのまま店舗マスターに登録すると、店舗ごとに独立した応募・所在地・当選が混ざる。
 * 判断は形だけ（区切り文字で分けた各部分のうち、店舗名らしい語尾のものが2つ以上）。個別の店名を覚えていない。区切りがあるだけの1つの店名
 * （例: 「ホビー・ランド 梅田店」）は、店舗名らしい部分が1つしかないので対象にしない。疑いがあるときは、自動登録せず人の確認に回す。
 */
const SEPARATORS = /[、,，・／/＆&]|\sと\s|および/;
const STORE_LIKE = /(店|店舗|支店|本店|館|センター|ホール|ストア|ショップ)$/;

export function looksLikeMultipleStores(name: string | null | undefined): boolean {
  const n = (name ?? "").normalize("NFKC").trim();
  if (n.length < 4 || !SEPARATORS.test(n)) return false;
  const parts = n.split(new RegExp(SEPARATORS.source, "g")).map((p) => p.trim()).filter((p) => p.length >= 2);
  return parts.length >= 2 && parts.filter((p) => STORE_LIKE.test(p)).length >= 2;
}
