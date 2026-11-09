-- Stage 7K: 購入記録を「開封した商品・購入したシングルカード」の記録へ再設計（追加のみ。既存の購入・収支・BOX在庫の履歴は変更しない）
--  - BOXの開封実績は、既存のBOX在庫の履歴（box_movements の open 行と取り消し行）から導出する。新しい支出は作らない。
--  - 単品パック・デッキ・セット商品など、BOXコレクションを経由しない開封・使用開始は opening_records に記録する（直接登録、または不明な購入の確認）。
--    収支（purchases）には何も書かない。購入明細との関連は purchase_item_id（二重計上の防止・元の購入との関連の保持）。
--  - 取り消しは archived_at（物理削除しない）。金額は開封分の実際の購入金額（市場相場は使わない）。不明は NULL（0円とは別）。
create table public.opening_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  product_id uuid,
  -- マスター未登録の商品名（product_id が無いとき、または商品が後から整理されたとき）
  label text not null default '' check (char_length(label) <= 120),
  quantity int not null check (quantity between 1 and 9999),
  -- 開封・使用開始の単位（BOXはBOXコレクションの開封で記録するため対象外）
  unit text not null check (unit in ('pack', 'set', 'piece')),
  opened_on date not null,
  amount_yen int check (amount_yen is null or amount_yen between 0 and 100000000),
  profile_id uuid,
  -- 元の購入明細（不明な購入を開封済みと確認した場合）。購入が削除されても記録は残す
  purchase_item_id uuid,
  note text not null default '' check (char_length(note) <= 300),
  -- 登録操作の識別（再送・二重タップで二重登録しない）
  op_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_profile_id uuid,
  unique (id, household_id),
  check (product_id is not null or label <> ''),
  foreign key (product_id, household_id) references public.products (id, household_id) on delete set null (product_id),
  foreign key (purchase_item_id, household_id) references public.purchase_items (id, household_id) on delete set null (purchase_item_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete set null (profile_id)
);
create unique index opening_records_op_uniq on public.opening_records (household_id, op_id) where op_id is not null;
create index opening_records_period_idx on public.opening_records (household_id, opened_on desc) where archived_at is null;
create index opening_records_item_idx on public.opening_records (purchase_item_id) where purchase_item_id is not null;

create trigger opening_records_touch before update on public.opening_records for each row execute function public.touch_updated_at();

alter table public.opening_records enable row level security;
revoke all on public.opening_records from anon, authenticated;
grant select, insert, update on public.opening_records to authenticated;
grant select, insert, update, delete on public.opening_records to service_role;
create policy opening_records_select on public.opening_records for select to authenticated using (public.is_household_member(household_id));
create policy opening_records_insert on public.opening_records for insert to authenticated with check (public.is_household_member(household_id));
create policy opening_records_update on public.opening_records for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
