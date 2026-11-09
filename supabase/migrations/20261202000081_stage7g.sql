-- Stage 7G: 対戦記録のプロフィール別管理（追加のみ。既存の行・列は変更しない）
--  - profile_id        : 記録の持ち主（「自分」側）。既存のまま。NULL=所有者不明の未割当（勝手に特定せず、後から本人が自分の記録にできる）
--  - opponent_profile_id: アプリ内プロフィールとの対戦のとき、相手のプロフィール。1件だけ保存し、表示するプロフィールに応じて自分/相手・デッキ・勝敗を反転する
--      外部の相手は従来どおり opponent（名称・任意）に入れる
--  - op_id             : 登録操作の識別（再送・二重タップで二重登録しない）
alter table public.battle_records
  add column opponent_profile_id uuid,
  add column op_id uuid;
alter table public.battle_records
  add constraint battle_records_opponent_fk foreign key (opponent_profile_id, household_id) references public.profiles (id, household_id),
  add constraint battle_records_distinct_players check (opponent_profile_id is null or opponent_profile_id is distinct from profile_id),
  add constraint battle_records_shared_needs_owner check (opponent_profile_id is null or profile_id is not null);
create unique index battle_records_op_uniq on public.battle_records (household_id, op_id) where op_id is not null;
create index battle_records_opponent_idx on public.battle_records (household_id, opponent_profile_id) where opponent_profile_id is not null;
