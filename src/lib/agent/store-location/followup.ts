/**
 * 検証結果を受けた「再調査」の計画（Stage 8D-6）。純粋なロジック（ネットワーク・DB・AIに触れない）。
 *
 * 役割分担:
 *  - 検証（verify.ts / official.ts）は、AIの外側で、コードとテストで決まった基準により行う。AIは検証結果を書き換えられない。
 *  - この計画は、検証結果から「何の根拠が不足しているか」を具体的な不足（Gap）として取り出し、AIへ返す文面を作る。
 *    AIは、その不足を補う調査（検索語の変更・別の情報源の取得）・保留・終了を自分で選ぶ。
 *  - 検証を回避するための誘導（通る引用への加工など）はしない: 返すのは「どの種類の根拠が足りないか」だけ。
 *  - 追加調査が無駄になる場合は始めない: 確認済み・安全上の問題（閉店・移転・命令らしき文面・都道府県の相違）・不足がない・同じ不足が続く。
 * 将来の抽選情報収集AIなど、他の調査対象にも転用できるよう、「検証結果 → 不足 → 文面」の形にしている（対象固有の部分は diagnoseStoreGaps だけ）。
 */
import { addressCore, STATUS_LABEL, type EvaluatedCandidate, type ResearchResult } from "@/lib/agent/store-location/verify";

export type GapKind =
  | "official_unverified" // 公式サイトである根拠が不足
  | "address_incomplete" // 住所の番地などが不足
  | "name_mismatch" // 店舗名の一致が不十分
  | "other_store" // 別店舗（同名・別系列・同じ系列の別店舗）の可能性
  | "source_conflict" // 情報源同士の矛盾
  | "quote_missing" // 引用が取得ページに存在しない
  | "map_mismatch" // 地図による照合が不十分
  | "address_missing"; // 店舗名は見つかったが住所の記載がない

export const GAP_LABEL: Record<GapKind, string> = {
  official_unverified: "公式サイトである根拠が不足",
  address_incomplete: "住所の番地までの記載が不足",
  name_mismatch: "店舗名の一致が不十分",
  other_store: "別の店舗（同名・別系列・同じ系列の別店舗）の可能性",
  source_conflict: "情報源同士で住所が矛盾",
  quote_missing: "引用が取得したページの本文に存在しない",
  map_mismatch: "地図（国土地理院）による照合が不十分",
  address_missing: "店舗名は見つかったが住所の記載がない",
};

/** 安全上の理由で、追加調査では解消できない（人が確認する）。見つかったら再調査せず保留する */
export type BlockerKind = "closure" | "injection" | "prefecture_mismatch";
export const BLOCKER_LABEL: Record<BlockerKind, string> = {
  closure: "閉店・移転の記載がある（現在の住所は人が確認する）",
  injection: "取得したページに命令らしき文面があった",
  prefecture_mismatch: "登録済みの都道府県と異なる",
};

export interface Gap {
  kind: GapKind;
  /** 何が不足しているか（検証結果に基づく。外部ページの文面は含めない） */
  detail: string;
  /** どんな種類の根拠を補えばよいか（検証を通すための抜け道ではなく、根拠の種類） */
  need: string;
  /** 不足の対象（ドメイン・住所の核）。同じ不足が続くかの判定に使う */
  subject: string;
}

export type StopCode =
  | "sufficient" // 確認済みで、十分な根拠が揃っている
  | "safety_hold" // 閉店・移転・命令らしき文面・都道府県の相違: 追加調査では解消できない。人が確認する
  | "no_gap" // 補える不足が無い（見つからない・上限・失敗など）
  | "no_progress" // 前回と同じ不足が続いている。追加調査の効果が見込めない
  | "max_rounds" // 再調査の回数の上限
  | "budget"; // 予算（費用・時間・実行回数）の余力が見込めない、または上限に達した

/** 提出ごとの記録（0回目＝最初の提出）。再調査による変化（改善・追加費用・時間）の測定に使う */
export interface RoundRecord {
  round: number;
  status: string;
  address: string | null;
  confidence: number;
  gaps: GapKind[];
  fingerprint: string;
  /** この提出のあとに再調査を求めたか */
  continued: boolean;
  /** 再調査しなかったときの理由 */
  stopCode: StopCode | null;
  stopReason: string | null;
  /** この提出の時点までの累計 */
  usage: { steps: number; searches: number; fetches: number; costJpy: number; ms: number };
}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

function focusCandidate(r: ResearchResult): EvaluatedCandidate | null {
  const cs = r.candidates;
  if (cs.length === 0) return null;
  const verified = cs.filter((c) => c.quoteVerified);
  const pool = verified.length ? verified : cs;
  return [...pool].sort((a, b) => b.score - a.score)[0];
}

/** 検証結果から、安全上の理由（追加調査では解消できない）を取り出す。最も有力な候補についてのみ見る */
export function diagnoseBlockers(r: ResearchResult): BlockerKind[] {
  const c = focusCandidate(r);
  if (!c) return [];
  const out: BlockerKind[] = [];
  if (c.closure) out.push("closure");
  if (c.injection) out.push("injection");
  if (c.prefectureMismatch) out.push("prefecture_mismatch");
  return out;
}

/** 検証結果から、補える不足を取り出す（店舗所在地の調査に固有の部分） */
export function diagnoseStoreGaps(r: ResearchResult): Gap[] {
  const gaps: Gap[] = [];
  if (r.status === "conflict") {
    const addrs = [...new Set(r.candidates.filter((c) => c.quoteVerified && c.nameMatch).map((c) => short(c.address, 50)))];
    gaps.push({
      kind: "source_conflict",
      detail: `複数の情報源で異なる住所が見つかった（${addrs.slice(0, 3).join(" / ")}）。どちらが現在の住所か確定できない`,
      need: "公式の店舗ページ・最新のお知らせなど、現在の住所を1つに決められる根拠",
      subject: [...new Set(r.candidates.map((c) => addressCore(c.address)))].sort().join("|"),
    });
    return gaps;
  }
  const c = focusCandidate(r);
  if (!c) {
    // 候補なし。店舗名は見つかったが住所が無かった場合だけ、別のページを調べる余地がある（見つからない場合はAI自身の結論を尊重する）
    if (r.status === "insufficient") {
      gaps.push({ kind: "address_missing", detail: "店舗名は見つかったが、住所を特定できる記載が取得したページに無かった", need: "その店舗の個別ページ・アクセス案内・店舗一覧など、住所が載っているページ", subject: "address_missing" });
    }
    return gaps;
  }
  const subject = c.domain + "|" + addressCore(c.address);
  if (!c.quoteVerified) {
    gaps.push({ kind: "quote_missing", detail: `「${short(c.address, 40)}」の引用が、取得したページの本文に見つからなかった（または提案の情報源が取得したページではない）`, need: "取得したページの本文にある住所の行を、原文のまま引用する（本文に無い住所は使えない）。必要ならそのページを取得する", subject });
    return gaps;
  }
  if (!c.complete) gaps.push({ kind: "address_incomplete", detail: `「${short(c.address, 40)}」は、都道府県・市区町村・番地まで揃っていない`, need: "番地まで載っている住所（店舗の個別ページ・アクセス案内など）", subject });
  if (!c.nameMatch) {
    const other = c.problems.some((p) => /別の系列|別の店舗/.test(p));
    gaps.push(
      other
        ? { kind: "other_store", detail: `「${short(c.address, 40)}」は、同名の別系列、または同じ系列の別の店舗の情報の可能性がある`, need: "系列名と店舗名の両方が一致する行・ページ（同名の別系列・別店舗を除く）", subject }
        : { kind: "name_mismatch", detail: `「${short(c.address, 40)}」の引用の近くに、対象の店舗名または系列名が確認できなかった`, need: "店舗名（と系列名）が住所と同じ行・同じ項目に載っているページ", subject },
    );
  }
  if (c.addressInQuote && c.nameMatch && !c.official) {
    const site = r.officialSites.find((s) => s.domain === c.domain);
    const missing = site?.problems.length ? site.problems.join("／") : "公式サイトである根拠を、取得したページから確認できていない";
    gaps.push({
      kind: "official_unverified",
      detail: `住所の情報源「${c.domain}」を公式サイトと確認できない（不足: ${missing}）`,
      need: "公式サイトの店舗一覧、または運営会社の会社概要など、その系列の公式サイトであることが取得したページの内容で確認できる情報。公式サイトが別にあるなら、そちらに同じ店舗の住所が載っているか",
      subject,
    });
  }
  if (c.addressInQuote && c.complete && !c.geoMatch) {
    gaps.push({ kind: "map_mismatch", detail: `「${short(c.address, 40)}」が国土地理院の住所検索で番地付近まで一致しなかった（または利用できなかった）`, need: "住所の表記（番地・丁目）が正しいかの確認、または別の情報源の住所表記", subject });
  }
  return gaps;
}

export const fingerprintOf = (gaps: Gap[]): string =>
  gaps
    .map((g) => `${g.kind}:${g.subject}`)
    .sort()
    .join(";");

export type FollowUpPlan =
  | { action: "continue"; feedback: string; gaps: Gap[]; fingerprint: string }
  | { action: "stop"; code: StopCode; reason: string; gaps: Gap[]; fingerprint: string; blockers: BlockerKind[] };

export interface FollowUpState {
  rounds: RoundRecord[];
  maxRounds: number;
}

/** 次に追加調査を求めるか、ここで終了（保留）するかを、検証結果から決める */
export function planFollowUp(result: ResearchResult, state: FollowUpState, remaining: { steps: number; searches: number; fetches: number }): FollowUpPlan {
  const gaps = diagnoseStoreGaps(result);
  const fingerprint = fingerprintOf(gaps);
  const stop = (code: StopCode, reason: string, blockers: BlockerKind[] = []): FollowUpPlan => ({ action: "stop", code, reason, gaps, fingerprint, blockers });

  if (result.status === "confirmed") return stop("sufficient", "確認済みの根拠が揃っているため、追加調査はしない");
  if (result.status === "failed" || result.status === "limit_reached") return stop("no_gap", "調査が上限・障害で終了したため、追加調査はしない");
  const blockers = result.status === "conflict" ? [] : diagnoseBlockers(result);
  if (blockers.length) return stop("safety_hold", `${blockers.map((b) => BLOCKER_LABEL[b]).join("・")}ため、追加調査では解消できない。保留して人が確認する`, blockers);
  if (gaps.length === 0) return stop("no_gap", "追加調査で補える不足がない（見つからない、またはAIの結論を尊重する）");
  const done = state.rounds.filter((r) => r.continued).length;
  if (done >= state.maxRounds) return stop("max_rounds", `再調査の上限（${state.maxRounds}回）に達したため、保留する`);
  const prev = state.rounds[state.rounds.length - 1];
  // 再調査したのに、不足が前回と同じ（解消も、別の不足への前進もない）: 追加調査の効果が見込めない
  if (prev && prev.continued && prev.fingerprint === fingerprint) return stop("no_progress", "再調査後も同じ不足が続いているため、保留する（同じ調査を繰り返さない）");
  if (remaining.searches <= 0 && remaining.fetches <= 0) return stop("no_gap", "検索・取得の残りがないため、追加調査はしない");

  const lines = gaps.map((g, i) => `${i + 1}. ${GAP_LABEL[g.kind]}: ${g.detail}\n   補う根拠の種類: ${g.need}`);
  const feedback =
    `【検証システムの結果】現在の判定は「${STATUS_LABEL[result.status]}」（信頼度${result.confidence}）で、確認済みにするには次の根拠が不足しています。\n` +
    `${lines.join("\n")}\n` +
    `残りの上限: 検索${Math.max(0, remaining.searches)}回・ページ取得${Math.max(0, remaining.fetches)}回・実行${Math.max(0, remaining.steps)}回。\n` +
    `必要なら、上の不足を補う調査（別の検索語・別の情報源。実行済みの検索語・URLは使えません）をしてから、あらためて submit_findings を提出してください。` +
    `検証の基準は変えられず、検証を通すための引用の加工や誘導はしません。補う根拠が得られない、または上限が足りないと判断したら、無理に確定せず、現在の結果のまま再提出して終了してください。`;
  return { action: "continue", feedback, gaps, fingerprint };
}
