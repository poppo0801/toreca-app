"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { localDeviceStore } from "@/services/local-device-store";
import { createRepository } from "@/services";
import type { LotteryRepository } from "@/services/types";
import type { AppData, FulfillmentStatus, Profile, ResultStatus } from "@/types/domain";

interface AppContextValue {
  data: AppData;
  now: Date;
  profile: Profile;
  selectProfile: (id: string) => void;
  actions: {
    setManaged: (lotteryId: string, v: boolean) => void;
    setApplied: (lotteryId: string, accountId: string, v: boolean) => void;
    setResult: (applicationId: string, r: ResultStatus) => void;
    setFulfillment: (applicationId: string, f: FulfillmentStatus) => void;
    setLotterySkip: (lotteryId: string, v: boolean) => void;
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
export function AppProvider({
  children,
  profiles,
}: {
  children: React.ReactNode;
  /** Supabaseモード: DBの実プロフィール。未指定ならデモのA/B/C */
  profiles?: Profile[];
}) {
  const [{ repo, initError }] = useState(() => {
    try {
      return { repo: createRepository(profiles) as LotteryRepository | null, initError: null as string | null };
    } catch (e) {
      return { repo: null, initError: e instanceof Error ? e.message : "初期化に失敗しました" };
    }
  });
  const [data, setData] = useState<AppData | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [runError, setError] = useState<string | null>(null);
  const error = initError ?? runError;

  useEffect(() => {
    let alive = true;
    if (!repo) return;
    const start = new Date();
    repo.load(start).then((d) => {
      if (!alive) return;
      const saved = localDeviceStore.getProfileId();
      setProfileId(d.profiles.some((p) => p.id === saved) ? saved : d.profiles[0].id);
      setNow(start);
      setData(d);
    });
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [repo]);

  const selectProfile = useCallback((id: string) => {
    localDeviceStore.setProfileId(id);
    setProfileId(id);
  }, []);

  const run = useCallback(
    (fn: (repo: LotteryRepository, actor: string) => Promise<AppData>) => {
      if (!repo || !profileId) return;
      fn(repo, profileId)
        .then(setData)
        .catch((e) => setError(e instanceof Error ? e.message : "保存に失敗しました"));
    },
    [repo, profileId],
  );

  const value = useMemo<AppContextValue | null>(() => {
    if (!data || !now || !profileId) return null;
    const profile = data.profiles.find((p) => p.id === profileId) ?? data.profiles[0];
    return {
      data,
      now,
      profile,
      selectProfile,
      actions: {
        setManaged: (id, v) => run((r, a) => r.setManaged(a, id, v)),
        setApplied: (id, acc, v) => run((r, a) => r.setApplied(a, id, acc, v)),
        setResult: (id, res) => run((r, a) => r.setResult(a, id, res)),
        setFulfillment: (id, f) => run((r, a) => r.setFulfillment(a, id, f)),
        setLotterySkip: (id, v) => run((r, a) => r.setLotterySkip(a, id, v)),
      },
    };
  }, [data, now, profileId, run, selectProfile]);

  if (error) {
    return (
      <p role="alert" className="p-6 text-sm text-danger">
        {error}
      </p>
    );
  }
  if (!value) {
    return (
      <div className="p-6 text-sm text-muted-foreground" aria-busy="true">
        読み込み中…
      </div>
    );
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
