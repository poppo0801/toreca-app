-- 定期収集を1日2回まで設定できるようにする（2回目の実行時刻。未設定=1日1回）。
-- 追加のみ。既存の設定・履歴は変更しない（2回目は利用者が設定画面で選ぶ）。
alter table public.collection_settings
  add column if not exists schedule_hour2_jst int check (schedule_hour2_jst is null or schedule_hour2_jst between 0 and 23);
