"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LotteryInput } from "@/lib/lottery-input";
import type { ExpenseInput, SaleInput } from "@/lib/finance-input";
import type { ProfileSettingsInput } from "@/lib/server/lottery-service";
import type { ManualPurchaseInput } from "@/lib/purchase-input";
import { createRepository } from "@/services";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { rebindPushSubscription } from "@/app/(app)/settings/notifications/actions";
import { copyProfileSettings, saveProfileSettings } from "@/app/(app)/settings/profile-settings-actions";
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
  reload: () => Promise<AppData | null>;
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
    setApplied: (lotteryId: string, accountId: string, v: boolean, selectedItemId?: string | null) => Promise<Outcome>;
    setItemResults: (applicationId: string, results: { itemId: string; result: ResultStatus }[]) => Promise<Outcome>;
    saveExpense: (id: string | null, input: ExpenseInput) => Promise<Outcome>;
    deleteExpense: (id: string) => Promise<Outcome>;
    saveSale: (id: string | null, input: SaleInput) => Promise<Outcome>;
    deleteSale: (id: string) => Promise<Outcome>;
    updateProfile: (profileId: string, input: ProfileSettingsInput) => Promise<Outcome>;
    reorderProfiles: (ids: string[]) => Promise<Outcome>;
    setResult: (applicationId: string, r: ResultStatus) => Promise<Outcome>;
    setFulfillment: (applicationId: string, f: FulfillmentStatus) => Promise<Outcome>;
    setLotterySkip: (lotteryId: string, v: boolean) => Promise<Outcome>;
    setEventState: (lotteryId: string, s: EventState) => Promise<Outcome>;
    saveLottery: (id: string | null, input: LotteryInput) => Promise<Outcome>;
    duplicateLottery: (lotteryId: string, storeIds: string[]) => Promise<Outcome>;
    archiveLottery: (lotteryId: string) => Promise<Outcome>;
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

  const load = useCallback(async (): Promise<AppData | null> => {
    const start = new Date();
    try {
      const d = await withTimeout(repo.load(start), LOAD_TIMEOUT_MS);
      hasData.current = true;
      setData(d);
      setNow(start);
      setLoadError(null);
      return d;
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : "データの取得に失敗しました";
      if (hasData.current) setNotice(`最新のデータを取得できませんでした（${message}）`);
      else setLoadError(message);
      return null;
    }
  }, [repo]);

  // 初回ロード。以降はページ遷移のたびに再取得（マスター管理での変更を反映するため）
  // 設定の中のページ同士の移動（一覧 ⇄ 下のページ）は、データを取り直さない（画面のちらつき・無駄な通信を避ける）
  const prevPath = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPath.current;
    prevPath.current = pathname;
    if (firstLoad.current) firstLoad.current = false;
    else if (prev?.startsWith("/settings") && pathname.startsWith("/settings") && hasData.current) return;
    void load();
  }, [load, pathname]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectProfile = useCallback((id: string) => {
    localDeviceStore.setProfileId(id);
    setProfileId(id);
  }, []);

  const run = useCallback(
    async (fn: (actor: string) => Promise<Outcome>): Promise<Outcome> => {
      const actor = profileId ?? data?.profiles.find((p) => p.active !== false)?.id;
      if (!actor) return { ok: false, error: "操作プロフィールが選択されていません" };
      let res: Outcome;
      try {
        res = await fn(actor);
      } catch {
        res = { ok: false, error: "通信に失敗しました。接続を確認して再度お試しください" };
      }
      if (res.ok) {
        setData(res.data);
        setNotice(null);
      } else {
        setNotice(res.error);
      }
      return res;
    },
    [profileId, data],
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
        setManaged: (id, v) => run((a) => repo.setManaged(a, id, v)),
        setApplied: (id, acc, v, sel) => run((a) => repo.setApplied(a, id, acc, v, sel)),
        setItemResults: (id, r) => run((a) => repo.setItemResults(a, id, r)),
        saveExpense: (id, input) => run((a) => repo.saveExpense(a, id, input)),
        deleteExpense: (id) => run((a) => repo.deleteExpense(a, id)),
        saveSale: (id, input) => run((a) => repo.saveSale(a, id, input)),
        deleteSale: (id) => run((a) => repo.deleteSale(a, id)),
        updateProfile: (pid, input) => run((a) => repo.updateProfile(a, pid, input)),
        reorderProfiles: (ids) => run((a) => repo.reorderProfiles(a, ids)),
        setResult: (id, r) => run((a) => repo.setResult(a, id, r)),
        setFulfillment: (id, f) => run((a) => repo.setFulfillment(a, id, f)),
        setLotterySkip: (id, v) => run((a) => repo.setLotterySkip(a, id, v)),
        setEventState: (id, s) => run((a) => repo.setEventState(a, id, s)),
        saveLottery: (id, input) => run((a) => repo.saveLottery(a, id, input)),
        duplicateLottery: (id, stores) => run((a) => repo.duplicateLottery(a, id, stores)),
        archiveLottery: (id) => run((a) => repo.archiveLottery(a, id)),
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
