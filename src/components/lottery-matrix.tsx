"use client";

import { useApp } from "@/components/app-provider";
import { STATUS_META } from "@/components/lottery-card";
import { ProfileAvatar } from "@/components/profile-avatar";
import { judgeAccount } from "@/lib/eligibility";
import { cn } from "@/lib/utils";
import type { AccountStatus, Lottery } from "@/types/domain";

const NEEDS_ACTION: AccountStatus[] = ["eligible_unapplied", "needs_review"];

/** 応募状況マトリクス。行=抽選、列=応募アカウント。判定は judgeAccount と共通。 */
export function LotteryMatrix({ lotteries, actionOnly }: { lotteries: Lottery[]; actionOnly: boolean }) {
  const { data, now } = useApp();
  const accounts = data.accounts;

  const rows = lotteries
    .map((l) => ({
      l,
      cells: accounts.map((acc) => (acc.chainId === l.chainId ? judgeAccount(data, l, acc, now) : null)),
    }))
    .filter((r) => !actionOnly || r.cells.some((c) => c && NEEDS_ACTION.includes(c.status)));

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border" data-testid="matrix">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="bg-muted">
            <th scope="col" className="sticky left-0 z-10 bg-muted px-2 py-2 text-left text-xs">
              抽選
            </th>
            {accounts.map((acc) => {
              const owner = data.profiles.find((p) => p.id === acc.profileId)!;
              const chain = data.chains.find((c) => c.id === acc.chainId);
              return (
                <th key={acc.id} scope="col" className="px-2 py-2 text-xs font-normal">
                  <div className="flex flex-col items-center gap-0.5">
                    <ProfileAvatar profile={owner} size="sm" />
                    <span className="whitespace-nowrap text-muted-foreground">{chain?.name}</span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ l, cells }) => {
            const chain = data.chains.find((c) => c.id === l.chainId);
            const store = data.stores.find((s) => s.id === l.storeId);
            return (
              <tr key={l.id} className="border-t">
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-background px-2 py-2 text-left text-xs font-normal whitespace-nowrap"
                >
                  {chain?.name} {store?.name}
                </th>
                {cells.map((c, i) => (
                  <td key={accounts[i].id} className="px-2 py-2 text-center">
                    {c ? (
                      <span
                        title={c.reason}
                        className={cn(
                          "inline-flex min-w-14 items-center justify-center gap-0.5 rounded border px-1 py-0.5 text-xs",
                          NEEDS_ACTION.includes(c.status) && "border-primary font-bold",
                        )}
                      >
                        <span aria-hidden="true">{STATUS_META[c.status].symbol}</span>
                        {STATUS_META[c.status].label}
                      </span>
                    ) : (
                      <span className="text-muted-foreground" aria-label="該当なし">
                        ・
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
