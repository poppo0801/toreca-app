"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * 「要手動確認」から候補の編集フォームを直接開くための橋渡し（Stage 6J）。
 * 要手動確認の一覧が候補IDを渡し、収集候補側（編集フォームを持つ）が受け取って開く。収集候補の一覧へ移動・スクロールしない。
 * プロバイダーが無い画面（テストなど）では何もしない。
 */
interface Ctx {
  id: string | null;
  request: (candidateId: string) => void;
  clear: () => void;
}
const EditRequestContext = createContext<Ctx | null>(null);

export function EditRequestProvider({ children }: { children: React.ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  const request = useCallback((candidateId: string) => setId(candidateId), []);
  const clear = useCallback(() => setId(null), []);
  const value = useMemo(() => ({ id, request, clear }), [id, request, clear]);
  return <EditRequestContext.Provider value={value}>{children}</EditRequestContext.Provider>;
}

export const useEditRequest = (): Ctx | null => useContext(EditRequestContext);
