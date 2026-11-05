-- Stage 6J: メイン／サブユーザーの紐づけ（追加のみ。既存のプロフィール・応募・当落・購入・受取の履歴は変更しない）
-- サブユーザーは同一世帯のメインユーザー1人に紐づけられる。メインの「応募済み」「当選」タブには、紐づくサブの履歴も表示される。
--  - サブ1人につきメイン1人（NULL=未紐づけ）。メイン1人に複数のサブを紐づけ可
--  - メインを紐づけ先にできるのはサブだけ（サブ同士・メイン→メインの紐づけは不可。よって循環も起きない）
--  - 紐づけ先は同一世帯（複合外部キー）
--  - メインへ戻すと紐づけは外れる。紐づくサブがいるメインをサブにはできない
--  - 紐づけの変更・解除は、応募・当落・購入・受取の履歴に影響しない（履歴は応募アカウントの所有プロフィールに残る）
alter table public.profiles add column main_profile_id uuid;
alter table public.profiles
  add constraint profiles_main_link_fk foreign key (main_profile_id, household_id) references public.profiles (id, household_id) on delete set null (main_profile_id);
alter table public.profiles add constraint profiles_main_link_not_self check (main_profile_id is null or main_profile_id <> id);

create function public.profiles_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_kind text;
begin
  if new.kind = 'main' then
    new.main_profile_id := null;
  end if;
  if new.main_profile_id is not null then
    if new.kind <> 'sub' then
      raise exception 'only sub profiles can be linked to a main profile' using errcode = '23514';
    end if;
    select kind into target_kind from public.profiles where id = new.main_profile_id and household_id = new.household_id;
    if target_kind is distinct from 'main' then
      raise exception 'link target must be a main profile in the same household' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.kind = 'sub' and old.kind is distinct from 'sub' then
    if exists (select 1 from public.profiles where main_profile_id = new.id) then
      raise exception 'a main profile with linked sub profiles cannot become a sub profile' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger profiles_link_guard before insert or update on public.profiles for each row execute function public.profiles_link_guard();

-- 起動時の収集結果ポップアップを表示するプロフィール（固定ID）。表示名ではなくIDで識別するため、名前を変えても対象は変わらない。
-- NULL=ポップアップを表示しない。既存データの移行: 表示名が「はとむぎ」の有効なプロフィールが世帯内にちょうど1つだけあるときに、そのIDを設定する。
alter table public.collection_settings add column result_notice_profile_id uuid;
alter table public.collection_settings
  add constraint collection_settings_notice_profile_fk foreign key (result_notice_profile_id, household_id) references public.profiles (id, household_id) on delete set null (result_notice_profile_id);
update public.collection_settings cs
set result_notice_profile_id = (select p.id from public.profiles p where p.household_id = cs.household_id and p.label = 'はとむぎ' and p.active)
where (select count(*) from public.profiles p where p.household_id = cs.household_id and p.label = 'はとむぎ' and p.active) = 1;
