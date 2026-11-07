/**
 * 応募時に受取店舗を選ぶ抽選の判定（Stage 6N・純関数）。トレカキャピタルや一部のLivePocket抽選のように、
 * 抽選の登録時点では店舗が決まらず、応募者が応募のときに店舗を選ぶ方式。AIの再解析は行わず、告知の本文・条件の文言と系列名から判定する。
 * 推測で店舗を決めない: 店舗選択式と読み取れたときだけ「応募時に店舗選択」にし、店舗名は空のままにする。
 */
const PATTERNS: RegExp[] = [
  // 「受取店舗を選択」「応募時に店舗をお選びください」「店舗を選んで応募」
  /(受取|受け取り|お受取り|引取|引き取り|お渡し|応募|購入).{0,8}店舗.{0,6}(選択|選べ|選ん|お選び|指定)/,
  /店舗(を|が)?(お)?(選択|選び|選べ|選んで)/,
  /(応募|エントリー)(時|の際|する際).{0,10}(店舗|店)/,
  /希望(する)?(受取)?店舗(を)?(選択|お選び|ご選択)/,
];

/** 告知の内容にかかわらず、応募時に店舗を選ぶ運用が分かっている系列 */
const KNOWN_CHAINS: RegExp[] = [/トレカキャピタル|trecacapital|トレカ\s*キャピタル/i];

export function detectStoreSelect(o: { texts: (string | null | undefined)[]; chainName?: string }): boolean {
  const text = o.texts.filter(Boolean).join("\n").normalize("NFKC");
  if (PATTERNS.some((re) => re.test(text))) return true;
  const chain = (o.chainName ?? "").normalize("NFKC");
  return chain.length > 0 && KNOWN_CHAINS.some((re) => re.test(chain));
}
