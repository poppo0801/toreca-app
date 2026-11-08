-- Stage 7E: 購入記録の標準画像（品目別: シングルカード・その他）。追加のみ（既存の表・行は変更しない）。
--  - 商品個別の画像が無い購入記録に表示する共通の画像を、世帯ごと・品目ごとに1つ持つ。購入記録ごとに画像を複製せず、この1行を参照する
--  - 画像本体は既存の非公開バケット product-images（自世帯フォルダのみ）に保存する。ここには保存先と内容ハッシュだけを持つ
create table public.item_default_images (
  household_id uuid not null references public.households (id) on delete cascade,
  category text not null check (category in ('single_card', 'other')),
  storage_path text not null check (char_length(storage_path) between 1 and 300),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  primary key (household_id, category)
);

alter table public.item_default_images enable row level security;
revoke all on public.item_default_images from anon, authenticated;
grant select, insert, update, delete on public.item_default_images to authenticated, service_role;
create policy item_default_images_select on public.item_default_images for select to authenticated using (public.is_household_member(household_id));
create policy item_default_images_insert on public.item_default_images for insert to authenticated with check (public.is_household_member(household_id));
create policy item_default_images_update on public.item_default_images for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy item_default_images_delete on public.item_default_images for delete to authenticated using (public.is_household_member(household_id));
