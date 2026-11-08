"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setChainStoreSelectDefaultAction } from "@/app/(app)/settings/masters/chain-settings-actions";

/** 系列の「店舗選択式を基本とする」設定の切り替え（系列行のメニュー内）。ON/OFFは1タップで切り替わる */
export function ChainStoreSelectToggle({ chainId, name, on }: { chainId: string; name: string; on: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        aria-pressed={on}
        aria-label={`${name}の店舗選択式を基本とする設定を${on ? "解除" : "有効に"}する`}
        data-testid="chain-store-select-toggle"
        onClick={() =>
          start(async () => {
            const r = await setChainStoreSelectDefaultAction(chainId, !on);
            if (r.ok) {
              setError(null);
              router.refresh();
            } else setError(r.error);
          })
        }
      >
        {on ? "店舗選択式: ON" : "店舗選択式: OFF"}
      </Button>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </>
  );
}
