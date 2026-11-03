-- Stage 5P（追加のみ。既存データは変更しない）
-- 1) 購入明細の数量単位に「個」(piece) を追加（売却 sales は既に piece 可）
alter table public.purchase_items drop constraint if exists purchase_items_unit_check;
alter table public.purchase_items add constraint purchase_items_unit_check check (unit in ('box', 'pack', 'set', 'piece'));

-- 2) メイン／サブユーザー。既存のユーザーはすべてメイン（従来どおり全系列）として移行する。
--    サブの対象系列は既存の profile_target_rules（mode='allow' かつ store_id が null の行）を使う（新しい表は作らない）。
--    種別・対象系列を変えても、応募・当落・購入などの履歴は変更しない。
alter table public.profiles
  add column kind text not null default 'main' check (kind in ('main', 'sub'));
