/**
 * 抽選詳細の任意の「公式」バッジ（Stage 10P・純関数）。**公式性は登録・通知・補完の条件ではなく、このバッジの表示にだけ使う**。
 *  - 表示してよいのは、**当該抽選について実際に公式発信元と確認できたソースが存在する**とき。確認できなければ何も表示しない（「非公式」「偽物」などの否定的ラベルは付けない・付けられない）。
 *  - バッジの意味は「公式情報源の裏付けあり」に限る。抽選全体の正確性を保証しない。
 *  - **発信者の確認（publisher）と、当該抽選の告知の確認（announcement）を分離**する。両方が必要。ソースURLがあるだけ・プロフィールの自己申告・名称類似・ロゴでは付けない。
 *  - 発信者の確認の根拠は複数（相互リンクは有力な1つで、唯一ではない）: reciprocal_link／official_page_itself（公式と確認済みのホストのページ自身の告知）／trusted_site_links（公式と確認済みのサイトからの発信元リンク）／store_public_info（店舗の確実な公開情報＝店舗マスターに登録された公式サイトのホスト）。
 *  - 根拠と最終確認日時を保持し、詳細画面から確認できる。判別できなければバッジなし。バッジのための高額な探索はしない（既に取得した情報の組み合わせだけで判定する）。
 */
export type PublisherBasisCode = "reciprocal_link" | "official_page_itself" | "trusted_site_links" | "store_public_info";
export const STRONG_PUBLISHER_BASES: readonly PublisherBasisCode[] = ["reciprocal_link", "official_page_itself", "trusted_site_links", "store_public_info"];

export interface BadgeSourceEvidence {
  /** 情報源の識別（原文・URLは持たない） */
  sourceId: string;
  /** 表示用のホスト名（URL全体ではない） */
  host: string | null;
  /** 発信者の確認の根拠（空なら未確認） */
  publisherBasis: { code: PublisherBasisCode; checkedAt: string }[];
  /** この抽選の告知であると、原文（または照合済みの画像）の根拠で確認できているか */
  announcementConfirmed: boolean;
  announcementCheckedAt: string | null;
}

export interface OfficialBadgeData {
  show: true;
  /** 根拠（詳細画面で確認できる） */
  sources: { host: string | null; basis: PublisherBasisCode[]; publisherCheckedAt: string; announcementCheckedAt: string }[];
  /** 最終確認日時（根拠のうち最も新しい確認） */
  lastCheckedAt: string;
}

/** バッジの判定。表示しない場合は null（何も表示しない）。maxAgeDays を過ぎた発信者の確認は古いものとして扱い、表示しない（再確認が必要） */
export function deriveOfficialBadge(sources: BadgeSourceEvidence[], now: Date, maxAgeDays = 180): OfficialBadgeData | null {
  const fresh = (iso: string): boolean => Number.isFinite(Date.parse(iso)) && now.getTime() - Date.parse(iso) <= maxAgeDays * 86_400_000;
  const ok = sources
    .filter((s) => s.announcementConfirmed && s.announcementCheckedAt)
    .map((s) => ({ s, basis: s.publisherBasis.filter((b) => STRONG_PUBLISHER_BASES.includes(b.code) && fresh(b.checkedAt)) }))
    .filter((x) => x.basis.length > 0);
  if (!ok.length) return null;
  const rows = ok.map(({ s, basis }) => ({ host: s.host, basis: [...new Set(basis.map((b) => b.code))].sort() as PublisherBasisCode[], publisherCheckedAt: basis.map((b) => b.checkedAt).sort().at(-1) as string, announcementCheckedAt: s.announcementCheckedAt as string }));
  const lastCheckedAt = rows.flatMap((r) => [r.publisherCheckedAt, r.announcementCheckedAt]).sort().at(-1) as string;
  return { show: true, sources: rows, lastCheckedAt };
}
