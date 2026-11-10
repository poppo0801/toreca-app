"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import type { CandidateView } from "@/components/auto-collect-view";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { domainExcludable, hostOf } from "@/lib/collector/triage";
import { cityToPrefecture, judgeRegion } from "@/lib/collector/region";
import { EXCLUDE_REASONS, ruleNameKey, searchDupTargets, suggestDuplicates, suggestKeywords, type DupSuggestion, type DupTarget, type ExcludeReason } from "@/lib/collector/user-rules";
import { matchChain } from "@/lib/lottery-match";
import { PREFECTURE_LIST } from "@/lib/geo";
import { cn } from "@/lib/utils";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";

export interface ExcludeResult {
  prev: { id: string; prev: Record<string, unknown> }[];
  rule: { table: "collection_rules" | "collection_exclusions"; id: string; created: boolean } | null;
  reason: ExcludeReason;
  /** 補足（系列の別名だけ登録できなかった場合など） */
  note?: string;
}

/** 候補から取り出せる事実（系列・店舗・商品名・情報源）。除外理由の入力欄の初期値になる */
export function candidateFacts(c: CandidateView) {
  const i = c.draft?.input as
    | { chain?: { id?: string | null; name?: string }; store?: { id?: string | null; name?: string; prefecture?: string }; items?: { product?: { id?: string | null; name?: string } }[]; applyDeadline?: { precision: string; date?: string; time?: string }; sourceUrls?: string[] }
    | undefined;
  const x = c.source_url?.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//i);
  return {
    chainId: i?.chain?.id ?? null,
    chainName: i?.chain?.name ?? "",
    storeId: i?.store?.id ?? null,
    storeName: i?.store?.name ?? "",
    statedPrefecture: i?.store?.prefecture ?? "",
    productIds: (i?.items ?? []).map((t) => t.product?.id).filter((v): v is string => !!v),
    productNames: (i?.items ?? []).map((t) => t.product?.name ?? "").filter(Boolean),
    deadline: i?.applyDeadline && i.applyDeadline.precision !== "unknown" && i.applyDeadline.date ? `${i.applyDeadline.date}T${i.applyDeadline.time || "23:59"}:00+09:00` : null,
    xUsername: x ? x[1] : null,
    host: hostOf(c.source_url),
    urls: [c.source_url, ...(i?.sourceUrls ?? [])].filter((u): u is string => !!u),
  };
}

/**
 * 除外理由の選択（下から開くパネル）。6種類の理由を2列×3行で選び、必要な理由だけ追加の入力を表示する（自動入力済み・確認だけ）。
 * 「その他」は追加の入力なしで除外し、ルールを作らない。ルールは、ここで確定したものだけが自動収集に反映される。
 */
export function ExcludeReasonSheet({ candidate, others, onClose, onDone }: { candidate: CandidateView; /** 重複先の候補（同じ一覧の別の候補） */ others: CandidateView[]; onClose: () => void; onDone: (r: ExcludeResult) => void }) {
  const { data, profile } = useApp();
  const f = useMemo(() => candidateFacts(candidate), [candidate]);
  const [reason, setReason] = useState<ExcludeReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 地域・店舗: 取得済みの情報から店舗・所在地を自動入力
  const storeMaster = f.storeId ? data.stores.find((s) => s.id === f.storeId) : undefined;
  const region = useMemo(() => judgeRegion({ masterPrefecture: storeMaster?.prefecture, address: storeMaster?.address, storeName: f.storeId ? "" : f.storeName, statedPrefecture: f.statedPrefecture }), [storeMaster, f.storeId, f.storeName, f.statedPrefecture]);
  // 市区町村: 判定で分かればそれ。店舗マスターの都道府県で決まった場合は、住所の市区町村が同じ都道府県のものであるときだけ補う
  const addrCity = !region.city && storeMaster?.address ? cityToPrefecture(storeMaster.address, { explicitOnly: true }) : null;
  const city0 = region.city || (addrCity && addrCity.prefecture === region.prefecture ? addrCity.city : "");
  const [rg, setRg] = useState({ chainName: f.chainName, storeName: f.storeName, prefecture: region.prefecture, city: city0, note: "" });
  // 信頼性なし
  const chainRes = useMemo(() => {
    if (f.chainId) return { id: f.chainId, name: data.chains.find((c) => c.id === f.chainId)?.name ?? f.chainName, viaAlias: false };
    if (!f.chainName.trim()) return null;
    const m = matchChain(f.chainName, data.chains, { stores: data.stores, storeName: f.storeName });
    return (m.kind === "exact" || m.kind === "alias") && m.item ? { id: m.item.id, name: m.item.name, viaAlias: m.kind === "alias" || ruleNameKey(m.item.name) !== ruleNameKey(f.chainName) } : null;
  }, [f.chainId, f.chainName, f.storeName, data.chains, data.stores]);
  const sources = useMemo(() => {
    const out: { key: string; target: "chain" | "x_account" | "domain"; value: string; label: string; text: string; register?: boolean }[] = [];
    // 系列: 候補の系列IDが無くても、系列名・別名を系列マスターと照合して特定する（投稿本文に系列名があるだけの別の系列は対象にしない）。未登録なら、登録して除外
    if (chainRes) out.push({ key: "chain", target: "chain", value: chainRes.id, label: chainRes.name, text: `系列「${chainRes.name}」${chainRes.viaAlias ? `（取得した名称: ${f.chainName}）` : ""}` });
    else if (f.chainName.trim()) out.push({ key: "chain", target: "chain", value: "", label: f.chainName.trim(), text: `系列「${f.chainName.trim()}」（系列マスターに未登録。仮登録して除外）`, register: true });
    if (f.xUsername) out.push({ key: "x", target: "x_account", value: f.xUsername, label: `@${f.xUsername}`, text: `Xアカウント @${f.xUsername}` });
    if (f.host && domainExcludable(f.host)) out.push({ key: "domain", target: "domain", value: f.host, label: f.host, text: `サイト ${f.host}` });
    return out;
  }, [f, chainRes]);
  const [srcKey, setSrcKey] = useState(sources[0]?.key ?? "");
  // 別ゲーム
  const [kw, setKw] = useState(() => suggestKeywords(f.productNames, candidate.title).join("、"));
  // 重複
  const dupTargets = useMemo<DupTarget[]>(() => {
    const names = new Map(data.products.map((p) => [p.id, p.officialName]));
    const chainName = new Map(data.chains.map((c) => [c.id, c.name]));
    const storeName = new Map(data.stores.map((s) => [s.id, s.name]));
    const aliasOf = new Map(data.chains.map((c) => [c.id, c.aliases ?? []]));
    const lots: DupTarget[] = data.lotteries.map((l) => ({ kind: "lottery", id: l.id, label: [chainName.get(l.chainId), l.storeId ? storeName.get(l.storeId) : "", l.items.map((t) => names.get(t.productId) ?? "").filter(Boolean).join("・")].filter(Boolean).join(" "), chainId: l.chainId, chainName: chainName.get(l.chainId) ?? "", chainAliases: aliasOf.get(l.chainId) ?? [], storeId: l.storeId ?? null, storeName: l.storeId ? (storeName.get(l.storeId) ?? "") : "", urls: l.sourceUrls ?? [], productIds: l.items.map((t) => t.productId), productNames: l.items.map((t) => names.get(t.productId) ?? ""), deadline: l.applyDeadline.precision === "date_time" ? l.applyDeadline.at : l.applyDeadline.precision === "date_only" ? `${l.applyDeadline.date}T23:59:00+09:00` : null }));
    const cands: DupTarget[] = others
      .filter((o) => o.id !== candidate.id)
      .map((o) => {
        const of = candidateFacts(o);
        return { kind: "candidate" as const, id: o.id, label: [of.chainName, of.storeName, of.productNames.join("・")].filter(Boolean).join(" ") || o.title, chainId: of.chainId, chainName: of.chainName, chainAliases: of.chainId ? (aliasOf.get(of.chainId) ?? []) : [], storeId: of.storeId, storeName: of.storeName, urls: of.urls, productIds: of.productIds, productNames: of.productNames, deadline: of.deadline };
      });
    return [...lots, ...cands];
  }, [data, others, candidate.id]);
  const myChainAliases = useMemo(() => (chainRes ? (data.chains.find((c) => c.id === chainRes.id)?.aliases ?? []) : []), [chainRes, data.chains]);
  const dups = useMemo(
    () => suggestDuplicates({ chainId: chainRes?.id ?? f.chainId, chainName: f.chainName, chainAliases: myChainAliases, storeId: f.storeId, storeName: f.storeName, productIds: f.productIds, productNames: f.productNames, deadline: f.deadline, urls: f.urls }, dupTargets),
    [f, chainRes, myChainAliases, dupTargets],
  );
  const [dupPick, setDupPick] = useState<string>(dups[0] ? `${dups[0].kind}:${dups[0].id}` : "");
  // 手動検索（自動で候補が見つからなくても、統合先を探せる）
  const [dupQuery, setDupQuery] = useState("");
  const found = useMemo(() => searchDupTargets(dupQuery, dupTargets, { storeId: f.storeId, storeName: f.storeName }), [dupQuery, dupTargets, f.storeId, f.storeName]);
  const picked: DupSuggestion | undefined = useMemo(() => [...dups, ...found].find((d) => `${d.kind}:${d.id}` === dupPick), [dups, found, dupPick]);
  // 系列の別名: 統合先の系列名と、取得した系列名が違うとき、利用者が確認して別名として登録できる
  const aliasCandidate = useMemo(() => {
    const mine = f.chainName.trim();
    if (!picked || !picked.chainId || !picked.chainName || !mine) return null;
    if (chainRes && chainRes.id === picked.chainId) return null;
    const known = [picked.chainName, ...(picked.chainAliases ?? [])].map(ruleNameKey);
    return known.includes(ruleNameKey(mine)) ? null : { chainId: picked.chainId, from: mine, to: picked.chainName };
  }, [picked, f.chainName, chainRes]);
  const [aliasOk, setAliasOk] = useState(false);
  const chainStores = f.chainId ? data.stores.filter((s) => s.chainId === f.chainId) : [];

  const submit = async (code: ExcludeReason) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let input: Record<string, unknown>;
    if (code === "region") input = { reason: "region", chainId: f.chainId, chainName: rg.chainName.trim(), storeId: f.storeId, storeName: rg.storeName.trim(), prefecture: rg.prefecture, city: rg.city.trim(), note: rg.note.trim() };
    else if (code === "untrusted") {
      const s = sources.find((x) => x.key === srcKey);
      if (!s) {
        setBusy(false);
        return setError("除外する系列・情報源を選択してください");
      }
      input = { reason: "untrusted", target: s.target, key: s.value, label: s.label, ...(s.target === "chain" ? { chainName: s.label, registerChain: s.register === true } : {}) };
    } else if (code === "area_chain") {
      if (!f.chainId) {
        setBusy(false);
        return setError("系列マスターに未登録の系列は、エリア外系列のルールにできません");
      }
      input = { reason: "area_chain", chainId: f.chainId, chainName: f.chainName };
    } else if (code === "duplicate") {
      const [kind, id] = dupPick.split(":");
      if (!id) {
        setBusy(false);
        return setError("重複先を選択してください");
      }
      if (picked?.storeDiffers) {
        setBusy(false);
        return setError("店舗が異なる抽選は、店舗ごとに独立した別の抽選のため統合できません");
      }
      input = { reason: "duplicate", target: { kind, id }, ...(picked ? { matchReason: picked.reason.slice(0, 200) } : {}), ...(aliasOk && aliasCandidate ? { registerChainAlias: { chainId: aliasCandidate.chainId, alias: aliasCandidate.from.slice(0, 80) } } : {}) };
    } else if (code === "other_game") {
      const keywords = kw.split(/[、,\s]+/).map((k) => k.trim()).filter((k) => k.length >= 2);
      if (keywords.length === 0) {
        setBusy(false);
        return setError("除外するキーワードを2文字以上で入力してください");
      }
      input = { reason: "other_game", keywords };
    } else input = { reason: "other" };
    try {
      const res = await fetch("/api/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "excludeReason", id: candidate.id, actor: profile.id, input }) });
      const j = (await res.json().catch(() => null)) as { ok: boolean; error?: string; prev?: ExcludeResult["prev"]; rule?: ExcludeResult["rule"]; reason?: ExcludeReason; note?: string } | null;
      setBusy(false);
      if (!j?.ok) return setError(j?.error ?? "除外できませんでした");
      onDone({ prev: j.prev ?? [], rule: j.rule ?? null, reason: code, note: j.note });
    } catch {
      setBusy(false);
      setError("通信に失敗しました");
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="exclude-desc" data-testid="exclude-sheet">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>除外の理由</SheetTitle>
            <SheetDescription id="exclude-desc" className="truncate">
              {[f.chainName, f.storeName].filter(Boolean).join(" ") || candidate.title}
            </SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="除外理由">
            {EXCLUDE_REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                role="radio"
                aria-checked={reason === r.code}
                disabled={busy}
                data-testid={`reason-${r.code}`}
                onClick={() => {
                  setError(null);
                  if (r.code === "other") void submit("other");
                  else setReason(r.code);
                }}
                className={cn("min-h-11 rounded-md border text-sm font-medium", reason === r.code ? "border-primary bg-primary text-primary-foreground" : "bg-input")}
              >
                {r.label}
              </button>
            ))}
          </div>

          {reason === "region" && (
            <div className="space-y-2" data-testid="reason-region-form">
              <p className="text-xs text-muted-foreground">この店舗の抽選（通販・発送・店舗選択式を除く）を、今後の収集で自動的に除外します。地名の一致だけでは除外しません。</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  <span className="text-[13px] font-medium">系列</span>
                  <input className={field} value={rg.chainName} onChange={(e) => setRg({ ...rg, chainName: e.target.value })} />
                </label>
                <label className="text-sm">
                  <span className="text-[13px] font-medium">店舗</span>
                  <input className={field} value={rg.storeName} onChange={(e) => setRg({ ...rg, storeName: e.target.value })} />
                </label>
                <label className="text-sm">
                  <span className="text-[13px] font-medium">都道府県</span>
                  <select className={field} value={rg.prefecture} onChange={(e) => setRg({ ...rg, prefecture: e.target.value })}>
                    <option value="">未確認</option>
                    {PREFECTURE_LIST.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-[13px] font-medium">市区町村</span>
                  <input className={field} value={rg.city} onChange={(e) => setRg({ ...rg, city: e.target.value })} placeholder="未確認" />
                </label>
              </div>
              {region.prefecture && <p className="text-[11px] text-muted-foreground">自動入力: {region.note}</p>}
              <label className="block text-sm">
                <span className="text-[13px] font-medium">理由（任意）</span>
                <input className={field} value={rg.note} onChange={(e) => setRg({ ...rg, note: e.target.value })} />
              </label>
            </div>
          )}

          {reason === "untrusted" && (
            <div className="space-y-2" data-testid="reason-untrusted-form">
              <p className="text-xs text-muted-foreground">除外の対象を選びます。系列の除外は、その系列が実施する抽選全体が対象です（情報源が不明でも作れます）。情報源（Xアカウント・サイト）の除外は別のルールです。投稿本文に系列名があるだけの別の系列は除外せず、登録済みの抽選カードも削除しません。設定の収集ルールから解除できます。</p>
              {sources.length === 0 && <p className="text-sm text-warn">除外の対象にできる系列・情報源が見つかりません（系列がマスター未登録で、Xアカウント・個別サイトでもありません）。</p>}
              <div className="space-y-1.5" role="radiogroup" aria-label="除外の対象">
                {sources.map((s) => (
                  <label key={s.key} className="flex min-h-10 items-center gap-2 rounded-md border bg-input px-3 text-sm">
                    <input type="radio" name="src" checked={srcKey === s.key} onChange={() => setSrcKey(s.key)} />
                    {s.text}
                  </label>
                ))}
              </div>
            </div>
          )}

          {reason === "area_chain" && (
            <div className="space-y-1.5" data-testid="reason-area-form">
              <p className="text-sm">{f.chainName ? `系列「${f.chainName}」` : "この系列"}を、収集の対象から外します（系列マスターには残ります）。</p>
              <p className="text-xs text-muted-foreground">
                {chainStores.length > 0 ? `登録済みの店舗の都道府県: ${[...new Set(chainStores.map((s) => s.prefecture).filter(Boolean))].join("・") || "未登録"}。` : "この系列の店舗はマスターに登録されていません。"}
                対象地域に店舗が追加されたときは、自動的に適用されなくなります。通販・全国応募・店舗選択式は除外しません。
              </p>
              {!f.chainId && <p className="text-sm text-warn">系列マスターに未登録のため、この理由は使えません。</p>}
            </div>
          )}

          {reason === "duplicate" && (
            <div className="space-y-2" data-testid="reason-dup-form">
              <p className="text-xs text-muted-foreground">同じ抽選として扱う登録済みの抽選・候補を選びます。この候補の情報源URLは、統合先に参照として残ります。店舗が異なる抽選は別の抽選のため統合できません。</p>
              {dups.length === 0 && <p className="text-sm text-warn" data-testid="dup-none">自動では統合先の候補が見つかりませんでした。下の検索から、登録済みの抽選・確認待ちの候補を探せます。</p>}
              <DupList items={dups} pick={dupPick} onPick={setDupPick} />
              <label className="block text-sm">
                <span className="text-[13px] font-medium">統合先を検索（系列・店舗・商品・URL）</span>
                <input className={field} value={dupQuery} onChange={(e) => setDupQuery(e.target.value)} placeholder="例: ドラゴンスター 神戸" aria-label="統合先を検索" data-testid="dup-search" />
              </label>
              {dupQuery.trim() !== "" && found.length === 0 && <p className="text-xs text-muted-foreground">一致する抽選・候補がありません。</p>}
              <DupList items={found} pick={dupPick} onPick={setDupPick} />
              {aliasCandidate && (
                <label className="flex items-start gap-2 rounded-md border bg-input px-3 py-2 text-sm" data-testid="dup-alias">
                  <input type="checkbox" className="mt-1" checked={aliasOk} onChange={(e) => setAliasOk(e.target.checked)} />
                  <span>
                    「{aliasCandidate.from}」を、系列「{aliasCandidate.to}」の別名として登録する
                    <span className="block text-[11px] text-muted-foreground">同じ系列の表記揺れである場合だけ選んでください（別の系列の名称は登録しないでください）。</span>
                  </span>
                </label>
              )}
            </div>
          )}

          {reason === "other_game" && (
            <div className="space-y-1.5" data-testid="reason-game-form">
              <p className="text-xs text-muted-foreground">除外する商品名のキーワード（「、」区切り）。解析した商品名がすべて該当するときだけ除外し、ポケモンカードの商品も含む投稿は維持します。</p>
              <input className={field} aria-label="除外するキーワード" value={kw} onChange={(e) => setKw(e.target.value)} />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="exclude-error">
              {error}
            </p>
          )}
          {reason && (
            <div className="flex justify-end">
              <Button type="button" disabled={busy} onClick={() => void submit(reason)} data-testid="exclude-submit">
                {busy ? "処理中…" : "除外する"}
              </Button>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** 重複先の選択肢（登録済みの抽選／確認待ちの候補）。店舗が異なるものは選べない */
function DupList({ items, pick, onPick }: { items: DupSuggestion[]; pick: string; onPick: (v: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5" role="radiogroup" aria-label="重複先">
      {items.map((d) => (
        <label key={`${d.kind}:${d.id}`} className={cn("flex min-h-10 items-start gap-2 rounded-md border bg-input px-3 py-2 text-sm", d.storeDiffers && "opacity-60")} data-testid="dup-option">
          <input type="radio" name="dup" className="mt-1" disabled={d.storeDiffers} checked={pick === `${d.kind}:${d.id}`} onChange={() => onPick(`${d.kind}:${d.id}`)} />
          <span className="min-w-0">
            <span className="block break-words">{d.label}</span>
            <span className="block text-[11px] text-muted-foreground">
              {d.kind === "lottery" ? "登録済みの抽選" : "確認待ちの候補"}・{d.storeDiffers ? "店舗が異なるため統合できません（別の抽選）" : d.reason}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
