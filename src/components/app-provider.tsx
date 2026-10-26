"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LotteryInput } from "@/lib/lottery-input";
import type { ManualPurchaseInput } from "@/lib/purchase-input";
import { createRepository } from "@/services";
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
  reload: () => Promise<void>;
  /** 操作失敗の通知（画面全体は止めない） */
  notice: string | null;
  dismissNotice: () => void;
  actions: {
    setManaged: (lotteryId: string, v: boolean) => Promise<Outcome>;
    setApplied: (lotteryId: string, accountId: string, v: boolean) => Promise<Outcome>;
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
export function AppProvider({ children }: { children: React.ReactNode }) {
  const [repo] = useState<LotteryRepository>(() => createRepository());
  const pathname = usePathname();
  const [data, setData] = useState<AppData | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const start = new Date();
    try {
      const d = await repo.load(start);
      setData(d);
      setNow(start);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "データの取得に失敗しました");
    }
  }, [repo]);

  // 初回ロード。以降はページ遷移のたびに再取得（マスター管理での変更を反映するため）
  useEffect(() => {
    if (firstLoad.current) firstLoad.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部データの取得
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

  const value = useMemo<AppContextValue | null>(() => {
    if (!data || !now) return null;
    const active = data.profiles.filter((p) => p.active !== false);
    if (active.length === 0) return null;
    const saved = profileId ?? localDeviceStore.getProfileId();
    const profile = active.find((p) => p.id === saved) ?? active[0];
    return {
      data,
      now,
      profile,
      selectProfile,
      persistent: repo.persistent,
      reload: load,
      notice,
      dismissNotice: () => setNotice(null),
      actions: {
        setManaged: (id, v) => run((a) => repo.setManaged(a, id, v)),
        setApplied: (id, acc, v) => run((a) => repo.setApplied(a, id, acc, v)),
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
  }, [data, now, profileId, repo, run, selectProfile, load, notice]);

  if (loadError) {
    return (
      <p role="alert" className="p-6 text-sm text-danger">
        {loadError}
      </p>
    );
  }
  if (!value) {
    return (
      <div className="p-6 text-sm text-muted-foreground" aria-busy="true">
        {data && data.profiles.every((p) => p.active === false)
          ? "有効なプロフィールがありません。設定のマスター管理で有効化してください。"
          : "読み込み中…"}
      </div>
    );
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
