/**
 * 情報源の観測（SourceFact）を、既存のデータ形から組み立てる（Stage 10N・純関数）。
 *  - 一覧の項目（10M の ListItemResult）・既存の登録・旧方式の抽出（候補の draft）を、同じ形に揃える。
 *  - **自己照合の防止**: 一覧の項目は `originId = <候補ID>`、その候補から作られた登録・旧方式の抽出も同じ `originId`。同じ候補由来のものどうしは互いに別の情報源として照合しない。
 *  - 原文・URLの全体は持ち込まない（URLは正規化用に保持するが、保存・表示ではホストのみ）。
 */
import { createHash } from "node:crypto";
import { judgeRegion } from "@/lib/collector/region";
import type { ListItemResult } from "../list-discovery";
import type { ApplyUnitName, FieldName, SourceFact } from "./types";

export const hashId = (...parts: (string | number)[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);

const unitOf = (u: string | null | undefined): ApplyUnitName => (u === "store_select" || u === "per_store" || u === "per_product" || u === "one_form_one" ? u : "unknown");

export function factFromListItem(a: { candidateId: string; parentKey: string; item: ListItemResult; fetchedAt: string | null; postedAt?: string | null; urls?: string[]; range?: { start: number; end: number } | null; /** 見出し（例: 《店舗名（県）- 1件》）。県名の根拠になる */ groupLabel?: string; /** 項目の原文・投稿の冒頭（TCGの種類の手掛かり。保存しない） */ contextTexts?: string[]; /** この項目の応募先リンクが展開済みで、他の項目と別の応募先と確認できた（linkMap による）。原文に応募単位が書かれていない項目の応募単位を、構造から推定する根拠 */ destinationDistinct?: boolean }): SourceFact | null {
  const it = a.item;
  // 応募機会として確定した項目だけが観測になる（保留・失敗・抽選でない項目は、他の情報源の根拠にしない）
  if (it.status !== "done" || it.verdict !== "independent_lottery") return null;
  const ev = { range: a.range ?? null, quoteVerified: it.quoteVerified, image: null } as const;
  const fields: SourceFact["fields"] = { chain: it.chain, store: it.store, products: it.products, applyDeadline: it.applyDeadline, applyStart: it.applyStart, method: it.method, applyUnit: unitOf(it.unit) };
  // 応募単位が原文に書かれておらず、店舗が特定でき、応募先が他の項目と別と確認できる場合だけ「店舗ごとに別応募」と推定する（書かれていれば原文を優先。応募先が不明なら unknown のまま）
  if (fields.applyUnit === "unknown" && it.store && a.destinationDistinct) fields.applyUnit = "per_store";
  // 見出しの県名（告知に書かれた都道府県）。店舗名から別の県が読める場合は judgeRegion が「不明」にする（推測で選ばない）
  const reg = judgeRegion({ storeName: it.store, statedPrefecture: a.groupLabel });
  if (reg.prefecture) fields.prefecture = reg.prefecture;
  const evidence: SourceFact["evidence"] = {};
  for (const k of Object.keys(fields) as FieldName[]) if (fields[k] != null) evidence[k] = ev;
  return { sourceId: `list:${hashId(a.candidateId, a.parentKey, it.no)}`, kind: "list_item", fetchedAt: a.fetchedAt, postedAt: a.postedAt ?? null, fields, evidence, urls: a.urls, originId: `cand:${a.candidateId}`, texts: [a.groupLabel, ...(a.contextTexts ?? [])].filter((x): x is string => !!x) };
}

export interface RegistrationLike {
  id: string;
  /** この登録の元になった候補（あれば）。同じ候補由来の項目・抽出とは照合しない */
  candidateId?: string | null;
  chain: string | null;
  store: string | null;
  prefecture?: string | null;
  products: string[];
  applyStart?: string | null;
  applyDeadline?: string | null;
  resultDate?: string | null;
  method?: string | null;
  applyUrl?: string | null;
  protectedCodes: string[];
  protectionUnknown?: boolean;
  humanConfirmed?: FieldName[];
  updatedAt?: string | null;
}

export function factFromRegistration(r: RegistrationLike): SourceFact {
  return {
    sourceId: `reg:${r.id}`,
    kind: "registration",
    fetchedAt: r.updatedAt ?? null,
    fields: { chain: r.chain, store: r.store, prefecture: r.prefecture ?? null, products: r.products, applyStart: r.applyStart ?? null, applyDeadline: r.applyDeadline ?? null, resultDate: r.resultDate ?? null, method: r.method ?? null, applyUrl: r.applyUrl ?? null },
    urls: r.applyUrl ? [r.applyUrl] : undefined,
    registration: { id: r.id, protectedCodes: r.protectedCodes, protectionUnknown: r.protectionUnknown, humanConfirmed: r.humanConfirmed },
    originId: r.candidateId ? `cand:${r.candidateId}` : undefined,
  };
}
