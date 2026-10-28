import type { DeviceStore } from "@/services/types";

const KEY = "tcg.device.profileId";

/** localStorage が使えない環境（プライベートウィンドウ等）でも落とさない。 */
export const localDeviceStore: DeviceStore = {
  getProfileId() {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  setProfileId(id) {
    try {
      window.localStorage.setItem(KEY, id);
    } catch {
      /* 保存できなくても動作は継続 */
    }
  },
};

export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(`tcg.pref.${key}`);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 画面の一時的な状態（タブ・フィルターなど）。タブを閉じるまで保持し、保存できなくても動作は続ける */
export function readSession<T>(key: string, validate: (v: unknown) => T | null): T | null {
  try {
    const raw = window.sessionStorage.getItem(`tcg.session.${key}`);
    return raw ? validate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(`tcg.session.${key}`, JSON.stringify(value));
  } catch {
    /* noop */
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(`tcg.pref.${key}`, value);
  } catch {
    /* noop */
  }
}
