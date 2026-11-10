"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ListPlus, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { AiImportDialog } from "@/components/ai-import-dialog";
import { AiSupplementDialog } from "@/components/ai-supplement-dialog";
import { ProductThumb } from "@/components/product-image";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { CountInput } from "@/components/count-input";
import { unitForProduct, unitOptions } from "@/lib/product-kind";
import { ClearableDateInput, DateClearButton } from "@/components/ui/clearable-date";
import { MasterCombobox, NewMasterBadge } from "@/components/master-combobox";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { EMPTY_FLEX, flexFromParts, flexToInput, lotteryInputSchema, type FlexInput, type LotteryInput } from "@/lib/lottery-input";
import { fingerprint, purgeLegacyDrafts, type FieldSource } from "@/lib/lottery-draft";
import { clearResume, loadResume, mergeResume, resumeKeyLabel, saveResume, type ResumeStash } from "@/lib/lottery-resume";
import { FlagChip, FlagPanel, type FlagEvidence } from "@/components/review-flag";
import { findDuplicates, type DraftDuplicate, type LotteryDraft } from "@/lib/lottery-match";
import { loadCollectionAreaAction, saveLotteryBulkAction } from "@/app/(app)/lotteries/actions";
import type { FieldKey } from "@/lib/ai/extraction";
import { flexToJstDate } from "@/lib/finance";
import { FEEDBACK_REASONS, REASON_LABEL, type FeedbackReason } from "@/lib/ai/feedback";
import type { Product, Chain, Store } from "@/types/domain";
import { AnnouncePicker, RequirementPicker } from "@/components/taxonomy-picker";
import { classifyAnnouncement, classifyRequirements, foldAnnounceNote, type AnnounceMethod, type RequirementDetails, type RequirementTag } from "@/lib/lottery-taxonomy";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import type { AppData, Lottery } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
/** 画面の1回の操作ごとの操作ID（二重登録の防止に使う） */
function newOpId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`;
}
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
  if (source === "default") return <span className="ml-1 rounded border border-dashed border-primary/60 px-1 text-[10px] text-primary-ink" data-testid="tag-default">初期値</span>;
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
        {(value.date !== "" || value.time !== "") && <DateClearButton label={label} onClear={() => onChange(EMPTY_FLEX)} className="ml-auto" />}
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
    procedureSplit: false,
    receiveStart: EMPTY_FLEX,
    receiveDeadline: EMPTY_FLEX,
    lotteryKind: "normal",
    validUntil: "",
    receiveMethod: d.receiveMethod,
    applyMethod: d.applyMethod,
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementMethods: [],
    announcementTarget: "unknown",
    announcementInferred: false,
    requirementTags: [],
    requirementLogic: "and",
    requirementDetails: {},
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
    storeMode: l.storeMode ?? "fixed",
    selectableStores: l.selectableStores ?? [],
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
    procedureSplit: l.procedureSplit ?? false,
    receiveStart: flexToInput(l.receiveStart ?? { precision: "unknown" }),
    receiveDeadline: flexToInput(l.receiveDeadline ?? { precision: "unknown" }),
    lotteryKind: l.kind ?? "normal",
    validUntil: l.validUntil ?? "",
    receiveMethod: l.receiveMethod,
    applyMethod: l.applyMethod,
    conditionsText: l.conditionsText,
    verificationText: l.verificationText,
    announcementMethod: l.announcementMethod,
    announcementMethods: l.announcementMethods ?? [],
    announcementTarget: l.announcementTarget ?? "unknown",
    announcementInferred: l.announcementInferred ?? false,
    requirementTags: l.requirementTags ?? [],
    requirementLogic: l.requirementLogic ?? "and",
    requirementDetails: l.requirementDetails ?? {},
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
 *  - 入力途中の再開はしない（Stage 7J）。閉じると未保存の入力は破棄され、次に開くと新規は初期状態、編集は保存済みの最新データから始まる。
 *    入力内容があるまま閉じようとしたときは、破棄してよいか確認する（保存済みのデータは変わらない）。
 *  - 応募期限が過去でも保存でき、新規登録時は応募済み／当選／落選まで同時に登録できる。
 *  - 日時は空欄=不明・日付のみ・日付+時刻。応募方法・受取方法の初期値は「未確認」として区別して保存する。
 *  - 編集中に他の端末で更新された場合は、保存前に気づけるよう警告する。
 */
export function LotteryFormDialog({
  open,
  onOpenChange,
  lottery,
  prefill,
  candidateId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 編集対象。null なら新規登録 */
  lottery: Lottery | null;
  /** 一括解析の結果など、AIの解析結果をあらかじめ入力して開く（新規登録のみ） */
  prefill?: { draft: LotteryDraft; runId: string | null };
  /** 抽選候補から開いたときの候補ID（店舗別の一括登録で、作成した抽選との関連を保存する） */
  candidateId?: string | null;
  /** 保存に成功したときに呼ばれる（新規登録なら作成した抽選のID） */
  onSaved?: (lotteryId: string | null) => void;
}) {
  const { data, actions, reload, profile } = useApp();
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
  const [pending, setPending] = useState<null | "discard" | "reset" | "bulk">(null);
  const router = useRouter();
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false); // 状態の更新より前に続けて送信されても、保存を1回だけにする
  const [aiOpen, setAiOpen] = useState(false);
  // 編集画面の「AIで情報を補完」（画像から読み取り、差分を確認して選んだ項目だけ反映する）
  const [supOpen, setSupOpen] = useState(false);
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
  // AI読み取りから入力したときの、解析の実行IDとフォームに入力した直後の値（登録時にAIの抽出結果との比較を1回だけ記録する）
  const [aiRun, setAiRun] = useState<{ runId: string; filled: LotteryInput } | null>(null);
  const [reason, setReason] = useState<FeedbackReason | "">("");
  const [candidates, setCandidates] = useState<{ chain: Chain[]; store: Store[]; items: Product[][] }>({ chain: [], store: [], items: [] });
  const modeRef = useRef<HTMLSelectElement>(null);

  // ---- 店舗別の一括登録（Stage 7L）。新規登録のみ。共通情報を入力し、系列マスターの店舗から対象を選んで、店舗ごとに独立した抽選を作る
  const [bulk, setBulk] = useState(false);
  const [bulkSel, setBulkSel] = useState<Record<string, boolean>>({});
  const [bulkExtra, setBulkExtra] = useState<string[]>([]);
  const [bulkNew, setBulkNew] = useState("");
  const [bulkStep, setBulkStep] = useState<"edit" | "confirm" | "result">("edit");
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: { storeName: string; reason: string }[]; firstId: string | null } | null>(null);
  const [area, setArea] = useState<string[] | null>(null);
  const bulkOp = useRef<{ fp: string; id: string } | null>(null);
  useEffect(() => {
    if (!bulk || area !== null) return;
    let alive = true;
    void loadCollectionAreaAction().then((r) => alive && setArea(r.ok ? r.prefectures : []));
    return () => {
      alive = false;
    };
  }, [bulk, area]);
  const chainStores = useMemo(() => (v.chain.id ? data.stores.filter((s) => s.chainId === v.chain.id && !s.archived && s.salesKind !== "online_only") : []), [data.stores, v.chain.id]);
  const dupOfStore = (st: { id: string | null; name: string }) => findDuplicates({ ...v, store: { id: st.id, name: st.name, prefecture: "" } } as never, data.lotteries, undefined, { chains: data.chains, stores: data.stores });
  /** 店舗の行（既存の店舗＋新しく入力した店舗）。初期選択は、自動収集の対象地域内の店舗だけ（所在地が不明な店舗は推定せず未選択） */
  const bulkRows = useMemo(() => {
    const rows = chainStores.map((s) => {
      const inArea = area !== null && !!s.prefecture && area.includes(s.prefecture);
      const dup = dupOfStore({ id: s.id, name: s.name })[0];
      return { key: s.id, id: s.id as string | null, name: s.name, prefecture: s.prefecture, inArea, dup: dup?.reason ?? null, def: inArea && !dup, isNew: false };
    });
    for (const name of bulkExtra) {
      const dup = dupOfStore({ id: null, name })[0];
      rows.push({ key: `n:${name}`, id: null, name, prefecture: "", inArea: false, dup: dup?.reason ?? null, def: !dup, isNew: true });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainStores, bulkExtra, area, v.items, v.applyDeadline, v.chain]);
  const bulkChecked = (r: { key: string; def: boolean; dup: string | null }) => !r.dup && (bulkSel[r.key] ?? r.def);
  const bulkPicked = bulkRows.filter(bulkChecked);
  const addBulkStore = () => {
    const name = bulkNew.trim().slice(0, 80);
    if (!name) return;
    const key = name.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    const exists = [...chainStores.map((s) => s.name), ...bulkExtra].some((n) => n.normalize("NFKC").toLowerCase().replace(/\s+/g, "") === key);
    setBulkNew("");
    if (exists) return setError("同じ店舗がすでに一覧にあります");
    setBulkExtra((x) => [...x, name]);
    setBulkSel((m) => ({ ...m, [`n:${name}`]: true }));
    setError(null);
  };

  const dirty = fingerprint({ i: v, u: urlsText }) !== initialFp;

  // 編集の一時保存・再開（Stage 7L）: 直前に編集した抽選1件だけ、最後の編集から10分間、この端末内に保持する。開いた直後は常に保存済みの内容
  const [resume, setResume] = useState<ResumeStash | null>(() => (lottery ? loadResume(lottery.id, profile.id, Date.now()) : null));
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const stashRef = useRef<() => void>(() => undefined);
  const initialRef = useRef({ input: initial.input, urlsText: initial.urlsText });
  // 最新の入力を保存する関数（描画のたびに更新する。ref への書き込みは描画後に行う）
  useEffect(() => {
    stashRef.current = () => {
      if (!lottery || !dirty) return;
      saveResume({ lotteryId: lottery.id, profileId: profile.id, baseUpdatedAt: baseVersion, base: initialRef.current.input, baseUrls: initialRef.current.urlsText, edited: v, editedUrls: urlsText, sources, at: Date.now() });
    };
  });
  // 編集中は少し間を置いて保存する（アプリを閉じる・バックグラウンドへ移っても内容が残る）
  useEffect(() => {
    if (!lottery || !dirty) return;
    const t = window.setTimeout(() => stashRef.current(), 400);
    return () => window.clearTimeout(t);
  }, [lottery, dirty, v, urlsText]);
  useEffect(() => {
    if (!lottery) return;
    const flush = () => stashRef.current();
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [lottery]);

  // 以前の版が端末に残した長期の下書きは不要になったので、一度だけ消す
  useEffect(() => {
    purgeLegacyDrafts();
  }, []);

  const finish = () => onOpenChange(false);
  // 閉じる操作（×・背景・Esc・ハンドルのスワイプ）。入力が変更されていれば、破棄の確認を出す。変更が無ければそのまま閉じる
  // 編集中の抽選は、確認なしで閉じて一時保存する（10分以内なら「編集を再開」で戻せる）。新規登録は従来どおり破棄の確認を出す
  const requestClose = () => {
    if (isEdit) {
      stashRef.current();
      return finish();
    }
    return dirty ? setPending("discard") : finish();
  };

  /** 「編集を再開」: 一時保存の未保存の内容を、最新の保存済みの内容に重ねて復元する（他で更新された項目は最新を残す）。入力欄へは自動でフォーカスしない */
  const resumeEdit = async () => {
    const s = resume;
    if (!s || !lottery) return;
    const fresh = await reload().catch(() => null);
    const curLot = fresh?.lotteries.find((l) => l.id === lottery.id) ?? lottery;
    const curInput = fromLottery(curLot, fresh ?? data);
    const curUrls = curLot.sourceUrls.join("\n");
    const m = mergeResume(s, curInput, curUrls);
    setV(m.input);
    setUrlsText(m.urlsText);
    setSources({ ...sourcesFromLottery(curLot), ...s.sources });
    setBaseVersion(curLot.updatedAt ?? null);
    setInitialFp(fingerprint({ i: curInput, u: curUrls }));
    initialRef.current = { input: curInput, urlsText: curUrls };
    setResume(null);
    setResumeNote(m.conflicts.length > 0 ? `他の端末などで更新されていた項目（${m.conflicts.map(resumeKeyLabel).join("・")}）は、最新の内容を残しました。` : null);
  };

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
  /** 商品を選び直したとき、その商品区分で使えない単位は使える単位に直す（拡張パック＝パック／BOX、それ以外＝個） */
  const withProduct = (x: LotteryInput["items"][number], product: { id: string | null; name: string }): LotteryInput["items"][number] => ({
    ...x,
    product,
    unit: product.id ? unitForProduct(data.products.find((p) => p.id === product.id), x.unit) : x.unit,
  });
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
  // 応募・当落の記録がある商品・方式は、編集で壊さない（商品の削除・方式の変更を止める）
  const lotteryApps = isEdit && lottery ? data.applications.filter((x) => x.lotteryId === lottery.id) : [];
  const modeLocked = lotteryApps.some((x) => x.state === "applied");
  const lockedItemIds = new Set(lotteryApps.flatMap((x) => [...(x.selectedItemId ? [x.selectedItemId] : []), ...Object.keys(x.itemResults)]));
  const addItem = () => {
    if (v.multiMode === "single") {
      if (modeLocked) return;
      setModePending(true); // 1商品→2商品: 抽選方式は自動で確定せず、選んでもらう
      setV((st) => ({ ...st, items: [...st.items, { product: { id: null, name: "" }, quantity: 1, unit: "box" as const }], multiMode: "all", applications: [] }));
    } else set("items", [...v.items, { product: { id: null, name: "" }, quantity: 1, unit: "box" as const }]);
  };
  const removeItem = (i: number) => {
    const items = v.items.filter((_, j) => j !== i);
    if (items.length < 2) {
      // 1商品に戻したら単一商品の表示へ（方式の選択は不要）
      setModePending(false);
      setV((st) => ({ ...st, items, multiMode: "single", applications: [] }));
    } else set("items", items);
  };
  const jumpToFirstFlag = () => {
    const k = (Object.keys(flags) as FieldKey[]).find((x) => flags[x]);
    if (!k) return;
    setOpenFlag(k);
    requestAnimationFrame(() => document.getElementById(`flag-${k}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
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
    if (savingRef.current) return;
    setError(null);
    if (bulk) return bulkReview();
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
    savingRef.current = true;
    setSaving(true);
    // 編集: 開いてから他の端末で更新されていないか、保存の直前に最新の状態で確認する
    if (lottery && !overwrite && baseVersion) {
      const fresh = await reload();
      const cur = fresh?.lotteries.find((l) => l.id === lottery.id);
      if (fresh && cur && cur.updatedAt && cur.updatedAt !== baseVersion) {
        freshRef.current = { data: fresh, lottery: cur };
        savingRef.current = false;
        setSaving(false);
        setConflict(true);
        setError("この抽選は、編集を始めたあとに別の端末などで更新されました。");
        return;
      }
    }
    const res = await actions.saveLottery(lottery?.id ?? null, input);
    savingRef.current = false;
    setSaving(false);
    if (res.ok) {
      if (isEdit) clearResume(); // 正式に保存したので、一時保存は不要
      onSaved?.(res.createdIds?.[0] ?? null);
      finish();
    }
    else setError(res.error);
  };

  /** 店舗別の一括登録: 入力を確認し、登録前に件数と店舗名を示す（簡潔な確認） */
  const bulkReview = () => {
    if (modePending) return setError("複数商品の応募方式を選択してください（告知から判断できませんでした）");
    if (!v.chain.id && !v.chain.name.trim()) return setError("系列を選択してください");
    if (bulkPicked.length === 0) return setError("登録する店舗を1つ以上選択してください");
    const probe = lotteryInputSchema.safeParse({ ...buildInput(), store: { id: bulkPicked[0].id, name: bulkPicked[0].name, prefecture: "" }, storeMode: "fixed", noStore: false, applications: [], newCampaign: null, aiFeedback: undefined });
    if (!probe.success) return setError(probe.error.issues[0]?.message ?? "入力内容を確認してください");
    setBulkStep("confirm");
  };
  const bulkSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const base = buildInput();
    const inputs = bulkPicked.map((r) => ({ ...base, store: { id: r.id, name: r.name, prefecture: "" }, storeMode: "fixed" as const, noStore: false, selectableStores: [], applications: [], newCampaign: null, aiFeedback: undefined }));
    // 画面の1回の操作ごとの操作ID。同じ内容の再実行（通信失敗後の再試行など）では同じIDで、二重に登録されない。内容を変えれば新しいID
    const fp = fingerprint(inputs);
    if (!bulkOp.current || bulkOp.current.fp !== fp) bulkOp.current = { fp, id: newOpId() };
    const res = await saveLotteryBulkAction(inputs as never, bulkOp.current.id, candidateId ?? null, profile.id);
    savingRef.current = false;
    setSaving(false);
    if (!res.ok) {
      setBulkStep("edit");
      return setError(res.error);
    }
    await reload();
    const firstId = res.createdIds?.[0] ?? null;
    if ((res.skipped ?? []).length === 0) {
      onSaved?.(firstId);
      return finish();
    }
    setBulkResult({ created: res.createdIds?.length ?? 0, skipped: res.skipped ?? [], firstId });
    setBulkStep("result");
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

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && requestClose()}>
        <SheetContent aria-describedby="lottery-form-desc" data-testid="lottery-form" onOpenAutoFocus={(e) => e.preventDefault()} onSwipeDismiss={requestClose}>
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

          {isEdit && resume && !dirty && (
            <div className="px-4 pb-2">
              <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={() => void resumeEdit()} data-testid="resume-edit">
                編集を再開
              </Button>
            </div>
          )}
          {resumeNote && (
            <p role="status" className="mx-4 mb-2 rounded-md border border-warn p-2 text-xs text-warn" data-testid="resume-note">
              {resumeNote}
            </p>
          )}
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

          {bulk && bulkStep === "confirm" && (
            <div role="alert" className="mx-4 mb-2 space-y-2 rounded-md border border-primary p-2 text-sm" data-testid="bulk-confirm">
              <p className="font-medium">{bulkPicked.length}店舗の抽選を登録します</p>
              <ul className="list-disc pl-5 text-xs" data-testid="bulk-confirm-list">
                {bulkPicked.map((r) => (
                  <li key={r.key}>{r.name}</li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void bulkSave()} disabled={saving} data-testid="bulk-confirm-ok">
                  {saving ? "登録中…" : "登録する"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBulkStep("edit")} disabled={saving}>
                  戻る
                </Button>
              </div>
            </div>
          )}
          {bulk && bulkStep === "result" && bulkResult && (
            <div role="status" className="mx-4 mb-2 space-y-2 rounded-md border border-warn p-2 text-sm" data-testid="bulk-result">
              <p className="font-medium">{bulkResult.created}店舗の抽選を登録しました</p>
              <p className="text-xs text-warn">登録済みのため対象から除いた店舗: {bulkResult.skipped.map((s) => s.storeName).join("・")}</p>
              <Button
                size="sm"
                onClick={() => {
                  onSaved?.(bulkResult.firstId);
                  finish();
                }}
                data-testid="bulk-result-close"
              >
                閉じる
              </Button>
            </div>
          )}
          <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
            <SheetBody className="space-y-3 border-t pt-3">
              {isEdit && (
                <Button type="button" variant="outline" size="sm" className="min-h-10 w-full" onClick={() => setSupOpen(true)} data-testid="ai-supplement-open">
                  <Sparkles className="size-4 text-primary-ink" aria-hidden="true" /> AIで情報を補完
                </Button>
              )}
              {!isEdit && (
                <div className="space-y-1">
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={() => (dirty ? setPending("bulk") : router.push("/lotteries/bulk"))} data-testid="bulk-open">
                      <ListPlus className="size-4 text-primary-ink" aria-hidden="true" /> まとめて登録
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={() => setAiOpen(true)} data-testid="ai-open">
                      <Sparkles className="size-4 text-primary-ink" aria-hidden="true" /> AIで読み取る
                    </Button>
                  </div>
                  {aiFilled && (
                    <div className="flex items-center gap-1.5" data-testid="ai-filled-note">
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Sparkles className="size-3 text-primary-ink" aria-hidden="true" />
                        AI入力
                      </span>
                      {flagCount > 0 && (
                        <button
                          type="button"
                          onClick={jumpToFirstFlag}
                          aria-label={`要確認 ${flagCount}件（タップで最初の項目へ）`}
                          className="inline-flex min-h-6 items-center gap-0.5 rounded-full border border-warn px-1.5 text-[10px] font-medium leading-none text-warn"
                        >
                          <AlertTriangle className="size-3" aria-hidden="true" />
                          要確認 {flagCount}件
                        </button>
                      )}
                    </div>
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
                    <NewMasterBadge show={!v.chain.id && v.chain.name.trim().length > 0} />
                    {flagChip("chain", "系列")}
                  </span>
                  <MasterCombobox label="系列" value={v.chain} disabled={isEdit} options={chainOptions} onChange={chooseChain} />
                </div>
                <div className="min-w-0 text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    店舗
                    <NewMasterBadge show={!v.store.id && v.store.name.trim().length > 0} />
                    {flagChip("store", "店舗")}
                  </span>
                  {bulk ? (
                    <span className="mt-1 flex min-h-11 items-center rounded-md border border-dashed bg-muted/40 px-3 text-xs text-muted-foreground" data-testid="bulk-store-cell">
                      下で店舗を選択
                    </span>
                  ) : (
                    <MasterCombobox label="店舗" value={v.store} options={storeOptions} onChange={(store) => set("store", { ...store, prefecture: store.id ? "" : (v.store.prefecture ?? "") })} />
                  )}
                  {!v.store.id && !v.store.name.trim() && (v.chain.id || v.chain.name.trim()) && v.storeMode !== "select_on_apply" && <span className="mt-0.5 block text-[11px] text-muted-foreground" data-testid="no-store-hint">店舗なし（系列のみ）</span>}
                </div>
              </div>
              {/* 店舗の指定方式。応募時に店舗を選ぶ抽選は、登録時に店舗を決めず、応募者ごとに応募店舗を記録する */}
              <label className="block text-sm">
                <span className="text-[13px] font-medium">店舗の指定</span>
                <select
                  aria-label="店舗の指定"
                  value={bulk ? "bulk" : (v.storeMode ?? "fixed")}
                  onChange={(e) => {
                    if (e.target.value === "bulk") {
                      // 店舗別に一括登録: 候補に店舗が読み取れていれば、その店舗を最初から選択する
                      setBulk(true);
                      setBulkStep("edit");
                      setBulkSel(v.store.id ? { [v.store.id]: true } : {});
                      setBulkExtra(!v.store.id && v.store.name.trim() && v.storeMode === "fixed" ? [v.store.name.trim()] : []);
                      setV((st) => ({ ...st, storeMode: "fixed", store: { id: null, name: "", prefecture: "" } }));
                      return;
                    }
                    setBulk(false);
                    const m = e.target.value as NonNullable<LotteryInput["storeMode"]>;
                    setV((st) => ({ ...st, storeMode: m, ...(m === "select_on_apply" ? { store: { id: null, name: "応募時に店舗選択", prefecture: "" } } : m === "none" ? { store: { id: null, name: "", prefecture: "" } } : st.storeMode === "select_on_apply" ? { store: { id: null, name: "", prefecture: "" } } : {}) }));
                  }}
                  className="mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm"
                  data-testid="store-mode"
                >
                  <option value="fixed">店舗固定</option>
                  <option value="select_on_apply">応募時に店舗選択</option>
                  <option value="none">店舗指定なし</option>
                  {!isEdit && <option value="bulk">店舗別に一括登録</option>}
                </select>
                {/* 応募済みの抽選を店舗選択式に変更するとき: 既存の応募履歴は変更しない。応募店舗は、応募したプロフィールが詳細から入力する */}
                {isEdit && lottery && v.storeMode === "select_on_apply" && lottery.storeMode !== "select_on_apply" && data.applications.some((a) => a.lotteryId === lottery.id && a.state === "applied") && (
                  <span className="mt-1 block text-[11px] text-warn" data-testid="store-mode-applied-note">
                    応募済みのプロフィールがあります。応募の履歴は変わりません。応募した店舗は、各プロフィールが抽選の詳細で入力してください（未設定の間は「店舗未設定」と表示されます）。
                  </span>
                )}
              </label>
              {bulk && (
                <div className="space-y-2 rounded-md border p-2" data-testid="bulk-stores">
                  <p className="text-xs font-medium">
                    対象の店舗 <span data-testid="bulk-count">{bulkPicked.length}</span>店舗を選択中
                  </p>
                  {!v.chain.id && <p className="text-[11px] text-muted-foreground">系列マスターの店舗を選ぶには、系列を選択してください（未登録の系列は、店舗名を追加して登録できます）。</p>}
                  {area !== null && area.length === 0 && <p className="text-[11px] text-muted-foreground">自動収集の対象地域が未設定のため、店舗は初期状態で未選択です。</p>}
                  <ul className="space-y-1" data-testid="bulk-store-list">
                    {bulkRows.map((r) => (
                      <li key={r.key}>
                        <label className={cn("flex min-h-10 items-center gap-2 rounded-md border bg-input px-2.5 py-1 text-sm", r.dup && "opacity-70")}>
                          <input type="checkbox" className="size-4" checked={bulkChecked(r)} disabled={!!r.dup} onChange={(e) => setBulkSel((m) => ({ ...m, [r.key]: e.target.checked }))} aria-label={r.name} />
                          <span className="min-w-0 flex-1 truncate">{r.name}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{r.dup ? "登録済み" : r.isNew ? "新規店舗" : r.prefecture ? (area !== null && area.length > 0 && !r.inArea ? `${r.prefecture}（対象地域外）` : r.prefecture) : "所在地未確認"}</span>
                        </label>
                        {r.dup && <p className="px-1 text-[11px] text-warn">{r.dup}。二重登録を防ぐため、対象から除いています。</p>}
                      </li>
                    ))}
                    {bulkRows.length === 0 && <li className="text-[11px] text-muted-foreground">この系列の店舗はマスターに登録されていません。店舗名を追加してください。</li>}
                  </ul>
                  <div className="flex gap-2">
                    <input className="min-h-10 min-w-0 flex-1 rounded-md border bg-input px-3 text-sm" value={bulkNew} onChange={(e) => setBulkNew(e.target.value)} placeholder="店舗名を追加" aria-label="追加する店舗名" data-testid="bulk-new-name" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addBulkStore())} />
                    <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={addBulkStore} data-testid="bulk-new-add">
                      追加
                    </Button>
                  </div>
                </div>
              )}
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
                  対象商品・数量
                  <NewMasterBadge show={v.items.some((it) => !it.product.id && it.product.name.trim().length > 0)} />
                  {flagChip("items", "商品")}
                </legend>
                {v.items.map((it, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_3.4rem_4.6rem_auto] items-start gap-1" data-testid="item-row">
                    <MasterCombobox
                      label={`商品${i + 1}`}
                      value={it.product}
                      options={productOptions}
                      className="min-w-0"
                      onChange={(product) => set("items", v.items.map((x, j) => (j === i ? withProduct(x, product) : x)))}
                    />
                    <CountInput
                      aria-label={`数量${i + 1}`}
                      value={it.quantity}
                      max={9999}
                      onChange={(quantity) => set("items", v.items.map((x, j) => (j === i ? { ...x, quantity } : x)))}
                      className="mt-0 h-11 min-w-0 rounded-md border bg-input px-1 text-center text-sm"
                    />
                    <Select
                      label={`単位${i + 1}`}
                      value={it.unit}
                      onChange={(unit) => set("items", v.items.map((x, j) => (j === i ? { ...x, unit } : x)))}
                      className="mt-0 h-11 px-1"
                      options={unitOptions(data.products.find((p) => p.id === it.product.id), it.unit)}
                    />
                    {v.items.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mt-0 size-11"
                        aria-label={`商品${i + 1}を削除`}
                        disabled={(!!it.id && lockedItemIds.has(it.id)) || (modeLocked && v.items.length <= 2)}
                        title={it.id && lockedItemIds.has(it.id) ? "応募・当落の記録がある商品は削除できません" : undefined}
                        onClick={() => removeItem(i)}
                      >
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
                      onPick={(k) => set("items", v.items.map((x, j) => (j === i ? withProduct(x, { id: candidates.items[i][k].id, name: candidates.items[i][k].officialName }) : x)))}
                    />
                  ) : null,
                )}
                {v.items.length < 10 && (
                  <Button type="button" size="sm" variant="outline" onClick={addItem} disabled={modeLocked && v.multiMode === "single"} title={modeLocked && v.multiMode === "single" ? "応募・当落の記録があるため、商品は追加できません" : undefined} data-testid="add-item">
                    <Plus className="size-4" /> 商品を追加
                  </Button>
                )}
                {/* 2商品以上のときだけ、商品の近くに抽選方式を出す（自動では確定しない。AIが読み取れていれば初期値） */}
                {(multi || modePending) && (
                  <label className="block text-sm" data-testid="mode-field">
                    <span className="flex items-center gap-1 text-[13px] font-medium">
                      抽選方式
                      {flagChip("multiMode", "抽選の方式")}
                    </span>
                    <select
                      ref={modeRef}
                      aria-label="抽選の方式"
                      value={modePending ? "" : (v.multiMode ?? "all")}
                      disabled={modeLocked}
                      title={modeLocked ? "応募・当落の記録があるため、方式は変更できません" : undefined}
                      onChange={(e) => setMode(e.target.value as NonNullable<LotteryInput["multiMode"]>)}
                      className={field}
                    >
                      {modePending && <option value="">方式を選択</option>}
                      {MODE_OPTIONS.filter((m) => m.value !== "single").map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    {flagPanel("multiMode")}
                  </label>
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
                    <div className="mt-1">
                      <ClearableDateInput label="当選発表の終了日" value={v.resultEndDate ?? ""} min={v.resultDate.date || undefined} onChange={(x) => set("resultEndDate", x)} />
                    </div>
                    {v.resultDate.precision === "unknown" && <p className="mt-0.5 text-[11px] text-warn">開始日も入力してください</p>}
                  </div>
                ) : (
                  <span aria-hidden="true" />
                )}
                <div>
                  <FlexField label={v.procedureSplit ? "購入開始" : "購入・受取開始"} value={v.procedureStart ?? EMPTY_FLEX} onChange={(x) => set("procedureStart", x)} chip={flagChip("procedureStart", "購入・受取開始")} />
                  {flagPanel("procedureStart")}
                </div>
                <div>
                  <FlexField label={v.procedureSplit ? "購入締切" : "購入・受取終了"} value={v.procedureDeadline} onChange={(x) => set("procedureDeadline", x)} chip={flagChip("procedureDeadline", "購入・受取終了")} />
                  {flagPanel("procedureDeadline")}
                </div>
                <label className="col-span-2 flex min-h-8 items-center gap-1.5 text-xs" data-testid="split-toggle">
                  <input type="checkbox" className="size-4" checked={v.procedureSplit ?? false} onChange={(e) => set("procedureSplit", e.target.checked)} />
                  購入期間と受取期間を分ける
                  <InfoTip text="事前の購入手続き（支払い）と店舗での受取で期限が異なる抽選用です。通常はオフのままで、購入・受取は同じ期間として扱います。" label="購入期間と受取期間" />
                </label>
                {v.procedureSplit && (
                  <>
                    <div>
                      <FlexField label="受取開始" value={v.receiveStart ?? EMPTY_FLEX} onChange={(x) => set("receiveStart", x)} />
                    </div>
                    <div>
                      <FlexField label="受取締切" value={v.receiveDeadline ?? EMPTY_FLEX} onChange={(x) => set("receiveDeadline", x)} />
                    </div>
                  </>
                )}
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
              {(openFlag === "applyMethod" || openFlag === "receiveMethod") && (
                <div>
                  {flagPanel("applyMethod")}
                  {flagPanel("receiveMethod")}
                </div>
              )}

              {/* 6. URL */}
              <div className="space-y-1 text-sm">
                <span className="flex items-center gap-1 text-[13px] font-medium">
                  当落発表方法
                  {flagChip("announcement", "発表方法")}
                  {(v.announcementMethods ?? []).length === 0 && v.announcementMethod.trim() && (
                    <button
                      type="button"
                      className="ml-1 text-[11px] font-normal text-info underline"
                      data-testid="announce-classify"
                      onClick={() => {
                        const c = classifyAnnouncement(v.announcementMethod);
                        if (c.matched) setV((cur) => ({ ...cur, announcementMethods: c.methods, announcementMethod: foldAnnounceNote(cur.announcementMethod, c.extra), announcementTarget: c.target, announcementInferred: false }));
                      }}
                    >
                      文章から分類
                    </button>
                  )}
                </span>
                <AnnouncePicker
                  methods={(v.announcementMethods ?? []) as AnnounceMethod[]}
                  target={v.announcementTarget ?? "unknown"}
                  inferred={v.announcementInferred ?? false}
                  note={v.announcementMethod}
                  onChange={(n) => setV((cur) => ({ ...cur, announcementMethods: n.methods, announcementTarget: n.target, announcementInferred: n.inferred }))}
                  onNote={(t) => set("announcementMethod", t)}
                />
                <label className="block">
                  <span className="text-[13px] font-medium">結果確認URL</span>
                  <input value={v.announcementUrl} onChange={(e) => set("announcementUrl", e.target.value)} className={field} inputMode="url" placeholder="https://" />
                </label>
              </div>
              {flagPanel("announcement")}
              <label className="block text-sm">
                <span className="text-[13px] font-medium">情報源URL（1行に1つ）</span>
                <textarea value={urlsText} onChange={(e) => setUrlsText(e.target.value)} rows={1} className={cn(field, "py-2")} />
              </label>

              {/* 7. 応募条件・制限 */}
              <div className="space-y-1 text-sm">
                <span className="flex items-center gap-1 text-[13px] font-medium">
                  応募条件
                  {flagChip("conditions", "応募条件")}
                  {(v.requirementTags ?? []).length === 0 && v.conditionsText.trim() && (
                    <button
                      type="button"
                      className="ml-1 text-[11px] font-normal text-info underline"
                      data-testid="requirement-classify"
                      onClick={() => {
                        const c = classifyRequirements(v.conditionsText);
                        if (c.matched) setV((cur) => ({ ...cur, requirementTags: c.tags, requirementDetails: c.details }));
                      }}
                    >
                      文章から分類
                    </button>
                  )}
                </span>
                <RequirementPicker
                  tags={(v.requirementTags ?? []) as RequirementTag[]}
                  logic={v.requirementLogic ?? "and"}
                  details={(v.requirementDetails ?? {}) as RequirementDetails}
                  onChange={(n) => setV((cur) => ({ ...cur, requirementTags: n.tags, requirementLogic: n.logic, requirementDetails: n.details }))}
                />
                <textarea value={v.conditionsText} onChange={(e) => set("conditionsText", e.target.value)} rows={1} className={cn(field, "py-2")} placeholder="補足・原文（任意）" aria-label="応募条件の補足" />
              </div>
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
                  <CountInput aria-label="上限回数" emptyValue={1} max={99} value={v.limitMaxCount} onChange={(n) => set("limitMaxCount", n)} className={cn(field, "text-center")} />
                </label>
              </div>
              {flagPanel("limit")}

              {/* 8-9. 詳細設定（抽選方式・キャンペーン・状態・本人確認・メモ） */}
              <details open={detailsOpen} onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-lg border" data-testid="form-details">
                <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
                  詳細設定（キャンペーン・備考など）
                  {(v.newCampaign || v.campaignId) && <span className="ml-2 text-xs text-primary-ink">設定あり</span>}
                </summary>
                <div className="space-y-3 border-t p-3">
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
                    <span className="flex items-center gap-1 text-[13px] font-medium">
                      抽選方式
                      <InfoTip text="継続抽選＝応募後も抽選が続く方式（ノジマオンライン等）。招待制販売＝商品ごとの招待リクエスト（Amazon等）。応募済みタブの「継続中の抽選」にまとめて表示します。" label="抽選方式" />
                    </span>
                    <Select
                      label="抽選方式"
                      value={v.lotteryKind ?? "normal"}
                      onChange={(x) => set("lotteryKind", x)}
                      options={[
                        { value: "normal", label: "通常抽選" },
                        { value: "ongoing", label: "継続抽選" },
                        { value: "invite", label: "招待制販売" },
                      ]}
                    />
                  </label>
                  {(v.lotteryKind ?? "normal") !== "normal" && (
                    <div className="text-sm">
                      <span className="flex items-center gap-1 text-[13px] font-medium">
                        有効期限
                        <InfoTip text="告知に有効期限があるときだけ入力します。無期限とは仮定しません。" label="有効期限" />
                      </span>
                      <div className="mt-1">
                        <ClearableDateInput label="有効期限" value={v.validUntil ?? ""} onChange={(x) => set("validUntil", x)} />
                      </div>
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
                    要チェック（★）にする
                  </label>
                  {v.multiMode === "choose_one" ? (
                    <p className="text-xs text-muted-foreground">希望商品を選んで応募する方式では、登録後にカード上でユーザーごとに希望商品を選択して応募を記録します。</p>
                  ) : (
                    <ul className="space-y-1" data-testid="app-status-list">
                      {profiles.map((p) => {
                        const st = appStatus(p.id);
                        return (
                          <li key={p.id} className="flex min-h-10 items-center gap-2 text-sm">
                            <label className="flex min-w-0 flex-1 items-center gap-2">
                              <input type="checkbox" className="size-4 shrink-0" aria-label={`${p.label}は応募済み`} checked={st !== "none"} onChange={(e) => setAppStatus(p.id, e.target.checked ? "applied" : "none")} />
                              <span className="truncate">{p.label}</span>
                            </label>
                            {st !== "none" && !multi && (
                              <select aria-label={`${p.label}の結果`} value={st} onChange={(e) => setAppStatus(p.id, e.target.value)} className="min-h-9 rounded-md border bg-input px-1 text-xs">
                                <option value="applied">応募済み</option>
                                <option value="won">当選</option>
                                <option value="lost">落選</option>
                              </select>
                            )}
                          </li>
                        );
                      })}
                    </ul>
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
                    <p className="text-[11px] text-muted-foreground">任意（AIの結果を修正したときの理由として記録）</p>
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
              <Button type="button" variant="outline" className="mr-auto" onClick={requestClose} data-testid="form-discard">
                {isEdit ? "閉じる" : "破棄"}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </form>
        </SheetContent>
        {aiOpen && <AiImportDialog open onOpenChange={setAiOpen} onApply={applyDraft} />}
        {supOpen && (
          <AiSupplementDialog
            open
            onOpenChange={setSupOpen}
            current={v}
            defaults={new Set(DEFAULTABLE.filter((k) => sources[k] === "default"))}
            hint={[data.chains.find((c) => c.id === v.chain.id)?.name ?? v.chain.name, data.stores.find((s) => s.id === v.store.id)?.name ?? v.store.name, ...v.items.map((it) => data.products.find((p) => p.id === it.product.id)?.officialName ?? it.product.name)].map((s) => s.trim()).filter(Boolean).join(" / ")}
            onApply={(next) => {
              setV(next);
              setUrlsText(next.sourceUrls.join("\n"));
              // AIが補完した区分は「AI」、それ以外の出典は変えない
              setSources((s) => {
                const n = { ...s };
                for (const k of DEFAULTABLE) if (next[k] !== v[k]) n[k] = "ai";
                return n;
              });
            }}
          />
        )}
      </Sheet>
    </>
  );
}
