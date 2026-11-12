/**
 * 店舗所在地の調査結果の検証（Stage 8D-2）。純粋なロジック。
 *
 * AI（LLM）が提案した住所を「そのまま信じない」ための検証層。信頼度とステータスは、AI の自己評価ではなく、
 * 実際に取得したページの本文との照合・店舗の識別・情報源の独立性・住所の完全性・地図の照合・閉店の記載など、客観的な根拠だけで決める。
 *  - 引用（quote）が、取得したページの本文に実在すること（無ければその候補は無効。AIが作った住所は通らない）
 *  - 住所がその引用の中にあること、都道府県＋市区町村＋番地まで揃っていること
 *  - ページ内の店舗名の近くに住所があること（系列名・店舗名の一致。同名店舗・別系列の混同を防ぐ）
 *  - 公式の情報源か（既知の公式ドメインと一致）。第三者だけなら、独立した2つ以上のドメインの一致が必要
 *  - 国土地理院の住所検索で、同じ住所が番地付近まで一致すること
 *  - 閉店・移転の記載、外部文面中の命令らしき文面（プロンプトインジェクション）の検出、複数情報源の矛盾
 * 「確認済み」は、すべての必須条件を満たした場合だけ。それ以外は候補・情報不足・矛盾などにとどめ、住所を推測で確定しない。
 */
import { isCompleteAddress, normalizeForMatch, pickCandidate, type GeoHit } from "@/lib/geocode";
import { prefectureOf } from "@/lib/geo";
import { distinctiveToken, domainOf, norm } from "@/lib/agent/store-location/common";
import { assessOfficialSites, isOfficialUrl, type OfficialSiteAssessment, type OfficialStatus } from "@/lib/agent/store-location/official";

export type ResearchStatus = "confirmed" | "candidate" | "insufficient" | "conflict" | "not_found" | "limit_reached" | "failed";
export const STATUS_LABEL: Record<ResearchStatus, string> = {
  confirmed: "確認済み",
  candidate: "候補あり",
  insufficient: "情報不足",
  conflict: "情報矛盾",
  not_found: "該当店舗なし",
  limit_reached: "検索上限到達",
  failed: "調査失敗（API障害など）",
};

export interface StoreTarget {
  chain: string;
  name: string;
  /** 登録済みの都道府県（空なら不明） */
  prefecture: string;
  /** 既知の公式サイトのドメイン（店舗の store_url など。無ければ空＝公式かどうかは確認できない） */
  knownDomains: string[];
  /** 同じ系列の他の店舗名（取り違え防止） */
  siblingNames: string[];
  /** 系列の別名・旧称・運営ブランド名（店舗マスターの系列別名。例: ふるいち=古本市場）。ページの表記ゆれの吸収に使う */
  chainAliases?: string[];
}

export interface PageEvidence {
  url: string;
  finalUrl?: string;
  title?: string;
  text: string;
  /** ページ内のリンク（公式サイトの根拠: 信頼済みサイトからのリンクの確認に使う） */
  links?: { text: string; href: string }[];
  /** 本文中に命令らしき文面を検出したか */
  injection: boolean;
}

export interface AddressProposal {
  address: string;
  sourceUrl: string;
  /** 取得したページの本文からの引用（住所を含む1〜2行）。本文に実在しなければ無効 */
  quote: string;
  closureHint?: string | null;
}
export interface Proposal {
  candidates: AddressProposal[];
  summary?: string;
}

export interface EvaluatedCandidate {
  address: string;
  sourceUrl: string;
  quote: string;
  quoteVerified: boolean;
  addressInQuote: boolean;
  complete: boolean;
  nameMatch: boolean;
  prefectureMismatch: boolean;
  official: boolean;
  /** 情報源ドメインの公式性（trusted=登録済み / verified=根拠で検証 / candidate / rejected / null=未評価） */
  officialStatus: OfficialStatus | null;
  closure: boolean;
  /** AIが付けた閉店・移転のヒント（記録用。判定にはAIの主張として使うのみ） */
  closureHint?: string | null;
  injection: boolean;
  geoMatch: boolean;
  lat: number | null;
  lng: number | null;
  domain: string;
  /** 規則に基づく点数（0〜100）。AI の自己評価は使わない */
  score: number;
  problems: string[];
}

export type { OfficialSiteAssessment, OfficialStatus };
export interface ResearchResult {
  /** 公式サイトの評価（根拠つき）。店舗マスターの store_url は更新しない */
  officialSites: OfficialSiteAssessment[];
  status: ResearchStatus;
  address: string | null;
  prefecture: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  /** 0〜100。確認済み以外は上限がある */
  confidence: number;
  sources: { url: string; quote: string; official: boolean; domain: string }[];
  /** 判断理由（規則による説明。AI の文章ではない） */
  reasons: string[];
  candidates: EvaluatedCandidate[];
}

export { domainOf, distinctiveToken };

export function parseCity(address: string): string | null {
  const a = address.normalize("NFKC").replace(/\s+/g, "");
  const pref = prefectureOf(a);
  if (!pref) return null;
  const rest = a.slice(pref.length);
  return /^(.+?郡.+?[町村]|.{1,6}?[市区町村])/.exec(rest)?.[1] ?? null;
}

const CLOSURE_WORDS = /(閉店|移転|営業終了|閉館|リニューアル休業|閉鎖)/;
/** 閉店・移転の記載か。営業時間の表示（「営業中 / 営業終了 22:00」）とオンラインストアの閉店は、店舗の閉店ではないので除く */
const CLOSURE = {
  test: (s: string) => CLOSURE_WORDS.test(s.replace(/営業中\s*営業終了/g, "").replace(/営業終了\s*\d/g, "").replace(/オンライン(?:ストア|ショップ)?閉店/g, "")),
};

export interface VerifyInput {
  store: StoreTarget;
  proposal: Proposal | null;
  pages: PageEvidence[];
  /** 住所 → 国土地理院の候補（失敗は null）。本番のAPIか、テストの偽物 */
  geocode: (query: string) => Promise<GeoHit[] | null>;
  /** 実行が上限で終わったか */
  limitReached: boolean;
}

function evaluate(c: AddressProposal, store: StoreTarget, pages: PageEvidence[], sites: OfficialSiteAssessment[]): EvaluatedCandidate {
  const problems: string[] = [];
  const page = pages.find((p) => p.url === c.sourceUrl || p.finalUrl === c.sourceUrl);
  const text = page ? page.text.normalize("NFKC") : "";
  let q = c.quote.normalize("NFKC").trim();
  const collapsed = (s: string) => s.replace(/[\s　]+/g, "");
  let quotePos = page && q.length >= 8 ? collapsed(text).indexOf(collapsed(q)) : -1;
  // 引用が「見出し … 住所」のように「…」「|」でつながれている場合: 住所を含む部分だけが本文に実在すれば、その部分だけを根拠とする（他の部分は根拠にしない）
  if (page && quotePos < 0 && /…|\.{3}|\|/.test(q)) {
    const addrC = collapsed(c.address.normalize("NFKC"));
    const seg = q.split(/\s*(?:…+|\.{3,}|\|)\s*/).find((s) => collapsed(s).includes(addrC));
    if (seg && seg.length >= 8) {
      const pos = collapsed(text).indexOf(collapsed(seg));
      if (pos >= 0) { q = seg.trim(); quotePos = pos; }
    }
  }
  const quoteVerified = quotePos >= 0;
  if (!page) problems.push("提案の情報源は、実際に取得したページではない");
  else if (!quoteVerified) problems.push("引用が取得したページの本文に存在しない（AIの作り話の可能性）");

  const addrNorm = normalizeForMatch(c.address);
  // 住所は引用の中にあるのが基本。引用が住所の一部だけ（改行で分かれた後半など）でも、その直前直後の本文に住所全体が実在すれば、住所は本文に実在するとみなす
  const nearQuote = quoteVerified ? collapsed(text).slice(Math.max(0, quotePos - 80), quotePos + collapsed(q).length + 80) : "";
  const addressInQuote = quoteVerified && (normalizeForMatch(q).includes(addrNorm) || normalizeForMatch(nearQuote).includes(addrNorm));
  if (quoteVerified && !addressInQuote) problems.push("住所が引用の中に無い");

  const complete = isCompleteAddress(c.address) && /\d/.test(addrNorm.replace(/^.+?[都道府県]/, ""));
  if (!complete) problems.push("住所が都道府県・市区町村・番地まで揃っていない");

  // 店舗の識別: 引用の前後に、店舗を見分ける語と系列名があり、他店舗の名前が混ざっていない
  let nameMatch = false;
  if (quoteVerified) {
    const flat = collapsed(text);
    const flatQ = collapsed(q);
    const window = flat.slice(Math.max(0, quotePos - 250), quotePos + flatQ.length + 250).toLowerCase();
    const tok = distinctiveToken(store.chain, store.name);
    // 系列を示す語: 系列名、および店舗名の先頭の語（系列名と店舗名の表記が違う場合: 例「テストカード専門店」と「テストカード 中央店」）
    const chainKeys = [norm(store.chain), ...(store.chainAliases ?? []).map(norm), norm(store.name.split(/[\s　]+/)[0] ?? "")].filter((k) => k.length >= 2 && k !== norm(tok));
    const ownInWindow = window.includes(norm(tok));
    const chainOnPage = chainKeys.length === 0 || chainKeys.some((k) => flat.toLowerCase().includes(k));
    const otherNearer = store.siblingNames
      .map((n) => distinctiveToken(store.chain, n))
      .filter((t) => t && t !== tok && !tok.includes(t) && !t.includes(tok))
      .some((t) => flatQ.toLowerCase().includes(norm(t)) && !flatQ.toLowerCase().includes(norm(tok)));
    // 同名店舗（別系列の「本店」など）: 引用の中で店舗を見分ける語の直前が別の系列名なら、別系列の店舗とみなす
    // 住所の部分は除く（「吉祥寺本町」のように住所の地名が店舗名の語と同じ場合、住所の途中を店舗名と取り違えないため）
    const addrFlat = collapsed(c.address.normalize("NFKC")).toLowerCase();
    const flatQLower = addrFlat.length >= 6 ? flatQ.toLowerCase().split(addrFlat).join("") : flatQ.toLowerCase();
    // 店舗名として現れる形（「吉祥寺店」）だけを見る。建物名（「コピス吉祥寺」）や地名の一部は店舗名ではない
    const needle = norm(store.name).endsWith("店") ? (norm(tok).endsWith("店") ? norm(tok) : `${norm(tok)}店`) : norm(tok);
    const at = flatQLower.indexOf(needle);
    const pre = at > 0 ? flatQLower.slice(0, at).replace(/[【】\[\]()（）「」『』・:：|｜\-－ 0-9.]/g, "") : "";
    const otherChain = pre.length >= 3 && !chainKeys.some((k) => pre.endsWith(k));
    if (otherChain) problems.push("引用の店舗が別の系列の可能性（同名の店舗）");
    nameMatch = ownInWindow && chainOnPage && !otherNearer && !otherChain;
    if (!ownInWindow) problems.push("ページ内の住所の近くに、対象の店舗名がない");
    if (!chainOnPage) problems.push("ページに系列名がない（別系列の同名店舗の可能性）");
    if (otherNearer) problems.push("引用が同じ系列の別の店舗の住所の可能性");
  }

  const pref = prefectureOf(c.address);
  const prefectureMismatch = !!store.prefecture && !!pref && store.prefecture !== pref;
  if (prefectureMismatch) problems.push(`登録済みの都道府県（${store.prefecture}）と異なる`);

  const domain = domainOf(c.sourceUrl);
  // 公式性は、取得したページの根拠で決める（AIの主張は使わない）。登録済み(trusted)か、根拠で検証済み(verified)のみ公式として扱う
  const officialStatus = isOfficialUrl(sites, page?.finalUrl ?? c.sourceUrl);
  const official = officialStatus === "trusted" || officialStatus === "verified";
  const injection = !!page?.injection;
  if (injection) problems.push("取得したページに命令らしき文面があった（無視した。信頼度を下げる）");

  // 閉店・移転: 引用の前後、または取得した他のページで、この店舗の名前の近くに閉店・移転の記載がある（公式の一覧が古く、別のお知らせで閉店が分かる場合を含む）
  const tokN = norm(distinctiveToken(store.chain, store.name));
  const closureElsewhere = pages.some((p) => {
    const flat = p.text.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
    for (let i = flat.indexOf(tokN); i >= 0; i = flat.indexOf(tokN, i + tokN.length)) if (CLOSURE.test(flat.slice(Math.max(0, i - 40), i + tokN.length + 60))) return true;
    return false;
  });
  const closure = !!c.closureHint || (quoteVerified && CLOSURE.test(collapsed(text).slice(Math.max(0, quotePos - 300), quotePos + collapsed(q).length + 300))) || closureElsewhere;
  if (closure) problems.push("閉店・移転の記載がある（現在の住所とは限らない）");

  return { address: c.address, sourceUrl: c.sourceUrl, quote: c.quote, quoteVerified, addressInQuote, complete, nameMatch, prefectureMismatch, official, officialStatus, closure, closureHint: c.closureHint ?? null, injection, geoMatch: false, lat: null, lng: null, domain, score: 0, problems };
}

export async function verifyResearch(input: VerifyInput): Promise<ResearchResult> {
  const { store, proposal, pages } = input;
  const officialSites = assessOfficialSites({ store, pages });
  const evaluated = (proposal?.candidates ?? []).slice(0, 5).map((c) => evaluate(c, store, pages, officialSites));

  // 地図の照合（引用が実在する候補だけ。無駄な通信を避ける）
  for (const e of evaluated.filter((x) => x.quoteVerified && x.addressInQuote)) {
    const hits = await input.geocode(e.address).catch(() => null);
    if (hits) {
      const p = pickCandidate(e.address, hits);
      if (p.kind === "ok") Object.assign(e, { geoMatch: true, lat: p.hit.lat, lng: p.hit.lng });
      else e.problems.push("国土地理院の住所検索で番地付近まで一致しない");
    } else e.problems.push("国土地理院の住所検索を利用できなかった");
  }

  const valid = evaluated.filter((e) => e.quoteVerified && e.addressInQuote && e.nameMatch);
  const key = (e: EvaluatedCandidate) => normalizeForMatch(e.address);
  const groups = new Map<string, EvaluatedCandidate[]>();
  for (const e of valid) groups.set(key(e), [...(groups.get(key(e)) ?? []), e]);
  // 別々の住所が検証を通った＝矛盾（片方がもう片方の前方一致なら同じ場所の表記の細かさの違いとみなす）
  const keys = [...groups.keys()];
  const rawConflict = keys.some((a) => keys.some((b) => a !== b && !a.startsWith(b) && !b.startsWith(a)));
  // 公式優先: 別々の住所のうち、公式（登録済み・根拠で検証済み）の情報源に支えられた住所がちょうど1つなら、それを採る（非公式の異なる住所は参考として理由に残す）。
  // 公式が複数の住所を示す、または公式がない場合は、矛盾のまま確定しない
  let conflict = rawConflict;
  let ignoredByOfficial: string[] = [];
  let validUse = valid;
  if (rawConflict) {
    const officialKeys = keys.filter((k) => groups.get(k)!.some((e) => e.official));
    if (officialKeys.length === 1) {
      conflict = false;
      validUse = valid.filter((e) => key(e) === officialKeys[0]);
      ignoredByOfficial = keys.filter((k) => k !== officialKeys[0]).map((k) => groups.get(k)![0].address);
    }
  }

  for (const e of evaluated) {
    const sameAddress = valid.filter((v) => key(v) === key(e));
    const independent = new Set(sameAddress.map((v) => v.domain).filter(Boolean)).size;
    let s = 0;
    if (e.quoteVerified) s += 5;
    if (e.nameMatch) s += 15;
    if (e.complete) s += 10;
    if (e.geoMatch) s += 15;
    if (e.officialStatus === "trusted") s += 35;
    else if (e.officialStatus === "verified") s += 30;
    if (independent >= 2) s += 20;
    if (e.closure) s -= 40;
    if (e.injection) s -= 30;
    if (e.prefectureMismatch) s -= 30;
    if (!e.quoteVerified || !e.addressInQuote) s = Math.min(s, 10);
    if (conflict) s = Math.min(s, 20);
    e.score = Math.max(0, Math.min(100, s));
  }

  const reasons: string[] = [];
  const ranked = [...validUse].sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  const out = (status: ResearchStatus, c: EvaluatedCandidate | null, confidence: number): ResearchResult => ({
    status,
    address: c && status !== "not_found" ? c.address : null,
    prefecture: c ? prefectureOf(c.address) : null,
    city: c ? parseCity(c.address) : null,
    lat: c && status === "confirmed" ? c.lat : c?.lat ?? null,
    lng: c && status === "confirmed" ? c.lng : c?.lng ?? null,
    confidence,
    officialSites,
    sources: (c ? sourcesFor(c, validUse) : []).map((v) => ({ url: v.sourceUrl, quote: v.quote.slice(0, 200), official: v.official, domain: v.domain })),
    reasons,
    candidates: evaluated,
  });

  if (conflict) {
    reasons.push("複数の情報源で、異なる住所が見つかった。どちらが現在の住所か確定できないため、確認済みにしない");
    return out("conflict", best, Math.min(best?.score ?? 0, 20));
  }
  if (best) {
    const independent = new Set(validUse.filter((v) => key(v) === key(best)).map((v) => v.domain)).size;
    if (ignoredByOfficial.length) reasons.push(`公式の情報源と異なる住所（${ignoredByOfficial.join(" / ")}）が公式でない情報源にあったが、公式の情報を優先した`);
    const ok = best.complete && best.geoMatch && !best.closure && !best.injection && !best.prefectureMismatch && (best.official || independent >= 2);
    if (ok) {
      reasons.push(best.official ? (best.officialStatus === "verified" ? "公式サイト（店舗一覧・運営元などの根拠で検証済み）に、店舗名と住所が載っている" : "公式の情報源（登録済み）に、店舗名と住所が載っている") : `独立した${independent}つの情報源で、同じ住所が見つかった`);
      reasons.push("引用が取得したページの本文に実在し、住所は番地まで揃い、国土地理院の住所検索とも一致した");
      return out("confirmed", best, Math.min(100, Math.max(best.score, 70)));
    }
    reasons.push(...best.problems);
    if (!best.official && independent < 2) reasons.push("公式の情報源を確認できず、独立した2つ目の情報源もない（第三者の情報だけでは確定しない）");
    return out("candidate", best, Math.min(best.score, 60));
  }
  // 検証を通った候補が無い
  const anyVerified = evaluated.some((e) => e.quoteVerified);
  if (input.limitReached) {
    reasons.push("調査の上限に達して終了した。確定できる情報は得られていない");
    return out("limit_reached", null, 0);
  }
  if (evaluated.length === 0) {
    const mentioned = pages.some((p) => norm(p.text).includes(norm(distinctiveToken(store.chain, store.name))) && norm(p.text).includes(norm(store.chain)));
    reasons.push(mentioned ? "店舗名は見つかったが、住所を特定できる記載がなかった" : "該当する店舗の情報が見つからなかった");
    return out(mentioned ? "insufficient" : "not_found", null, 0);
  }
  reasons.push(...[...new Set(evaluated.flatMap((e) => e.problems))].slice(0, 5));
  reasons.push(anyVerified ? "引用はあるが、店舗の識別または住所の条件を満たさないため採用しない" : "AIの提案を、取得したページの本文で裏付けられなかったため採用しない");
  return out("insufficient", null, 0);
}

function sourcesFor(best: EvaluatedCandidate, valid: EvaluatedCandidate[]): EvaluatedCandidate[] {
  const k = normalizeForMatch(best.address);
  const same = valid.filter((v) => normalizeForMatch(v.address) === k);
  return same.length ? same : [best];
}
