import { OP_META, SWIPE_MAP, SWIPE_OPS_ENABLED } from "@/lib/swipe-actions";
import type { Tab } from "@/lib/lottery-view";

const ROWS: { tab: Tab; label: string }[] = [
  { tab: "all", label: "全情報" },
  { tab: "managed", label: "要チェック" },
  { tab: "applied", label: "応募済み" },
  { tab: "won", label: "当選" },
];

/** 「？」ガイドに出すスワイプ操作の早見表（タブごとに1行）。割り当てと同じ定義から作るので、操作を無効にすると表示からも消える */
export function SwipeGuide({ className }: { className?: string }) {
  return (
    <ul className={className} aria-label="スワイプ操作" data-testid="swipe-guide">
      {ROWS.map(({ tab, label }) => {
        const m = SWIPE_MAP[tab];
        const parts = [
          m.right && SWIPE_OPS_ENABLED[m.right] ? `右→${OP_META[m.right].hint.replace("★ ", "★")}` : null,
          m.left && SWIPE_OPS_ENABLED[m.left] ? `左→${OP_META[m.left].hint.replace("★ ", "★")}` : null,
        ].filter(Boolean);
        return (
          <li key={tab} className="flex gap-1.5">
            <span className="w-16 shrink-0 font-medium">{label}</span>
            <span className="text-muted-foreground">{parts.join("／") || "—"}</span>
          </li>
        );
      })}
    </ul>
  );
}
