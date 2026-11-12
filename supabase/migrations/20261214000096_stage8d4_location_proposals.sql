-- Stage 8D-4: 店舗所在地の「反映候補」と承認フロー（開発環境のみ。本番には適用しない）。
-- 調査結果（store_location_research）と確定データ（stores）を分離したまま、利用者が「承認・却下・保留」を選んで反映する。
--  ・反映候補（proposals）: 調査結果から作る。対象店舗・現在の登録内容・AIが取得した住所・情報源・公式性・信頼度・理由・既存との差異を持つ
--  ・操作履歴（events）: 追記専用。候補の作成・保留・却下・反映・反映の失敗・取消をすべて残す
--  ・stores の更新は、このファイルの関数（security definer）だけが行う。直接の insert/update は認証済みユーザーに許可しない
--  ・誤登録・重複登録の防止: 調査1件につき候補は1件／同じ店舗・同じ住所の有効な候補は1件／反映は pending・on_hold の1回だけ／
--    反映時に「店舗名・系列名が候補作成時と同じ」「店舗の住所が候補作成時から変わっていない」を確認／既存の住所は明示の許可なしに上書きしない
--  ・取消: 反映前の値（住所・都道府県・座標）を保存し、反映後に店舗が編集されていなければ元へ戻す
-- ※ 本番へは、利用者の承認・事前バックアップのうえで別途適用する（Stage 8D-4 では本番に適用していない。アプリ側も開発環境でのみ操作を許可する）。

create function public.norm_address(a text)
returns text
language sql
stable
set search_path = ''
as $$
  -- 同じ住所の表記ゆれ（全角半角・空白・ハイフン類・「丁目」「番」「号」）を同一視する（アプリ側の normalizeForMatch と同じ考え方）
  select regexp_replace(regexp_replace(replace(regexp_replace(regexp_replace(normalize(coalesce(a, ''), NFKC), '[[:space:]　]', '', 'g'), '[‐‑–—―−ー－]', '-', 'g'), '号', ''), '(丁目|番地|番)', '-', 'g'), '-+', '-', 'g');
$$;

create table public.store_location_proposals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  store_id uuid not null,
  research_id uuid not null references public.store_location_research (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'on_hold', 'rejected', 'applied', 'reverted')),
  -- 候補作成時の店舗の表示名と現在の登録内容（反映時に変わっていないか確認する）
  chain_name text not null check (char_length(chain_name) between 1 and 80),
  store_name text not null check (char_length(store_name) between 1 and 80),
  current_address text not null default '' check (char_length(current_address) <= 200),
  current_prefecture text not null default '' check (char_length(current_prefecture) <= 10),
  current_latitude numeric(9, 6),
  current_longitude numeric(9, 6),
  -- AIが取得した住所（検証層を通したもの）
  proposed_address text not null check (char_length(proposed_address) between 1 and 200),
  proposed_key text not null,
  proposed_prefecture text check (proposed_prefecture is null or char_length(proposed_prefecture) <= 10),
  proposed_latitude numeric(9, 6),
  proposed_longitude numeric(9, 6),
  research_status text not null check (research_status in ('confirmed', 'candidate')),
  confidence smallint not null check (confidence between 0 and 100),
  official_status text not null check (official_status in ('trusted', 'verified', 'candidate', 'none')),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  -- 既存との差異（[{field, before, after}]）。反映後の内容そのもの
  diff jsonb not null default '[]'::jsonb check (jsonb_typeof(diff) = 'array'),
  note text check (note is null or char_length(note) <= 500),
  decided_at timestamptz,
  decided_by_profile_id uuid,
  applied_at timestamptz,
  applied_before jsonb check (applied_before is null or jsonb_typeof(applied_before) = 'object'),
  reverted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by_profile_id uuid,
  check ((proposed_latitude is null) = (proposed_longitude is null)),
  unique (research_id),
  foreign key (store_id, household_id) references public.stores (id, household_id) on delete cascade,
  foreign key (decided_by_profile_id, household_id) references public.profiles (id, household_id),
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id)
);
-- 同じ店舗・同じ住所の有効な候補（保留中・承認待ち・反映済み）は1件だけ
create unique index store_location_proposals_open_idx on public.store_location_proposals (store_id, proposed_key) where status in ('pending', 'on_hold', 'applied');
create index store_location_proposals_store_idx on public.store_location_proposals (household_id, store_id, created_at desc);

create table public.store_location_proposal_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  proposal_id uuid not null references public.store_location_proposals (id) on delete cascade,
  action text not null check (action in ('created', 'held', 'reopened', 'rejected', 'applied', 'apply_blocked', 'reverted', 'revert_blocked')),
  from_status text,
  to_status text,
  actor_profile_id uuid,
  actor_auth_user_id uuid,
  note text check (note is null or char_length(note) <= 500),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  occurred_at timestamptz not null default now(),
  foreign key (actor_profile_id, household_id) references public.profiles (id, household_id)
);
create index store_location_proposal_events_idx on public.store_location_proposal_events (household_id, proposal_id, occurred_at);

alter table public.store_location_proposals enable row level security;
alter table public.store_location_proposal_events enable row level security;
revoke all on public.store_location_proposals, public.store_location_proposal_events from anon, authenticated;
grant select on public.store_location_proposals, public.store_location_proposal_events to authenticated; -- 書き込みは下の関数だけ（追記専用の履歴）
grant select, insert, update, delete on public.store_location_proposals, public.store_location_proposal_events to service_role;
create policy store_location_proposals_select on public.store_location_proposals for select to authenticated using (public.is_household_member(household_id));
create policy store_location_proposal_events_select on public.store_location_proposal_events for select to authenticated using (public.is_household_member(household_id));

-- 共通: 履歴の追記
create function public.log_proposal_event(p_hid uuid, p_pid uuid, p_action text, p_from text, p_to text, p_profile uuid, p_note text, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.store_location_proposal_events (household_id, proposal_id, action, from_status, to_status, actor_profile_id, actor_auth_user_id, note, detail)
  values (p_hid, p_pid, p_action, p_from, p_to, p_profile, (select auth.uid()), p_note, coalesce(p_detail, '{}'::jsonb));
$$;
revoke all on function public.log_proposal_event(uuid, uuid, text, text, text, uuid, text, jsonb) from public, anon, authenticated;

-- 反映候補の作成（調査結果から。住所のある confirmed / candidate のみ）
create function public.propose_store_location(p_research_id uuid, p_profile_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.store_location_research%rowtype;
  s public.stores%rowtype;
  v_chain text;
  v_existing uuid;
  v_key text;
  v_official text := 'none';
  v_diff jsonb := '[]'::jsonb;
  v_id uuid;
begin
  select * into r from public.store_location_research where id = p_research_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'research_not_found'); end if;
  if not public.is_household_member(r.household_id) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if r.status not in ('confirmed', 'candidate') or r.address is null or btrim(r.address) = '' then
    return jsonb_build_object('ok', false, 'error', 'not_adoptable');
  end if;
  select * into s from public.stores where id = r.store_id and household_id = r.household_id for share;
  if not found or s.archived_at is not null then return jsonb_build_object('ok', false, 'error', 'store_unavailable'); end if;
  select name into v_chain from public.chains where id = s.chain_id;

  select id into v_existing from public.store_location_proposals where research_id = p_research_id;
  if found then return jsonb_build_object('ok', true, 'id', v_existing, 'duplicate', true); end if;

  v_key := public.norm_address(r.address);
  if public.norm_address(s.address_optional) = v_key then return jsonb_build_object('ok', false, 'error', 'no_change'); end if;
  if exists (select 1 from public.store_location_proposals where store_id = s.id and proposed_key = v_key and status in ('pending', 'on_hold', 'applied')) then
    return jsonb_build_object('ok', false, 'error', 'duplicate_open');
  end if;

  -- 公式性: 情報源のドメインについて、調査時の公式サイト判定の最良の状態
  select coalesce(
    (select case when bool_or(o ->> 'status' = 'trusted') then 'trusted' when bool_or(o ->> 'status' = 'verified') then 'verified' when bool_or(o ->> 'status' = 'candidate') then 'candidate' end
       from jsonb_array_elements(r.official_sites) o
      where o ->> 'domain' in (select src ->> 'domain' from jsonb_array_elements(r.sources) src)),
    'none') into v_official;

  v_diff := jsonb_build_array(jsonb_build_object('field', 'address', 'before', s.address_optional, 'after', r.address));
  if s.prefecture = '' and r.prefecture is not null then
    v_diff := v_diff || jsonb_build_array(jsonb_build_object('field', 'prefecture', 'before', s.prefecture, 'after', r.prefecture));
  end if;
  if r.latitude is not null then
    v_diff := v_diff || jsonb_build_array(jsonb_build_object('field', 'coordinates', 'before', case when s.latitude is null then null else s.latitude::text || ',' || s.longitude::text end, 'after', r.latitude::text || ',' || r.longitude::text));
  end if;

  begin
    insert into public.store_location_proposals
      (household_id, store_id, research_id, chain_name, store_name, current_address, current_prefecture, current_latitude, current_longitude,
       proposed_address, proposed_key, proposed_prefecture, proposed_latitude, proposed_longitude, research_status, confidence, official_status,
       reasons, sources, diff, created_by_profile_id)
    values
      (r.household_id, s.id, r.id, coalesce(v_chain, r.chain_name), s.name, s.address_optional, s.prefecture, s.latitude, s.longitude,
       r.address, v_key, r.prefecture, r.latitude, r.longitude, r.status, r.confidence, v_official,
       r.reasons, r.sources, v_diff, p_profile_id)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'duplicate_open');
  end;
  perform public.log_proposal_event(r.household_id, v_id, 'created', null, 'pending', p_profile_id, null, jsonb_build_object('research_id', r.id, 'confidence', r.confidence, 'official_status', v_official));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- 却下・保留・保留の解除（再確認）
create function public.decide_store_location_proposal(p_id uuid, p_decision text, p_note text default null, p_profile_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.store_location_proposals%rowtype;
  v_to text;
  v_action text;
begin
  select * into p from public.store_location_proposals where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not public.is_household_member(p.household_id) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_decision = 'reject' and p.status in ('pending', 'on_hold') then v_to := 'rejected'; v_action := 'rejected';
  elsif p_decision = 'hold' and p.status = 'pending' then v_to := 'on_hold'; v_action := 'held';
  elsif p_decision = 'reopen' and p.status = 'on_hold' then v_to := 'pending'; v_action := 'reopened';
  else return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.store_location_proposals
    set status = v_to, note = coalesce(p_note, note), decided_at = now(), decided_by_profile_id = p_profile_id
    where id = p.id;
  perform public.log_proposal_event(p.household_id, p.id, v_action, p.status, v_to, p_profile_id, p_note, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', v_to);
end;
$$;

-- 承認して店舗マスターへ反映（開発DB）。反映できない場合は何も変更せず、理由を履歴に残す
create function public.apply_store_location_proposal(p_id uuid, p_allow_overwrite boolean default false, p_note text default null, p_profile_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.store_location_proposals%rowtype;
  s public.stores%rowtype;
  v_chain text;
  v_err text;
begin
  select * into p from public.store_location_proposals where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not public.is_household_member(p.household_id) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p.status not in ('pending', 'on_hold') then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if; -- 反映済み・却下済み・取消済みは再反映しない（二重反映の防止）

  select * into s from public.stores where id = p.store_id and household_id = p.household_id for update;
  if not found or s.archived_at is not null then
    v_err := 'store_unavailable';
  else
    select name into v_chain from public.chains where id = s.chain_id;
    if s.name <> p.store_name or coalesce(v_chain, '') <> p.chain_name then
      v_err := 'store_changed'; -- 候補作成後に店舗名・系列が変わった（別の店舗への誤反映を防ぐ）
    elsif public.norm_address(s.address_optional) <> public.norm_address(p.current_address) then
      v_err := 'stale'; -- 候補作成後に店舗の住所が変わった（利用者の編集を上書きしない）
    elsif btrim(s.address_optional) <> '' and not p_allow_overwrite then
      v_err := 'would_overwrite'; -- 既存の住所は、明示の許可なしに置き換えない
    end if;
  end if;
  if v_err is not null then
    perform public.log_proposal_event(p.household_id, p.id, 'apply_blocked', p.status, p.status, p_profile_id, p_note, jsonb_build_object('error', v_err));
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  update public.store_location_proposals
    set status = 'applied', applied_at = now(), decided_at = now(), decided_by_profile_id = p_profile_id, note = coalesce(p_note, note),
        applied_before = jsonb_build_object('address_optional', s.address_optional, 'prefecture', s.prefecture, 'latitude', s.latitude, 'longitude', s.longitude)
    where id = p.id;
  update public.stores
    set address_optional = p.proposed_address,
        prefecture = case when s.prefecture = '' and p.proposed_prefecture is not null then p.proposed_prefecture else s.prefecture end,
        latitude = p.proposed_latitude,
        longitude = p.proposed_longitude,
        updated_by_profile_id = coalesce(p_profile_id, s.updated_by_profile_id)
    where id = s.id and household_id = p.household_id;
  perform public.log_proposal_event(p.household_id, p.id, 'applied', p.status, 'applied', p_profile_id, p_note, jsonb_build_object('store_id', s.id, 'overwrote', btrim(s.address_optional) <> ''));
  return jsonb_build_object('ok', true, 'status', 'applied');
end;
$$;

-- 反映の取消（反映前の値へ戻す。反映後に利用者が店舗を編集していたら、上書きしない）
create function public.revert_store_location_proposal(p_id uuid, p_note text default null, p_profile_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.store_location_proposals%rowtype;
  s public.stores%rowtype;
  v_err text;
begin
  select * into p from public.store_location_proposals where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not public.is_household_member(p.household_id) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p.status <> 'applied' or p.applied_before is null then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;

  select * into s from public.stores where id = p.store_id and household_id = p.household_id for update;
  if not found then
    v_err := 'store_unavailable';
  elsif public.norm_address(s.address_optional) <> p.proposed_key then
    v_err := 'edited_since'; -- 反映後に店舗の住所が編集された（その編集を上書きしない）
  end if;
  if v_err is not null then
    perform public.log_proposal_event(p.household_id, p.id, 'revert_blocked', p.status, p.status, p_profile_id, p_note, jsonb_build_object('error', v_err));
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  update public.stores
    set address_optional = coalesce(p.applied_before ->> 'address_optional', ''),
        prefecture = coalesce(p.applied_before ->> 'prefecture', ''),
        latitude = nullif(p.applied_before ->> 'latitude', '')::numeric,
        longitude = nullif(p.applied_before ->> 'longitude', '')::numeric,
        updated_by_profile_id = coalesce(p_profile_id, s.updated_by_profile_id)
    where id = s.id and household_id = p.household_id;
  update public.store_location_proposals set status = 'reverted', reverted_at = now(), note = coalesce(p_note, note) where id = p.id;
  perform public.log_proposal_event(p.household_id, p.id, 'reverted', 'applied', 'reverted', p_profile_id, p_note, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', 'reverted');
end;
$$;

revoke all on function public.propose_store_location(uuid, uuid), public.decide_store_location_proposal(uuid, text, text, uuid),
  public.apply_store_location_proposal(uuid, boolean, text, uuid), public.revert_store_location_proposal(uuid, text, uuid) from public, anon;
grant execute on function public.propose_store_location(uuid, uuid), public.decide_store_location_proposal(uuid, text, text, uuid),
  public.apply_store_location_proposal(uuid, boolean, text, uuid), public.revert_store_location_proposal(uuid, text, uuid) to authenticated;
