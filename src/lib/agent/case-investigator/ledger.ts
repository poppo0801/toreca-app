/**
 * 案件（1つの抽選）の調査台帳（Stage 9H-1・純関数＋メモリ上の状態）。DBは触らない。
 * 情報源ごとの記録（URL・種類・取得日時・告知日時・出どころ・成否）と、項目ごとの観測（値・原文の根拠）を保持し、項目単位で統合する。
 *   - 採用値・根拠・未確認・矛盾を項目ごとに保持する（矛盾は無条件にどちらかへ決めず、暫定値＋要調査として残す）
 *   - 独立した裏付け: 出どころ（転載元）が同じ複数のページは1つと数える
 *   - 公式（一次）でも二次でも、単独で正しいとは扱わない: 確定は「一次情報の根拠がある」または「独立した出どころが2つ以上」かつ矛盾がないとき
 *   - 手動で確定した項目は上書きしない。同一抽選と確認できないページは統合せず隔離する
 */
import { FIELD_LABEL, type FieldKey } from "@/lib/collector/fields";
import { relateDateTimes } from "@/lib/collector/date-phrases";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { productKey } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";
import { matchIdentity, type IdentityFacts, type IdentityResult } from "./identity";
import type { CaseSourceKind, Tier } from "./source-class";

export type FetchFailKind = "robots_blocked" | "http_error" | "timeout" | "login_required" | "refused";

export interface CaseTarget {
  id: string;
  chain: string;
  store?: string;
  storeMode?: "fixed" | "select_on_apply";
  products: string[];
  /** すでに分かっている項目（登録済みの抽選・一覧の表示など）。出どころは seed の source で示す */
  known: Partial<Record<FieldKey, string>>;
  /** 利用者が手動で確定した項目（自動で上書きしない） */
  manualFields: FieldKey[];
  /** 登録済みの情報源（公式ページ・告知URLなど） */
  knownSources: { url: string; kind: CaseSourceKind }[];
}

export type SourceStatus = "fetched" | "failed" | "different_lottery" | "quarantined";
export interface SourceRecord {
  url: string;
  kind: CaseSourceKind;
  tier: Tier;
  status: SourceStatus;
  failKind?: FetchFailKind;
  failReason?: string;
  fetchedAt: string;
  /** 告知日時・更新日時（取得できたとき） */
  publishedAt?: string;
  /** 出どころ（転載元があればその元）。同じ出どころは独立した裏付けとして数えない */
  origin: string;
  /** 転載・引用の元（一次情報への参照）。無ければ null */
  derivedFrom: string | null;
  account?: string;
  identity?: IdentityResult;
  /** この情報源から採用候補になった項目 */
  contributed: FieldKey[];
  /** 本文に命令らしき文面があった（データとして扱い、従わない） */
  injection: boolean;
  /** 根拠に使った原文（短い抜粋。項目ごと） */
  quotes: Partial<Record<FieldKey, string>>;
}

export interface Observation {
  field: FieldKey;
  /** 値の正規形。日時は "YYYY-MM-DD" または "YYYY-MM-DD HH:MM"。商品は " / " 区切り */
  value: string;
  quote: string;
  sourceUrl: string;
  basis?: "organizer_body" | "platform_meta";
}

interface Entry {
  field: FieldKey;
  value: string;
  sourceUrl: string;
  kind: CaseSourceKind;
  tier: Tier;
  origin: string;
  account?: string;
  at: string;
  publishedAt?: string;
  basis?: "organizer_body" | "platform_meta";
  quote: string;
  seed?: boolean;
}

export type FieldStateX = "confirmed" | "unverified" | "conflict" | "manual" | "missing";
export interface FieldRecord {
  field: FieldKey;
  label: string;
  adopted: string | null;
  state: FieldStateX;
  independentOrigins: number;
  hasPrimary: boolean;
  sources: { url: string; kind: CaseSourceKind; tier: Tier; basis?: string; quote: string; at: string }[];
  alternatives: { value: string; sources: string[] }[];
  note?: string;
}

const DATE_FIELDS: FieldKey[] = ["applyStart", "applyDeadline", "resultDate", "procedureStart", "procedureDeadline", "receiveStart", "receiveDeadline"];
const isDateField = (f: FieldKey) => DATE_FIELDS.includes(f);
const dt = (v: string): { date: string; time: string } | null => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(v.trim());
  return m ? { date: m[1], time: m[2] ?? "" } : null;
};
const urlKey = (u: string): string => u.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
const SHORT_URL = /^https?:\/\/(t\.co|bit\.ly|lin\.ee|buff\.ly|ow\.ly|goo\.gl|amzn\.to)\//i;

/** 値の比較用の形（表記の揺れで矛盾にしない） */
function cmpKey(f: FieldKey, v: string): string {
  switch (f) {
    case "chain":
      return chainCanonicalKey(v);
    case "store":
      return normName(v);
    case "items":
      return v.split(" / ").map(productKey).filter(Boolean).sort().join("|");
    case "applyUrl":
      return SHORT_URL.test(v) ? "short" : urlKey(v);
    case "conditions":
    case "announcement":
      return "present";
    default:
      return v.trim();
  }
}

/** 2つの値が同じ意味か（日時は境界表現・詳しさの違いを同一視。商品は一方が他方を含むときも同じ企画の記載として同一視） */
function sameValue(f: FieldKey, a: string, b: string): boolean {
  if (isDateField(f)) {
    const x = dt(a);
    const y = dt(b);
    return !!x && !!y && relateDateTimes(x, y).same;
  }
  if (f === "items") {
    const x = cmpKey(f, a).split("|").filter(Boolean);
    const y = cmpKey(f, b).split("|").filter(Boolean);
    if (!x.length || !y.length) return false;
    const sub = (s: string[], t: string[]) => s.every((p) => t.some((q) => p === q || (p.length >= 4 && q.length >= 4 && (p.includes(q) || q.includes(p)))));
    return sub(x, y) || sub(y, x);
  }
  if (f === "applyUrl" && (cmpKey(f, a) === "short" || cmpKey(f, b) === "short")) return true; // 短縮URLは比較できない（矛盾にしない）
  return cmpKey(f, a) === cmpKey(f, b);
}

export const CORE_FIELDS: FieldKey[] = ["items", "applyDeadline", "applyStart", "store"];
export const OPTIONAL_FIELDS: FieldKey[] = ["resultDate", "conditions", "applyMethod", "applyUrl"];

export class CaseLedger {
  readonly sources = new Map<string, SourceRecord>();
  private readonly entries: Entry[] = [];
  private readonly manual: Set<FieldKey>;
  constructor(readonly target: CaseTarget, readonly now: () => string) {
    this.manual = new Set(target.manualFields);
    for (const s of target.knownSources) this.sources.set(urlKey(s.url), this.blank(s.url, s.kind, "registered"));
    // すでに分かっている項目は、手動確定なら manual、そうでなければ「既知の値（出どころ不明の二次）」として入れる
    for (const [f, v] of Object.entries(target.known) as [FieldKey, string][]) {
      if (!v) continue;
      this.entries.push({ field: f, value: v, sourceUrl: "(既知の登録情報)", kind: "unknown", tier: "secondary", origin: "seed", at: now(), quote: "", seed: true });
    }
  }
  private blank(url: string, kind: CaseSourceKind, status: "registered"): SourceRecord {
    void status;
    return { url, kind, tier: kind === "organizer_official" || kind === "store_official" || kind === "official_social" ? "primary" : "secondary", status: "quarantined", fetchedAt: "", origin: `u:${urlKey(url)}`, derivedFrom: null, contributed: [], injection: false, quotes: {} };
  }
  /** 登録済み・未取得の情報源（まだ試していない） */
  untriedSources(): { url: string; kind: CaseSourceKind }[] {
    return this.target.knownSources.filter((s) => !this.sources.get(urlKey(s.url))?.fetchedAt);
  }

  recordFetchOk(rec: Omit<SourceRecord, "status" | "contributed" | "quotes" | "identity">): SourceRecord {
    const r: SourceRecord = { ...rec, status: "quarantined", contributed: [], quotes: {} };
    this.sources.set(urlKey(rec.url), r);
    return r;
  }
  recordFetchFail(url: string, kind: CaseSourceKind, tier: Tier, failKind: FetchFailKind, reason: string): SourceRecord {
    const r: SourceRecord = { url, kind, tier, status: "failed", failKind, failReason: reason.slice(0, 200), fetchedAt: this.now(), origin: `u:${urlKey(url)}`, derivedFrom: null, contributed: [], injection: false, quotes: {} };
    this.sources.set(urlKey(url), r);
    return r;
  }

  /** ページの報告を統合する。同一抽選と確認できなければ統合しない（別の抽選は隔離・拒否、不明は保留） */
  integrate(url: string, facts: IdentityFacts, obs: Observation[]): { identity: IdentityResult; accepted: Observation[]; skipped: { field: FieldKey; reason: string }[] } {
    const src = this.sources.get(urlKey(url));
    if (!src || src.status === "failed") return { identity: { verdict: "unknown", matched: [], mismatched: [] }, accepted: [], skipped: obs.map((o) => ({ field: o.field, reason: "未取得の情報源" })) };
    // 比べる側の事実: 目標の識別情報＋現時点で採用している応募締切
    const targetFacts: IdentityFacts = { chain: this.target.chain, store: this.target.store, storeSelect: this.target.storeMode === "select_on_apply", products: this.target.products, applyDeadline: this.resolve("applyDeadline").adopted ?? this.target.known.applyDeadline };
    const identity = matchIdentity(targetFacts, facts);
    src.identity = identity;
    if (identity.verdict === "different") {
      src.status = "different_lottery";
      return { identity, accepted: [], skipped: obs.map((o) => ({ field: o.field, reason: `別の抽選の情報（${identity.mismatched.join("・")}が異なる）` })) };
    }
    if (identity.verdict === "unknown") {
      src.status = "quarantined";
      return { identity, accepted: [], skipped: obs.map((o) => ({ field: o.field, reason: "同じ抽選と確認できないため統合しない（保留）" })) };
    }
    src.status = "fetched";
    const accepted: Observation[] = [];
    const skipped: { field: FieldKey; reason: string }[] = [];
    for (const o of obs) {
      if (this.manual.has(o.field)) {
        skipped.push({ field: o.field, reason: "手動で確定した項目のため上書きしない" });
        continue;
      }
      this.entries.push({ field: o.field, value: o.value, sourceUrl: src.url, kind: src.kind, tier: src.tier, origin: src.origin, account: src.account, at: src.fetchedAt, publishedAt: src.publishedAt, basis: o.basis, quote: o.quote });
      src.quotes[o.field] = o.quote.slice(0, 160);
      if (!src.contributed.includes(o.field)) src.contributed.push(o.field);
      accepted.push(o);
    }
    return { identity, accepted, skipped };
  }

  /** 項目を統合して、採用値・状態・根拠・矛盾を返す */
  resolve(field: FieldKey): FieldRecord {
    const label = FIELD_LABEL[field];
    if (this.manual.has(field)) {
      const v = this.target.known[field] ?? null;
      return { field, label, adopted: v, state: "manual", independentOrigins: 0, hasPrimary: false, sources: [], alternatives: [], note: "手動で確定した値（自動で変更しない）" };
    }
    const es = this.entries.filter((e) => e.field === field);
    if (!es.length) return { field, label, adopted: null, state: "missing", independentOrigins: 0, hasPrimary: false, sources: [], alternatives: [] };
    // 値のグループ（同じ意味の値をまとめる）
    const groups: Entry[][] = [];
    for (const e of es) {
      const g = groups.find((gr) => sameValue(field, gr[0].value, e.value));
      if (g) g.push(e);
      else groups.push([e]);
    }
    const refOf = (e: Entry) => ({ url: e.sourceUrl, kind: e.kind, tier: e.tier, ...(e.basis ? { basis: e.basis } : {}), quote: e.quote, at: e.at });
    const origins = (g: Entry[]) => new Set(g.filter((e) => !e.seed).map((e) => e.origin)).size;
    const hasPrimary = (g: Entry[]) => g.some((e) => e.tier === "primary" && !e.seed);
    const valueOfGroup = (g: Entry[]): string => {
      if (isDateField(field)) {
        // 境界表現・詳しさの違いは、安全側（早い方・時刻つき）を採用する
        return g.map((e) => e.value).reduce((acc, v) => {
          const a = dt(acc);
          const b = dt(v);
          if (!a || !b) return acc;
          const r = relateDateTimes(a, b);
          return r.adopt ? `${r.adopt.date}${r.adopt.time ? ` ${r.adopt.time}` : ""}` : acc;
        });
      }
      if (field === "items") {
        const names: string[] = [];
        for (const e of g) for (const n of e.value.split(" / ")) if (n && !names.some((x) => productKey(x) === productKey(n))) names.push(n);
        return names.join(" / ");
      }
      // 文面: 優先度の高い（一次・主催者本文）情報源の値
      return [...g].sort((a, b) => rank(b) - rank(a))[0].value;
    };
    if (groups.length === 1) {
      const g = groups[0];
      const o = origins(g);
      const confirmed = !g.every((e) => e.seed) && (hasPrimary(g) || o >= 2);
      return { field, label, adopted: valueOfGroup(g), state: confirmed ? "confirmed" : "unverified", independentOrigins: o, hasPrimary: hasPrimary(g), sources: g.map(refOf), alternatives: [] };
    }
    // 値が違う: まず、同じ情報源（アカウント・ホスト）の新しい更新・訂正かを見る（古い値は履歴）
    const latestOf = (g: Entry[]) => g.reduce((m, e) => ((e.publishedAt ?? e.at) > (m.publishedAt ?? m.at) ? e : m));
    const sameAccount = (a: Entry[], b: Entry[]) => !!latestOf(a).account && latestOf(a).account === latestOf(b).account;
    const byRecency = [...groups].sort((a, b) => ((latestOf(b).publishedAt ?? latestOf(b).at) > (latestOf(a).publishedAt ?? latestOf(a).at) ? 1 : -1));
    if (groups.length === 2 && sameAccount(groups[0], groups[1])) {
      const [newer, older] = byRecency;
      const hasDated = !!latestOf(newer).publishedAt && !!latestOf(older).publishedAt;
      if (hasDated) return { field, label, adopted: valueOfGroup(newer), state: "unverified", independentOrigins: origins(newer), hasPrimary: hasPrimary(newer), sources: newer.map(refOf), alternatives: [{ value: valueOfGroup(older), sources: older.map((e) => e.sourceUrl) }], note: "同じ情報源の新しい更新・訂正を採用（古い値は履歴）" };
    }
    // 主催者の説明本文は、サービス側の表示より優先する（矛盾として止めない）
    const bodyG = groups.filter((g) => g.every((e) => e.basis === "organizer_body"));
    const metaG = groups.filter((g) => g.every((e) => e.basis === "platform_meta"));
    if (groups.length === 2 && bodyG.length === 1 && metaG.length === 1) {
      const g = bodyG[0];
      return { field, label, adopted: valueOfGroup(g), state: hasPrimary(g) || origins(g) >= 2 ? "confirmed" : "unverified", independentOrigins: origins(g), hasPrimary: hasPrimary(g), sources: g.map(refOf), alternatives: [{ value: valueOfGroup(metaG[0]), sources: metaG[0].map((e) => e.sourceUrl) }], note: "主催者の説明本文を、サービス側の表示より優先" };
    }
    // それ以外の食い違い: どちらにも決めない。暫定値（一次情報→応募締切は早い方→独立した出どころが多い方）と、要調査の矛盾として残す
    const sorted = [...groups].sort((a, b) => Number(hasPrimary(b)) - Number(hasPrimary(a)) || origins(b) - origins(a));
    let prov = sorted[0];
    if (field === "applyDeadline" && !(hasPrimary(sorted[0]) && !hasPrimary(sorted[1]))) {
      const early = [...groups].sort((a, b) => valueOfGroup(a).localeCompare(valueOfGroup(b)))[0];
      prov = early; // 応募の機会を逃さないよう、安全側（早い方）を暫定採用
    }
    return { field, label, adopted: valueOfGroup(prov), state: "conflict", independentOrigins: origins(prov), hasPrimary: hasPrimary(prov), sources: prov.map(refOf), alternatives: groups.filter((g) => g !== prov).map((g) => ({ value: valueOfGroup(g), sources: g.map((e) => e.sourceUrl) })), note: "情報源どうしで食い違う（どちらにも決めていません）" };
  }

  allFields(): FieldRecord[] {
    return [...CORE_FIELDS, ...OPTIONAL_FIELDS].map((f) => this.resolve(f));
  }
  /** 取得に成功した一次情報の情報源があるか */
  hasPrimaryFetched(): boolean {
    return [...this.sources.values()].some((s) => s.status === "fetched" && s.tier === "primary");
  }
  failedPrimary(): SourceRecord[] {
    return [...this.sources.values()].filter((s) => s.status === "failed" && s.tier === "primary");
  }
  failedAny(): SourceRecord[] {
    return [...this.sources.values()].filter((s) => s.status === "failed");
  }
  /** 項目ごとの採用値（手動・既知の値を含む）から作る、現時点の識別情報 */
  snapshotSources(): SourceRecord[] {
    return [...this.sources.values()].filter((s) => s.fetchedAt);
  }
}

function rank(e: Entry): number {
  return (e.tier === "primary" ? 4 : 0) + (e.basis === "organizer_body" ? 2 : 0) + (e.seed ? -1 : 0);
}
