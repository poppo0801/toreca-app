-- Stage 8D-2: 店舗所在地の調査結果（自律型AIエージェントの調査ログ）。
-- 店舗マスター（stores）とは分離して保存する。この表への保存は、検証済みの専用処理（アプリ）だけが行い、stores を更新するトリガー・関数は無い。
-- 追記専用（履歴）: 認証済みユーザーは select / insert のみ（update / delete なし）。
-- ※ 開発用DBで検証する。本番へは、利用者の承認・事前バックアップのうえで別途適用する（Stage 8D-2 では本番に適用していない）。

create table public.store_location_research (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  store_id uuid not null,
  -- 調査時点の系列名・店舗名（後で店舗名が変わっても、何を調べたか分かるように）
  chain_name text not null check (char_length(chain_name) between 1 and 80),
  store_name text not null check (char_length(store_name) between 1 and 80),
  status text not null check (status in ('confirmed', 'candidate', 'insufficient', 'conflict', 'not_found', 'limit_reached', 'failed')),
  address text check (address is null or char_length(address) <= 200),
  prefecture text check (prefecture is null or char_length(prefecture) <= 10),
  city text check (city is null or char_length(city) <= 40),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  -- 規則に基づく信頼度（0〜100）。AI の自己評価ではなく、引用の実在・店舗の識別・公式性・地図の照合などから算出
  confidence smallint not null check (confidence between 0 and 100),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 20),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) <= 30),
  candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) <= 10),
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  trace jsonb not null default '[]'::jsonb check (jsonb_typeof(trace) = 'array' and jsonb_array_length(trace) <= 200),
  engine text not null check (char_length(engine) between 1 and 80),
  researched_at timestamptz not null default now(),
  created_by_profile_id uuid,
  check ((latitude is null) = (longitude is null)),
  foreign key (store_id, household_id) references public.stores (id, household_id) on delete cascade,
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index store_location_research_store_idx on public.store_location_research (household_id, store_id, researched_at desc);

alter table public.store_location_research enable row level security;
revoke all on public.store_location_research from anon, authenticated;
grant select, insert on public.store_location_research to authenticated;
grant select, insert, update, delete on public.store_location_research to service_role;
create policy store_location_research_select on public.store_location_research for select to authenticated using (public.is_household_member(household_id));
create policy store_location_research_insert on public.store_location_research for insert to authenticated with check (public.is_household_member(household_id));
