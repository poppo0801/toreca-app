/**
 * Xアカウントからの系列・店舗の特定（Stage 9C・純関数）。1つの情報だけに頼らず、複数の根拠を照合する。
 *   根拠: 表示名 / ユーザーID / プロフィール（自己紹介・所在地・リンク先のサイト）/ 投稿本文 / 公式サイト（マスターの店舗URL・系列の公式サイト）
 * 方針:
 *  - 系列: 根拠の重みの合計が2以上、または1つだけで他の系列の根拠が無いとき。複数の系列が同点なら決めない
 *  - 店舗: 決めた系列の店舗マスターのうち、根拠に名前が現れる店舗が1つだけのとき。同名が複数・複数の店舗が現れるときは決めない
 *  - 特定できなくても、抽選の情報そのものは登録する（店舗不明のまま。店舗を推測しない）
 *  - 所在地（都道府県）は店舗マスター・プロフィールに明記されたものだけ。アカウント名だけから推測しない
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import type { Chain, Store } from "@/types/domain";

export type EvidenceSource = "display_name" | "username" | "bio" | "post" | "official_site";
const WEIGHT: Record<EvidenceSource, number> = { display_name: 2, official_site: 2, username: 1, bio: 1, post: 1 };
const LABEL: Record<EvidenceSource, string> = { display_name: "表示名", username: "ユーザーID", bio: "プロフィール", post: "投稿本文", official_site: "公式サイト" };

export interface AccountEvidenceInput {
  username: string;
  displayName?: string;
  bio?: string;
  /** プロフィールのリンク先・投稿内の公式サイトらしきURL */
  siteUrls?: string[];
  postText?: string;
  chains: Chain[];
  stores: (Store & { storeUrl?: string | null })[];
  /** 系列の公式サイト（ドメイン）。マスターに無いときは空 */
  chainSites?: { chainId: string; host: string }[];
}

export interface EvidenceItem {
  source: EvidenceSource;
  target: "chain" | "store";
  /** 一致した名称 */
  matched: string;
}
export interface AccountEvidenceResult {
  chainId: string | null;
  chainName: string;
  storeId: string | null;
  storeName: string;
  confidence: "high" | "medium" | "low";
  evidence: EvidenceItem[];
  /** 特定できなかった理由・食い違い */
  notes: string[];
}

const alnum = (s: string) => normName(s).replace(/[^a-z0-9ぁ-んァ-ヶ一-龠ー]/g, "");
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const storeCore = (name: string): string => alnum(name).replace(/店$/, "");

export function corroborateAccount(i: AccountEvidenceInput): AccountEvidenceResult {
  const empty: AccountEvidenceResult = { chainId: null, chainName: "", storeId: null, storeName: "", confidence: "low", evidence: [], notes: [] };
  const live = i.chains.filter((c) => !c.archived);
  const texts: { source: EvidenceSource; raw: string }[] = [
    { source: "display_name", raw: i.displayName ?? "" },
    { source: "username", raw: i.username },
    { source: "bio", raw: i.bio ?? "" },
    { source: "post", raw: (i.postText ?? "").slice(0, 400) },
  ];
  // ---- 系列
  const score = new Map<string, { w: number; ev: EvidenceItem[] }>();
  const add = (c: Chain, e: EvidenceItem) => {
    const cur = score.get(c.id) ?? { w: 0, ev: [] };
    if (!cur.ev.some((x) => x.source === e.source)) {
      cur.w += WEIGHT[e.source];
      cur.ev.push(e);
    }
    score.set(c.id, cur);
  };
  for (const c of live) {
    const keys = [c.name, ...(c.aliases ?? [])].map((n) => ({ n, k: chainCanonicalKey(n) })).filter((x) => x.k.length >= (/^[a-z0-9]+$/.test(x.k) ? 4 : 2));
    for (const t of texts) {
      const flat = chainCanonicalKey(t.raw) || "";
      const al = alnum(t.raw);
      const hit = keys.find((x) => (t.source === "display_name" ? flat.includes(x.k) || al.includes(x.k) : al.includes(x.k) || flat.includes(x.k)));
      if (hit && al) add(c, { source: t.source, target: "chain", matched: hit.n });
    }
    // 公式サイト: プロフィールのリンク先・投稿内のURLが、系列の公式サイト（または系列の店舗マスターのURL）と同じドメイン
    const hosts = new Set<string>([...(i.chainSites ?? []).filter((s) => s.chainId === c.id).map((s) => s.host.toLowerCase()), ...i.stores.filter((s) => s.chainId === c.id && s.storeUrl).map((s) => hostOf(s.storeUrl as string))].filter(Boolean));
    const siteHit = (i.siteUrls ?? []).map(hostOf).find((h) => h && hosts.has(h));
    if (siteHit) add(c, { source: "official_site", target: "chain", matched: siteHit });
  }
  const ranked = [...score.entries()].map(([id, v]) => ({ chain: live.find((c) => c.id === id) as Chain, ...v })).sort((a, b) => b.w - a.w);
  if (ranked.length === 0) return { ...empty, notes: ["アカウントの表示名・ユーザーID・プロフィール・投稿から系列を特定できませんでした"] };
  const top = ranked[0];
  if (ranked.length > 1 && ranked[1].w === top.w) return { ...empty, notes: [`系列の根拠が複数の系列で並びました（${ranked.slice(0, 2).map((r) => r.chain.name).join("／")}）。決めません`], evidence: [] };
  if (top.w < 2 && ranked.length > 1) return { ...empty, notes: ["系列の根拠が1つだけで、他の系列の根拠もあるため決めません"] };
  const chain = top.chain;
  const evidence = [...top.ev];
  // ---- 店舗（決めた系列の店舗マスターから）
  const chainStores = i.stores.filter((s) => s.chainId === chain.id && !s.archived && !/^応募時に店舗選択$/.test(s.name) && storeCore(s.name).length >= 2);
  const found = new Map<string, { store: Store; sources: Set<EvidenceSource> }>();
  for (const s of chainStores) {
    const core = storeCore(s.name);
    for (const t of texts) {
      if (t.source === "username") continue; // ローマ字のIDから店舗名は決めない
      if (alnum(t.raw).includes(core)) {
        const cur = found.get(s.id) ?? { store: s, sources: new Set<EvidenceSource>() };
        cur.sources.add(t.source);
        found.set(s.id, cur);
      }
    }
  }
  const notes: string[] = [];
  let store: Store | null = null;
  const names = new Set([...found.values()].map((f) => storeCore(f.store.name)));
  if (found.size === 1 && names.size === 1) {
    const f = [...found.values()][0];
    store = f.store;
    for (const s of f.sources) evidence.push({ source: s, target: "store", matched: f.store.name });
  } else if (found.size > 1) {
    // 長い名称が短い名称を含むだけ（「新宿」「新宿南口」）のときは、長い方を採用
    const longest = [...found.values()].sort((a, b) => storeCore(b.store.name).length - storeCore(a.store.name).length);
    const contained = longest.slice(1).every((f) => storeCore(longest[0].store.name).includes(storeCore(f.store.name)));
    if (contained) {
      store = longest[0].store;
      for (const s of longest[0].sources) evidence.push({ source: s, target: "store", matched: longest[0].store.name });
    } else notes.push(`複数の店舗名が現れたため、店舗は決めません（${longest.slice(0, 3).map((f) => f.store.name).join("・")}）`);
  } else notes.push("店舗名の根拠がないため、系列だけを特定しました（店舗は未確認）");
  // 同名の店舗が複数ある（都道府県が違う）ときは決めない
  if (store) {
    const same = chainStores.filter((s) => storeCore(s.name) === storeCore(store!.name));
    if (same.length > 1) {
      notes.push("同名の店舗が複数あるため、店舗を確定できません");
      store = null;
      for (let k = evidence.length - 1; k >= 0; k--) if (evidence[k].target === "store") evidence.splice(k, 1);
    }
  }
  const sources = new Set(evidence.map((e) => e.source));
  return { chainId: chain.id, chainName: chain.name, storeId: store?.id ?? null, storeName: store?.name ?? "", confidence: sources.size >= 2 ? "high" : "medium", evidence, notes };
}

/** 画面・記録用の根拠の要約 */
export function describeEvidence(r: AccountEvidenceResult): string {
  return r.evidence.map((e) => `${LABEL[e.source]}→${e.target === "chain" ? "系列" : "店舗"}「${e.matched}」`).join("、");
}
