"use client";

import { useState } from "react";
import type { OfficialBadgeData } from "@/lib/judgment/xsource/badge";

const BASIS_LABEL: Record<string, string> = {
  reciprocal_link: "公式サイトと発信元の相互リンク",
  official_page_itself: "公式サイト自身の告知",
  trusted_site_links: "公式サイトからの発信元リンク",
  store_public_info: "店舗の公開情報",
};
const fmt = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/**
 * 抽選詳細の任意の「公式」バッジ（Stage 10P）。意味は「公式情報源の裏付けあり」だけで、抽選全体の正確性を保証しない。
 * 確認できていなければ（badge が無い・null）**何も表示しない**。否定的なラベル（非公式・偽物など）は出さない。タップで根拠と最終確認日時を表示する。
 */
export function OfficialBadge({ badge }: { badge?: OfficialBadgeData | null }) {
  const [open, setOpen] = useState(false);
  if (!badge?.show) return null;
  return (
    <span className="ml-1 inline-block align-middle" data-testid="official-badge">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="rounded border border-success px-1 py-0.5 text-[10px] font-medium text-success">
        公式
      </button>
      {open && (
        <span className="mt-1 block rounded border bg-card p-2 text-[11px] font-normal text-muted-foreground" data-testid="official-badge-detail">
          公式情報源の裏付けがあります（抽選の内容の正確性を保証するものではありません）。
          {badge.sources.map((s, i) => (
            <span key={i} className="mt-1 block">
              {s.host ?? "（ホスト不明）"}：{s.basis.map((b) => BASIS_LABEL[b] ?? b).join("・")}／発信元の確認 {fmt(s.publisherCheckedAt)}／告知の確認 {fmt(s.announcementCheckedAt)}
            </span>
          ))}
          <span className="mt-1 block">最終確認 {fmt(badge.lastCheckedAt)}</span>
        </span>
      )}
    </span>
  );
}
