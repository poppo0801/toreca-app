-- Stage 5B: 店舗の往復交通費・メモ、世帯設定（自宅の位置・カード表示項目・距離区分・AI予算）、AI利用ログのモデル名。
-- 追加のみ。既存データは変更しない。

-- ---------------------------------------------------------------- 店舗
-- 住所(address_optional)・緯度経度・最寄駅・駐車場メモは既存。往復交通費と店舗メモを追加し、緯度経度の範囲を制約にする。
alter table public.stores
  add column round_trip_fare int check (round_trip_fare is null or round_trip_fare between 0 and 1000000),
  add column memo text not null default '' check (char_length(memo) <= 1000);
alter table public.stores
  add constraint stores_latitude_range check (latitude is null or latitude between -90 and 90),
  add constraint stores_longitude_range check (longitude is null or longitude between -180 and 180),
  -- 緯度と経度は両方あるか、両方ないか（片方だけの位置は無効）
  add constraint stores_lat_lng_pair check ((latitude is null) = (longitude is null));

-- ---------------------------------------------------------------- AI利用ログ: 使用モデル（費用の推定に使う）
alter table public.ai_extraction_logs
  add column model text check (model is null or char_length(model) <= 60);

-- ---------------------------------------------------------------- 世帯設定
-- 自宅の住所・位置は家族内のプライベートな情報。次のように扱いを絞る:
--  * 住所の文字列(home_address)は通常の参照では返さない（列の参照権限を与えない）。設定画面が get_home_address() で明示的に読む。
--  * 変更はすべて RPC（検証つき・自世帯のみ）。テーブルへの直接の書き込みは許可しない。
--  * 操作履歴には「何が変わったか（項目名）」だけを残し、住所・緯度経度の値は残さない。
create table public.household_settings (
  household_id uuid primary key references public.households (id) on delete cascade,
  home_address text check (home_address is null or char_length(home_address) <= 200),
  home_lat numeric(9, 6) check (home_lat is null or home_lat between -90 and 90),
  home_lng numeric(9, 6) check (home_lng is null or home_lng between -180 and 180),
  -- 自宅の位置が変わったら、店舗の往復交通費の見直しを促す（利用者が確認して外す）
  travel_review_needed boolean not null default false,
  card_display jsonb not null default '{}'::jsonb check (jsonb_typeof(card_display) = 'object'),
  distance_bands_km jsonb not null default '[5, 15, 30, 60]'::jsonb check (jsonb_typeof(distance_bands_km) = 'array' and jsonb_array_length(distance_bands_km) = 4),
  ai_monthly_budget_jpy int not null default 3000 check (ai_monthly_budget_jpy between 0 and 1000000),
  auto_ai_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  check ((home_lat is null) = (home_lng is null)),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
alter table public.household_settings enable row level security;
revoke all on public.household_settings from anon, authenticated;
grant select (household_id, home_lat, home_lng, travel_review_needed, card_display, distance_bands_km, ai_monthly_budget_jpy, auto_ai_enabled, updated_at) on public.household_settings to authenticated;
grant select, insert, update, delete on public.household_settings to service_role;
create policy household_settings_select on public.household_settings for select to authenticated using (public.is_household_member(household_id));

-- 呼び出した本人の世帯（RPC内部用）
create function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select household_id from public.household_members where user_id = auth.uid() limit 1;
$$;
revoke all on function public.current_household_id() from public, anon;
grant execute on function public.current_household_id() to authenticated;

-- 操作履歴（値は残さない）
create function public.log_settings_change(p_household uuid, p_actor uuid, p_changed text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (household_id, actor_profile_id, actor_auth_user_id, entity_type, entity_id, action, before_json, after_json)
  values (p_household, p_actor, auth.uid(), 'household_settings', p_household, 'update', null, jsonb_build_object('changed', to_jsonb(p_changed)));
end;
$$;
revoke all on function public.log_settings_change(uuid, uuid, text[]) from public, anon, authenticated;

-- 自宅の位置を保存（住所・緯度経度。住所の文字列は返さない）。位置が変わったら交通費の見直しを促す
create function public.save_home_location(p_address text, p_lat numeric, p_lng numeric, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  cur public.household_settings;
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'lat/lng must be set together' using errcode = '23514'; end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then raise exception 'out of range' using errcode = '23514'; end if;
  if p_address is not null and char_length(p_address) > 200 then raise exception 'address too long' using errcode = '23514'; end if;
  select * into cur from public.household_settings where household_id = hid;
  insert into public.household_settings (household_id, home_address, home_lat, home_lng, updated_by_profile_id, travel_review_needed)
  values (hid, nullif(btrim(p_address), ''), p_lat, p_lng, p_actor, false)
  on conflict (household_id) do update set
    home_address = excluded.home_address,
    home_lat = excluded.home_lat,
    home_lng = excluded.home_lng,
    updated_by_profile_id = p_actor,
    updated_at = now(),
    travel_review_needed = public.household_settings.travel_review_needed
      or (public.household_settings.home_lat is distinct from excluded.home_lat or public.household_settings.home_lng is distinct from excluded.home_lng);
  perform public.log_settings_change(hid, p_actor, array['home_location']);
end;
$$;
revoke all on function public.save_home_location(text, numeric, numeric, uuid) from public, anon;
grant execute on function public.save_home_location(text, numeric, numeric, uuid) to authenticated;

-- 自宅の住所の文字列（設定画面が明示的に読む）
create function public.get_home_address()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select home_address from public.household_settings where household_id = public.current_household_id();
$$;
revoke all on function public.get_home_address() from public, anon;
grant execute on function public.get_home_address() to authenticated;

-- 交通費の見直しを済ませた
create function public.ack_travel_review(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare hid uuid := public.current_household_id();
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  update public.household_settings set travel_review_needed = false, updated_by_profile_id = p_actor, updated_at = now() where household_id = hid;
  perform public.log_settings_change(hid, p_actor, array['travel_review']);
end;
$$;
revoke all on function public.ack_travel_review(uuid) from public, anon;
grant execute on function public.ack_travel_review(uuid) to authenticated;

-- 表示・距離区分・AI予算の設定（検証つき）
create function public.save_household_settings(p_card_display jsonb, p_bands jsonb, p_budget int, p_auto_ai boolean, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  k text;
  v jsonb;
  prev numeric := 0;
  n numeric;
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if jsonb_typeof(p_card_display) <> 'object' then raise exception 'card_display must be object' using errcode = '23514'; end if;
  for k, v in select * from jsonb_each(p_card_display) loop
    if k not in ('prefecture', 'distance', 'travelCost', 'deadline', 'announce', 'receive', 'applyMethod', 'quantity', 'accounts') or jsonb_typeof(v) <> 'boolean' then
      raise exception 'invalid card_display' using errcode = '23514';
    end if;
  end loop;
  if jsonb_typeof(p_bands) <> 'array' or jsonb_array_length(p_bands) <> 4 then raise exception 'invalid bands' using errcode = '23514'; end if;
  for v in select * from jsonb_array_elements(p_bands) loop
    if jsonb_typeof(v) <> 'number' then raise exception 'invalid bands' using errcode = '23514'; end if;
    n := (v #>> '{}')::numeric;
    if n <= prev or n > 5000 then raise exception 'invalid bands' using errcode = '23514'; end if;
    prev := n;
  end loop;
  if p_budget not between 0 and 1000000 then raise exception 'invalid budget' using errcode = '23514'; end if;
  insert into public.household_settings (household_id, card_display, distance_bands_km, ai_monthly_budget_jpy, auto_ai_enabled, updated_by_profile_id)
  values (hid, p_card_display, p_bands, p_budget, p_auto_ai, p_actor)
  on conflict (household_id) do update set
    card_display = excluded.card_display,
    distance_bands_km = excluded.distance_bands_km,
    ai_monthly_budget_jpy = excluded.ai_monthly_budget_jpy,
    auto_ai_enabled = excluded.auto_ai_enabled,
    updated_by_profile_id = p_actor,
    updated_at = now();
  perform public.log_settings_change(hid, p_actor, array['card_display', 'distance_bands', 'ai_budget']);
end;
$$;
revoke all on function public.save_household_settings(jsonb, jsonb, int, boolean, uuid) from public, anon;
grant execute on function public.save_household_settings(jsonb, jsonb, int, boolean, uuid) to authenticated;
