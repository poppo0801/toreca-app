/**
 * 内部管理の予告（Stage 9H-3N）を、通常の抽選候補・件数・通知から除くための絞り込み（PostgREST の or 条件）。
 * 通常の候補に出すのは、予告ではないもの、または昇格・中止・終了した予告。有効・延期の予告（announcement.ts の isInternalTeaser）だけを除く。
 * JSON の項目が無い候補（予告の追跡をしていない候補）は、そのまま表示する。
 */
export const NOT_INTERNAL_TEASER = "draft->tracking->>announcement.is.null,draft->tracking->>announcement.neq.teaser,draft->tracking->>outcome.in.(promoted,cancelled,expired)";
/** 内部管理の予告だけを取り出す条件（管理・診断画面用）。PostgREST: announcement=teaser かつ outcome が有効・延期・未設定 */
export const INTERNAL_TEASER_EQ = "draft->tracking->>announcement";
