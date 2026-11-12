"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LotteryInput } from "@/lib/lottery-input";
import type { ExpenseInput, SaleInput } from "@/lib/finance-input";
import type { ApplyOptions, ProfileSettingsInput } from "@/lib/server/lottery-service";
import type { ManualPurchaseInput } from "@/lib/purchase-input";
import { createRepository } from "@/services";
import * as local from "@/lib/mutations";
import { reconcileData } from "@/lib/reconcile-data";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { rebindPushSubscription } from "@/app/(app)/settings/notifications/actions";
import { copyProfileSettings, saveProfileSettings } from "@/app/(app)/settings/profile-settings-actions";
import { recordClientError } from "@/lib/client-resilience";
import { classifyError, retryDelayMs } from "@/lib/resilience";
import { normalizeProfileSettings, type ProfileSettingKey, type ProfileSettings } from "@/lib/profile-settings";
import { currentSubscription, pushSupported, registerServiceWorker } from "@/lib/push-client";
import { SplashScreen } from "@/components/splash-screen";
import { localDeviceStore } from "@/services/local-device-store";
import type { LotteryRepository, Outcome } from "@/services/types";
import type { AppData, EventState, FulfillmentStatus, Profile, ResultStatus } from "@/types/domain";

interface AppContextValue {
  data: AppData;
  now: Date;
  /** 現在の操作プロフィール（有効なもののうち端末で選択中のもの） */
  profile: Profile;
  selectProfile: (id: string) => void;
  /** DB保存を伴う機能（抽選登録・編集・複製・購入入力）が使えるか。mockでは false */
  persistent: boolean;
  /** 最新のデータを取得して画面に反映し、そのデータを返す（失敗時は null） */
  /** データの再取得。silent=失敗しても通知を出さない（バックグラウンド復帰時の静かな更新） */
  reload: (opts?: { silent?: boolean }) => Promise<AppData | null>;
  /** 現在のプロフィールの設定（下部メニュー・カード表示・テーマ） */
  settings: ProfileSettings;
  settingsOf: (profileId: string) => ProfileSettings;
  /** 現在のプロフィールの設定を更新する（指定した項目だけ。null で既定に戻す） */
  saveSettings: (patch: Partial<Record<ProfileSettingKey, unknown>>) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 選んだ項目を、あるプロフィールから別のプロフィールへコピーする */
  copySettings: (fromId: string, toId: string, keys: string[]) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 操作失敗の通知（画面全体は止めない） */
  notice: string | null;
  dismissNotice: () => void;
  actions: {
    setManaged: (lotteryId: string, v: boolean) => Promise<Outcome>;
    setApplied: (lotteryId: string, accountId: string, v: boolean, selectedItemId?: string | null, opts?: ApplyOptions) => Promise<Outcome>;
    setItemResults: (applicationId: string, results: { itemId: string; result: ResultStatus }[]) => Promise<Outcome>;
    /** 複数商品抽選の応募商品の変更（Stage 7M） */
    setAppliedItems: (applicationId: string, itemIds: string[]) => Promise<Outcome>;
    saveExpense: (id: string | null, input: ExpenseInput) => Promise<Outcome>;
    deleteExpense: (id: string) => Promise<Outcome>;
    saveSale: (id: string | null, input: SaleInput) => Promise<Outcome>;
    deleteSale: (id: string) => Promise<Outcome>;
    updateProfile: (profileId: string, input: ProfileSettingsInput) => Promise<Outcome>;
    reorderProfiles: (ids: string[]) => Promise<Outcome>;
    setResult: (applicationId: string, r: ResultStatus) => Promise<Outcome>;
    setAppliedStore: (applicationId: string, store: { id: string | null; name: string; prefecture: string } | null) => Promise<Outcome>;
    setFulfillment: (applicationId: string, f: FulfillmentStatus) => Promise<Outcome>;
    revertFulfillment: (applicationId: string, to: "none" | "procedure_done") => Promise<Outcome>;
    setLotterySkip: (lotteryId: string, v: boolean) => Promise<Outcome>;
    setEventState: (lotteryId: string, s: EventState) => Promise<Outcome>;
    saveLottery: (id: string | null, input: LotteryInput) => Promise<Outcome>;
    duplicateLottery: (lotteryId: string, storeIds: string[], opts?: import("@/lib/server/lottery-service").DuplicateOptions) => Promise<Outcome>;
    saveLotteryAndDuplicate: (input: LotteryInput, storeIds: string[], newStores: { name: string; prefecture: string }[]) => Promise<Outcome>;
    archiveLottery: (lotteryId: string) => Promise<Outcome>;
    excludeLottery: (lotteryId: string, ex: import("@/lib/server/lottery-service").ExclusionInput) => Promise<Outcome>;
    groupLotteries: (lotteryIds: string[], opts?: import("@/lib/server/lottery-service").GroupOptions) => Promise<Outcome>;
    ungroupLottery: (lotteryId: string) => Promise<Outcome>;
    dissolveLotteryGroup: (groupId: string) => Promise<Outcome>;
    addManualPurchase: (input: ManualPurchaseInput) => Promise<Outcome>;
  };
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppProvider の外で useApp が呼ばれました");
  return ctx;
}

/**
 * データ・現在時刻・操作プロフィールを保持する。
 * 選択プロフィールは端末(localStorage)ごと。サーバー/他端末とは同期しない。
 */
/** 起動時の読み込みの上限。これを超えたら無限に待たず、エラーと再試行を出す */
const LOAD_TIMEOUT_MS = 25_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("読み込みに時間がかかっています。通信環境を確認して、再試行してください")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** 操作中のプロフィールID: 選択中の state → 端末に保存した選択 → 先頭の有効なプロフィール。画面の表示（value.profile）と同じ規則 */
export function resolveActorId(profiles: readonly { id: string; active?: boolean }[], selected: string | null, saved: string | null): string | undefined {
  const active = profiles.filter((p) => p.active !== false);
  const want = selected ?? saved;
  return (active.find((p) => p.id === want) ?? active[0])?.id;
}

export function AppProvider({ children, repository }: { children: React.ReactNode; /** テスト用: データの取得元を差し替える */ repository?: LotteryRepository }) {
  const [repo] = useState<LotteryRepository>(() => repository ?? createRepository());
  const pathname = usePathname();
  const [data, setData] = useState<AppData | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // プロフィール別の設定の「変更直後」の値。保存・再取得が終わるまで画面に反映し続ける（モックでは端末内に保存）
  const [overrides, setOverrides] = useState<Record<string, ProfileSettings>>({});
  const overridesRef = useRef<Record<string, ProfileSettings>>({});
  // 設定の保存を1件ずつ順に行い、保存中の件数を数える（連続して押しても、前の操作の結果で後の操作を巻き戻さないため）
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSaves = useRef<Record<string, number>>({});
  const firstLoad = useRef(true);
  // 一度でも読み込めたあとの更新失敗では、画面全体をエラーにせず通知にとどめる（全面ローディング/エラーは起動時だけ）
  const hasData = useRef(false);
  // 最新のデータ・「いま」・最後に取得できた時刻（再取得の判断と、保存の楽観的更新・失敗時の巻き戻しに使う）
  const dataRef = useRef<AppData | null>(null);
  const nowRef = useRef(0);
  const lastLoadAt = useRef(0);
  // 保存の順序づけ（押した順に1件ずつ）と、保存中に見送った再取得の印
  const opQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingOps = useRef(0);
  const resync = useRef(false);

  const loading = useRef(false);
  const load = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<AppData | null> => {
      // 一時的な通信失敗（切断・時間切れ）は、数回やり直してから失敗として扱う（Stage 7C）。認証や画面のバグ由来のエラーは繰り返さない
      loading.current = true;
      try {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const start = new Date();
          try {
            const d = await withTimeout(repo.load(start), attempt === 0 ? LOAD_TIMEOUT_MS : 12_000);
            hasData.current = true;
            lastLoadAt.current = Date.now();
            // 保存中の操作があるときは、古い取得結果で画面（楽観的な表示）を上書きしない。保存がすべて終わってから取り直す
            if (pendingOps.current > 0) {
              resync.current = true;
              return d;
            }
            // 内容が前回と同じ部分は同じ参照のまま。すべて同じなら再描画しない（ページ移動・復帰のたびの全体の再描画を避ける。Stage 7O）
            const merged = reconcileData(dataRef.current, d);
            const changed = merged !== dataRef.current;
            dataRef.current = merged;
            if (changed) setData(merged);
            // 「いま」（締切の残り時間の基準）は、内容が変わったとき、または30秒以上更新していないときだけ更新する
            if (changed || start.getTime() - nowRef.current >= 30_000) {
              nowRef.current = start.getTime();
              setNow(start);
            }
            setLoadError(null);
            return merged;
          } catch (e) {
            lastError = e;
            // 時間切れ（すでに25秒待った）は繰り返さない。すぐ失敗する通信エラーだけやり直す
            if (classifyError(e) !== "network" || attempt === 2) break;
            if (typeof navigator !== "undefined" && navigator.onLine === false) break; // 切断中は復帰（online）を待つ
            await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
          }
        }
        recordClientError(lastError, "load");
        const message = lastError instanceof Error && lastError.message ? lastError.message : "データの取得に失敗しました";
        if (hasData.current) {
          if (!opts.silent) setNotice(`最新のデータを取得できませんでした（${message}）`);
        } else setLoadError(message);
        return null;
      } finally {
        loading.current = false;
      }
    },
    [repo],
  );

  // 初回ロード。以降はページ遷移のたびに再取得（マスター管理での変更を反映するため）
  // 設定の中のページ同士の移動（一覧 ⇄ 下のページ）は、データを取り直さない（画面のちらつき・無駄な通信を避ける）
  const prevPath = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPath.current;
    prevPath.current = pathname;
    if (firstLoad.current) firstLoad.current = false;
    else if (prev?.startsWith("/settings") && pathname.startsWith("/settings") && hasData.current) return;
    // 画面の移動は、表示を止めずに裏で最新化する（取得済みの画面を先に出し、内容が変わったときだけ更新）。
    // 保存の結果で最新になっているコア画面どうしの移動は、直近15秒以内なら取り直さない（連続した切り替えでサーバーへ何度も問い合わせない）。
    // マスター管理・コレクション・一括登録など、画面の外でデータが変わりうる画面から戻るときは必ず取り直す
    const CORE = ["/lotteries", "/purchases", "/finance", "/records", "/battles"];
    if (prev && CORE.includes(prev) && CORE.includes(pathname) && hasData.current && Date.now() - lastLoadAt.current < 15_000) return;
    void load();
  }, [load, pathname]);

  useEffect(() => {
    // 「いま」の更新（1分ごと）。バックグラウンドの間は動かさず、戻ったときに1回だけ更新する（全画面の再描画を無駄に起こさない）
    const tick = () => {
      if (document.visibilityState !== "hidden") setNow(new Date());
    };
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const selectProfile = useCallback((id: string) => {
    localDeviceStore.setProfileId(id);
    setProfileId(id);
  }, []);

  const run = useCallback(
    async (fn: (actor: string) => Promise<Outcome>, optimistic?: (d: AppData, actor: string) => AppData): Promise<Outcome> => {
      // 操作者は、画面に表示している（操作中の）プロフィールと必ず同じにする。端末に保存した選択（再読み込み後など）も同じ規則で解決する。
      // 以前は state が未設定のとき先頭のプロフィールを使い、第二ユーザーの応募済み操作が「他のユーザーの応募状況は変更できません」になっていた（Stage 7E）
      const actor = resolveActorId(data?.profiles ?? [], profileId, localDeviceStore.getProfileId());
      if (!actor) return { ok: false, error: "操作プロフィールが選択されていません" };
      // 楽観的更新: 押した直後に画面へ反映し、サーバーの結果で置き換える。失敗したら元の表示へ戻してエラーを通知する（応募状態などはサーバーの結果が常に正）
      const before = dataRef.current;
      let guess: AppData | null = null;
      if (optimistic && before) {
        const g = optimistic(before, actor);
        if (g !== before) {
          guess = g;
          dataRef.current = g;
          setData(g);
        }
      }
      // 保存は押した順に1件ずつ実行する（画面は先に反映されるため、続けて押された操作がサーバーで入れ替わって、応募→取消が取消→応募の順に処理されるのを防ぐ）
      pendingOps.current += 1;
      const prevOp = opQueue.current;
      let release!: () => void;
      opQueue.current = new Promise<void>((r) => (release = r));
      await prevOp;
      let res: Outcome;
      try {
        res = await fn(actor);
      } catch {
        res = { ok: false, error: "通信に失敗しました。接続を確認して再度お試しください" };
      } finally {
        release();
        pendingOps.current -= 1;
      }
      const last = pendingOps.current === 0; // 後ろに続く操作がなければ、このサーバーの結果が最新
      if (res.ok) {
        if (last) {
          const merged = reconcileData(dataRef.current, res.data);
          dataRef.current = merged;
          setData(merged);
          lastLoadAt.current = Date.now();
        }
        setNotice(null);
      } else {
        resync.current = true;
        if (last && guess && dataRef.current === guess && before) {
          // 他の更新が間に入っていなければ元の表示へ戻す
          dataRef.current = before;
          setData(before);
          resync.current = false;
        }
        setNotice(res.error);
      }
      // 続く操作が無くなったとき、失敗や取得の見送りがあれば、最新の状態を取り直す
      if (last && resync.current) {
        resync.current = false;
        void load({ silent: true });
      }
      return res;
    },
    [profileId, data, load],
  );

  // モック（DB保存なし）では、設定を端末内に残す（画面の動作確認用）
  useEffect(() => {
    if (repo.persistent) return;
    try {
      const raw = window.localStorage.getItem("tcg.mock.profileSettings");

      if (raw) {
        const restored = Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, unknown>).map(([k, v]) => [k, normalizeProfileSettings(v)]));
        overridesRef.current = restored;
        setOverrides(restored);
      }
    } catch {
      /* noop */
    }
  }, [repo.persistent]);

  const value = useMemo<AppContextValue | null>(() => {
    if (!data || !now) return null;
    const active = data.profiles.filter((p) => p.active !== false);
    if (active.length === 0) return null;
    const saved = profileId ?? localDeviceStore.getProfileId();
    const profile = active.find((p) => p.id === saved) ?? active[0];
    const settingsOf = (id: string): ProfileSettings => ({ ...(data.profileSettings?.[id] ?? {}), ...(overrides[id] ?? {}) });
    const persist = (next: Record<string, ProfileSettings>) => {
      if (repo.persistent) return;
      try {
        window.localStorage.setItem("tcg.mock.profileSettings", JSON.stringify(next));
      } catch {
        /* noop */
      }
    };
    const apply = (id: string, patch: Partial<Record<ProfileSettingKey, unknown>>) => {
      const cur = settingsOf(id) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      return normalizeProfileSettings(merged);
    };
    return {
      data,
      now,
      profile,
      selectProfile,
      settings: settingsOf(profile.id),
      settingsOf,
      saveSettings: async (patch) => {
        const pid = profile.id;
        // 画面には即反映する。直前の操作の結果（まだ保存中でも）の上に積むので、連続して押しても順に積み重なる
        const cur = { ...(data.profileSettings?.[pid] ?? {}), ...(overridesRef.current[pid] ?? {}) } as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...cur };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        const next = { ...overridesRef.current, [pid]: normalizeProfileSettings(merged) };
        overridesRef.current = next;
        setOverrides(next);
        persist(next);
        if (!repo.persistent) return { ok: true };
        pendingSaves.current[pid] = (pendingSaves.current[pid] ?? 0) + 1;
        const job = saveQueue.current.then(() => saveProfileSettings(pid, patch, pid));
        saveQueue.current = job.catch(() => undefined);
        let res: { ok: true } | { ok: false; error: string };
        try {
          res = await job;
        } catch {
          res = { ok: false, error: "通信に失敗しました。接続を確認して再度お試しください" };
        }
        pendingSaves.current[pid] -= 1;
        if (!res.ok) setNotice(res.error);
        // 最後の保存が終わったときだけ、サーバーの値を取り直して画面の一時的な値を外す（途中で外すと、押した結果が一瞬戻って見える）
        if (pendingSaves.current[pid] === 0) {
          await load();
          if (pendingSaves.current[pid] === 0) {
            const { [pid]: _removed, ...rest } = overridesRef.current;
            void _removed;
            overridesRef.current = rest;
            setOverrides(rest);
          }
        }
        return res;
      },
      copySettings: async (fromId, toId, keys) => {
        if (!repo.persistent) {
          const src = settingsOf(fromId) as Record<string, unknown>;
          const patch = Object.fromEntries(keys.map((k) => [k, k in src ? src[k] : null]));
          const next = { ...overrides, [toId]: apply(toId, patch as Partial<Record<ProfileSettingKey, unknown>>) };
          overridesRef.current = next;
          setOverrides(next);
          persist(next);
          return { ok: true };
        }
        const res = await copyProfileSettings(fromId, toId, keys, profile.id);
        if (res.ok) {
          const d = await load();
          if (d) {
            overridesRef.current = {};
            setOverrides({});
          }
        }
        return res;
      },
      persistent: repo.persistent,
      reload: load,
      notice,
      dismissNotice: () => setNotice(null),
      actions: {
        setManaged: (id, v) => run((a) => repo.setManaged(a, id, v), repo.persistent ? (d, a) => local.setManaged(d, a, id, v, new Date()) : undefined),
        // 応募状態は重要なデータのため、楽観的には切り替えない（押した直後にボタンへスピナーを出し、サーバーで保存できてから表示を変える）。★だけは楽観的に反映する
        setApplied: (id, acc, v, sel, opts) => run((a) => repo.setApplied(a, id, acc, v, sel, opts)),
        setItemResults: (id, r) => run((a) => repo.setItemResults(a, id, r)),
        setAppliedItems: (id, items) => run((a) => repo.setAppliedItems(a, id, items)),
        saveExpense: (id, input) => run((a) => repo.saveExpense(a, id, input)),
        deleteExpense: (id) => run((a) => repo.deleteExpense(a, id)),
        saveSale: (id, input) => run((a) => repo.saveSale(a, id, input)),
        deleteSale: (id) => run((a) => repo.deleteSale(a, id)),
        updateProfile: (pid, input) => run((a) => repo.updateProfile(a, pid, input)),
        reorderProfiles: (ids) => run((a) => repo.reorderProfiles(a, ids)),
        setResult: (id, r) => run((a) => repo.setResult(a, id, r)),
        setAppliedStore: (id, store) => run((a) => repo.setAppliedStore(a, id, store)),
        setFulfillment: (id, f) => run((a) => repo.setFulfillment(a, id, f)),
        revertFulfillment: (id, to) => run((a) => repo.revertFulfillment(a, id, to)),
        setLotterySkip: (id, v) => run((a) => repo.setLotterySkip(a, id, v)),
        setEventState: (id, s) => run((a) => repo.setEventState(a, id, s)),
        saveLottery: (id, input) => run((a) => repo.saveLottery(a, id, input)),
        duplicateLottery: (id, stores, opts) => run((a) => repo.duplicateLottery(a, id, stores, opts)),
        saveLotteryAndDuplicate: (input, stores, news) => run((a) => repo.saveLotteryAndDuplicate(a, input, stores, news)),
        archiveLottery: (id) => run((a) => repo.archiveLottery(a, id)),
        excludeLottery: (id, ex) => run((a) => repo.excludeLottery(a, id, ex)),
        groupLotteries: (ids, opts) => run((a) => repo.groupLotteries(a, ids, opts)),
        ungroupLottery: (id) => run((a) => repo.ungroupLottery(a, id)),
        dissolveLotteryGroup: (id) => run((a) => repo.dissolveLotteryGroup(a, id)),
        addManualPurchase: (input) => run((a) => repo.addManualPurchase(a, input)),
      },
    };
  }, [data, now, profileId, repo, run, selectProfile, load, notice, overrides]);

  // PWA: Service Worker を登録し、通知を許可済みの端末は選択プロフィールに通知先を付け替える
  // （プロフィール切替時に旧プロフィールへの紐付けを解除。通知は担当プロフィールの端末へのみ届く）
  const activeProfileId = value?.profile.id;
  useEffect(() => {
    if (!IS_SUPABASE_MODE) return;
    void registerServiceWorker();
  }, []);
  useEffect(() => {
    if (!IS_SUPABASE_MODE || !activeProfileId) return;
    if (!pushSupported() || Notification.permission !== "granted") return;
    let alive = true;
    currentSubscription().then((sub) => {
      if (alive && sub) void rebindPushSubscription(sub.endpoint, activeProfileId);
    });
    return () => {
      alive = false;
    };
  }, [activeProfileId]);

  if (loadError && !data) {
    return (
      <SplashScreen
        error={loadError}
        onRetry={() => {
          setLoadError(null);
          void load();
        }}
      />
    );
  }
  if (!value) {
    if (data && data.profiles.every((p) => p.active === false)) {
      return (
        <div className="p-6 text-sm text-muted-foreground" role="alert">
          有効なプロフィールがありません。設定のマスター管理で有効化してください。
        </div>
      );
    }
    return <SplashScreen />;
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
