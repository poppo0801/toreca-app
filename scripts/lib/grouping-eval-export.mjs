// 抽選グループ判定の実データ評価（Stage 8F-2）の入力・正解を、本番の記録（読み取り専用）から組み立てる純粋な関数。DB・ネットワークには触れない。
// 正解の根拠は「利用者自身の判断」だけ（AIの判定結果は一切使わない）:
//   - 手動でまとめたグループ（origin が manual / save_and_duplicate / duplicate）の組 → 正解 auto（同じ企画としてまとめるのが正しい）。根拠 kind=manual_group
//   - 手動で外した・解除した組（lottery_group_events の removed・origin=manual・detail.wasWith）→ 正解 none。根拠 kind=manual_separation
//   - それ以外（人が判断していない組）は、ケースにしない（正解が確定できないため。評価の分母に混ぜない）
// 入力（cases）には正解・グループ判定の履歴（手動の分離の記録）を入れない。AIが見るのは、抽選の項目・情報源の文章・（既存グループがあれば）グループの構成だけ。

const MANUAL_ORIGINS = new Set(["manual", "save_and_duplicate", "duplicate"]);
const MAX_TEXT = 1500;

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};
/** 下書き（JSON）から、人が読む文章らしい文字列を集める（URL・IDらしきものは除く） */
export function textsOfDraft(draft) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") {
      if (v.length >= 20 && !/^https?:\/\//.test(v) && !/^[0-9a-f-]{30,}$/i.test(v)) out.push(v.slice(0, MAX_TEXT));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(draft);
  return out;
}

const dateOf = (precision, date, at) => {
  if (precision === "date_time" && at) {
    // JST の「YYYY-MM-DDTHH:mm」
    const j = new Date(new Date(at).getTime() + 9 * 3600_000).toISOString();
    return j.slice(0, 16);
  }
  if (precision === "date_only" && date) return date;
  return null;
};

/**
 * @param {object} rows { lotteries, items, productNames, storeNames, chainNames, groups, events, evidenceByLottery, applied, now }
 *   lotteries: lotteries の行（id, chain_id, store_id, store_mode, campaign_id, apply_*, result_*, apply_method, receive_method, requirement_tags, conditions_text, source_urls, bulk_group_id, archived_at, created_at）
 *   items: [{lottery_id, product_id, quantity}]  productNames: {id: name}  storeNames: {id: name}  chainNames: {id: name}
 *   groups: [{id, origin, chain_id, title}]  events: [{lottery_id, detail}]（removed・origin=manual）
 *   evidenceByLottery: {lotteryId: string[]}（collection_candidates の下書き由来の文章）
 */
export function buildCases(rows, { max = 30, pool = false } = {}) {
  const live = rows.lotteries.filter((l) => !l.archived_at);
  const byId = new Map(live.map((l) => [l.id, l]));
  const itemsBy = new Map();
  for (const i of rows.items) itemsBy.set(i.lottery_id, [...(itemsBy.get(i.lottery_id) ?? []), i]);
  const groupsById = new Map(rows.groups.map((g) => [g.id, g]));
  const now = rows.now ?? new Date().toISOString();

  // 抽選IDは、評価データでは連番に置き換える（本番のIDを出さない）
  const alias = new Map();
  const aid = (id) => {
    if (!alias.has(id)) alias.set(id, `L${String(alias.size + 1).padStart(3, "0")}`);
    return alias.get(id);
  };

  const spec = (l, groupOverride) => {
    const its = itemsBy.get(l.id) ?? [];
    const qty = its[0]?.quantity ?? 1;
    return {
      id: aid(l.id),
      store: l.store_id ? rows.storeNames[l.store_id] ?? "" : "",
      chain: rows.chainNames[l.chain_id] ?? "",
      products: its.map((i) => rows.productNames[i.product_id] ?? "（商品名不明）"),
      qty,
      start: dateOf(l.apply_start_precision, l.apply_start_date, l.apply_start_at),
      deadline: dateOf(l.apply_deadline_precision, l.apply_deadline_date, l.apply_deadline_at),
      result: dateOf(l.result_precision, l.result_date, l.result_at),
      apply: l.apply_method,
      receive: l.receive_method,
      tags: l.requirement_tags ?? [],
      conditions: l.conditions_text ?? "",
      ...(l.campaign_id ? { campaign: l.campaign_id } : {}),
      urls: l.source_urls ?? [],
      storeMode: ["fixed", "select_on_apply", "none"].includes(l.store_mode) ? l.store_mode : "fixed",
      ...(groupOverride !== undefined ? (groupOverride ? { group: groupOverride } : {}) : l.bulk_group_id ? { group: `G:${l.bulk_group_id}` } : {}),
      ...(rows.applied?.includes(l.id) ? { applied: true } : {}),
    };
  };
  const sameChain = (l) => live.filter((x) => x.chain_id === l.chain_id && x.id !== l.id);
  const categoryOf = (members, subject, remainingGrouped) => {
    if (remainingGrouped >= 2) return "add_to_group";
    const g = (f) => new Set(members.map(f)).size;
    if (g((m) => m.apply_deadline_date ?? m.apply_deadline_at) > 1 || g((m) => m.apply_start_date ?? m.apply_start_at) > 1) return "period_differs";
    if (g((m) => JSON.stringify([...(m.requirement_tags ?? [])].sort())) > 1) return "conditions_differ";
    if (members.some((m) => (itemsBy.get(m.id) ?? []).length > 1)) return "multi_product";
    if (new Set(members.flatMap((m) => (m.source_urls ?? []).map(hostOf)).filter(Boolean)).size > 1) return "source_mixed";
    return "multi_store_same";
  };
  const evidenceFor = (ids) => Object.fromEntries(ids.map((id) => [aid(id), (rows.evidenceByLottery[id] ?? []).join("\n").slice(0, MAX_TEXT * 2)]).filter(([, t]) => t));
  const sourcesFor = (ids) => {
    const seen = new Set();
    const out = [];
    for (const id of ids) for (const u of byId.get(id)?.source_urls ?? []) if (/^https?:\/\//.test(u) && !seen.has(u)) { seen.add(u); out.push({ url: u, fetchedAt: byId.get(id).created_at ?? now }); }
    return out;
  };

  // 候補の洗い出し用: 有効な抽選をそのまま（正解なし）。人が一次情報で正解を確定するための材料
  if (pool) return { pool: live.map((l) => ({ ...spec(l, null), sources: sourcesFor([l.id]), text: evidenceFor([l.id])[aid(l.id)] ?? "" })), cases: [], gold: {} };

  const cases = [];
  const gold = {};
  const add = (c, g) => {
    c.id = `K${String(cases.length + 1).padStart(2, "0")}`;
    cases.push(c);
    gold[c.id] = g;
  };

  // ① 手動でまとめたグループ: 1件を対象にして、残りが相手（leave-one-out）
  for (const g of rows.groups) {
    if (!MANUAL_ORIGINS.has(g.origin) || cases.length >= max) continue;
    const members = live.filter((l) => l.bulk_group_id === g.id);
    if (members.length < 2) continue;
    const subject = members[members.length - 1]; // 最後に加わった（作成が新しい）ものを、新規の抽選とみなす
    const rest = members.filter((m) => m.id !== subject.id);
    const remainingGrouped = rest.length;
    const others = sameChain(subject).filter((x) => x.id !== subject.id);
    // 残りが2件以上なら、グループは残したまま（add_to_group）。1件だけなら、組は解いた状態にする（new_group）
    const keepGroup = remainingGrouped >= 2;
    const ids = [subject, ...others].map((l) => l.id);
    add(
      {
        title: `手動グループの再現（${keepGroup ? "既存グループへの追加" : "新規の組"}・${members.length}件）`,
        category: categoryOf(members, subject, keepGroup ? remainingGrouped : 0),
        capturedAt: now,
        sources: sourcesFor(ids),
        subject: spec(subject, null),
        others: others.map((o) => spec(o, keepGroup && o.bulk_group_id === g.id ? `G:${g.id}` : null)),
        ...(keepGroup ? { groups: [{ id: `G:${g.id}`, origin: "manual", members: rest.map((m) => aid(m.id)) }] } : {}),
        evidence: evidenceFor(ids),
      },
      { label: "auto", basis: [{ kind: "manual_group", ref: `利用者が手動でまとめたグループ（${g.origin}・${members.length}件）`, checkedAt: now }], note: "同じ企画としてまとめるのが正しい（利用者の判断）。自動・候補のどちらでも誤りではない" },
    );
  }

  // ② 手動で分けた組: 正解 none（分離の記録は入力に含めない＝AIの素の判断を測る）
  const seenPairs = new Set();
  for (const e of rows.events) {
    const subject = byId.get(e.lottery_id);
    const was = Array.isArray(e.detail?.wasWith) ? e.detail.wasWith : [];
    if (!subject || e.detail?.reason === "group_too_small") continue;
    for (const wid of was) {
      const other = byId.get(wid);
      const key = [subject.id, wid].sort().join("|");
      if (!other || seenPairs.has(key) || cases.length >= max || other.chain_id !== subject.chain_id) continue;
      seenPairs.add(key);
      const others = sameChain(subject).filter((x) => x.id !== subject.id).slice(0, 29);
      const ids = [subject, ...others].map((l) => l.id);
      add(
        { title: "利用者が手動で分けた組", category: "manual_separated", capturedAt: now, sources: sourcesFor(ids), subject: spec(subject, null), others: others.map((o) => spec(o, null)), evidence: evidenceFor(ids) },
        { label: "none", basis: [{ kind: "manual_separation", ref: "利用者が手動でグループから外した・解除した（記録あり）", checkedAt: now }], note: "同じ企画ではないと利用者が判断" },
      );
    }
  }
  void groupsById;
  return { cases: cases.slice(0, max), gold };
}
