/**
 * 項目ごとの応募先リンクの出所の組み立て（Stage 10S・純関数）。収集時に保存される `linkMap`（Xの投稿データの `entities.urls` の短縮URL→展開済みURL）と親投稿のリンクから、
 * 各項目に **出所つき** のリンクを作る。
 *  - 項目の本文にある短縮URLが linkMap にあれば item_entity（展開済み）。無ければ item_text_short_unexpanded（**robots に反して追跡しない**。復元不能として明示）。
 *  - 親投稿のリンク（保存原文の links）のうち、どの項目の展開結果にも当たらないものは、linkMap があれば parent_card、無ければ（展開結果の対応が失われているため）parent_shared。
 *  - 既存の保存データ（linkMap 無し）では項目ごとの対応は**復元できない**（短縮URLが複数でも、展開済みリンクは重複排除されて順序の対応が失われている）。無理に復元しない。
 */
import type { ListItem } from "../list-items";
import type { ItemLink } from "./link-scope";
import { canonUrl } from "./normalize";

const SHORT_RE = /https:\/\/t\.co\/[A-Za-z0-9]+/g;

export function buildItemLinks(a: { items: ListItem[]; linkMap: { short: string; url: string }[] | undefined; parentLinks: string[]; recordedAt: string | null }): Map<number, ItemLink[]> {
  const map = new Map((a.linkMap ?? []).map((m) => [m.short, m.url]));
  const out = new Map<number, ItemLink[]>();
  const expandedKeys = new Set<string>();
  for (const it of a.items) {
    const links: ItemLink[] = [];
    const shorts = [...new Set([...it.links, ...(it.text.match(SHORT_RE) ?? [])])];
    for (const s of shorts) {
      const u = map.get(s);
      if (u && /^https:\/\//.test(u)) {
        const c = canonUrl(u);
        if (c.cls === "invalid" || c.cls === "social") continue; // 投稿URL（X）は応募先ではない
        links.push({ url: u, origin: "item_entity", shortUrl: s, recordedAt: a.recordedAt });
        expandedKeys.add(c.key);
      } else links.push({ url: s, origin: "item_text_short_unexpanded", recordedAt: a.recordedAt });
    }
    out.set(it.no, links);
  }
  // 親投稿のリンクのうち、項目の展開結果に当たらないもの（出所を明示して、各項目へ「共通」として付ける）。X・短縮は除く
  const parent = a.parentLinks.filter((u) => /^https:\/\//.test(u)).filter((u) => {
    const c = canonUrl(u);
    return c.cls !== "invalid" && c.cls !== "social" && c.cls !== "shortener" && !expandedKeys.has(c.key);
  });
  const origin = (a.linkMap ?? []).length ? "parent_card" : "parent_shared";
  for (const it of a.items) out.set(it.no, [...(out.get(it.no) ?? []), ...parent.map((u) => ({ url: u, origin: origin as ItemLink["origin"], recordedAt: a.recordedAt }))]);
  return out;
}

/** 同じ（正規化した）URLが、いくつの項目に割り当てられているか。共有リンクの検証（無根拠の一括流用の防止）に使う */
export function sameUrlCounts(links: Map<number, ItemLink[]>): Map<string, number> {
  const m = new Map<string, number>();
  for (const ls of links.values()) for (const k of new Set(ls.map((l) => canonUrl(l.url).key))) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** 項目の応募先として判断に引き継いでよいURL: 項目自身のリンク（item_entity）だけ。親投稿共通のリンクは、対応が確認されるまで項目の応募先にしない */
export const itemScopedUrls = (links: ItemLink[]): string[] => links.filter((l) => l.origin === "item_entity").map((l) => l.url);
