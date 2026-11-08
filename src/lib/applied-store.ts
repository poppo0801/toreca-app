import type { AppData, Lottery } from "@/types/domain";

/** 応募時に店舗を選ぶ抽選の、仮の店舗名（抽選の店舗欄に入る。応募店舗の選択肢には出さない） */
export const SELECT_STORE_PLACEHOLDER = "応募時に店舗選択";

export interface StoreChoice {
  id: string | null;
  name: string;
  prefecture: string;
}

/**
 * 応募時に選べる店舗の候補（Stage 6N）。抽選に店舗一覧が取得済みならそれを、無ければ同じ系列の店舗マスターを候補にする。
 * どちらも無ければ空（手動入力）。仮の店舗は含めない。マスターにある名前は id と都道府県を補う。
 */
export function storeChoices(data: Pick<AppData, "stores">, lottery: Pick<Lottery, "chainId" | "selectableStores">): StoreChoice[] {
  const master = data.stores.filter((s) => s.chainId === lottery.chainId && !s.archived && s.name !== SELECT_STORE_PLACEHOLDER);
  const listed = lottery.selectableStores ?? [];
  if (listed.length > 0) {
    return listed.map((x) => {
      const m = master.find((s) => s.name === x.name);
      return { id: m?.id ?? null, name: x.name, prefecture: x.prefecture || m?.prefecture || "" };
    });
  }
  return master.map((s) => ({ id: s.id, name: s.name, prefecture: s.prefecture }));
}

/** 応募店舗の表示名。未設定は null */
export function appliedStoreLabel(s: { name: string; prefecture: string } | null | undefined): string | null {
  if (!s || !s.name) return null;
  return s.prefecture ? `${s.name}（${s.prefecture}）` : s.name;
}

/**
 * 応募店舗の候補（Stage 7B）。実際に応募する店舗はほぼ固定なので、現在のプロフィールの応募履歴を優先する。
 *  1. 現在のプロフィールが同じ系列の抽選で応募した店舗   2. 現在のプロフィールが過去に利用した、この系列の店舗（他系列の抽選で記録された同じ店舗マスター）
 *  3. 系列マスターに登録されている店舗（または抽選に取得済みの店舗一覧）
 * 1・2 は、利用回数の多い順 → 新しい順。同じ店舗名は1つにまとめ、別の系列の店舗は出さない（店舗マスターの系列で確認する）。
 * 戻り値は優先順の全候補（履歴由来は history=true）。画面は先頭の数件を並べ、入力で残りを絞り込む。
 */
export interface StoreCandidate extends StoreChoice {
  history: boolean;
  /** 現在のプロフィールの利用回数（履歴由来のみ） */
  uses: number;
}
export function recentStoreCandidates(
  data: Pick<AppData, "stores" | "accounts" | "applications" | "lotteries">,
  lottery: Pick<Lottery, "id" | "chainId" | "selectableStores">,
  profileId: string,
): StoreCandidate[] {
  const mineAccounts = new Set(data.accounts.filter((a) => a.profileId === profileId).map((a) => a.id));
  const chainStoreIds = new Set(data.stores.filter((s) => s.chainId === lottery.chainId).map((s) => s.id));
  const lotteryChain = new Map(data.lotteries.map((l) => [l.id, l.chainId]));
  const master = storeChoices(data, lottery);
  const key = (n: string) => n.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const stat = new Map<string, { choice: StoreChoice; uses: number; last: string; sameChain: boolean }>();
  for (const a of data.applications) {
    if (a.state !== "applied" || !a.appliedStore?.name || !mineAccounts.has(a.accountId)) continue;
    const sameChainLottery = lotteryChain.get(a.lotteryId) === lottery.chainId;
    // 別の系列の抽選で使った店舗は、店舗マスターがこの系列のものと確認できるときだけ候補にする
    const inChain = (a.appliedStore.id && chainStoreIds.has(a.appliedStore.id)) || master.some((m) => key(m.name) === key(a.appliedStore!.name));
    if (!sameChainLottery && !inChain) continue;
    const k = key(a.appliedStore.name);
    const at = a.appliedAt ?? a.createdAt;
    const cur = stat.get(k);
    if (!cur) stat.set(k, { choice: a.appliedStore, uses: 1, last: at, sameChain: sameChainLottery });
    else {
      cur.uses += 1;
      if (at > cur.last) cur.last = at;
      cur.sameChain ||= sameChainLottery;
    }
  }
  const hist = [...stat.values()].sort((x, y) => Number(y.sameChain) - Number(x.sameChain) || y.uses - x.uses || y.last.localeCompare(x.last));
  const out: StoreCandidate[] = hist.map((h) => {
    const m = master.find((c) => key(c.name) === key(h.choice.name));
    return { id: m?.id ?? h.choice.id, name: m?.name ?? h.choice.name, prefecture: h.choice.prefecture || m?.prefecture || "", history: true, uses: h.uses };
  });
  const seen = new Set(out.map((c) => key(c.name)));
  for (const m of master) {
    if (!seen.has(key(m.name))) {
      seen.add(key(m.name));
      out.push({ ...m, history: false, uses: 0 });
    }
  }
  return out;
}

/**
 * 店舗選択式の抽選カードの店舗表示（Stage 7B）。カードは1枚のまま、応募状態に応じて表示を切り替える。
 *  - 応募前（誰も店舗を入力していない）: 「店舗選択式」
 *  - 応募後: 現在のプロフィール（なければ表示範囲内の他の応募者）が応募した店舗名。複数の応募者が違う店舗なら title に「ユーザー: 店舗」を並べる
 * 店舗固定の抽選では使わない（null）。
 */
export function selectStoreDisplay(
  data: Pick<AppData, "accounts" | "applications" | "profiles">,
  lottery: Pick<Lottery, "id" | "storeMode">,
  profileId: string,
  scope?: ReadonlySet<string>,
): { text: string; title: string } | null {
  if (lottery.storeMode !== "select_on_apply") return null;
  const owner = new Map(data.accounts.map((a) => [a.id, a.profileId]));
  const apps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied" && !!a.appliedStore?.name && (!scope || scope.has(owner.get(a.accountId) ?? "")));
  if (apps.length === 0) return { text: "店舗選択式", title: "応募時に店舗を選ぶ抽選です" };
  const mine = apps.find((a) => owner.get(a.accountId) === profileId) ?? apps[0];
  const label = (id: string | undefined) => data.profiles.find((p) => p.id === id)?.label ?? "";
  const lines = apps.map((a) => `${label(owner.get(a.accountId))}: ${a.appliedStore!.name}`);
  return { text: mine.appliedStore!.name, title: lines.join(" / ") };
}
