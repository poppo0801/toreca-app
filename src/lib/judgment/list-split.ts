/**
 * 一覧・まとめ投稿の分割と、対象案件への絞り込み（Stage 10I）。**純関数のみ。DB・ネットワーク・実AIには接続しない**。
 *  - 保存原文は改行が空白に畳まれていることが多いため、見出し（《店舗名（県）- n件》・🏬店舗名）と項目（・…／✅…）の印で分ける。印が無ければ「一覧ではない」（分割しない）。
 *  - 目的1（焦点）: 対象案件の登録（currentCase）と一覧の項目を照合し、**対象に関係する項目だけ**を判断へ渡す。無関係な店舗・開催回・商品を対象案件へ足さない。
 *    一意に特定できなければ理由を残し、**推測で結び付けない**（判断に渡さない）。
 *  - 目的2（出力途切れ対策）: 一覧全体を1件の巨大な出力にせず、小さな塊に分けて判断する。失敗（出力の途切れ等）した塊は半分に割って再試行し、成功した部分は採用する。
 *  - 共通の注意書き（見出し・冒頭）は各塊に付ける（共通条件の脱落を防ぐ）。固定の例外規則（特定の系列・店舗の名前）は書かない。
 */
import type { CurrentCase } from "./contract";

export interface ListGroup {
  /** 見出し（例: 《店舗名（県）- 2件》 または 🏬店舗名） */
  label: string;
  /** 見出しの直後の項目（・…／✅… の並び）。項目が無い見出しは本文全体を1項目とする */
  items: string[];
}
export interface SplitList {
  isList: boolean;
  /** 冒頭の共通部分（見出し・共通の注意書き）。長すぎる場合は切り詰める */
  header: string;
  groups: ListGroup[];
}

const HEADER_MAX = 400;
const GROUP_MARK = /《[^》]{2,80}》|🏬/g;
const ITEM_MARK = /(?<=[ \t　])(?=・)|(?<=[ \t　])(?=✅)/g; // 空白の直後の ・ だけを項目の印とする（商品名の中の ・ では割らない）

export const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）【】『』「」《》]/g, "");

/** 一覧かどうかを判定して分割する。見出しの印が2つ未満なら一覧ではない（1つの告知として扱う） */
export function splitListPost(text: string): SplitList {
  const marks = [...text.matchAll(GROUP_MARK)];
  if (marks.length < 2) return { isList: false, header: "", groups: [] };
  const header = text.slice(0, marks[0].index).trim().slice(0, HEADER_MAX);
  const groups: ListGroup[] = marks.map((m, i) => {
    const start = m.index as number;
    const end = i + 1 < marks.length ? (marks[i + 1].index as number) : text.length;
    const body = text.slice(start, end).trim();
    if (m[0] === "🏬") {
      // 🏬店舗名 ✅商品 ⏰締切 … : 見出し＝🏬から最初の ✅ まで
      const parts = body.split(ITEM_MARK).map((s) => s.trim()).filter(Boolean);
      return { label: parts[0] ?? m[0], items: parts.slice(1).length ? parts.slice(1) : [body] };
    }
    const after = body.slice(m[0].length).trim();
    const items = after.split(ITEM_MARK).map((s) => s.trim()).filter(Boolean);
    return { label: m[0], items: items.length ? items : [after || body] };
  });
  return { isList: true, header, groups };
}

export type FocusReason = "unique_store" | "unique_chain" | "ambiguous" | "none" | "not_list";
export interface Focus {
  reason: FocusReason;
  /** 判断へ渡す項目（見出し＋対象に関係する項目）。reason が unique_* のときだけ */
  groups: ListGroup[];
  /** 一覧のうち渡さなかった項目数（対象外として扱う） */
  excludedItems: number;
}

const GENERIC_STORE = /^(通販|オンライン|応募時に店舗選択|店舗選択|全店|各店)/;
const md = (iso: string | null): string | null => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[1])}/${Number(m[2])}` : null;
};

/**
 * 対象案件（currentCase）と一覧の項目を照合して、対象に関係する項目だけを選ぶ。
 *  - 店舗名が見出しに含まれる（または含む）グループが**ちょうど1つ**なら unique_store。店舗が一般的な語（通販・店舗選択など）または未登録で、
 *    系列名が見出しにちょうど1グループだけ含まれるなら unique_chain。複数該当・該当なしは ambiguous / none（**推測で結び付けず、判断に渡さない**）。
 *  - 選ばれたグループの項目が複数あるときは、商品名・締切（M/D）で項目を絞る。絞れなければ全項目を渡さず ambiguous（どの項目が対象か不明）。
 */
export function focusOnCase(split: SplitList, cur: CurrentCase): Focus {
  if (!split.isList) return { reason: "not_list", groups: [], excludedItems: 0 };
  const total = split.groups.reduce((n, g) => n + g.items.length, 0);
  const store = norm(cur.store);
  const chain = norm(cur.chain);
  const storeUsable = store.length >= 3 && !GENERIC_STORE.test(cur.store ?? "");
  const hit = (g: ListGroup, key: string): boolean => key.length >= 3 && (norm(g.label).includes(key) || key.includes(norm(g.label)));
  let picked: ListGroup[] = [];
  let reason: FocusReason = "none";
  if (storeUsable) {
    picked = split.groups.filter((g) => hit(g, store));
    reason = picked.length === 1 ? "unique_store" : picked.length > 1 ? "ambiguous" : "none";
  }
  if (reason === "none" && chain.length >= 3 && (!storeUsable || GENERIC_STORE.test(cur.store ?? "") || !cur.store)) {
    const c = split.groups.filter((g) => hit(g, chain));
    if (c.length === 1) {
      picked = c;
      reason = "unique_chain";
    } else if (c.length > 1) reason = "ambiguous";
  }
  if (reason !== "unique_store" && reason !== "unique_chain") return { reason, groups: [], excludedItems: total };
  const g = picked[0];
  if (g.items.length > 1) {
    // 商品名で項目を絞る。完全一致（商品名の全体を含む）を優先し、完全一致が1つも無いときだけ先頭8文字の一致を使う。
    // 登録商品が複数あるなら、該当する項目をすべて残す（1項目に絞らない）。登録商品が1つで複数項目が残るときは締切（M/D）で絞り、絞れなければ推測しない。
    const products = cur.products.map(norm).filter((p) => p.length >= 4);
    const day = md(cur.applyDeadline);
    const full = g.items.filter((it) => products.some((p) => norm(it).includes(p)));
    const loose = full.length ? full : g.items.filter((it) => products.some((p) => p.length >= 8 && norm(it).includes(p.slice(0, 8))));
    let chosen = loose;
    if (chosen.length > 1 && products.length <= 1 && day) {
      const byDay = chosen.filter((it) => it.includes(day));
      if (byDay.length >= 1) chosen = byDay;
    }
    const sameProductsMany = products.length > 1 && chosen.length >= 1;
    if (chosen.length === 0 || (chosen.length > 1 && !sameProductsMany && chosen.length !== g.items.length)) return { reason: "ambiguous", groups: [], excludedItems: total };
    if (chosen.length > 1 && !sameProductsMany && products.length <= 1) return { reason: "ambiguous", groups: [], excludedItems: total };
    return { reason, groups: [{ label: g.label, items: chosen }], excludedItems: total - chosen.length };
  }
  return { reason, groups: [g], excludedItems: total - g.items.length };
}

/** 判断へ渡す本文を組み立てる（共通の見出しを必ず付ける。各項目は原文のまま＝引用検証が通る） */
export function composeText(header: string, groups: ListGroup[]): string {
  return [header, ...groups.map((g) => `${g.label} ${g.items.join(" ")}`)].filter(Boolean).join(" ");
}

/** 一覧を小さな塊に分ける（項目数・文字数で動的に）。1グループが大きければ項目ごとに割り、見出しを各塊に付ける */
export function chunkGroups(groups: ListGroup[], opts: { maxItems?: number; maxChars?: number } = {}): ListGroup[][] {
  const maxItems = opts.maxItems ?? 6;
  const maxChars = opts.maxChars ?? 1400;
  const chunks: ListGroup[][] = [];
  let cur: ListGroup[] = [];
  let items = 0;
  let chars = 0;
  const flush = (): void => {
    if (cur.length) chunks.push(cur);
    cur = [];
    items = 0;
    chars = 0;
  };
  for (const g of groups) {
    let rest = g.items;
    while (rest.length) {
      const room = Math.max(1, maxItems - items);
      const take: string[] = [];
      for (const it of rest) {
        if (take.length >= room || (take.length && chars + take.join("").length + it.length > maxChars)) break;
        take.push(it);
      }
      cur.push({ label: g.label, items: take });
      items += take.length;
      chars += take.join("").length + g.label.length;
      rest = rest.slice(take.length);
      if (items >= maxItems || chars >= maxChars) flush();
    }
  }
  flush();
  return chunks;
}

export interface ChunkJudgeResult {
  ok: boolean;
  /** 出力があれば、その中の応募機会の数（部分結果の採用に使う） */
  opportunities: number;
  costJpy: number;
  attempts: number;
}
export interface ChunkRun {
  items: number;
  ok: boolean;
  opportunities: number;
  costJpy: number;
  attempts: number;
  /** 失敗して分割し直した回数 */
  splits: number;
}

/**
 * 塊を判断する。失敗（出力の途切れ・形式エラー等）したら、項目が2つ以上ある限り**半分に割って**それぞれ再試行する（同じ巨大な要求を繰り返さない）。
 * 成功した部分は採用し、失敗した箇所だけを再試行する。再試行の深さ・呼び出し回数・費用の上限は呼び出し側の judge が守る（maxCalls/maxCostJpy を超えたら打ち切る）。
 */
export async function judgeChunkWithSplit(
  header: string,
  groups: ListGroup[],
  judge: (text: string) => Promise<ChunkJudgeResult>,
  limits: { maxDepth: number; calls: { used: number; max: number }; cost: { spent: number; max: number } },
  depth = 0,
): Promise<ChunkRun[]> {
  const items = groups.reduce((n, g) => n + g.items.length, 0);
  if (limits.calls.used >= limits.calls.max || limits.cost.spent >= limits.cost.max) return [{ items, ok: false, opportunities: 0, costJpy: 0, attempts: 0, splits: depth }];
  const r = await judge(composeText(header, groups));
  limits.calls.used += r.attempts;
  limits.cost.spent += r.costJpy;
  if (r.ok) return [{ items, ok: true, opportunities: r.opportunities, costJpy: r.costJpy, attempts: r.attempts, splits: depth }];
  if (items < 2 || depth >= limits.maxDepth) return [{ items, ok: false, opportunities: 0, costJpy: r.costJpy, attempts: r.attempts, splits: depth }];
  const flat = groups.flatMap((g) => g.items.map((it) => ({ label: g.label, it })));
  const mid = Math.ceil(flat.length / 2);
  const regroup = (xs: typeof flat): ListGroup[] => {
    const out: ListGroup[] = [];
    for (const x of xs) {
      const last = out.at(-1);
      if (last && last.label === x.label) last.items.push(x.it);
      else out.push({ label: x.label, items: [x.it] });
    }
    return out;
  };
  const a = await judgeChunkWithSplit(header, regroup(flat.slice(0, mid)), judge, limits, depth + 1);
  const b = await judgeChunkWithSplit(header, regroup(flat.slice(mid)), judge, limits, depth + 1);
  return [{ items: 0, ok: false, opportunities: 0, costJpy: r.costJpy, attempts: r.attempts, splits: depth }, ...a, ...b];
}
