-- Stage 9B: 登録済み抽選の自動更新の履歴（開発DBのみで検証。本番へは、利用者の承認・事前バックアップのうえ別途適用する）。
-- 目的: 収集が、十分な根拠のある変更（応募締切の延長・当選発表日の変更など）を自動で反映するとき、更新前後の値・情報源・時刻を残し、誤更新を元に戻せるようにする。
-- 方針: 追加のみ（NULL不可・既定は空配列の列1つ）。既存の行・応募・当選・購入・通知・期限には触れない。履歴は上限件数を超えたら古いものから落とす（アプリ側）。
alter table public.lotteries
  add column if not exists update_history jsonb not null default '[]'::jsonb check (jsonb_typeof(update_history) = 'array');
comment on column public.lotteries.update_history is '自動更新の履歴（jsonb配列）。要素: {id, at, keys, labels, before, after, sourceUrl, sourceKind, official, revertedAt?}。before/after は列名→値';
