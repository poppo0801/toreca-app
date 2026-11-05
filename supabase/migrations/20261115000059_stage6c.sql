-- Stage 6C: 受付前の抽選予告を追跡する設定（追加のみ。既存の設定値は変えない）
-- 「現在応募可能のみ」の意味は変えず、受付前の抽選予告を破棄せず追跡候補として保持するかを別の設定にする。初期値はON。
alter table public.collection_settings add column if not exists track_upcoming boolean not null default true;
