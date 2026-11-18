// 正誤チェック用の事例集の組み立て（純粋なロジック。DB・通信なし）。Stage 9F-2
// 選定: 区分ごとの目安件数。除外は「分類不能」を優先し、確認待ち・重複・特殊事例も、同じ情報源・同じ重複キーを避けて選ぶ。
// 出力する項目は許可リスト方式（応募履歴・個人情報・認証情報・世帯ID・プロフィールIDは決して含めない）。

/** 除外理由の分類（analyze-collection-9f.mjs と同じ分類） */
export const EXCLUSION_GROUPS = [
  ["user_condition_region", "収集条件: 対象外の地域・距離", /対象外の地域|直線で約|上限.*を超えて/],
  ["user_condition_tcg", "収集条件: 他TCG・除外する商品", /他TCG|除外する商品|対象外のTCG|ポケモン以外|別のTCG/],
  ["user_condition_method", "収集条件: 受取・応募方法・通販の設定", /受取方法が収集条件|応募方法が収集条件|通販・発送の抽選は収集しない|除外する応募条件|必要な応募条件/],
  ["ended_or_before", "応募期間外（終了・開始前）", /応募締切を過ぎ|まだ応募開始前|応募受付が終了/],
  ["excluded_chain", "除外設定の系列", /除外.*系列|系列.*除外/],
  ["merged", "同じ抽選の候補へ統合", /統合しました|へ統合/],
  ["user_excluded", "利用者が対象外にした", /利用者が.*対象外|利用者が除外/],
  ["not_lottery", "抽選の告知ではない", /抽選.*(ではありません|ではない|認識できません|ありません)|告知ではない/],
];
export const classifyExclusion = (texts) => {
  for (const [id, , re] of EXCLUSION_GROUPS) if (texts.some((t) => re.test(t))) return id;
  return "other_unclassified";
};
const reasonTexts = (c) => [...(c.reasons ?? []), c.triage_reason ?? ""].map(String);

export const CATEGORY_LABEL = {
  auto_registered: "自動登録",
  excluded: "除外",
  pending: "確認待ち",
  duplicate: "重複",
  registered_duplicate: "登録済みの重複疑い",
  special: "特殊事例",
};

/** 軽量な行（draft なし）から、区分ごとの目安件数で選ぶ。lite: collection_candidates の軽量列、specialIds: 特殊事例と判定済みの候補ID。決定的（同じ入力→同じ選定） */
export function pickCandidates(lite, total = 30, specialIds = new Set()) {
  const scale = total / 30;
  const quota = { auto_registered: Math.round(5 * scale), excluded: Math.round(7 * scale), pending: Math.round(6 * scale), duplicate: Math.round(5 * scale), special: Math.round(7 * scale) };
  const used = new Set();
  const usedKeys = new Set();
  const out = [];
  const byHash = (a) => [...a].sort((x, y) => (hash(x.id) < hash(y.id) ? -1 : 1));
  const take = (rows, n, category, tags = []) => {
    // 情報源のホストが偏らないよう、ホストごとに1件ずつ順に選ぶ
    const groups = new Map();
    for (const r of byHash(rows)) {
      if (used.has(r.id) || usedKeys.has(r.dedupe_key || r.source_url || r.id)) continue;
      const h = r.origin_host || r.service_host || "?";
      groups.set(h, [...(groups.get(h) ?? []), r]);
    }
    let got = 0;
    while (got < n && [...groups.values()].some((g) => g.length)) {
      for (const g of groups.values()) {
        const r = g.shift();
        if (!r || got >= n) continue;
        if (used.has(r.id) || usedKeys.has(r.dedupe_key || r.source_url || r.id)) continue;
        used.add(r.id);
        usedKeys.add(r.dedupe_key || r.source_url || r.id);
        out.push({ id: r.id, category, tags });
        got++;
      }
    }
  };
  // 特殊事例（店舗選択式・複数商品・店舗不明）を先に確保（他の区分に吸われないように）
  take(lite.filter((c) => specialIds.has(c.id)), quota.special, "special", ["特殊事例"]);
  const ex = lite.filter((c) => c.status === "excluded");
  const unclassified = ex.filter((c) => classifyExclusion(reasonTexts(c)) === "other_unclassified");
  take(unclassified, quota.excluded, "excluded", ["分類不能の除外"]);
  take(ex.filter((c) => classifyExclusion(reasonTexts(c)) !== "other_unclassified"), quota.excluded - out.filter((o) => o.category === "excluded").length, "excluded", ["理由つきの除外"]);
  take(lite.filter((c) => c.status === "pending"), quota.pending, "pending");
  take(lite.filter((c) => c.status === "duplicate"), quota.duplicate, "duplicate");
  take(lite.filter((c) => c.status === "auto_registered"), quota.auto_registered, "auto_registered");
  return out;
}

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

const flex = (f) => (f && f.precision && f.precision !== "unknown" ? [f.date, f.time].filter(Boolean).join(" ") : null);
const cut = (s, n = 600) => (typeof s === "string" ? s.slice(0, n) : null);

/** 草稿（draft）から、表示に必要な項目だけを許可リスト方式で取り出す（profileId・応募の記録・メモなどは取り出さない） */
export function extractAi(draft) {
  const i = draft && typeof draft === "object" ? draft.input : null;
  if (!i) return null;
  const items = Array.isArray(i.items) ? i.items : [];
  const names = items.map((x) => x?.product?.name).filter((n) => typeof n === "string" && n);
  const storeMode = i.storeMode ?? null;
  return {
    chain: cut(i.chain?.name, 120) || null,
    store: storeMode === "select_on_apply" ? "（応募時に店舗を選択）" : cut(i.store?.name, 120) || null,
    products: names.map((n) => cut(n, 160)),
    applyStart: flex(i.applyStart),
    applyDeadline: flex(i.applyDeadline),
    resultDate: flex(i.resultDate),
    conditions: cut(i.conditionsText, 600) || null,
    lotteryForm: storeMode === "select_on_apply" ? "店舗選択式" : storeMode === "fixed" ? "店舗固定" : (storeMode ?? null),
    receiveMethod: i.receiveMethod ?? null,
    applyMethod: i.applyMethod ?? null,
  };
}

/** 候補1件 → 事例。lotteryView: 重複の比較対象の抽選を取得済みの形にしたもの（id → 表示用） */
export function buildCase(row, meta, lotteryView = new Map()) {
  const draft = row.draft && typeof row.draft === "object" ? row.draft : null;
  const ev = draft?.evidence && typeof draft.evidence === "object" ? Object.entries(draft.evidence).map(([field, e]) => ({ field, quote: cut(e?.quote, 400) })).filter((e) => e.quote) : [];
  const dups = Array.isArray(draft?.duplicates) ? draft.duplicates : [];
  const dupIds = [...new Set([...(row.lottery_id ? [row.lottery_id] : []), ...dups.map((d) => d.lotteryId)].filter(Boolean))];
  return {
    caseId: `k-${String(row.id).slice(0, 8)}`,
    sourceRef: { table: "collection_candidates", id: row.id },
    category: meta.category,
    categoryLabel: CATEGORY_LABEL[meta.category],
    tags: meta.tags ?? [],
    source: { url: row.source_url ?? null, title: cut(row.title, 300), kind: row.kind ?? null, fetchedAt: row.fetched_at ?? null, createdAt: row.created_at ?? null, bodyText: row.bodyText ?? null, bodyNote: row.bodyNote ?? "本文は収集データに保存されていません。情報元URLで確認してください。", bodyFetchedAt: row.bodyFetchedAt ?? null, images: [], imageNote: "画像は収集データに保存されていません。X投稿・画像告知は情報元URLで確認してください。" },
    ai: {
      decision: { status: row.status, label: { auto_registered: "自動登録", excluded: "除外", pending: "確認待ち", duplicate: "重複", failed: "失敗" }[row.status] ?? row.status, triage: row.triage ?? null, triageReason: cut(row.triage_reason, 300) || null },
      reasons: (row.reasons ?? []).map((r) => cut(r, 400)),
      extracted: extractAi(draft),
      evidence: ev.slice(0, 12),
      notices: (draft?.notices ?? []).map((n) => cut(n, 300)).slice(0, 10),
      warnings: (draft?.warnings ?? []).map((n) => cut(n, 300)).slice(0, 10),
    },
    duplicateOf: dupIds
      .filter((id) => lotteryView.has(id))
      .map((id) => ({ level: dups.find((d) => d.lotteryId === id)?.level ?? null, reason: cut(dups.find((d) => d.lotteryId === id)?.reason, 300) || (id === row.lottery_id ? "既存の抽選に紐づけられた候補" : null), lottery: lotteryView.get(id) })),
  };
}

/** 登録済みの重複疑いの組 → 事例（候補ではなく、登録済みの2件の抽選を比較する） */
export function buildRegisteredDuplicateCase(a, b, idx) {
  return {
    caseId: `r-${idx + 1}`,
    sourceRef: { table: "lotteries", ids: [a.id, b.id] },
    category: "registered_duplicate",
    categoryLabel: CATEGORY_LABEL.registered_duplicate,
    tags: ["登録済みの重複疑い"],
    source: { url: a.urls?.[0] ?? null, title: `${a.chain ?? ""} ${a.store ?? ""} ${(a.products ?? []).join("・")}`.trim(), kind: "lottery", fetchedAt: null, createdAt: a.createdAt ?? null, bodyText: null, bodyNote: "登録済みの抽選どうしの比較です。本文はありません。情報源のURLで確認してください。", images: [], imageNote: "" },
    ai: { decision: { status: "duplicate_suspect", label: "同じ系列・店舗・商品・締切の抽選が2件登録されている（重複の疑い）" }, reasons: ["集計で、同じ系列・店舗・商品・応募締切の抽選が複数登録されていると判定された組です"], extracted: { chain: a.chain, store: a.store, products: a.products, applyStart: a.applyStart, applyDeadline: a.applyDeadline, resultDate: null, conditions: null, lotteryForm: a.storeMode, receiveMethod: null, applyMethod: null }, evidence: [], notices: [], warnings: [] },
    duplicateOf: [{ level: null, reason: "比較対象（もう一方の登録）", lottery: b }],
  };
}

/** HTML → 本文テキスト（簡易）。script/style を除き、タグを取り、空白を整える */
export function htmlToText(html, max = 8000) {
  return String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t　]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, max);
}

/** 本文取得してよいURLか（https のみ。ローカル・プライベート宛・X/Twitter（認証が必要）は不可） */
export function isFetchableSourceUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h.includes(":")) return false;
  if (/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(h)) return false;
  return true;
}
