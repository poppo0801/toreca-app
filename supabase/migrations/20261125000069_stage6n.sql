-- Stage 6N（追加のみ。既存の抽選・応募・当選・購入・受取・売却・コレクションのデータは変更しない）
--  1. Xアカウントの固定ID（アカウントIDでの対応づけ）
--  2. Xブックマークの投稿ごとの処理状況（x_bookmark_posts）
--  3. 店舗選択式の抽選（lotteries.store_mode / selectable_stores）と、プロフィール別の応募店舗（applications.applied_store_*）
--  4. 支出の系列（purchases.chain_id）。受取からの購入記録に系列・応募店舗を反映
--  5. ガソリン代: 世帯の設定（fuel_settings）、系列×店舗ごとの片道距離（store_trip_distances）

-- ================================================================ 1. Xアカウントの固定ID
alter table public.x_account_identities add column x_user_id text check (x_user_id is null or x_user_id ~ '^[0-9]{1,25}$');
create index x_account_identities_user_id_idx on public.x_account_identities (household_id, x_user_id) where x_user_id is not null;

-- ================================================================ 2. Xブックマークの処理状況
-- 投稿IDごとに1行。「投稿を取得できたこと」と「抽選として登録できたこと」を状態で分けて持つ。
create table public.x_bookmark_posts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  post_id text not null check (post_id ~ '^[0-9]{1,25}$'),
  username text not null default '' check (char_length(username) <= 40),
  display_name text not null default '' check (char_length(display_name) <= 100),
  post_url text not null default '' check (char_length(post_url) <= 500),
  summary text not null default '' check (char_length(summary) <= 300),
  state text not null default 'fetched_pending' check (state in (
    'unfetched', 'fetched_pending', 'analyzing', 'insufficient', 'manual_review',
    'registered', 'merged', 'excluded', 'fetch_failed', 'closed_unresolved'
  )),
  -- 未処理・失敗の理由（画面に出す短い文）
  reason text not null default '' check (char_length(reason) <= 300),
  -- 取得失敗の種類: temporary=一時的（API・通信・レート制限。再試行する）／permanent=恒久的（削除・非公開・権限不足）
  failure_kind text check (failure_kind in ('temporary', 'permanent')),
  candidate_id uuid,
  lottery_id uuid,
  -- 応募締切（分かっているとき）。過ぎたら自動再調査を止め「受付終了・未解決」にする
  deadline_at timestamptz,
  retry_count int not null default 0 check (retry_count >= 0),
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  -- 別ソースからの補完の記録（情報元URL・取得日時を保持）
  supplement_note text not null default '' check (char_length(supplement_note) <= 500),
  supplement_url text check (supplement_url is null or char_length(supplement_url) <= 500),
  supplemented_at timestamptz,
  -- 利用者が「対象外」「調査終了」を選んだ日時（未解決一覧から外す）
  user_closed_at timestamptz,
  user_closed_kind text check (user_closed_kind in ('excluded', 'investigation_ended')),
  -- 同期で初めて見つけた日時（起動時ポップアップの「新規」の判定）
  first_seen_at timestamptz not null default now(),
  -- 起動時ポップアップに表示済みの日時（再起動ごとに同じ新規として重複させない）
  popup_shown_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, post_id)
);
create index x_bookmark_posts_state_idx on public.x_bookmark_posts (household_id, state);
create index x_bookmark_posts_retry_idx on public.x_bookmark_posts (household_id, next_retry_at) where user_closed_at is null;

alter table public.x_bookmark_posts enable row level security;
revoke all on public.x_bookmark_posts from anon, authenticated;
grant select, insert, update on public.x_bookmark_posts to authenticated;
grant select, insert, update, delete on public.x_bookmark_posts to service_role;
create policy x_bookmark_posts_select on public.x_bookmark_posts for select to authenticated using (public.is_household_member(household_id));
create policy x_bookmark_posts_insert on public.x_bookmark_posts for insert to authenticated with check (public.is_household_member(household_id));
create policy x_bookmark_posts_update on public.x_bookmark_posts for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create trigger x_bookmark_posts_touch before update on public.x_bookmark_posts for each row execute function public.touch_updated_at();

-- ================================================================ 3. 店舗選択式の抽選
-- fixed=店舗固定 / select_on_apply=応募時に店舗選択 / none=店舗指定なし（通販など）。既存の抽選は fixed のまま。
alter table public.lotteries add column store_mode text not null default 'fixed' check (store_mode in ('fixed', 'select_on_apply', 'none'));
-- 選べる店舗の一覧（取得できたときだけ）。[{"name": "...", "prefecture": "..."}] の配列（最大200件）
alter table public.lotteries add column selectable_stores jsonb check (selectable_stores is null or (jsonb_typeof(selectable_stores) = 'array' and jsonb_array_length(selectable_stores) <= 200));

-- 応募した店舗は、抽選ではなく各プロフィールの応募記録に持つ（同じ抽選でも応募者ごとに独立）。
-- 店舗マスターにある店舗は applied_store_id、無い店舗は名前だけ。どちらも空なら「未設定」。
alter table public.applications add column applied_store_id uuid;
alter table public.applications add column applied_store_name text not null default '' check (char_length(applied_store_name) <= 80);
alter table public.applications add column applied_store_prefecture text not null default '' check (char_length(applied_store_prefecture) <= 10);
alter table public.applications add constraint applications_applied_store_fk foreign key (applied_store_id, household_id) references public.stores (id, household_id) on delete set null (applied_store_id);

-- ================================================================ 4. 支出の系列
alter table public.purchases add column chain_id uuid;
alter table public.purchases add constraint purchases_chain_fk foreign key (chain_id, household_id) references public.chains (id, household_id) on delete set null (chain_id);
create index purchases_chain_idx on public.purchases (household_id, chain_id);

-- 受取（購入済み）から作る購入記録に、系列と店舗を反映する。
-- 店舗選択式の抽選は、プロフィール別の応募店舗を優先する（未設定なら店舗は空。抽選側の仮の店舗は使わない）。
create or replace function public.mark_purchased(p_application_id uuid, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  app public.applications;
  lot public.lotteries;
  pid uuid;
  sid uuid;
  slabel text;
begin
  select * into app from public.applications where id = p_application_id for update;
  if not found then
    raise exception 'application not found' using errcode = 'P0002';
  end if;
  if app.state <> 'applied' or app.result_status <> 'won' then
    raise exception 'not a winning application' using errcode = '22023';
  end if;

  update public.applications
     set fulfillment_status = 'purchased',
         procedure_completed_at = coalesce(procedure_completed_at, now()),
         updated_by_profile_id = p_actor
   where id = app.id and fulfillment_status <> 'purchased';

  select * into lot from public.lotteries where id = app.lottery_id;

  if lot.store_mode = 'select_on_apply' then
    sid := app.applied_store_id;
    slabel := nullif(app.applied_store_name, '');
  else
    sid := lot.store_id;
    slabel := null;
  end if;

  insert into public.purchases
    (household_id, application_id, chain_id, store_id, store_label, buyer_profile_id, purchased_at, channel, record_kind, source_kind, updated_by_profile_id)
  values (
    app.household_id, app.id, lot.chain_id, sid, case when sid is null then slabel else null end,
    (select s.managed_by_profile_id from public.service_accounts s where s.id = app.service_account_id),
    now(),
    case when lot.receive_method = 'shipping' then 'shipping' else 'store' end,
    'detail', 'lottery', p_actor
  )
  on conflict (application_id) where application_id is not null do nothing
  returning id into pid;

  if pid is not null then
    -- 単一商品: 全明細 / 複数商品: 当選した明細のみ。定価があれば金額を仮入力する（購入時に修正可能）
    insert into public.purchase_items
      (household_id, purchase_id, product_id, quantity, unit, lottery_item_id, amount_paid, updated_by_profile_id)
    select i.household_id, pid, i.product_id, i.quantity, i.unit,
           i.id,
           case i.unit when 'box' then pr.list_price_box * i.quantity
                       when 'pack' then pr.list_price_pack * i.quantity
                       when 'set' then pr.list_price_unit * i.quantity
                       when 'piece' then pr.list_price_unit * i.quantity end,
           p_actor
      from public.lottery_items i
      join public.products pr on pr.id = i.product_id
     where i.lottery_id = lot.id
       and (
         lot.multi_mode = 'single'
         or exists (
           select 1 from public.application_item_results r
            where r.application_id = app.id and r.lottery_item_id = i.id and r.result_status = 'won'
         )
       );
  end if;
end;
$$;

-- 既存の購入記録: 店舗マスターが確実に分かるものだけ、店舗の系列を補う（曖昧なもの・店舗なしは触れない）
update public.purchases p
   set chain_id = s.chain_id
  from public.stores s
 where p.store_id = s.id and p.household_id = s.household_id and p.chain_id is null;

-- ================================================================ 5. ガソリン代
-- 世帯の設定（燃費・ガソリン単価の初期値）。行が無いときはアプリ側の既定（155円/L・16.7km/L）を使う。
-- 既定の燃費: MAZDA3 セダン 20S（2WD・5BA-BPFP）の公称値に近い目安。実燃費に合わせて設定画面で変更できる。
create table public.fuel_settings (
  household_id uuid primary key references public.households (id) on delete cascade,
  price_per_l numeric(6, 1) not null default 155 check (price_per_l > 0 and price_per_l <= 1000),
  km_per_l numeric(5, 1) not null default 16.7 check (km_per_l > 0 and km_per_l <= 100),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid
);
alter table public.fuel_settings enable row level security;
revoke all on public.fuel_settings from anon, authenticated;
grant select, insert, update on public.fuel_settings to authenticated;
grant select, insert, update, delete on public.fuel_settings to service_role;
create policy fuel_settings_select on public.fuel_settings for select to authenticated using (public.is_household_member(household_id));
create policy fuel_settings_insert on public.fuel_settings for insert to authenticated with check (public.is_household_member(household_id));
create policy fuel_settings_update on public.fuel_settings for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create trigger fuel_settings_touch before update on public.fuel_settings for each row execute function public.touch_updated_at();
create trigger fuel_settings_audit after insert or update or delete on public.fuel_settings for each row execute function public.audit_row();

-- 系列×店舗ごとの片道距離(km)。店舗なし（系列のみ）は store_id が null。別店舗の距離を流用しない。
create table public.store_trip_distances (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  chain_id uuid not null,
  store_id uuid,
  one_way_km numeric(6, 1) not null check (one_way_km > 0 and one_way_km <= 3000),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  foreign key (chain_id, household_id) references public.chains (id, household_id) on delete cascade,
  foreign key (store_id, household_id) references public.stores (id, household_id) on delete cascade
);
create unique index store_trip_distances_uniq on public.store_trip_distances (household_id, chain_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.store_trip_distances enable row level security;
revoke all on public.store_trip_distances from anon, authenticated;
grant select, insert, update, delete on public.store_trip_distances to authenticated, service_role;
create policy store_trip_distances_select on public.store_trip_distances for select to authenticated using (public.is_household_member(household_id));
create policy store_trip_distances_insert on public.store_trip_distances for insert to authenticated with check (public.is_household_member(household_id));
create policy store_trip_distances_update on public.store_trip_distances for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy store_trip_distances_delete on public.store_trip_distances for delete to authenticated using (public.is_household_member(household_id));
create trigger store_trip_distances_touch before update on public.store_trip_distances for each row execute function public.touch_updated_at();
create trigger store_trip_distances_audit after insert or update or delete on public.store_trip_distances for each row execute function public.audit_row();
