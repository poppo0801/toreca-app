/**
 * 店舗名の照合（Stage 7N・純関数）。応募時に入力した店舗を店舗マスターへ登録するとき、表記揺れで重複登録しないために使う。
 *  - 全角半角・大文字小文字・空白・中点の差を無視する
 *  - 系列名が先頭に付いた表記（「GEO 伊川谷店」）と、末尾の「店」の有無（「伊川谷」「伊川谷店」）の差を無視する
 */
export function storeKey(name: string, chainName?: string | null): string {
  let k = name.normalize("NFKC").toLowerCase().replace(/[\s・･·]+/g, "");
  const c = chainName ? chainName.normalize("NFKC").toLowerCase().replace(/[\s・･·]+/g, "") : "";
  if (c && k.startsWith(c) && k.length > c.length) k = k.slice(c.length);
  return k.replace(/店$/, "");
}

/** 実在の店舗ではない名前（架空の店舗として登録しない）。自動収集・応募時入力のどちらでもマスターに作らない */
const DUMMY = /^(店舗未確認|店舗不明|店舗未設定|未確認|不明|未設定|未定|なし|店舗なし|応募時に店舗選択)$/;
export function isDummyStoreName(name: string | null | undefined): boolean {
  return !name || DUMMY.test(name.normalize("NFKC").replace(/\s+/g, ""));
}

/** 通販・オンラインの店舗（距離・交通費を表示せず「通販」と表示する） */
export function isMailOrderStore(name: string | null | undefined, kind?: string | null): boolean {
  if (kind === "online_only") return true;
  return /通販|オンライン|ネットショップ|公式サイト|online/i.test((name ?? "").normalize("NFKC"));
}
