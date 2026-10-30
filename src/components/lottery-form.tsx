"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ListPlus, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { AiImportDialog } from "@/components/ai-import-dialog";
import { ProductThumb } from "@/components/product-image";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { MasterCombobox } from "@/components/master-combobox";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { EMPTY_FLEX, flexFromParts, flexToInput, lotteryInputSchema, type FlexInput, type LotteryInput } from "@/lib/lottery-input";
import { fingerprint, purgeLegacyDrafts, type FieldSource } from "@/lib/lottery-draft";
import { FlagChip, FlagPanel, type FlagEvidence } from "@/components/review-flag";
import type { DraftDuplicate, LotteryDraft } from "@/lib/lottery-match";
import type { FieldKey } from "@/lib/ai/extraction";
import { flexToJstDate } from "@/lib/finance";
import { FEEDBACK_REASONS, REASON_LABEL, type FeedbackReason } from "@/lib/ai/feedback";
import type { Product, Chain, Store } from "@/types/domain";
import { cn } from "@/lib/utils";
import type { AppData, Lottery } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
/** 初期値のまま（未確認）の入力欄。点線の枠で、利用者が選んだ値と区別する */
const defaultFieldClass = "border-dashed border-primary/60";

const MODE_OPTIONS = [
  { value: "single", label: "A. 単一商品に応募" },
  { value: "all", label: "B. 1回の応募で複数商品に参加（商品ごとに当落）" },
  { value: "one_win", label: "C. 複数商品が対象（当選はいずれか1商品まで）" },
  { value: "choose_one", label: "D. 複数商品から希望の1つを選んで応募" },
] as const;

/** 初期値を持つ項目（応募制限は判定に直結するため初期値を置かない） */
const DEFAULTABLE = ["applyMethod", "receiveMethod"] as const;
type Defaultable = (typeof DEFAULTABLE)[number];

function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className={cn(field, className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 一致が不確実なマスターの候補（近い順）。選ぶと選択済みになる。自動では確定しない */
function CandidateButtons({ label, names, onPick }: { label: string; names: string[]; onPick: (index: number) => void }) {
  if (names.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label={label} data-testid="candidates">
      <span className="text-[11px] text-muted-foreground">候補:</span>
      {names.map((n, i) => (
        <button key={n} type="button" onClick={() => onPick(i)} className="min-h-8 max-w-full truncate rounded-full border bg-input px-2.5 text-xs hover:bg-muted">
          {n}
        </button>
      ))}
    </div>
  );
}

/** 項目名の横に付ける入力元の印（初期値・AI）。利用者が選んだ値には何も付けない */
function SourceTag({ source }: { source?: FieldSource }) {
  if (source === "default") return <span className="ml-1 rounded border border-dashed border-primary/60 px-1 text-[10px] text-primary" data-testid="tag-default">初期値</span>;
  if (source === "ai") return <span className="ml-1 rounded border border-info px-1 text-[10px] text-info" data-testid="tag-ai">AI</span>;
  return null;
}

/**
 * 日付と時刻の入力。空欄=不明 / 日付のみ=日付のみ / 日付+時刻=日時（事前の精度選択は不要）。
 * 時刻は任意で、未入力と 0:00 は区別される。時刻を推測で補わない。
 */
function FlexField({ label, value, onChange, chip }: { label: string; value: FlexInput; onChange: (v: FlexInput) => void; chip?: React.ReactNode }) {
  const timeOnly = value.precision === "unknown" && value.time !== "";
  return (
    <div className="min-w-0 text-sm">
      <span className="flex items-center gap-1 text-[13px] font-medium">
        {label}
        {chip}
      </span>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_4.6rem] gap-1">
        <input
          type="date"
          aria-label={`${label}の日付`}
          value={value.date}
          onChange={(e) => onChange(flexFromParts(e.target.value, value.time))}
          className="min-h-11 min-w-0 rounded-md border bg-input px-1.5 text-[13px]"
        />
        <input
          type="time"
          aria-label={`${label}の時刻`}
          value={value.time}
          onChange={(e) => onChange(flexFromParts(value.date, e.target.value))}
          className="min-h-11 min-w-0 rounded-md border bg-input px-1 text-[13px]"
        />
      </div>
      {timeOnly && <p className="mt-0.5 text-[11px] text-warn">日付も入力してください</p>}
      {value.precision === "date_only" && <p className="mt-0.5 text-[11px] text-muted-foreground">時刻は未設定</p>}
    </div>
  );
}

/** 同系列の直近の抽選から確かな設定を引き継ぐ。なければ標準の初期値（どちらも未確認として扱う） */
export function methodDefaults(data: AppData, chainId: string | null): { applyMethod: "web" | "store" | "app"; receiveMethod: "store" | "shipping" | "either" } {
  const same = chainId
    ? data.lotteries.filter((l) => l.chainId === chainId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  // 以前の抽選でも、初期値のまま保存された項目は引き継がない（未確認の値を連鎖させない）
  const confirmed = (l: Lottery, k: Defaultable) => l[k] !== "unknown" && !(l.unconfirmedFields ?? []).includes(k);
  const apply = same.find((l) => confirmed(l, "applyMethod"))?.applyMethod;
  const receive = same.find((l) => confirmed(l, "receiveMethod"))?.receiveMethod;
  return {
    applyMethod: apply && apply !== "unknown" ? apply : "web",
    receiveMethod: receive && receive !== "unknown" ? receive : "store",
  };
}

function emptyInput(data: AppData): LotteryInput {
  const d = methodDefaults(data, null);
  return {
    chain: { id: null, name: "" },
    store: { id: null, name: "", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "" }, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
    resultDate: EMPTY_FLEX,
    resultEndDate: "",
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: d.receiveMethod,
    applyMethod: d.applyMethod,
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "unknown",
    limitMaxCount: 1,
    memo: "",
    isManaged: true,
    applications: [],
    appliedAt: "",
  };
}

function fromLottery(l: Lottery, data: AppData): LotteryInput {
  const chain = data.chains.find((c) => c.id === l.chainId);
  const store = data.stores.find((s) => s.id === l.storeId);
  return {
    chain: { id: l.chainId, name: chain?.name ?? "" },
    store: { id: l.storeId, name: store?.name ?? "", prefecture: store?.prefecture ?? "" },
    multiMode: l.multiMode,
    campaignId: l.campaignId ?? null,
    newCampaign: null,
    items: l.items.map((i) => ({
      id: i.id ?? null,
      product: { id: i.productId, name: data.products.find((p) => p.id === i.productId)?.officialName ?? "" },
      quantity: i.quantity,
      unit: i.unit,
    })),
    applyStart: flexToInput(l.applyStart),
    applyDeadline: flexToInput(l.applyDeadline),
    resultDate: flexToInput(l.resultDate),
    resultEndDate: l.resultEndDate ?? "",
    procedureStart: flexToInput(l.procedureStart),
    procedureDeadline: flexToInput(l.procedureDeadline),
    receiveMethod: l.receiveMethod,
    applyMethod: l.applyMethod,
    conditionsText: l.conditionsText,
    verificationText: l.verificationText,
    announcementMethod: l.announcementMethod,
    announcementUrl: l.announcementUrl ?? "",
    sourceUrls: l.sourceUrls,
    eventState: l.eventState === "closed" ? "open" : l.eventState,
    limitBasis: l.limit.basis,
    limitMaxCount: l.limit.maxCount,
    memo: l.memo,
    applications: [],
    appliedAt: "",
  };
}

/** 編集時: 初期値のまま保存された項目だけ「初期値」扱い、それ以外は利用者が確認済みの値 */
function sourcesFromLottery(l: Lottery | null): Record<string, FieldSource> {
  const un = l?.unconfirmedFields ?? [];
  return Object.fromEntries(DEFAULTABLE.map((k) => [k, l ? (un.includes(k) ? "default" : "user") : "default"])) as Record<string, FieldSource>;
}

/**
 * 抽選の登録・編集（下から開くパネル）。
 *  - 上部のハンドルを下へスワイプすると最小化し、一覧を見ながら入力を保持できる（下部の再開バーのタップ／上スワイプで再開）。
 *    入力内容は画面内の状態としてだけ保持し、再読み込みで破棄する（長期の下書き保存はしない）。
 *  - 応募期限が過去でも保存でき、新規登録時は応募済み／当選／落選まで同時に登録できる。
 *  - 日時は空欄=不明・日付のみ・日付+時刻。応募方法・受取方法の初期値は「未確認」として区別して保存する。
 *  - 編集中に他の端末で更新された場合は、保存前に気づけるよう警告する。
 */
/** 最小化中の再開バー。タップ・上へのスワイプ・Enter/Space で再開。右端の×で破棄（入力があれば確認） */
function MinimizedBar({
  title,
  summary,
  dirty,
  onResume,
  onDiscard,
  confirming,
  setConfirming,
}: {
  title: string;
  summary: string;
  dirty: boolean;
  onResume: () => void;
  onDiscard: () => void;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
}) {
  const start = useRef<{ y: number; moved: boolean } | null>(null);
  return (
    <div
      data-testid="form-minimized"
      className="fixed inset-x-3 bottom-[calc(3.25rem+env(safe-area-inset-bottom)+0.5rem-var(--vp-gap,0px))] z-40 rounded-xl border border-primary bg-card shadow-[var(--shadow-sheet)] md:left-auto md:right-6 md:w-96"
    >
      {confirming ? (
        <div role="alert" className="flex items-center gap-2 p-2 text-sm">
          <span className="min-w-0 flex-1">入力中の内容を破棄しますか？</span>
          <Button size="sm" variant="danger" onClick={onDiscard} data-testid="form-minimized-discard-ok">
            破棄
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
            続ける
          </Button>
        </div>
      ) : (
        <div className="flex items-center">
          <button
            type="button"
            aria-label={`${title}を再開（タップまたは上へスワイプ）`}
            onClick={() => {
              if (!start.current?.moved) onResume();
            }}
            onPointerDown={(e) => {
              start.current = { y: e.clientY, moved: false };
            }}
            onPointerMove={(e) => {
              if (start.current && start.current.y - e.clientY > 8) start.current.moved = true;
            }}
            onPointerUp={(e) => {
              if (start.current && start.current.y - e.clientY > 30) onResume();
            }}
            className="flex min-h-12 min-w-0 flex-1 touch-pan-x items-center gap-2 px-3 text-left"
          >
            <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted-foreground">{title}（入力途中）</span>
              <span className="block truncate text-sm font-medium">{summary}</span>
            </span>
            <span className="shrink-0 text-xs font-bold text-primary">再開</span>
          </button>
          <button type="button" aria-label="入力を破棄" onClick={() => (dirty ? setConfirming(true) : onDiscard())} className="flex size-11 shrink-0 items-center justify-center text-muted-foreground" data-testid="form-minimized-discard">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export function LotteryFormDialog({
  open,
  onOpenChange,
  lottery,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 編集対象。null なら新規登録 */
  lottery: Lottery | null;
  /** 一括解析の結果など、AIの解析結果をあらかじめ入力して開く（新規登録のみ） */
  prefill?: { draft: LotteryDraft; runId: string | null };
  /** 保存に成功したときに呼ばれる（新規登録なら作成した抽選のID） */
  onSaved?: (lotteryId: string | null) => void;
}) {
  const { data, actions, reload } = useApp();
  const isEdit = lottery !== null;
  // 編集を始めた時点の更新日時。保存の直前に最新と比べ、他の端末で更新されていないか確認する
  const [baseVersion, setBaseVersion] = useState<string | null>(lottery?.updatedAt ?? null);
  const freshRef = useRef<{ data: AppData; lottery: Lottery } | null>(null);

  // 初期状態（リセット・変更有無の基準）。新規は同系列未選択の標準初期値
  const initial = useMemo(() => {
    const input = lottery ? fromLottery(lottery, data) : emptyInput(data);
    return { input, urlsText: (lottery?.sourceUrls ?? []).join("\n"), sources: sourcesFromLottery(lottery) };
    // 開いた時点の内容を基準にする（その後のデータ更新で入力を巻き戻さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [initialFp, setInitialFp] = useState(() => fingerprint({ i: initial.input, u: initial.urlsText }));

  const [v, setV] = useState<LotteryInput>(() => initial.input);
  const [urlsText, setUrlsText] = useState(() => initial.urlsText);
  const [sources, setSources] = useState<Record<string, FieldSource>>(() => initial.sources);
  const [minimized, setMinimized] = useState(false);
  const [pending, setPending] = useState<null | "discard" | "reset" | "bulk">(null);
  const router = useRouter();
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const showPeriod = periodOpen || !!v.resultEndDate;
  const [detailsOpen, setDetailsOpen] = useState(() => initial.input.multiMode !== "single");
  const [flags, setFlags] = useState<Partial<Record<FieldKey, string>>>({});
  const [evidence, setEvidence] = useState<Partial<Record<FieldKey, FlagEvidence>>>({});
  const [generalNotes, setGeneralNotes] = useState<string[]>([]);
  /** 展開中の「要確認」の詳細（一度に1項目） */
  const [openFlag, setOpenFlag] = useState<FieldKey | null>(null);
  const [modePending, setModePending] = useState(false);
  const [duplicates, setDuplicates] = useState<DraftDuplicate[]>([]);
  const [dupAck, setDupAck] = useState(false);
  const [aiFilled, setAiFilled] = useState(false);
  const [discardOnBar, setDiscardOnBar] = useState(false);
  // AI読み取りから入力したときの、解析の実行IDとフォームに入力した直後の値（登録時にAIの抽出結果との比較を1回だけ記録する）
  const [aiRun, setAiRun] = useState<{ runId: string; filled: LotteryInput } | null>(null);
  const [reason, setReason] = useState<FeedbackReason | "">("");
  const [candidates, setCandidates] = useState<{ chain: Chain[]; store: Store[]; items: Product[][] }>({ chain: [], store: [], items: [] });
  const modeRef = useRef<HTMLSelectElement>(null);

  const dirty = fingerprint({ i: v, u: urlsText }) !== initialFp;

  // 以前の版が端末に残した長期の下書きは不要になったので、一度だけ消す
  useEffect(() => {
    purgeLegacyDrafts();
  }, []);

  const finish = () => onOpenChange(false);

  const applyDraft = (d: LotteryDraft, runId: string | null = null) => {
    const next = { ...d.input };
    const src: Record<string, FieldSource> = { ...sources };
    // AIが読み取れた方法は「AI」、読み取れなかった項目は標準の初期値（未確認）にする
    const defs = methodDefaults(data, next.chain.id);
    for (const k of DEFAULTABLE) {
      if (next[k] && next[k] !== "unknown") src[k] = "ai";
      else {
        (next as Record<string, unknown>)[k] = defs[k];
        src[k] = "default";
      }
    }
    setV(next);
    setUrlsText(d.input.sourceUrls.join("\n"));
    setSources(src);
    setFlags(d.flags);
    setEvidence(d.evidence);
    setGeneralNotes(d.generalNotes);
    setOpenFlag(null);
    setModePending(d.modePending);
    setDetailsOpen(d.modePending || next.multiMode !== "single");
    setDuplicates(d.duplicates);
    setDupAck(false);
    setAiFilled(true);
    setCandidates(d.candidates);
    // 初期値（未確認の仮設定）は「AIが入力した値」ではないので、比較用の値からは外す
    setAiRun(runId ? { runId, filled: { ...next, applyMethod: src.applyMethod === "default" ? "unknown" : next.applyMethod, receiveMethod: src.receiveMethod === "default" ? "unknown" : next.receiveMethod } } : null);
    setReason("");
    setError(null);
  };

  // 解析結果つきで開いたときは、最初に一度だけ入力する
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefill && !prefilled.current && !isEdit) {
      prefilled.current = true;
      applyDraft(prefill.draft, prefill.runId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof LotteryInput>(k: K, val: LotteryInput[K]) => setV((s) => ({ ...s, [k]: val }));
  /** 初期値を持つ項目を利用者が選んだ: 以降は「利用者が選んだ値」として扱う */
  const setMethod = (k: Defaultable, val: LotteryInput[Defaultable]) => {
    setV((s) => ({ ...s, [k]: val }));
    setSources((s) => ({ ...s, [k]: "user" }));
  };

  const chainOptions = useMemo(
    () => data.chains.filter((c) => c.id === lottery?.chainId || !c.archived).map((c) => ({ id: c.id, name: c.name, hint: c.provisional ? "仮登録" : undefined })),
    [data.chains, lottery?.chainId],
  );
  const storeOptions = useMemo(
    () =>
      data.stores
        .filter((s) => s.chainId === v.chain.id && (!s.archived || s.id === v.store.id))
        .map((s) => ({ id: s.id, name: s.name, hint: s.prefecture || undefined })),
    [data.stores, v.chain.id, v.store.id],
  );
  const productOptions = useMemo(
    () => data.products.filter((p) => !p.archived || v.items.some((i) => i.product.id === p.id)).map((p) => ({ id: p.id, name: p.officialName, hint: p.provisional ? "仮登録" : p.code || undefined, thumb: <ProductThumb product={p} heightClass="h-9" /> })),
    [data.products, v.items],
  );
  const campaigns = data.campaigns.filter((c) => c.chainId === v.chain.id);
  const profiles = data.profiles.filter((p) => p.active !== false);
  const multi = v.multiMode !== "single";
  const appStatus = (profileId: string) => v.applications?.find((a) => a.profileId === profileId)?.status ?? "none";
  const setAppStatus = (profileId: string, status: string) =>
    set("applications", [...(v.applications ?? []).filter((a) => a.profileId !== profileId), ...(status === "none" ? [] : [{ profileId, status: status as "applied" | "won" | "lost" }])]);
  const setMode = (mode: NonNullable<LotteryInput["multiMode"]>) => {
    setModePending(false);
    setV((s) => {
      const items = mode === "single" ? s.items.slice(0, 1) : s.items.length < 2 ? [...s.items, { product: { id: null, name: "" }, quantity: 1, unit: "box" as const }] : s.items;
      // 方式を変えると商品別の当落の意味が変わるため、同時登録する応募状況はリセットする
      return { ...s, multiMode: mode, items, applications: [] };
    });
  };
  const chooseChain = (chain: LotteryInput["chain"]) => {
    const same = chain.id === v.chain.id;
    setV((s) => {
      const next = {
        ...s,
        chain,
        store: same ? s.store : { id: null, name: "", prefecture: "" },
        campaignId: same ? s.campaignId : null,
        newCampaign: same ? s.newCampaign : null,
      };
      // 新規登録で、まだ選んでいない初期値は同系列の確かな設定に差し替える
      if (!isEdit && !same) {
        const defs = methodDefaults(data, chain.id);
        for (const k of DEFAULTABLE) if (sources[k] === "default") (next as Record<string, unknown>)[k] = defs[k];
      }
      return next;
    });
  };

  const buildInput = (): LotteryInput => ({
    ...v,
    sourceUrls: urlsText.split("\n").map((s) => s.trim()).filter(Boolean),
    applications: isEdit ? [] : v.applications,
    // 初期値のまま（利用者が選んでいない）の項目は「未確認」として記録する
    unconfirmedFields: DEFAULTABLE.filter((k) => sources[k] === "default"),
    // 新規登録のAI読み取り結果のときだけ、修正の記録に使う情報を送る（登録後の編集では送らない）
    aiFeedback: !isEdit && aiRun ? { runId: aiRun.runId, filled: aiRun.filled as unknown as Record<string, unknown>, reason: reason || null } : undefined,
  });

  const submit = async (e: React.FormEvent, overwrite = false) => {
    e.preventDefault();
    setError(null);
    if (modePending) {
      setError("複数商品の応募方式を選択してください（告知から判断できませんでした）");
      setDetailsOpen(true);
      return;
    }
    if (duplicates.some((d) => d.level === "high") && !dupAck) {
      setError("同じ抽選が登録済みの可能性があります。内容を確認し、「重複ではないことを確認した」にチェックしてください");
      return;
    }
    const input = buildInput();
    const parsed = lotteryInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
      return;
    }
    setSaving(true);
    // 編集: 開いてから他の端末で更新されていないか、保存の直前に最新の状態で確認する
    if (lottery && !overwrite && baseVersion) {
      const fresh = await reload();
      const cur = fresh?.lotteries.find((l) => l.id === lottery.id);
      if (fresh && cur && cur.updatedAt && cur.updatedAt !== baseVersion) {
        freshRef.current = { data: fresh, lottery: cur };
        setSaving(false);
        setConflict(true);
        setError("この抽選は、編集を始めたあとに別の端末などで更新されました。");
        return;
      }
    }
    const res = await actions.saveLottery(lottery?.id ?? null, input);
    setSaving(false);
    if (res.ok) {
      onSaved?.(res.createdIds?.[0] ?? null);
      finish();
    }
    else setError(res.error);
  };

  /** 他の端末での更新を取り込む: 最新の内容で入力し直し、比較の基準も最新にする（自分の入力は破棄される） */
  const loadLatest = () => {
    const f = freshRef.current;
    if (!f) return;
    const input = fromLottery(f.lottery, f.data);
    const urls = f.lottery.sourceUrls.join("\n");
    setV(input);
    setUrlsText(urls);
    setSources(sourcesFromLottery(f.lottery));
    setBaseVersion(f.lottery.updatedAt ?? null);
    setInitialFp(fingerprint({ i: input, u: urls }));
    setConflict(false);
    setError(null);
  };

  const reset = () => {
    setV(initial.input);
    setUrlsText(initial.urlsText);
    setSources(initial.sources);
    setFlags({});
    setModePending(false);
    setDuplicates([]);
    setDupAck(false);
    setAiFilled(false);
    setAiRun(null);
    setReason("");
    setCandidates({ chain: [], store: [], items: [] });
    setConflict(false);
    setError(null);
    setPending(null);
    setEvidence({});
    setGeneralNotes([]);
    setOpenFlag(null);
  };

  /** 項目名の横の「要確認」の印と、その下に出す詳細 */
  const flagChip = (k: FieldKey, label: string) => <FlagChip text={flags[k]} open={openFlag === k} onToggle={() => setOpenFlag(openFlag === k ? null : k)} panelId={`flag-${k}`} label={label} />;
  const flagPanel = (k: FieldKey) => <FlagPanel id={`flag-${k}`} text={flags[k]} evidence={evidence[k]} open={openFlag === k} />;
  const flagCount = Object.values(flags).filter(Boolean).length;
  const title = isEdit ? "抽選を編集" : "抽選を登録";
  const summary = [v.chain.name, v.store.name].filter(Boolean).join(" ") || "（系列・店舗 未入力）";

  return (
    <>
      <Sheet open={open && !minimized} onOpenChange={(o) => !o && setMinimized(true)}>
        <SheetContent aria-describedby="lottery-form-desc" data-testid="lottery-form" onOpenAutoFocus={(e) => e.preventDefault()} onSwipeDismiss={() => setMinimized(true)}>
          <div className="flex items-center gap-1 px-4 pb-2">
            <div className="min-w-0 flex-1">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription id="lottery-form-desc" className="sr-only">
                {title}
              </SheetDescription>
            </div>
            <button type="button" onClick={() => setPending("reset")} aria-label="入力をリセット" className="flex size-10 items-center justify-center rounded-md hover:bg-muted">
              <RotateCcw className="size-[18px]" aria-hidden="true" />
            </button>
          </div>

          {pending && (
            <div role="alert" className="mx-4 mb-2 space-y-2 rounded-md border border-warn p-2 text-sm" data-testid="form-confirm">
              {pending === "discard" ? (
                <>
                  <p>入力中の内容を破棄して閉じます。よろしいですか？</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="danger" onClick={finish}>
                      破棄して閉じる
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setPending(null)}>
                      入力を続ける
                    </Button>
                  </div>
                </>
              ) : pending === "bulk" ? (
                <>
                  <p>入力中の内容は破棄されます。まとめて登録へ移動しますか？</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" onClick={() => router.push("/lotteries/bulk")} data-testid="bulk-go">
                      移動する
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setPending(null)}>
                      入力を続ける
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p>入力した内容をすべて消して、最初の状態に戻します。よろしいですか？</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" onClick={reset}>
                      リセットする
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setPending(null)}>
                      やめる
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
            <SheetBody className="space-y-3 border-t pt-3">
              {!isEdit && (
                <div className="space-y-1">
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={() => (dirty ? setPending("bulk") : router.push("/lotteries/bulk"))} data-testid="bulk-open">
                      <ListPlus className="size-4 text-primary" aria-hidden="true" /> まとめて登録
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={() => setAiOpen(true)} data-testid="ai-open">
                      <Sparkles className="size-4 text-primary" aria-hidden="true" /> AIで読み取る
                    </Button>
                  </div>
                  {aiFilled && (
                    <p className="text-[11px] text-muted-foreground" data-testid="ai-filled-note">
                      AIの読み取り結果を入力しました{flagCount > 0 ? `（要確認 ${flagCount}件）` : ""}。保存前に確認してください。
                    </p>
                  )}
                </div>
              )}
              {duplicates.length > 0 && (
                <div role="alert" className="space-y-1 rounded-md border border-warn p-2 text-sm" data-testid="dup-warning">
                  <p className="flex gap-1 font-medium text-warn">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> 登録済みの抽選と重複している可能性があります
                  </p>
                  <ul className="list-disc space-y-0.5 pl-5 text-xs">
                    {duplicates.map((d) => {
                      const l = data.lotteries.find((x) => x.id === d.lotteryId);
                      return (
                        <li key={d.lotteryId}>
                          {l ? `${data.stores.find((s) => s.id === l.storeId)?.name ?? ""} / ${l.items.map((i) => data.products.find((p) => p.id === i.productId)?.officialName ?? "").join("・")} / 締切 ${flexToJstDate(l.applyDeadline) ?? "不明"}` : ""}
                          — {d.reason}
                        </li>
                      );
                    })}
                  </ul>
                  {duplicates.some((d) => d.level === "high") && (
                    <label className="flex min-h-10 items-center gap-2 text-sm">
                      <input type="checkbox" checked={dupAck} onChange={(e) => setDupAck(e.target.checked)} className="size-4" />
                      重複ではないことを確認した
                    </label>
                  )}
                </div>
              )}

              {/* 1. 系列・店舗 */}
              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0 text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    系列
                    {flagChip("chain", "系列")}
                  </span>
                  <MasterCombobox label="系列" value={v.chain} disabled={isEdit} options={chainOptions} onChange={chooseChain} />
                </div>
                <div className="min-w-0 text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    店舗
                    {flagChip("store", "店舗")}
                  </span>
                  <MasterCombobox label="店舗" value={v.store} options={storeOptions} onChange={(store) => set("store", { ...store, prefecture: store.id ? "" : (v.store.prefecture ?? "") })} />
                </div>
              </div>
              {(openFlag === "chain" || openFlag === "store" || (!v.chain.id && candidates.chain.length > 0) || (!v.store.id && candidates.store.length > 0)) && (
                <div>
                  {flagPanel("chain")}
                  {!v.chain.id && (
                    <CandidateButtons label="系列の候補" names={candidates.chain.map((c) => c.name)} onPick={(i) => chooseChain({ id: candidates.chain[i].id, name: candidates.chain[i].name })} />
                  )}
                  {flagPanel("store")}
                  {!v.store.id && (
                    <CandidateButtons label="店舗の候補" names={candidates.store.map((c) => c.name)} onPick={(i) => set("store", { id: candidates.store[i].id, name: candidates.store[i].name, prefecture: "" })} />
                  )}
                </div>
              )}

              {/* 2. 対象商品・数量 */}
              <fieldset className="space-y-1.5">
                <legend className="flex items-center gap-1 text-[13px] font-medium">
                  対象商品・数量{multi && "（2商品以上）"}
                  {flagChip("items", "商品")}
                </legend>
                {v.items.map((it, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_3.4rem_4.6rem_auto] items-start gap-1" data-testid="item-row">
                    <MasterCombobox
                      label={`商品${i + 1}`}
                      value={it.product}
                      options={productOptions}
                      className="min-w-0"
                      onChange={(product) => set("items", v.items.map((x, j) => (j === i ? { ...x, product } : x)))}
                    />
                    <input
                      type="number"
                      min={1}
                      aria-label={`数量${i + 1}`}
                      value={it.quantity}
                      onChange={(e) => set("items", v.items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))}
                      className="mt-0 h-11 min-w-0 rounded-md border bg-input px-1 text-center text-sm"
                    />
                    <Select
                      label={`単位${i + 1}`}
                      value={it.unit}
                      onChange={(unit) => set("items", v.items.map((x, j) => (j === i ? { ...x, unit } : x)))}
                      className="mt-0 h-11 px-1"
                      options={[
                        { value: "box", label: "BOX" },
                        { value: "pack", label: "パック" },
                        { value: "set", label: "セット" },
                      ]}
                    />
                    {multi && v.items.length > 2 ? (
                      <Button type="button" variant="ghost" size="icon" className="mt-0 size-11" aria-label={`商品${i + 1}を削除`} onClick={() => set("items", v.items.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    ) : (
                      <span className="w-0" />
                    )}
                  </div>
                ))}
                {flagPanel("items")}
                {v.items.map((it, i) =>
                  !it.product.id && candidates.items[i]?.length ? (
                    <CandidateButtons
                      key={`cand-${i}`}
                      label={`商品${i + 1}の候補`}
                      names={candidates.items[i].map((p) => p.officialName)}
                      onPick={(k) => set("items", v.items.map((x, j) => (j === i ? { ...x, product: { id: candidates.items[i][k].id, name: candidates.items[i][k].officialName } } : x)))}
                    />
                  ) : null,
                )}
                {multi ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => set("items", [...v.items, { product: { id: null, name: "" }, quantity: 1, unit: "box" }])}>
                    <Plus className="size-4" /> 商品を追加
                  </Button>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-info underline"
                    onClick={() => {
                      setDetailsOpen(true);
                      requestAnimationFrame(() => modeRef.current?.focus());
                    }}
                  >
                    複数商品の抽選にする（詳細設定で方式を選択）
                  </button>
                )}
              </fieldset>

              {/* 3-4. 日時（2カラム） */}
              <div className="grid grid-cols-2 gap-x-2 gap-y-2">
                <div>
                  <FlexField label="応募開始" value={v.applyStart} onChange={(x) => set("applyStart", x)} chip={flagChip("applyStart", "応募開始")} />
                  {flagPanel("applyStart")}
                </div>
                <div>
                  <FlexField label="応募締切" value={v.applyDeadline} onChange={(x) => set("applyDeadline", x)} chip={flagChip("applyDeadline", "応募締切")} />
                  {flagPanel("applyDeadline")}
                </div>
                <div>
                  <FlexField label="当選発表" value={v.resultDate} onChange={(x) => set("resultDate", x)} chip={flagChip("resultDate", "当選発表")} />
                  {flagPanel("resultDate")}
                  <label className="mt-1 flex min-h-7 items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={showPeriod}
                      onChange={(e) => {
                        setPeriodOpen(e.target.checked);
                        if (!e.target.checked) set("resultEndDate", "");
                      }}
                    />
                    期間で指定
                  </label>
                </div>
                {showPeriod ? (
                  <div className="min-w-0 text-sm">
                    <span className="flex items-center gap-1 text-[13px] font-medium">当選発表の終了日</span>
                    <input
                      type="date"
                      aria-label="当選発表の終了日"
                      value={v.resultEndDate ?? ""}
                      min={v.resultDate.date || undefined}
                      onChange={(e) => set("resultEndDate", e.target.value)}
                      className="mt-1 min-h-11 w-full min-w-0 rounded-md border bg-input px-1.5 text-[13px]"
                    />
                    {v.resultDate.precision === "unknown" && <p className="mt-0.5 text-[11px] text-warn">開始日も入力してください</p>}
                  </div>
                ) : (
                  <span aria-hidden="true" />
                )}
                <div>
                  <FlexField label="購入・受取開始" value={v.procedureStart ?? EMPTY_FLEX} onChange={(x) => set("procedureStart", x)} chip={flagChip("procedureStart", "購入・受取開始")} />
                  {flagPanel("procedureStart")}
                </div>
                <div>
                  <FlexField label="購入・受取終了" value={v.procedureDeadline} onChange={(x) => set("procedureDeadline", x)} chip={flagChip("procedureDeadline", "購入・受取終了")} />
                  {flagPanel("procedureDeadline")}
                </div>
              </div>

              {/* 5. 応募方法・受取方法（初期値は未確認の仮設定） */}
              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0 text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    応募方法
                    <SourceTag source={sources.applyMethod} />
                    {flagChip("applyMethod", "応募方法")}
                  </span>
                  <Select
                    label="応募方法"
                    value={v.applyMethod}
                    onChange={(x) => setMethod("applyMethod", x)}
                    className={sources.applyMethod === "default" ? defaultFieldClass : undefined}
                    options={[
                      { value: "unknown", label: "未確認" },
                      { value: "web", label: "Web" },
                      { value: "store", label: "店頭" },
                      { value: "app", label: "アプリ" },
                    ]}
                  />
                </div>
                <div className="min-w-0 text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    受取方法
                    <SourceTag source={sources.receiveMethod} />
                    {flagChip("receiveMethod", "受取方法")}
                  </span>
                  <Select
                    label="受取方法"
                    value={v.receiveMethod}
                    onChange={(x) => setMethod("receiveMethod", x)}
                    className={sources.receiveMethod === "default" ? defaultFieldClass : undefined}
                    options={[
                      { value: "unknown", label: "未確認" },
                      { value: "store", label: "店頭" },
                      { value: "shipping", label: "発送" },
                      { value: "either", label: "店頭/発送" },
                    ]}
                  />
                </div>
              </div>
              {(sources.applyMethod === "default" || sources.receiveMethod === "default") && (
                <p className="text-[11px] text-muted-foreground">点線の欄は初期値（未確認）です。内容を確認して選び直すと確認済みになります。</p>
              )}
              {(openFlag === "applyMethod" || openFlag === "receiveMethod") && (
                <div>
                  {flagPanel("applyMethod")}
                  {flagPanel("receiveMethod")}
                </div>
              )}

              {/* 6. URL */}
              <div className="grid grid-cols-2 gap-2">
                <label className="min-w-0 text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    発表方法
                    {flagChip("announcement", "発表方法")}
                  </span>
                  <input value={v.announcementMethod} onChange={(e) => set("announcementMethod", e.target.value)} className={field} placeholder="メール等" />
                </label>
                <label className="min-w-0 text-sm">
                  <span className="text-[13px] font-medium">発表URL</span>
                  <input value={v.announcementUrl} onChange={(e) => set("announcementUrl", e.target.value)} className={field} inputMode="url" placeholder="https://" />
                </label>
              </div>
              {flagPanel("announcement")}
              <label className="block text-sm">
                <span className="text-[13px] font-medium">情報源URL（1行に1つ）</span>
                <textarea value={urlsText} onChange={(e) => setUrlsText(e.target.value)} rows={1} className={cn(field, "py-2")} />
              </label>

              {/* 7. 応募条件・制限 */}
              <label className="block text-sm">
                <span className="flex items-center gap-1 text-[13px] font-medium">
                  応募条件
                  {flagChip("conditions", "応募条件")}
                </span>
                <textarea value={v.conditionsText} onChange={(e) => set("conditionsText", e.target.value)} rows={2} className={cn(field, "py-2")} />
              </label>
              {flagPanel("conditions")}
              <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
                <label className="min-w-0 text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    応募制限
                    {flagChip("limit", "応募制限")}
                  </span>
                  <Select
                    label="応募制限"
                    value={v.limitBasis}
                    onChange={(x) => set("limitBasis", x)}
                    options={[
                      { value: "unknown", label: "未確認（要確認）" },
                      { value: "account", label: "1アカウントにつき" },
                      { value: "person", label: "1人につき" },
                      { value: "family", label: "1家族につき" },
                      { value: "address", label: "1住所につき" },
                    ]}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-[13px] font-medium">上限回数</span>
                  <input type="number" min={1} max={99} value={v.limitMaxCount} onChange={(e) => set("limitMaxCount", Number(e.target.value))} className={cn(field, "text-center")} />
                </label>
              </div>
              {flagPanel("limit")}

              {/* 8-9. 詳細設定（抽選方式・キャンペーン・状態・本人確認・メモ） */}
              <details open={detailsOpen} onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-lg border" data-testid="form-details">
                <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
                  詳細設定（抽選方式・キャンペーン・備考など）
                  {(multi || modePending || v.newCampaign || v.campaignId) && <span className="ml-2 text-xs text-primary">設定あり</span>}
                </summary>
                <div className="space-y-3 border-t p-3">
                  <div className="text-sm">
                    <label className="block">
                      <span className="flex items-center gap-1 text-[13px] font-medium">
                        抽選の方式
                        {flagChip("multiMode", "抽選の方式")}
                      </span>
                      <select
                        ref={modeRef}
                        aria-label="抽選の方式"
                        value={modePending ? "" : (v.multiMode ?? "single")}
                        onChange={(e) => setMode(e.target.value as NonNullable<LotteryInput["multiMode"]>)}
                        className={field}
                      >
                        {modePending && <option value="">未確認（方式を選んでください）</option>}
                        {MODE_OPTIONS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {flagPanel("multiMode")}
                    <p className="mt-0.5 text-xs text-muted-foreground">商品ごとに独立して応募する告知（方式E）は、商品ごとに別の抽選として登録してください。</p>
                  </div>
                  <label className="block text-sm">
                    <span className="text-[13px] font-medium">同時開催キャンペーン（任意）</span>
                    <select
                      aria-label="同時開催キャンペーン"
                      value={v.newCampaign ? "__new" : (v.campaignId ?? "")}
                      onChange={(e) =>
                        e.target.value === "__new"
                          ? setV((s) => ({ ...s, campaignId: null, newCampaign: { name: "", storeRule: "multi" } }))
                          : setV((s) => ({ ...s, campaignId: e.target.value || null, newCampaign: null }))
                      }
                      className={field}
                    >
                      <option value="">なし</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}（{c.storeRule === "one_store" ? "1店舗まで" : "複数店舗可"}）
                        </option>
                      ))}
                      <option value="__new">＋ 新しいキャンペーン</option>
                    </select>
                  </label>
                  {v.newCampaign && (
                    <div className="grid grid-cols-2 gap-2">
                      <input aria-label="新しいキャンペーン名" placeholder="キャンペーン名" value={v.newCampaign.name} onChange={(e) => set("newCampaign", { ...v.newCampaign!, name: e.target.value })} className={field} />
                      <Select
                        label="店舗の応募ルール"
                        value={v.newCampaign.storeRule}
                        onChange={(storeRule) => set("newCampaign", { ...v.newCampaign!, storeRule })}
                        options={[
                          { value: "multi", label: "複数店舗に応募可" },
                          { value: "one_store", label: "1店舗まで" },
                        ]}
                      />
                    </div>
                  )}
                  <label className="block text-sm">
                    <span className="text-[13px] font-medium">抽選の状態</span>
                    <Select
                      label="抽選の状態"
                      value={v.eventState}
                      onChange={(x) => set("eventState", x)}
                      options={[
                        { value: "open", label: "通常（期限で自動的に受付終了）" },
                        { value: "before", label: "受付前" },
                        { value: "postponed", label: "発表延期" },
                        { value: "cancelled", label: "中止" },
                      ]}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-[13px] font-medium">本人確認・必要書類（書類の画像・番号は入力しない）</span>
                    <input value={v.verificationText} onChange={(e) => set("verificationText", e.target.value)} className={field} />
                  </label>
                  <label className="block text-sm">
                    <span className="text-[13px] font-medium">メモ</span>
                    <textarea value={v.memo} onChange={(e) => set("memo", e.target.value)} rows={2} className={cn(field, "py-2")} />
                  </label>
                </div>
              </details>

              {!isEdit && (
                <fieldset className="space-y-2 rounded-lg border p-3">
                  <legend className="px-1 text-[13px] font-medium">応募状況（過去の抽選はここで登録）</legend>
                  <label className="flex min-h-9 items-center gap-2 text-sm">
                    <input type="checkbox" checked={v.isManaged ?? true} onChange={(e) => set("isManaged", e.target.checked)} className="size-4" />
                    管理対象（★）にする
                  </label>
                  {multi && v.multiMode !== "choose_one" && <p className="text-xs text-muted-foreground">複数商品の当落は、登録後に商品ごとに入力します。</p>}
                  {v.multiMode === "choose_one" ? (
                    <p className="text-xs text-muted-foreground">希望商品を選んで応募する方式では、登録後にカード上でユーザーごとに希望商品を選択して応募を記録します。</p>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {profiles.map((p) => (
                        <label key={p.id} className="min-w-0 text-xs">
                          <span className="block truncate">{p.label}</span>
                          <select aria-label={`${p.label}の応募状況`} value={appStatus(p.id)} onChange={(e) => setAppStatus(p.id, e.target.value)} className="mt-0.5 min-h-10 w-full rounded-md border bg-input px-1 text-sm">
                            <option value="none">未応募</option>
                            <option value="applied">応募済み</option>
                            {!multi && <option value="won">当選</option>}
                            {!multi && <option value="lost">落選</option>}
                          </select>
                        </label>
                      ))}
                    </div>
                  )}
                  {(v.applications?.length ?? 0) > 0 && (
                    <label className="block text-sm">
                      <span className="text-xs">実際に応募した日時（任意・不明なら空欄）</span>
                      <input type="datetime-local" value={v.appliedAt} onChange={(e) => set("appliedAt", e.target.value)} className={field} />
                    </label>
                  )}
                </fieldset>
              )}

              {generalNotes.length > 0 && (
                <details className="rounded-lg border text-xs" data-testid="ai-general-notes">
                  <summary className="flex min-h-10 cursor-pointer items-center px-3">AIの読み取りについての補足（{generalNotes.length}件）</summary>
                  <ul className="list-disc space-y-0.5 border-t p-3 pl-7">
                    {generalNotes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </details>
              )}
              {aiRun && !isEdit && (
                <details className="rounded-lg border" data-testid="ai-reason">
                  <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm">AI読み取りの修正理由（任意）</summary>
                  <div className="space-y-1 border-t p-3 text-sm">
                    <select aria-label="AI読み取りの修正理由" value={reason} onChange={(e) => setReason(e.target.value as FeedbackReason | "")} className={field}>
                      <option value="">指定しない</option>
                      {FEEDBACK_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {REASON_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">AIの結果を修正して保存したときだけ、理由として記録します。選ばなくても保存できます。</p>
                  </div>
                </details>
              )}
              {error && (
                <div role="alert" className="space-y-2 text-sm text-danger">
                  <p>{error}</p>
                  {conflict && (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={loadLatest}>
                        最新の内容で入力し直す
                      </Button>
                      <Button type="button" size="sm" variant="danger" onClick={(e) => submit(e as unknown as React.FormEvent, true)}>
                        このまま上書き保存
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </SheetBody>
            <div className="flex items-center justify-end gap-2 border-t bg-card px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
              <Button type="button" variant="outline" className="mr-auto" onClick={() => (dirty ? setPending("discard") : finish())} data-testid="form-discard">
                破棄
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </form>
        </SheetContent>
        {aiOpen && <AiImportDialog open onOpenChange={setAiOpen} onApply={applyDraft} />}
      </Sheet>

      {/* 最小化中: 抽選一覧を見ながら、タップまたは上へのスワイプで入力を再開できる */}
      {open && minimized && (
        <MinimizedBar title={title} summary={summary} dirty={dirty} onResume={() => setMinimized(false)} onDiscard={finish} confirming={discardOnBar} setConfirming={setDiscardOnBar} />
      )}
    </>
  );
}
