/**
 * 検証層（Stage 8F）: AIの提案を、登録済みの事実と突き合わせて、区分（auto / suggest / hold / single）と信頼度を決める。
 * AIの外側にある固定ロジック。AIの自己申告（selfConfidence・「共通」の主張）は信用せず、事実と食い違えば降格する。
 *
 * 原則（誤ってまとめるより、まとめない方を選ぶ）:
 *  - 自動（auto）にできるのは、①系列・商品（数量まで）・応募期間・発表日・応募方法・受取方法・店舗の指定方式・応募条件がすべて一致し、
 *    ②同じ企画だという独立した裏づけ（同じキャンペーン／同じ情報源のURL／すべての情報源に実在する同一の企画文言）があり、
 *    ③店舗が重複せず、④手動で分けた組ではなく、⑤AIの主張と事実が食い違わず、⑥情報源に命令らしき文面が無く、
 *    ⑦手動で作ったグループへの追加ではない、場合だけ。
 *  - 相違がある（応募期間・条件・方式・商品など）が、同じ企画の裏づけがある → 利用者の承認が必要な候補（suggest）。相違と理由を示す。
 *  - 相違があり、裏づけも無い → まとめない（single）。不足があり判断できない → 保留（hold）。
 *  - 店舗が同じ・別のキャンペーン・商品がまったく別・手動で分けた組 → まとめない（single）。
 */
import { detectInjection } from "@/lib/agent/core";
import { comparePair, pairKey } from "@/lib/agent/lottery-grouping/compare";
import type { AgentProposal, GGroup, GLottery, GWorld, Mismatch, PairCompare, Tier, VerifiedDecision } from "@/lib/agent/lottery-grouping/types";

export const AUTO_MIN_CONFIDENCE = 90;
export const MAX_NEW_GROUP_MEMBERS = 50;
const MAX_GROUP_SIZE = 200;

/** 文字列を比較しやすくそろえる */
const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");

/** 小さなハッシュ（提案キー用。cyrb53） */
export function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
export const proposalKey = (kind: string, ids: string[], target: string | null): string => `${kind}:${hash53([...new Set(ids)].sort().join(",") + "@" + (target ?? ""))}:${new Set(ids).size}`;

// ---------------------------------------------------------------- 同じ企画の文言（強い裏づけ）の検証
/** それだけでは同じ企画の証拠にならない一般的な語（抽選・応募・受付など） */
const GENERIC = ["抽選販売", "抽選受付", "抽選応募", "応募受付", "予約受付", "予約抽選", "抽選", "応募", "受付", "販売", "予約", "のお知らせ", "について", "のご案内", "開催", "実施", "決定", "店頭", "店舗", "オンライン", "通販", "ポケモンカードゲーム", "ポケカ", "トレカ", "カード"];
function distinctiveLength(phrase: string): number {
  let s = norm(phrase);
  for (const g of [...GENERIC].sort((a, b) => b.length - a.length)) s = s.split(norm(g)).join("");
  return s.replace(/[\d\-/:：～〜~年月日時分()（）「」『』【】、。,.]/g, "").length;
}
/** AIが主張する共通の文言が、実在し、固有であるかを検証する。subject と、証拠のある相手すべてに含まれること */
export function verifyPhrase(phrase: string | null, subject: GLottery, peers: GLottery[], evidence: Map<string, string[]>): { ok: boolean; reason: string } {
  if (!phrase || norm(phrase).length < 8) return { ok: false, reason: "共通の文言が短い・未提出" };
  if (distinctiveLength(phrase) < 4) return { ok: false, reason: "共通の文言が一般的すぎる（企画を特定できない）" };
  const p = norm(phrase);
  const has = (id: string) => (evidence.get(id) ?? []).some((t) => norm(t).includes(p));
  const hasText = (id: string) => (evidence.get(id) ?? []).some((t) => t.trim().length > 0);
  if (!hasText(subject.id)) return { ok: false, reason: "この抽選の情報源の文章が保存されておらず、文言を確認できない" };
  if (!has(subject.id)) return { ok: false, reason: "共通の文言が、この抽選の情報源に見当たらない" };
  const withText = peers.filter((x) => hasText(x.id));
  if (withText.length === 0) return { ok: false, reason: "相手の抽選の情報源の文章が保存されておらず、文言を確認できない" };
  const missing = withText.filter((x) => !has(x.id));
  if (missing.length > 0) return { ok: false, reason: `共通の文言が、${missing.length}件の抽選の情報源に見当たらない` };
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------- 相違の整理
const FIELD_LABEL: Record<string, string> = {
  chain: "系列", store: "店舗", products: "対象商品", quantity: "数量", applyStart: "応募開始", applyDeadline: "応募締切", resultDate: "発表日",
  applyMethod: "応募方法", receiveMethod: "受取方法", kind: "抽選方式", storeMode: "店舗の指定方式", requirements: "応募条件", campaign: "キャンペーン", claim: "AIの主張",
};
export const fieldLabel = (f: string): string => FIELD_LABEL[f] ?? f;

/** 1組の比較から、相違・不足を取り出す */
export function mismatchesOf(c: PairCompare, lotteryId: string): Mismatch[] {
  const out: Mismatch[] = [];
  const add = (field: string, detail: string, severity: Mismatch["severity"]) => out.push({ field, detail, severity, lotteryId });
  if (c.store === "same") add("store", "同じ店舗の抽選（別のグループではなく重複の可能性）", "hard");
  if (c.store === "unknown") add("store", "店舗が特定できていない", "gap");
  if (c.campaign === "differs") add("campaign", "別のキャンペーンとして登録されている", "hard");
  if (c.products === "disjoint") add("products", "対象商品が重ならない", "hard");
  else if (c.products === "subset" || c.products === "overlap") add("products", "対象商品の一部だけが共通", "hard");
  else if (c.products === "unknown") add("products", "対象商品が未登録", "gap");
  if (c.quantity === "differs") add("quantity", "同じ商品で数量・単位が異なる", "hard");
  const dateFields = ["applyStart", "applyDeadline", "resultDate"] as const;
  for (const f of dateFields) {
    if (c[f] === "differs") add(f, `${fieldLabel(f)}が異なる`, "hard");
    else if (c[f] === "unknown") add(f, `${fieldLabel(f)}が不明`, "gap");
  }
  for (const f of ["applyMethod", "receiveMethod"] as const) {
    if (c[f] === "differs") add(f, `${fieldLabel(f)}が異なる（通販と店頭の混在など）`, "hard");
    else if (c[f] === "unknown") add(f, `${fieldLabel(f)}が不明`, "gap");
  }
  if (c.kind === "differs") add("kind", "抽選方式が異なる", "hard");
  if (c.storeMode === "differs") add("storeMode", "店舗の指定方式が異なる（店舗固定と店舗選択式）", "hard");
  if (c.requirements === "differs") add("requirements", "応募条件が異なる", "hard");
  else if (c.requirements === "unstated") add("requirements", "応募条件の一方にだけ記載がある項目がある（記載なし。条件が異なるとは限らない）", "soft");
  else if (c.requirements === "similar") add("requirements", "応募条件の文面が一部異なる", "soft");
  return out;
}

/** 1組の信頼度への寄与（事実が一致している項目だけ加点） */
function pairScore(c: PairCompare): number {
  let s = 0;
  if (c.chain === "same") s += 10;
  if (c.store === "distinct") s += 5;
  if (c.products === "same") s += 20;
  if (c.quantity === "same") s += 5;
  if (c.applyStart === "same") s += 8;
  if (c.applyDeadline === "same") s += 7;
  if (c.resultDate === "same") s += 8;
  if (c.applyMethod === "same") s += 5;
  if (c.receiveMethod === "same") s += 5;
  if (c.requirements === "same") s += 7;
  if (c.kind === "same" && c.storeMode === "same") s += 5;
  return s;
}
type PairField = "products" | "quantity" | "applyStart" | "applyDeadline" | "resultDate" | "applyMethod" | "receiveMethod" | "requirements";

/** AIの「共通」の主張 → 検証する項目 */
const CLAIM_FIELDS: Record<string, (keyof PairCompare)[]> = {
  products: ["products"], product: ["products"], 商品: ["products"], 対象商品: ["products"],
  period: ["applyStart", "applyDeadline"], applyperiod: ["applyStart", "applyDeadline"], 応募期間: ["applyStart", "applyDeadline"], 期間: ["applyStart", "applyDeadline"],
  announce: ["resultDate"], resultdate: ["resultDate"], 発表日: ["resultDate"], 当選発表: ["resultDate"],
  applymethod: ["applyMethod"], 応募方法: ["applyMethod"],
  receivemethod: ["receiveMethod"], 受取方法: ["receiveMethod"],
  requirements: ["requirements"], conditions: ["requirements"], 応募条件: ["requirements"], 条件: ["requirements"],
  campaign: ["campaign"], キャンペーン: ["campaign"],
};
function claimMismatches(claim: AgentProposal, pairs: PairCompare[]): string[] {
  const out: string[] = [];
  for (const raw of claim.claimedCommon) {
    const key = norm(raw);
    const fields = CLAIM_FIELDS[key] ?? CLAIM_FIELDS[raw];
    if (!fields) continue;
    for (const f of fields) {
      const bad = pairs.filter((p) => (f === "campaign" ? p.campaign === "differs" : p[f] === "differs" || p[f] === "disjoint"));
      if (bad.length > 0) out.push(`AIは「${raw}が共通」と判断したが、登録内容では異なる`);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- 本体
export interface VerifyOptions {
  /** 自動グループ化を許可するか（開発環境の設定）。false なら、auto になる提案も suggest にする */
  allowAuto: boolean;
}

function base(world: GWorld, kind: VerifiedDecision["kind"], tier: Tier, key: string): VerifiedDecision {
  return { kind, tier, confidence: 0, lotteryIds: [world.subject.id], targetGroupId: null, rationale: "", common: [], mismatches: [], missing: [], strongSignals: [], downgrades: [], title: "", key, skipReason: null };
}
const peerHashOf = (world: GWorld): string => hash53(world.lotteries.map((l) => l.id).sort().join(","));
const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 提案を検証し、確定した判断を返す。保存・実行はしない */
export function verifyProposal(world: GWorld, claim: AgentProposal | null, opts: VerifyOptions): VerifiedDecision {
  const subject = world.subject;
  const singleKey = `single:${subject.id}:${peerHashOf(world)}`;
  if (!claim) {
    const d = base(world, "hold", "hold", `hold:${subject.id}:${peerHashOf(world)}`);
    d.rationale = "AIの提出が不正または空だったため、判断を保留する";
    d.downgrades.push("AIの提出が不正");
    return d;
  }
  const rationale = short(claim.rationale.replace(/\s+/g, " ").trim(), 400);

  // ---- AI が「単独」「保留」を選んだ: 安全側の判断なのでそのまま採用する（取りこぼしは精度評価で測る）
  if (claim.action === "single") {
    const d = base(world, "single", "single", singleKey);
    d.rationale = rationale || "同じ企画の抽選は見つからなかった";
    d.missing = claim.missing.slice(0, 5);
    return d;
  }
  if (claim.action === "hold") {
    const d = base(world, "hold", "hold", `hold:${subject.id}:${peerHashOf(world)}`);
    d.rationale = rationale || "情報が不足しているため、判断を保留する";
    d.missing = claim.missing.slice(0, 5);
    return d;
  }

  // ---- グループ化の提案: 対象の確定
  const byId = new Map(world.lotteries.map((l) => [l.id, l]));
  const downgrades: string[] = [];
  const kind: "new_group" | "add_to_group" = claim.action;
  let group: GGroup | null = null;
  let peers: GLottery[] = [];
  if (subject.archived) {
    const d = base(world, "single", "single", singleKey);
    d.rationale = "この抽選は除外・取り下げ済みのため、グループ化しない";
    return d;
  }
  if (kind === "add_to_group") {
    group = world.groups.find((g) => g.id === claim.groupId) ?? null;
    if (!group) {
      const d = base(world, "single", "single", singleKey);
      d.rationale = "追加先のグループが見つからない（解除済みか、存在しない）ため、まとめない";
      d.downgrades.push("追加先のグループが存在しない");
      return d;
    }
    if (group.chainId && group.chainId !== subject.chainId) {
      const d = base(world, "single", "single", singleKey);
      d.rationale = "追加先のグループは別の系列のため、まとめない";
      d.downgrades.push("追加先が別の系列");
      return d;
    }
    peers = group.memberIds.map((id) => byId.get(id)).filter((l): l is GLottery => !!l && !l.archived && l.id !== subject.id);
    if (subject.groupId === group.id) {
      const d = base(world, "single", "single", `member:${subject.id}:${group.id}`);
      d.skipReason = "すでにこのグループの所属";
      d.rationale = "すでにこのグループに所属している";
      return d;
    }
    if (peers.length === 0) {
      const d = base(world, "single", "single", singleKey);
      d.rationale = "追加先のグループに有効な所属が無いため、まとめない";
      return d;
    }
    if (group.memberIds.length + 1 > MAX_GROUP_SIZE) {
      const d = base(world, "single", "single", singleKey);
      d.rationale = `グループの上限（${MAX_GROUP_SIZE}件）に達しているため、追加しない`;
      return d;
    }
  } else {
    const ids = [...new Set(claim.memberIds)].filter((id) => id !== subject.id);
    const invalid = ids.filter((id) => !byId.has(id));
    if (invalid.length > 0) downgrades.push(`存在しない・除外済み・別の系列の抽選${invalid.length}件を対象から外した`);
    const found = ids.map((id) => byId.get(id)).filter((l): l is GLottery => !!l && !l.archived);
    const grouped = found.filter((l) => l.groupId);
    if (grouped.length > 0) downgrades.push(`すでに別のグループに所属している抽選${grouped.length}件を対象から外した（追加は既存グループへの追加で行う）`);
    peers = found.filter((l) => !l.groupId).slice(0, MAX_NEW_GROUP_MEMBERS - 1);
    if (found.filter((l) => !l.groupId).length > peers.length) downgrades.push(`対象が多いため、先頭の${peers.length}件に限定した`);
    if (subject.groupId) {
      const d = base(world, "single", "single", singleKey);
      d.rationale = "この抽選はすでに別のグループに所属しているため、新しいグループにはしない";
      d.downgrades.push("すでにグループ所属");
      return d;
    }
    if (peers.length === 0) {
      const d = base(world, "single", "single", singleKey);
      d.rationale = rationale || "まとめる相手が見つからなかった";
      d.downgrades.push(...downgrades);
      return d;
    }
  }

  const ids = kind === "new_group" ? [subject.id, ...peers.map((p) => p.id)] : [subject.id];
  const key = proposalKey(kind, kind === "new_group" ? ids : [subject.id], group?.id ?? null);
  const dec = base(world, kind, "single", key);
  dec.lotteryIds = ids;
  dec.targetGroupId = group?.id ?? null;
  dec.downgrades = downgrades;

  // ---- 過去の判断（手動で分けた組・却下済み）を尊重する
  const compareSet = [subject, ...peers];
  for (let i = 0; i < compareSet.length; i++) {
    for (let j = i + 1; j < compareSet.length; j++) {
      if (kind === "add_to_group" && i > 0) continue; // 既存の所属どうしは比べない
      if (world.separated.has(pairKey(compareSet[i].id, compareSet[j].id))) {
        dec.kind = "single";
        dec.tier = "single";
        dec.key = singleKey;
        dec.skipReason = "手動で分けた組";
        dec.rationale = "利用者が以前に手動で分けた（解除・却下した）組を含むため、まとめない";
        dec.downgrades.push("手動で分けた組");
        return dec;
      }
    }
  }
  const known = world.knownKeys.get(key);
  if (known) {
    dec.skipReason = `この組はすでに記録がある（${known}）`;
  }

  // ---- 事実の突き合わせ（subject × 相手、新規グループは相手どうしも）
  const pairs: { c: PairCompare; other: GLottery }[] = peers.map((p) => ({ c: comparePair(subject, p), other: p }));
  const peerPairs: PairCompare[] = [];
  if (kind === "new_group") for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) peerPairs.push(comparePair(peers[i], peers[j]));
  const allPairs = [...pairs.map((p) => p.c), ...peerPairs];

  const mismatches: Mismatch[] = [];
  for (const { c, other } of pairs) mismatches.push(...mismatchesOf(c, other.id));
  for (const c of peerPairs) mismatches.push(...mismatchesOf(c, c.b).map((m) => ({ ...m, detail: `${m.detail}（相手の抽選どうし）` })));
  // 同じ内容の相違は1つにまとめる（相手が多いときの重複表示を避ける）
  const merged = new Map<string, Mismatch & { n: number }>();
  for (const m of mismatches) {
    const k = `${m.field}|${m.severity}|${m.detail}`;
    const cur = merged.get(k);
    if (cur) cur.n++;
    else merged.set(k, { ...m, n: 1 });
  }
  dec.mismatches = [...merged.values()].map(({ n, lotteryId, ...m }) => ({ ...m, ...(n === 1 && lotteryId ? { lotteryId } : {}), detail: n > 1 ? `${m.detail}（${n}件）` : m.detail }));

  // ---- 強い裏づけ（同じ企画であることの独立した根拠）
  const signals: VerifiedDecision["strongSignals"] = [];
  if (pairs.some((p) => p.c.campaign === "same") && !allPairs.some((c) => c.campaign === "differs")) signals.push("campaign");
  if (pairs.some((p) => p.c.sharedSourceUrl)) signals.push("source_url");
  let injection = false;
  for (const l of compareSet) if ((world.evidence.get(l.id) ?? []).some((t) => detectInjection(t).length > 0)) injection = true;
  const phrase = verifyPhrase(claim.commonPhrase, subject, peers, world.evidence);
  if (phrase.ok) signals.push("phrase");
  else if (claim.commonPhrase) dec.downgrades.push(`共通の文言を確認できない: ${phrase.reason}`);
  dec.strongSignals = signals;

  // ---- 区分の決定
  const hard = dec.mismatches.filter((m) => m.severity === "hard");
  const gaps = dec.mismatches.filter((m) => m.severity === "gap");
  const soft = dec.mismatches.filter((m) => m.severity === "soft");
  const blocking = dec.mismatches.filter((m) => m.severity === "hard" && ["store", "campaign"].includes(m.field) || (m.field === "products" && m.detail.startsWith("対象商品が重ならない")));
  const strong = signals.length > 0;
  let tier: Tier;
  let why: string;
  if (blocking.length > 0) {
    tier = "single";
    why = `まとめない: ${[...new Set(blocking.map((m) => m.detail))].join("・")}`;
  } else if (hard.length > 0) {
    tier = strong ? "suggest" : "single";
    why = strong
      ? `同じ企画の裏づけはあるが、店舗ごとに異なる点がある（${[...new Set(hard.map((m) => fieldLabel(m.field)))].join("・")}）。利用者の確認が必要`
      : `同じ系列でも、${[...new Set(hard.map((m) => fieldLabel(m.field)))].join("・")}が異なり、同じ企画の裏づけも無いため、まとめない`;
  } else if (gaps.length > 0) {
    // 不明（記載なし・確認できない）がある: 同じ企画の裏づけがあれば候補、無ければ保留（「記載なし」だけを根拠にまとめない）
    tier = strong ? "suggest" : "hold";
    why = `${[...new Set(gaps.map((m) => m.detail))].join("・")}のため、確定できない`;
  } else if (soft.length > 0) {
    tier = "suggest";
    why = soft.some((m) => m.detail.includes("記載なし")) ? "応募条件の一方にだけ記載がある項目があり（記載なし）、同じ条件かを利用者が確認する必要がある" : "応募条件の文面に違いがあるため、利用者の確認が必要";
  } else if (strong) {
    tier = "auto";
    why = "系列・商品・応募期間・発表日・応募方法・受取方法・応募条件がすべて一致し、同じ企画の裏づけもある";
  } else {
    tier = "suggest";
    why = "項目はすべて一致しているが、同じ企画であることの裏づけ（同じキャンペーン・同じ情報源・共通の企画名）が確認できていない";
  }

  // ---- 降格（自動にしてはいけない事情）
  const cap = (reason: string) => {
    if (tier === "auto") {
      tier = "suggest";
      dec.downgrades.push(reason);
    }
  };
  const claimBad = claimMismatches(claim, allPairs);
  if (claimBad.length > 0) {
    dec.downgrades.push(...claimBad);
    dec.mismatches.push({ field: "claim", detail: claimBad[0], severity: "soft" });
    cap("AIの主張と登録内容が食い違うため、自動にしない");
  }
  if (injection) {
    dec.mismatches.push({ field: "claim", detail: "情報源の文章に命令らしき文面があった（指示としては扱っていない）", severity: "gap" });
    cap("情報源に命令らしき文面があるため、自動にしない");
  }
  if (kind === "add_to_group" && group && group.origin === "manual") cap("手動で作ったグループには、承認なしで追加しない");
  if (!opts.allowAuto) cap("自動グループ化が無効の設定のため、候補として提示する");
  if (dec.skipReason) tier = tier === "auto" ? "suggest" : tier;

  // ---- 信頼度（事実の一致の度合い。AIの自己申告は使わない）
  const scores = pairs.map((p) => pairScore(p.c));
  let confidence = scores.length > 0 ? Math.min(...scores) : 0;
  if (peerPairs.length > 0) confidence = Math.min(confidence, ...peerPairs.map(pairScore));
  confidence += Math.min(15, (signals.includes("campaign") ? 10 : 0) + (signals.includes("source_url") ? 7 : 0) + (signals.includes("phrase") ? 7 : 0));
  if (claimBad.length > 0) confidence -= 15;
  if (injection) confidence -= 20;
  confidence = Math.max(0, Math.min(100, confidence));
  if (tier === "auto" && confidence < AUTO_MIN_CONFIDENCE) {
    tier = "suggest";
    dec.downgrades.push(`信頼度が自動の基準（${AUTO_MIN_CONFIDENCE}）に達しない`);
  }

  // ---- 共通している項目（すべての組で一致したもの）
  const allSame = (f: PairField) => allPairs.length > 0 && allPairs.every((c) => (f === "products" ? c.products === "same" : c[f] === "same"));
  const common: string[] = ["系列"];
  if (allSame("products")) common.push("対象商品");
  if (allSame("applyStart") && allSame("applyDeadline")) common.push("応募期間");
  if (allSame("resultDate")) common.push("発表日");
  if (allSame("applyMethod")) common.push("応募方法");
  if (allSame("receiveMethod")) common.push("受取方法");
  if (allSame("requirements")) common.push("応募条件");
  if (signals.includes("campaign")) common.push("同じキャンペーン");
  if (signals.includes("source_url")) common.push("同じ情報源");
  if (signals.includes("phrase")) common.push(`共通の企画文言「${short(claim.commonPhrase ?? "", 30)}」`);
  dec.common = common;

  dec.tier = tier;
  dec.confidence = confidence;
  dec.missing = [...new Set([...claim.missing, ...gaps.map((g) => g.detail)])].slice(0, 6);
  dec.rationale = [rationale, why].filter(Boolean).join(" / ").slice(0, 1400);
  if (tier === "single") {
    dec.kind = "single";
    dec.key = singleKey;
    dec.lotteryIds = [subject.id];
    dec.targetGroupId = null;
  } else if (tier === "hold") {
    dec.kind = "hold";
    dec.key = `hold:${subject.id}:${peerHashOf(world)}`;
    dec.lotteryIds = [subject.id];
    dec.targetGroupId = null;
  }
  return dec;
}
