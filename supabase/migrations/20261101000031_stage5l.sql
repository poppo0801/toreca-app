-- Stage 5L: 当落発表方法・応募条件の標準分類、店舗の営業形態（通販区分）、抽選Excelの一括取込。追加のみ。
-- 既存の列・データは変更しない。既存の自由記述（announcement_method / conditions_text）は補足・原文としてそのまま残す。

-- ---------------------------------------------------------------- 抽選: 標準分類
alter table public.lotteries
  -- 当落発表方法（複数）。コードは src/lib/lottery-taxonomy.ts と同じ
  add column announcement_methods text[] not null default '{}',
  -- 通知対象: 当選・落選の両方 / 当選者のみ / 不明（経路とは独立）
  add column announcement_target text not null default 'unknown',
  -- サービス標準ルール（LivePocketなど）による推定。告知に明記された内容ではない
  add column announcement_inferred boolean not null default false,
  -- 応募条件タグ（複数）・結合方法（すべて/いずれか）・具体的な数値（金額・期間・年齢など。不明な値は入れない）
  add column requirement_tags text[] not null default '{}',
  add column requirement_logic text not null default 'and',
  add column requirement_details jsonb not null default '{}'::jsonb,
  -- Excel取込で新規作成した抽選の識別（同じファイルの再取込で重複登録しない）
  add column import_key text;

alter table public.lotteries
  add constraint lotteries_announcement_methods_chk check (
    announcement_methods <@ array['result_mail', 'winner_mail', 'result_page', 'app', 'x_dm', 'line', 'sms', 'in_store', 'sns_post', 'phone', 'other', 'unknown']::text[]
    and cardinality(announcement_methods) <= 12
  ),
  add constraint lotteries_announcement_target_chk check (announcement_target in ('unknown', 'both', 'winners_only')),
  add constraint lotteries_requirement_tags_chk check (
    requirement_tags <@ array[
      'member_registration', 'member_card', 'app_member', 'purchase_history', 'purchase_amount', 'purchase_period',
      'id_check', 'photo_id', 'other_verification', 'x_account', 'x_follow', 'x_repost', 'line_register', 'livepocket_account', 'other_account',
      'resident_area', 'in_store_apply', 'in_store_receive', 'designated_store', 'once_per_person', 'once_per_family', 'one_store_only', 'multi_store_ok', 'age_limit',
      'ticket', 'serial_code', 'other', 'unknown'
    ]::text[]
    and cardinality(requirement_tags) <= 28
  ),
  add constraint lotteries_requirement_logic_chk check (requirement_logic in ('and', 'or')),
  add constraint lotteries_requirement_details_chk check (jsonb_typeof(requirement_details) = 'object' and pg_column_size(requirement_details) <= 2000),
  add constraint lotteries_import_key_chk check (import_key is null or char_length(import_key) between 1 and 80);
create unique index lotteries_import_key_uniq on public.lotteries (household_id, import_key) where import_key is not null;

-- ---------------------------------------------------------------- 店舗: 営業形態（既存店舗は実店舗）
alter table public.stores
  add column sales_kind text not null default 'physical' check (sales_kind in ('physical', 'online_only', 'both'));

-- ---------------------------------------------------------------- 抽選Excel取り込み履歴（追記専用。ファイル本体・変更前後の値は保存しない）
create table public.lottery_import_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  imported_by_profile_id uuid,
  created_at timestamptz not null default now(),
  file_name text not null check (char_length(file_name) <= 200),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  created_count int not null default 0 check (created_count >= 0),
  updated_count int not null default 0 check (updated_count >= 0),
  unchanged_count int not null default 0 check (unchanged_count >= 0),
  application_count int not null default 0 check (application_count >= 0),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  unique (id, household_id),
  unique (household_id, fingerprint),
  foreign key (imported_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index lottery_import_history_recent on public.lottery_import_history (household_id, created_at desc);
alter table public.lottery_import_history enable row level security;
revoke all on public.lottery_import_history from anon, authenticated;
grant select on public.lottery_import_history to authenticated;
grant select, insert, delete on public.lottery_import_history to service_role;
create policy lottery_import_history_select on public.lottery_import_history for select to authenticated using (public.is_household_member(household_id));

-- ---------------------------------------------------------------- 抽選の一括適用（1トランザクション。1件でも失敗・競合なら全体を取り消す）
-- SECURITY DEFINER（履歴の書き込みのため）。世帯は呼び出した本人のものに固定し、すべての書き込みを自世帯に限定する。
-- p_ops: { lotteries: [{
--   id: uuid|null, expected: updated_at|null, import_key: text|null,
--   save: save_lottery_tx の引数（applications は含めない）,
--   tax: { announcement_methods, announcement_target, announcement_inferred, requirement_tags, requirement_logic, requirement_details },
--   managed: bool|null,
--   apps: [{ profile_id, state?, applied_at?, result?, confirmed_at?, fulfillment?, skip?, selected?: {item_id, product}, items?: [{item_id, product, result}] }]
-- }] }
-- 取り込みは通知を作らない（通知は別のCron処理が、受付中・発表待ちの抽選だけを対象に判定する）。購入記録には触れない。
create function public.apply_lottery_import(p_ops jsonb, p_actor uuid, p_file_name text, p_file_sha text, p_fingerprint text, p_unchanged int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  op jsonb;
  a jsonb;
  it jsonb;
  lot_id uuid;
  cur public.lotteries;
  v_chain uuid;
  acc_id uuid;
  app_id uuid;
  app_row public.applications;
  item_id uuid;
  n_found int;
  results jsonb;
  created jsonb := '[]'::jsonb;
  n_created int := 0;
  n_updated int := 0;
  n_apps int := 0;
  mode text;
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if jsonb_typeof(p_ops) <> 'object' or jsonb_array_length(coalesce(p_ops -> 'lotteries', '[]'::jsonb)) > 2000 then
    raise exception 'invalid ops' using errcode = '22023';
  end if;

  -- 二重適用の防止（同じ指紋は1回だけ）
  insert into public.lottery_import_history (household_id, imported_by_profile_id, file_name, file_sha256, fingerprint)
  values (hid, p_actor, left(p_file_name, 200), p_file_sha, p_fingerprint);

  perform public.ensure_profile_accounts();

  for op in select * from jsonb_array_elements(coalesce(p_ops -> 'lotteries', '[]'::jsonb)) loop
    lot_id := nullif(op ->> 'id', '')::uuid;
    if lot_id is not null then
      select * into cur from public.lotteries where id = lot_id and household_id = hid for update;
      if not found then raise exception 'unknown lottery %', lot_id using errcode = 'P0002'; end if;
      if op ->> 'expected' is not null and cur.updated_at <> (op ->> 'expected')::timestamptz then
        raise exception 'conflict %', lot_id using errcode = 'PT409';
      end if;
    end if;

    -- 抽選本体・系列・店舗・商品明細（既存の保存処理を再利用）
    lot_id := public.save_lottery_tx((op -> 'save') || jsonb_build_object('id', coalesce(lot_id::text, ''), 'applications', '[]'::jsonb), p_actor);
    if (op ->> 'id') is null then
      n_created := n_created + 1;
      created := created || to_jsonb(lot_id::text);
    else
      n_updated := n_updated + 1;
    end if;

    -- 標準分類・取込キー（取込時の更新は、ファイルに値がある項目だけが含まれる）
    update public.lotteries l set
      announcement_methods = case when op -> 'tax' ? 'announcement_methods' then array(select jsonb_array_elements_text(op -> 'tax' -> 'announcement_methods')) else l.announcement_methods end,
      announcement_target = coalesce(op -> 'tax' ->> 'announcement_target', l.announcement_target),
      announcement_inferred = coalesce((op -> 'tax' ->> 'announcement_inferred')::boolean, l.announcement_inferred),
      requirement_tags = case when op -> 'tax' ? 'requirement_tags' then array(select jsonb_array_elements_text(op -> 'tax' -> 'requirement_tags')) else l.requirement_tags end,
      requirement_logic = coalesce(op -> 'tax' ->> 'requirement_logic', l.requirement_logic),
      requirement_details = coalesce(op -> 'tax' -> 'requirement_details', l.requirement_details),
      import_key = coalesce(l.import_key, nullif(op ->> 'import_key', '')),
      source_kind = case when (op ->> 'id') is null then 'import' else l.source_kind end
     where l.id = lot_id and l.household_id = hid;

    -- ★管理対象（新規は save_lottery_tx が登録済み。指定があるときだけ更新）
    if (op ->> 'managed') is not null then
      update public.lottery_management set is_managed = (op ->> 'managed')::boolean, managed_at = coalesce(managed_at, now()), updated_by_profile_id = p_actor
       where lottery_id = lot_id and household_id = hid and is_managed <> (op ->> 'managed')::boolean;
    end if;

    select chain_id, multi_mode into v_chain, mode from public.lotteries where id = lot_id;

    -- 応募・当落（プロフィール別。記録が無い＝応募していない、とは区別する）
    for a in select * from jsonb_array_elements(coalesce(op -> 'apps', '[]'::jsonb)) loop
      select s.id into acc_id from public.service_accounts s
       where s.household_id = hid and s.chain_id = v_chain and s.active and s.managed_by_profile_id = (a ->> 'profile_id')::uuid
       order by s.created_at limit 1;

      -- スルー設定（この抽選だけのスルー）
      if (a ->> 'skip') is not null then
        if (a ->> 'skip')::boolean then
          insert into public.skip_rules (household_id, profile_id, scope_type, lottery_id, updated_by_profile_id)
          values (hid, (a ->> 'profile_id')::uuid, 'lottery', lot_id, p_actor)
          on conflict (profile_id, lottery_id) where scope_type = 'lottery' do nothing;
        else
          delete from public.skip_rules where household_id = hid and profile_id = (a ->> 'profile_id')::uuid and scope_type = 'lottery' and lottery_id = lot_id;
        end if;
      end if;

      if a ->> 'state' is null and a -> 'items' is null and a ->> 'result' is null and a ->> 'fulfillment' is null then
        continue;
      end if;
      if acc_id is null then raise exception 'no account for profile' using errcode = '23503'; end if;

      select * into app_row from public.applications where lottery_id = lot_id and service_account_id = acc_id for update;
      if not found then
        if coalesce(a ->> 'state', 'applied') = 'cancelled' then continue; end if;
        insert into public.applications (household_id, lottery_id, service_account_id, applied_at, state, origin, updated_by_profile_id)
        values (hid, lot_id, acc_id, nullif(a ->> 'applied_at', '')::timestamptz, 'applied', 'import', p_actor)
        returning * into app_row;
        n_apps := n_apps + 1;
      else
        update public.applications set
          state = coalesce(a ->> 'state', state),
          applied_at = case when a ? 'applied_at' then nullif(a ->> 'applied_at', '')::timestamptz else applied_at end,
          updated_by_profile_id = p_actor
         where id = app_row.id returning * into app_row;
        n_apps := n_apps + 1;
      end if;

      -- 希望商品（D: 希望の1つを選んで応募）
      if a -> 'selected' is not null and a ->> 'state' is distinct from 'cancelled' then
        select count(*), (array_agg(li.id))[1] into n_found, item_id from public.lottery_items li join public.products pr on pr.id = li.product_id
         where li.lottery_id = lot_id and ((a -> 'selected' ->> 'item_id') is not null and li.id = (a -> 'selected' ->> 'item_id')::uuid
               or (a -> 'selected' ->> 'item_id') is null and public.norm_name(pr.official_name) = public.norm_name(a -> 'selected' ->> 'product'));
        if n_found <> 1 then raise exception 'selected item not found' using errcode = '23503'; end if;
        update public.applications set selected_item_id = item_id where id = app_row.id;
      end if;

      -- 当落: 複数商品は商品別（集計値は set_item_results が再計算）、単一は直接
      if a -> 'items' is not null and jsonb_array_length(a -> 'items') > 0 then
        results := '[]'::jsonb;
        for it in select * from jsonb_array_elements(a -> 'items') loop
          select count(*), (array_agg(li.id))[1] into n_found, item_id from public.lottery_items li join public.products pr on pr.id = li.product_id
           where li.lottery_id = lot_id and ((it ->> 'item_id') is not null and li.id = (it ->> 'item_id')::uuid
                 or (it ->> 'item_id') is null and public.norm_name(pr.official_name) = public.norm_name(it ->> 'product'));
          if n_found <> 1 then raise exception 'item not found' using errcode = '23503'; end if;
          results := results || jsonb_build_object('item_id', item_id, 'result', it ->> 'result');
        end loop;
        perform public.set_item_results(app_row.id, results, p_actor);
      elsif a ->> 'result' is not null and mode = 'single' then
        update public.applications set
          result_status = a ->> 'result',
          result_confirmed_at = case when a ->> 'result' = 'pending' then null else coalesce(nullif(a ->> 'confirmed_at', '')::timestamptz, result_confirmed_at, now()) end,
          updated_by_profile_id = p_actor
         where id = app_row.id;
      end if;
      if a ? 'confirmed_at' and a ->> 'confirmed_at' is not null and a ->> 'result' is not null then
        update public.applications set result_confirmed_at = (a ->> 'confirmed_at')::timestamptz where id = app_row.id and result_status <> 'pending';
      end if;

      -- 購入手続き: 「手続き済み」だけ。購入記録（purchased）は購入の操作でのみ作る
      if a ->> 'fulfillment' is not null then
        update public.applications set
          fulfillment_status = a ->> 'fulfillment',
          procedure_completed_at = case when a ->> 'fulfillment' = 'procedure_done' then coalesce(procedure_completed_at, now()) else procedure_completed_at end
         where id = app_row.id and fulfillment_status <> 'purchased';
      end if;
    end loop;
  end loop;

  update public.lottery_import_history
     set created_count = n_created, updated_count = n_updated, unchanged_count = coalesce(p_unchanged, 0), application_count = n_apps,
         details = jsonb_build_object('created', created)
   where household_id = hid and fingerprint = p_fingerprint;

  return jsonb_build_object('created', created, 'updated', n_updated, 'applications', n_apps);
end;
$$;
revoke all on function public.apply_lottery_import(jsonb, uuid, text, text, text, int) from public, anon;
grant execute on function public.apply_lottery_import(jsonb, uuid, text, text, text, int) to authenticated;
