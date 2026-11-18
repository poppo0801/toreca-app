/**
 * 単独の店舗（通販のみのショップ）が「店舗名」にだけ入り、系列名が空になるのを防ぐ（Stage 9H-3M・純関数）。
 * 9H-3K の評価: 「トレカ ラビットバーン」（通販）が、系列が空・店舗名に入って登録された。系列を持たない単独のショップは、系列名として扱い、店舗名は空にする。
 * 保守的に判断する: 受取が配送のみで、支店を示す語（〜店・支店・センター等）が無く、「オンライン」「通販」などの一般語ではないときだけ。
 * 判断できないときは何も変えない（既存の動作）。
 */
const BRANCH_SUFFIX = /(店|支店|本店|営業所|センター|モール|館|ステーション)$/;
const GENERIC = /^(オンライン|通販|ネット|web|ウェブ|公式|公式サイト|公式通販|公式オンライン(ストア|ショップ)?|店頭|全店|全店舗|店舗|不明)$/i;

export function isSoleShopName(storeName: string, receiveMethod: string | null | undefined): boolean {
  const s = storeName.normalize("NFKC").trim();
  if (s.length < 3) return false;
  if (receiveMethod !== "shipping") return false;
  if (BRANCH_SUFFIX.test(s) || GENERIC.test(s)) return false;
  if (/選択式|選べる|全国/.test(s)) return false;
  return true;
}
