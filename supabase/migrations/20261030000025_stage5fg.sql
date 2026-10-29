-- Stage 5F（コレクション）・5G（AI一括解析のジョブ管理）。追加のみ。既存データ・既存の内部IDは変更しない。
-- 適用前に npm run backup を取得し検証済みであること（docs/backup-and-ops.md）。

-- ================================================================ 5F: コレクション
-- カードマスター（カードそのものを識別する情報）。抽選・購入の「商品」マスター(products)とは別物。
create table public.card_masters (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  card_number text not null default '' check (char_length(card_number) <= 20),
  set_code text not null default '' check (char_length(set_code) <= 20),
  rarity text not null default '' check (char_length(rarity) <= 10),
  card_type text not null default '' check (char_length(card_type) <= 30),
  -- 収録商品の表記（AI読み取り・手入力）。商品マスターと一致が確かなときだけ product_id を設定する
  product_name text not null default '' check (char_length(product_name) <= 120),
  product_id uuid,
  -- 画像（Storage card-images 内のパス）。一覧用のサムネイルと詳細用を分ける
  image_path text check (image_path is null or char_length(image_path) <= 300),
  thumb_path text check (thumb_path is null or char_length(thumb_path) <= 300),
  image_sha256 text check (image_sha256 is null or image_sha256 ~ '^[0-9a-f]{64}$'),
  -- 外部情報を参照した場合の出典（実際に参照したときだけ設定する）
  source_url text check (source_url is null or (char_length(source_url) <= 2000 and source_url ~* '^https?://')),
  -- 画像解析の実行（ai_extraction_logs）。解析結果と最終登録値の比較・精度評価に使う
  analysis_run_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (analysis_run_id, household_id) references public.ai_extraction_logs (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
-- 番号がある同じカード（商品コード・番号・レアリティ）は1つだけ。名称の類似では統合しない
create unique index card_masters_identity on public.card_masters (household_id, lower(set_code), lower(card_number), lower(rarity)) where card_number <> '' and archived_at is null;
create index card_masters_recent on public.card_masters (household_id, created_at desc);

-- 所有記録（取得ごとの記録）。同じカードを異なる価格・日付で取得した場合は複数行になり、一覧では合算して表示する
create table public.card_holdings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  card_id uuid not null,
  quantity int not null check (quantity between 1 and 9999),
  acquired_on date,
  -- 1枚あたりの購入価格（円）。不明は NULL（0円として扱わない）
  unit_price_yen int check (unit_price_yen is null or unit_price_yen between 0 and 100000000),
  source text not null default '' check (char_length(source) <= 60),
  condition text not null default '' check (char_length(condition) <= 30),
  note text not null default '' check (char_length(note) <= 500),
  -- 関連する購入記録（参照のみ。コレクションの削除では購入・収支は削除しない）
  purchase_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (card_id, household_id) references public.card_masters (id, household_id),
  foreign key (purchase_id, household_id) references public.purchases (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index card_holdings_card on public.card_holdings (card_id) where archived_at is null;

-- 参考相場の履歴（追記専用）。販売参考・買取参考を区別し、確認日・出典を持つ。現在の値は最新の行
create table public.card_prices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  card_id uuid not null,
  kind text not null check (kind in ('sale', 'buyback')),
  amount_yen int not null check (amount_yen between 0 and 100000000),
  confirmed_on date not null default current_date,
  source text not null default '' check (char_length(source) <= 60),
  source_url text check (source_url is null or (char_length(source_url) <= 2000 and source_url ~* '^https?://')),
  created_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (card_id, household_id) references public.card_masters (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index card_prices_latest on public.card_prices (card_id, kind, confirmed_on desc, created_at desc);

-- お気に入り（プロフィールごと）と並び順
create table public.card_favorites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  profile_id uuid not null,
  card_id uuid not null,
  rank int not null default 0 check (rank >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  unique (profile_id, card_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id),
  foreign key (card_id, household_id) references public.card_masters (id, household_id)
);

-- ================================================================ 5G: AI解析ジョブ
-- ジョブ＝まとめて解析する依頼。項目(item)＝1件の抽選の解析（文章・URL・X投稿・複数画像のいずれか）。状態はサーバー（DB）に保持する。
create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  created_by_profile_id uuid,
  label text not null default '' check (char_length(label) <= 60),
  -- queued 待機 / running 解析中 / review 確認待ち / partial 一部失敗 / failed 失敗 / cancelled キャンセル / saved 保存済み
  status text not null default 'queued' check (status in ('queued', 'running', 'review', 'partial', 'failed', 'cancelled', 'saved')),
  total_items int not null default 0 check (total_items between 0 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  -- 結果を確認画面で開いた日時（完了通知の既読）
  seen_at timestamptz,
  unique (id, household_id),
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id)
);
create table public.ai_job_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  job_id uuid not null,
  position int not null default 0,
  source_kind text not null check (source_kind in ('text', 'url', 'x_url', 'images')),
  source_text text check (source_text is null or char_length(source_text) <= 20000),
  source_url text check (source_url is null or char_length(source_url) <= 2000),
  -- 入力画像（Storage job-inputs 内のパス。解析が終わったら削除する）。1抽選に最大5枚
  image_paths text[] not null default '{}' check (cardinality(image_paths) <= 5),
  -- 重複登録の防止（同じURL・同じ投稿・同じ文章・同じ画像）。進行中・確認待ちの間だけ一意
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 100),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled', 'saved', 'skipped')),
  attempts smallint not null default 0 check (attempts between 0 and 10),
  lease_until timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 40),
  error_message text check (error_message is null or char_length(error_message) <= 300),
  -- 検証済みの抽出結果（確認待ち。正式な抽選ではない）
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  -- 解析ログ（費用・解析仕様・抽出結果の記録）。保存時のフィードバック記録に使う
  run_id uuid,
  lottery_id uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (job_id, household_id) references public.ai_jobs (id, household_id) on delete cascade,
  foreign key (run_id, household_id) references public.ai_extraction_logs (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id)
);
create index ai_job_items_job on public.ai_job_items (job_id, position);
create index ai_job_items_work on public.ai_job_items (household_id, status, created_at) where status in ('queued', 'running');
create unique index ai_job_items_dedupe on public.ai_job_items (household_id, dedupe_key) where dedupe_key is not null and status in ('queued', 'running', 'done');
-- 同じ抽選に結びつく項目は1つだけ（二重保存の防止）
create unique index ai_job_items_lottery on public.ai_job_items (lottery_id) where lottery_id is not null;

-- 解析ログに、コレクションのカード画像解析の種別を追加
alter table public.ai_extraction_logs drop constraint ai_extraction_logs_kind_check;
alter table public.ai_extraction_logs add constraint ai_extraction_logs_kind_check check (kind in ('text', 'image', 'url', 'x_url', 'card_image'));

-- ================================================================ RLS・権限・トリガー
do $$
declare
  t text;
begin
  foreach t in array array['card_masters', 'card_holdings', 'card_favorites', 'ai_jobs', 'ai_job_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
  end loop;
  -- 監査（削除を伴わない表）
  foreach t in array array['card_masters', 'card_holdings'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row()', t || '_audit', t);
  end loop;
end;
$$;
-- お気に入りは並び替え・解除のため削除を許可
grant delete on public.card_favorites to authenticated;
create policy card_favorites_delete on public.card_favorites for delete to authenticated using (public.is_household_member(household_id));
-- 参考相場は追記専用（更新・削除なし）
alter table public.card_prices enable row level security;
revoke all on public.card_prices from anon, authenticated;
grant select, insert on public.card_prices to authenticated;
grant select, insert, update, delete on public.card_prices to service_role;
create policy card_prices_select on public.card_prices for select to authenticated using (public.is_household_member(household_id));
create policy card_prices_insert on public.card_prices for insert to authenticated with check (public.is_household_member(household_id));
create trigger card_prices_audit after insert on public.card_prices for each row execute function public.audit_row();
