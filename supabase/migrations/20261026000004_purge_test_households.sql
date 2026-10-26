-- テストデータ専用の削除経路。
--  * 対象は、メールが rls-test-%@example.invalid のユーザーだけが所属する世帯に限定（関数内で毎回再確認）。
--  * 監査ログの追記専用は維持。削除は「purge_test_households() の実行中」かつ「テスト世帯」の DELETE のみ許可。
--    UPDATE / TRUNCATE は常に禁止。本番世帯の行は、この経路では削除できない。
--  * 関数の実行権限は service_role のみ（anon / authenticated は不可）。

create function public.is_test_household(hid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.households h
    join auth.users u on u.id = h.owner_auth_user_id
    where h.id = hid and u.email like 'rls-test-%@example.invalid'
  ) and not exists (
    select 1 from public.household_members m
    join auth.users mu on mu.id = m.user_id
    where m.household_id = hid and mu.email not like 'rls-test-%@example.invalid'
  );
$$;
revoke all on function public.is_test_household(uuid) from public, anon, authenticated;
grant execute on function public.is_test_household(uuid) to service_role;

create or replace function public.forbid_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  purge text := coalesce(current_setting('app.purge_household', true), '');
begin
  if tg_op = 'DELETE' and purge <> '' and old.household_id::text = purge
     and public.is_test_household(old.household_id) then
    return old;
  end if;
  raise exception 'audit_logs は追記専用です';
end;
$$;

-- 削除中のテスト世帯については監査ログを新規に作らない（削除のたびに行が増えるのを防ぐ）
create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  if coalesce(current_setting('app.purge_household', true), '') = (rec ->> 'household_id') then
    return null;
  end if;
  insert into public.audit_logs
    (household_id, actor_profile_id, actor_auth_user_id, entity_type, entity_id, action, before_json, after_json)
  values (
    (rec ->> 'household_id')::uuid,
    case when tg_op = 'DELETE' then null else nullif(rec ->> 'updated_by_profile_id', '')::uuid end,
    (select auth.uid()),
    tg_table_name,
    nullif(rec ->> 'id', '')::uuid,
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return null;
end;
$$;

create function public.purge_test_households()
returns table (purged_household uuid, owner_email text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select h.id as hid, u.email as email
    from public.households h
    join auth.users u on u.id = h.owner_auth_user_id
    where public.is_test_household(h.id)
  loop
    -- トランザクション内のみ有効。この世帯の削除だけを許可する目印。
    perform set_config('app.purge_household', r.hid::text, true);

    delete from public.audit_logs where household_id = r.hid;
    delete from public.profile_target_rules where household_id = r.hid;
    delete from public.service_accounts where household_id = r.hid;
    delete from public.identities where household_id = r.hid;
    delete from public.family_groups where household_id = r.hid;
    delete from public.address_groups where household_id = r.hid;
    delete from public.product_prices where household_id = r.hid;
    delete from public.product_aliases where household_id = r.hid;
    delete from public.products where household_id = r.hid;
    delete from public.stores where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
    update public.profiles set updated_by_profile_id = null where household_id = r.hid;
    delete from public.profiles where household_id = r.hid;
    delete from public.household_members where household_id = r.hid;
    delete from public.households where id = r.hid;

    perform set_config('app.purge_household', '', true);
    purged_household := r.hid;
    owner_email := r.email;
    return next;
  end loop;
end;
$$;
revoke all on function public.purge_test_households() from public, anon, authenticated;
grant execute on function public.purge_test_households() to service_role;
