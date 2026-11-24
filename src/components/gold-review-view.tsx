"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { confirmAction, excludeAction, exportAction, holdAction, importAction, reopenAction, saveDraftAction, writeGoldAction } from "@/app/(app)/dev/gold-review/actions";
import { Button } from "@/components/ui/button";
import { APPLY_UNITS, EXCLUDE_REASONS, emptyChecks, progressOf, type Draft, type FieldChecks, type PageRecord, type Problem, type ReviewStatus } from "@/lib/gold-review/model";

/**
 * 独立gold確認（開発専用）。JSONを直接編集せずに、公式ページと照らして1ページずつ確認する。**通常の抽選UIには置かない**（URLを直接開いたときだけ。本番・未設定では404）。
 * 機械抽出の候補は「未確認」。項目ごとの確認・根拠の引用の実在・確認の基準が揃ったときだけ「確認済み」にできる。AI・旧方式・登録案の出力は使わない。
 * 年が書かれていない締切は、年を補わない（人が確認して入力する）。公式ページを開けないときは、保存原文との比較だけでは確認済みにせず「保留」にする。
 */
export interface ReviewPageView {
  n: number;
  url: string;
  text: string;
  hash: string;
  savedAt: string;
  title: string | null;
  candidate: { store: string | null; product: string | null; applyEnd: { md: string; year: number | null; quote: string } | null; attention: string[]; slots: string[] };
  /** 実投稿のページの出所（投稿・短縮URL・取得） */
  source?: { caseId: string; order: number; short: string; postUrl: string; postText: string; finalUrl: string; hops: number; status: number; fetchedAt: string; sameContentAs: number | null };
}

const STATUS_LABEL: Record<ReviewStatus, string> = { unreviewed: "未確認", confirmed: "確認済み", excluded: "除外", needs_recheck: "要再確認" };
const STATUS_CLASS: Record<ReviewStatus, string> = { unreviewed: "bg-muted text-muted-foreground", confirmed: "bg-foreground text-background", excluded: "border text-muted-foreground", needs_recheck: "border-2 border-warning text-foreground" };
const nfkc = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "");
const CHUNK = 1500;
type SetId = "lp12" | "real";

export function GoldReviewView({ pages, records, set }: { pages: ReviewPageView[]; records: PageRecord[]; set: SetId }) {
  const [recs, setRecs] = useState(records);
  // 操作のあと（再読み込み）も、続きの位置から。確認・除外・保留のあとは、次の未確認のページを開く（記憶はブラウザのタブ内だけ）
  const [sel, setSel] = useState<number | null>(() => {
    try {
      const v = typeof window !== "undefined" ? window.sessionStorage.getItem(`gold-sel-${set}`) : null;
      if (typeof window !== "undefined") window.sessionStorage.removeItem(`gold-sel-${set}`);
      const n = v ? Number(v) : null;
      return n !== null && pages.some((p) => p.n === n) ? n : null;
    } catch {
      return null;
    }
  });
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; problems?: Problem[] } | null>(null);
  const [busy, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const progress = progressOf(recs);
  const page = pages.find((p) => p.n === sel) ?? null;
  const rec = recs.find((r) => r.n === sel) ?? null;
  const patch = (n: number, f: (r: PageRecord) => PageRecord) => setRecs((rs) => rs.map((r) => (r.n === n ? f(r) : r)));
  const statusOf = (n: number): ReviewStatus => recs.find((r) => r.n === n)!.status;
  const run = (fn: () => Promise<{ ok: boolean; error?: string; problems?: Problem[] } & Record<string, unknown>>, okText: string, after?: (r: Record<string, unknown>) => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setMsg({ ok: true, text: okText });
        after?.(r);
      } else setMsg({ ok: false, text: r.error ?? "失敗しました", problems: r.problems });
    });

  // 実投稿: 投稿（案件）ごとにまとめる。少ないページの投稿から先に（確認の手間が小さい順＝最小工数で gold を作れる順）
  const groups = useMemo(() => {
    if (set !== "real") return [{ id: "", label: "", items: pages }];
    const by = new Map<string, ReviewPageView[]>();
    for (const p of pages) by.set(p.source!.caseId, [...(by.get(p.source!.caseId) ?? []), p]);
    return [...by.entries()].sort((a, b) => a[1].length - b[1].length || (a[0] < b[0] ? -1 : 1)).map(([id, items], i) => ({ id, label: `投稿 ${i + 1}（${items.length}ページ）`, items }));
  }, [pages, set]);
  const ordered = groups.flatMap((g) => g.items);
  /** 現在のページの次に、未確認・要再確認のページ（現在のページを除く）。無ければ null */
  const nextOpenAfter = (cur: number): number | null => {
    const from = ordered.findIndex((p) => p.n === cur);
    const rest = [...ordered.slice(from + 1), ...ordered.slice(0, Math.max(0, from))];
    return rest.find((p) => p.n !== cur && (statusOf(p.n) === "unreviewed" || statusOf(p.n) === "needs_recheck"))?.n ?? null;
  };
  const reloadTo = (n: number | null) => {
    try {
      if (n !== null) window.sessionStorage.setItem(`gold-sel-${set}`, String(n));
    } catch {
      /* 記憶できなくても動く */
    }
    window.location.reload();
  };
  const nextOpen = () => {
    const from = ordered.findIndex((p) => p.n === sel);
    const rest = [...ordered.slice(from + 1), ...ordered.slice(0, Math.max(0, from))];
    const n = rest.find((p) => statusOf(p.n) === "unreviewed" || statusOf(p.n) === "needs_recheck")?.n ?? null;
    if (n === null) setMsg({ ok: true, text: "未確認のページはありません" });
    else {
      setSel(n);
      setMsg(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="gold-review" data-set={set}>
      <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="gold-dev-banner">
        開発専用の確認画面です（ローカルのみ・本番では開けません）。機械抽出の候補は<strong>未確認</strong>です。公式ページを開いて、項目ごとに確認してください。
      </div>
      <div className="flex gap-2 text-xs" data-testid="gold-sets">
        <a href="?set=lp12" className={`rounded-md border px-2 py-1 ${set === "lp12" ? "bg-foreground text-background" : ""}`} data-testid="gold-set-lp12">
          LivePocket 12ページ（合成R1）
        </a>
        <a href="?set=real" className={`rounded-md border px-2 py-1 ${set === "real" ? "bg-foreground text-background" : ""}`} data-testid="gold-set-real">
          実投稿のリンク先（実投稿R1）
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="gold-progress">
        <span className="font-semibold">確認の進み具合</span>
        {(["confirmed", "excluded", "unreviewed", "needs_recheck"] as ReviewStatus[]).map((s) => (
          <span key={s} className={`rounded-full px-2 py-0.5 ${STATUS_CLASS[s]}`} data-testid={`gold-count-${s}`}>
            {STATUS_LABEL[s]} {progress[s]}
          </span>
        ))}
        <span className="text-muted-foreground">／ {progress.total}ページ</span>
      </div>

      {msg && (
        <div role="status" className={`rounded-md border px-3 py-2 text-sm ${msg.ok ? "" : "border-danger"}`} data-testid="gold-message">
          {msg.text}
          {msg.problems && (
            <ul className="mt-1 list-disc pl-5 text-xs" data-testid="gold-problems">
              {msg.problems.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[18rem_1fr]">
        <div className={`space-y-2 ${page ? "hidden md:block" : ""}`}>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} data-testid="gold-only-open" />
              未確認・要再確認だけ
            </label>
            <Button size="sm" variant="outline" onClick={nextOpen} data-testid="gold-next-open">
              次の未確認へ
            </Button>
          </div>
          <ul className="space-y-1" data-testid="gold-list">
            {groups.map((g) => {
              const items = g.items.filter((p) => !onlyOpen || statusOf(p.n) === "unreviewed" || statusOf(p.n) === "needs_recheck");
              if (items.length === 0) return null;
              const done = g.items.filter((p) => statusOf(p.n) === "confirmed" || statusOf(p.n) === "excluded").length;
              return (
                <li key={g.id || "all"}>
                  {g.label && (
                    <p className="mb-1 mt-2 text-[11px] font-semibold text-muted-foreground" data-testid="gold-group">
                      {g.label} ・確認 {done}/{g.items.length}
                    </p>
                  )}
                  <ul className="space-y-1">
                    {items.map((p) => {
                      const r = recs.find((x) => x.n === p.n)!;
                      return (
                        <li key={p.n}>
                          <button type="button" onClick={() => { setSel(p.n); setMsg(null); }} className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm ${sel === p.n ? "border-foreground" : ""}`} data-testid={`gold-row-${p.n}`} data-status={r.status}>
                            <span className="shrink-0 font-bold">#{p.source ? p.source.order + 1 : p.n}</span>
                            <span className="min-w-0 flex-1 truncate text-xs">{r.confirmed?.draft.store || p.candidate.store || p.title || "（タイトルなし）"}</span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>

        {page && rec && (
          <PageDetail
            key={`${page.n}-${rec.status}`}
            page={page}
            rec={rec}
            siblings={page.source ? pages.filter((p) => p.source!.caseId === page.source!.caseId && p.n !== page.n) : []}
            busy={busy}
            onBack={() => setSel(null)}
            onSave={(d, c) => run(() => saveDraftAction(page.n, d, c, set), "下書きを保存しました", () => patch(page.n, (r) => ({ ...r, draft: d, checks: c })))}
            onConfirm={(d, c, basis) => run(() => confirmAction(page.n, d, c, basis, set), "確認済みにしました", () => reloadTo(nextOpenAfter(page.n)))}
            onExclude={(reason, note) => run(() => excludeAction(page.n, reason, note, set), "除外しました（理由は記録されます）", () => reloadTo(nextOpenAfter(page.n)))}
            onHold={(note) => run(() => holdAction(page.n, note, set), "保留にしました（確認済みにはなりません）", () => reloadTo(nextOpenAfter(page.n)))}
            onReopen={() => run(() => reopenAction(page.n, set), "再確認にしました", () => reloadTo(page.n))}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t pt-3" data-testid="gold-tools">
        <Button size="sm" disabled={busy || (set === "lp12" && !progress.complete) || (set === "real" && progress.confirmed === 0)} onClick={() => run(() => writeGoldAction(set) as never, set === "real" ? "実投稿のgoldを書き出しました（確認が完了した案件だけ）" : "R1用のgoldを書き出しました（r1-build で案件を組み立てられます）")} data-testid="gold-write">
          {set === "real" ? "実投稿のgoldを書き出す" : "R1用のgoldを書き出す"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
          const r = await exportAction(set);
          if (r.ok) {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([r.json], { type: "application/json" }));
            a.download = `gold-review-${set}-export.json`;
            a.click();
          }
          return r as never;
        }, "エクスポートしました")} data-testid="gold-export">
          エクスポート
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="gold-import">
          インポート
        </Button>
        <input ref={fileRef} type="file" accept="application/json" className="hidden" data-testid="gold-import-file" onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          f.text().then((t) => run(() => importAction(t, set) as never, "取り込みました（確認済みはページの本文で再検査されます）", () => window.location.reload()));
          e.target.value = "";
        }} />
        {set === "lp12" && !progress.complete && <p className="w-full text-xs text-muted-foreground" data-testid="gold-incomplete">未確認・要再確認のページが残っている間は、R1用のgoldを書き出せません（有料の試験は実行できません）。</p>}
        {set === "real" && <p className="w-full text-xs text-muted-foreground" data-testid="gold-real-note">実投稿は、投稿の（内容の異なる）全ページが確認済みの投稿だけがgoldの案件になります。除外・保留・未確認が残る投稿は見送りです。</p>}
      </div>
    </div>
  );
}

function PageDetail({ page, rec, siblings, busy, onBack, onSave, onConfirm, onExclude, onHold, onReopen }: { page: ReviewPageView; rec: PageRecord; siblings: ReviewPageView[]; busy: boolean; onBack: () => void; onSave: (d: Draft, c: FieldChecks) => void; onConfirm: (d: Draft, c: FieldChecks, basis: string) => void; onExclude: (reason: string, note: string) => void; onHold: (note: string) => void; onReopen: () => void }) {
  const locked = rec.status === "confirmed" || rec.status === "excluded";
  const shown = rec.confirmed?.draft ?? rec.draft;
  const [d, setD] = useState<Draft>(shown);
  const [c, setC] = useState<FieldChecks>(rec.confirmed?.checks ?? rec.checks ?? emptyChecks());
  const [basis, setBasis] = useState(rec.confirmed?.basis ?? "");
  const [reason, setReason] = useState("multi_slot");
  const [note, setNote] = useState(rec.excluded?.note ?? "");
  const [q, setQ] = useState("");
  const [chunk, setChunk] = useState(0);
  const [showHist, setShowHist] = useState(false);
  const chunks = Math.max(1, Math.ceil(page.text.length / CHUNK));
  const body = page.text.slice(chunk * CHUNK, (chunk + 1) * CHUNK);
  const hay = useMemo(() => nfkc(page.text), [page.text]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const chk = (k: keyof FieldChecks, v: boolean) => setC((x) => ({ ...x, [k]: v }));
  const hits = q ? page.text.split(q).length - 1 : 0;
  const addSelection = () => {
    const s = window.getSelection()?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (s.length >= 6) set("quotes", [...d.quotes.filter(Boolean), s].slice(0, 10));
  };
  const jumpTo = (quote: string | null) => {
    if (!quote) return;
    // 候補の引用は正規化（全角→半角）されているため、先頭の語（日本語）で本文の位置を探す
    const key = quote.slice(0, 4);
    const at = page.text.indexOf(key);
    if (at >= 0) {
      setChunk(Math.floor(at / CHUNK));
      setQ(key);
    }
  };
  const field = "w-full rounded-md border bg-input px-2 py-2 text-sm";
  const ro = locked;
  const cand = page.candidate;
  const src = page.source;
  const shortAt = src ? src.postText.indexOf(src.short) : -1;
  const ctx = src ? src.postText.slice(Math.max(0, shortAt - 140), shortAt + src.short.length + 20) : "";

  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="gold-detail" data-page={page.n} data-status={rec.status}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-md border px-2 py-1 text-xs md:hidden" data-testid="gold-back">
          ← 一覧
        </button>
        <h2 className="text-sm font-bold">ページ #{src ? `${src.order + 1}（投稿 ${src.caseId.slice(2, 6)}）` : page.n}</h2>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_CLASS[rec.status]}`} data-testid="gold-status">
          {STATUS_LABEL[rec.status]}
        </span>
        <a href={page.url} target="_blank" rel="noopener noreferrer" className="ml-auto rounded-md border px-2 py-1 text-xs underline" data-testid="gold-open-official">
          公式ページを開く ↗
        </a>
      </div>
      <p className="break-all text-[11px] text-muted-foreground" data-testid="gold-version">
        {page.title ?? "（タイトルなし）"} ／ 保存した版 {page.hash}・{page.text.length}字・{page.savedAt.slice(0, 16).replace("T", " ")}
        {rec.status === "needs_recheck" && <strong className="ml-1 text-foreground">※要再確認（内容の変化または保留）</strong>}
      </p>

      {src && (
        <div className="space-y-1 rounded-md border p-2 text-xs" data-testid="gold-source">
          <p className="font-semibold">出所（実投稿のリンク先）</p>
          <p className="break-all">投稿: {src.postUrl || "（不明）"}</p>
          <p className="break-all">
            短縮URL {src.short} → 展開先 {page.url}
            {src.finalUrl !== page.url ? ` → 最終 ${src.finalUrl}（リダイレクト${src.hops}回）` : ""}
          </p>
          <p>
            取得 {src.fetchedAt.slice(0, 16).replace("T", " ")}・応答 {src.status}・ホスト {new URL(page.url).hostname}（<strong>公式かどうかは自動では判断していません。ご自身で確認してください</strong>）
          </p>
          {ctx && (
            <p className="rounded bg-muted p-1" data-testid="gold-post-context">
              投稿の該当箇所: …{ctx}
            </p>
          )}
          {src.sameContentAs !== null && <p className="text-foreground">※投稿内の別ページ（#{src.sameContentAs + 1}）と内容が同じです（同一の応募機会を重ねて書いている可能性）</p>}
        </div>
      )}

      <div className="rounded-md bg-muted p-2 text-xs" data-testid="gold-candidate">
        <p className="font-semibold">機械抽出の候補（未確認・正解ではありません）</p>
        <p>店舗: {cand.store ?? "なし"} ／ 商品: {cand.product ?? "なし"}</p>
        <p data-testid="gold-candidate-end">
          締切: {cand.applyEnd ? `${cand.applyEnd.md}（${cand.applyEnd.year ? `${cand.applyEnd.year}年と書かれています` : "年は書かれていません。年は公式ページで確認して入力してください"}）` : "なし"}
        </p>
        {cand.slots.length > 0 && <p>受付枠: {cand.slots.join(" | ")}</p>}
        {cand.attention.length > 0 && <p className="text-foreground">要確認: {cand.attention.join(" ／ ")}</p>}
        {!ro && (
          <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setD((x) => ({ ...x, store: cand.store ?? x.store, product: cand.product ?? x.product, applyEnd: cand.applyEnd?.year ? `${cand.applyEnd.year}-${cand.applyEnd.md.split("/").map((v) => v.padStart(2, "0")).join("-")}` : x.applyEnd, quotes: cand.applyEnd ? [cand.applyEnd.quote] : x.quotes }))} data-testid="gold-copy-candidate">
              候補を入力欄へコピー（確認の代わりにはなりません）
            </Button>
            {cand.applyEnd && (
              <Button size="sm" variant="outline" onClick={() => jumpTo(cand.applyEnd!.quote)} data-testid="gold-jump-candidate">
                候補の位置へ移動
              </Button>
            )}
          </div>
        )}
      </div>

      <div data-testid="gold-text">
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="原文を検索" className="min-h-9 flex-1 rounded-md border bg-input px-2 text-sm" data-testid="gold-search" />
          <span className="text-xs text-muted-foreground">{q ? `${hits}件` : ""}</span>
          <select value={chunk} onChange={(e) => setChunk(Number(e.target.value))} className="min-h-9 rounded-md border bg-input px-1 text-xs" aria-label="原文の位置" data-testid="gold-chunk">
            {Array.from({ length: chunks }, (_, i) => (
              <option key={i} value={i}>
                {i * CHUNK + 1}字目〜
              </option>
            ))}
          </select>
          {!ro && (
            <Button size="sm" variant="outline" onClick={addSelection} data-testid="gold-add-selection">
              選んだ原文を引用へ
            </Button>
          )}
        </div>
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs" data-testid="gold-body">
          {q ? body.split(q).flatMap((part, i, arr) => (i < arr.length - 1 ? [part, <mark key={i}>{q}</mark>] : [part])) : body}
        </pre>
      </div>

      <fieldset disabled={ro || busy} className="space-y-2 disabled:opacity-80">
        <Row label="店舗" ck={c.store} onCk={(v) => chk("store", v)} testid="store">
          <input className={field} value={d.store} onChange={(e) => set("store", e.target.value)} data-testid="gold-store" />
        </Row>
        <Row label="商品" ck={c.product} onCk={(v) => chk("product", v)} testid="product">
          <input className={field} value={d.product} onChange={(e) => set("product", e.target.value)} data-testid="gold-product" />
        </Row>
        <Row label="応募締切（年を含めて確認）" ck={c.applyEnd} onCk={(v) => chk("applyEnd", v)} testid="applyEnd">
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" className={`${field} max-w-44`} value={d.applyEnd ?? ""} onChange={(e) => setD((x) => ({ ...x, applyEnd: e.target.value || null, applyEndUnknown: e.target.value ? false : x.applyEndUnknown }))} data-testid="gold-applyEnd" />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={d.applyEndUnknown} onChange={(e) => setD((x) => ({ ...x, applyEndUnknown: e.target.checked, applyEnd: e.target.checked ? null : x.applyEnd }))} data-testid="gold-applyEnd-unknown" />
              ページに締切が無い／確認できない
            </label>
          </div>
        </Row>
        <Row label="応募単位" ck={c.applyUnit} onCk={(v) => chk("applyUnit", v)} testid="applyUnit">
          <div className="space-y-1">
            <select className={field} value={d.applyUnit ?? ""} onChange={(e) => setD((x) => ({ ...x, applyUnit: (e.target.value || null) as Draft["applyUnit"], applyUnitUnknown: e.target.value ? false : x.applyUnitUnknown }))} data-testid="gold-applyUnit">
              <option value="">（選ぶ）</option>
              {APPLY_UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={d.applyUnitUnknown} onChange={(e) => setD((x) => ({ ...x, applyUnitUnknown: e.target.checked, applyUnit: e.target.checked ? null : x.applyUnit }))} data-testid="gold-applyUnit-unknown" />
              公式ページからは確認できない
            </label>
          </div>
        </Row>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            対象地域（任意）
            <input className={field} value={d.region} onChange={(e) => set("region", e.target.value)} data-testid="gold-region" />
          </label>
          <label className="text-xs">
            開催回・応募枠のメモ（任意）
            <input className={field} value={d.round} onChange={(e) => set("round", e.target.value)} data-testid="gold-round" />
          </label>
        </div>
        {siblings.length > 0 && (
          <label className="block text-xs" data-testid="gold-same-wrap">
            同じ投稿の別ページと<strong>同じ応募機会</strong>を書いている場合（2機会と数えない）
            <select className={field} value={d.sameOpportunityAs ?? ""} onChange={(e) => set("sameOpportunityAs", e.target.value ? Number(e.target.value) : null)} data-testid="gold-same-as">
              <option value="">（別の応募機会）</option>
              {siblings.map((s) => (
                <option key={s.n} value={s.n}>
                  #{s.source!.order + 1} と同じ応募機会
                </option>
              ))}
            </select>
          </label>
        )}
        <Row label="根拠の引用（原文の一字一句）" ck={c.quotes} onCk={(v) => chk("quotes", v)} testid="quotes">
          <div className="space-y-1">
            {(d.quotes.length ? d.quotes : [""]).map((x, i) => {
              const found = x.trim().length >= 6 && hay.includes(nfkc(x.trim()));
              return (
                <div key={i} className="space-y-0.5">
                  <textarea rows={2} className={field} value={x} onChange={(e) => set("quotes", (d.quotes.length ? d.quotes : [""]).map((y, j) => (j === i ? e.target.value : y)))} data-testid={`gold-quote-${i}`} />
                  <p className="text-[11px]" data-testid={`gold-quote-state-${i}`} data-found={found ? "true" : "false"}>
                    {x.trim() ? (found ? "✓ ページの本文にあります" : "✗ ページの本文に見つかりません（6字以上・本文のとおりに）") : ""}
                  </p>
                </div>
              );
            })}
            {!ro && (
              <Button size="sm" variant="outline" onClick={() => set("quotes", [...d.quotes, ""].slice(0, 10))} data-testid="gold-add-quote">
                引用を追加
              </Button>
            )}
          </div>
        </Row>
      </fieldset>

      {!ro && (
        <div className="space-y-2 rounded-md border p-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.officialPageOpened} onChange={(e) => chk("officialPageOpened", e.target.checked)} data-testid="gold-official-opened" />
            公式ページを開いて、上の内容を確認した
          </label>
          <label className="block text-xs">
            確認の基準（何をどう確認したか）
            <textarea rows={2} className={field} value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="例: 公式ページを目視で確認（締切は本文の「応募締切」欄）" data-testid="gold-basis" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onSave(d, c)} data-testid="gold-save">
              下書きを保存
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onConfirm(d, c, basis)} data-testid="gold-confirm">
              確認済みにする
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onHold("公式ページを開けないため保留")} data-testid="gold-hold">
              公式ページを開けない（保留）
            </Button>
          </div>
          <div className="space-y-1 border-t pt-2">
            <p className="text-xs font-semibold">このページを除外する（1ページ=1応募機会に合わない・判断できない）</p>
            <select value={reason} onChange={(e) => setReason(e.target.value)} className={field} data-testid="gold-exclude-reason">
              {EXCLUDE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                  {r.suitableForMultiOpportunity ? "（複数機会の試験の対象にできる）" : ""}
                </option>
              ))}
            </select>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="メモ（その他は理由が必要）" className={field} data-testid="gold-exclude-note" />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onExclude(reason, note)} data-testid="gold-exclude">
              除外する
            </Button>
          </div>
        </div>
      )}

      {(rec.confirmed || rec.excluded) && (
        <div className="space-y-1 text-xs" data-testid="gold-confirmed-info">
          {rec.confirmed && (
            <p>
              確認: {rec.confirmed.verifiedAt.slice(0, 16).replace("T", " ")}・版 {rec.confirmed.pageVersion.hash}・確認者 {rec.confirmed.reviewer}・基準「{rec.confirmed.basis}」
            </p>
          )}
          {rec.excluded && (
            <p>
              除外: {EXCLUDE_REASONS.find((r) => r.value === rec.excluded!.reason)?.label}（{rec.excluded.note || "メモなし"}）
            </p>
          )}
        </div>
      )}
      {(locked || rec.status === "needs_recheck") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onReopen} data-testid="gold-reopen">
          再確認にする
        </Button>
      )}
      <button type="button" className="text-xs underline" onClick={() => setShowHist((v) => !v)} data-testid="gold-history-toggle">
        履歴（{rec.history.length}）
      </button>
      {showHist && (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground" data-testid="gold-history">
          {rec.history.slice().reverse().map((h, i) => (
            <li key={i}>
              {h.at.slice(0, 16).replace("T", " ")} {h.action}
              {h.changed?.length ? `（${h.changed.join("・")}）` : ""} {h.note ?? ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ label, ck, onCk, testid, children }: { label: string; ck: boolean; onCk: (v: boolean) => void; testid: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{label}</span>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={ck} onChange={(e) => onCk(e.target.checked)} data-testid={`gold-check-${testid}`} />
          確認した
        </label>
      </div>
      {children}
    </div>
  );
}
