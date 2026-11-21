-- Stage 10L: 画像根拠の検証結果の保存（**ローカルの開発DBでのみ適用・検証。本番へは、利用者の承認・直前の完全バックアップのうえ、10Kのマイグレーションの後に別途適用する**）
-- 目的: 収集時の画像の読み取り（申告）を、元画像の独立した書き起こし（盲検）と照合した記録を、追記専用で残す（再解析の抑止＝キャッシュ、監査、費用の集計）。
-- 方針: 追加のみ。画像そのものは保存しない（ハッシュ・書き起こした文字列・取得日時だけ）。書き起こしは公開告知の画像に見える文字で、保存前に伏せ字を通す。保持期限（shadow_settings.retention_days）で掃除する。
-- 逆戻し（参考・本番では実行しない）: drop table shadow_image_verifications; shadow_spent / shadow_purge は 10K の定義に戻す（この表を参照しない版）。

create table public.shadow_image_verifications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  image_index int not null check (image_index between 1 and 8),
  -- 取得した画像のバイト列の SHA-256。画像が更新されるとハッシュが変わり、再検証になる
  image_hash text not null check (image_hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz not null,
  -- 書き起こした行（[{text, certainty}]。伏せ字済み・最大80行・各200字）
  transcript jsonb not null check (jsonb_typeof(transcript) = 'array' and jsonb_array_length(transcript) <= 80 and pg_column_size(transcript) <= 30000),
  method text not null default 'blind_transcription' check (method in ('blind_transcription')),
  model_id text not null check (char_length(model_id) <= 80),
  prompt_version text not null check (char_length(prompt_version) <= 40),
  -- 費用（円）。不明は NULL（0円にしない）
  cost_jpy numeric(10, 4) check (cost_jpy is null or cost_jpy >= 0),
  created_at timestamptz not null default now(),
  unique (household_id, candidate_id, image_hash),
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
create index shadow_image_verifications_household_time on public.shadow_image_verifications (household_id, created_at desc);

-- 追記専用（更新不可）。削除は保持期限の掃除（service_role）のみ
create function public.shadow_image_verifications_no_update() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'shadow_image_verifications は追記専用です（更新できません）';
end;
$$;
create trigger shadow_image_verifications_append_only before update on public.shadow_image_verifications for each row execute function public.shadow_image_verifications_no_update();

alter table public.shadow_image_verifications enable row level security;
revoke all on public.shadow_image_verifications from anon, authenticated;
grant select on public.shadow_image_verifications to authenticated;
create policy shadow_image_verifications_select on public.shadow_image_verifications for select to authenticated using (public.is_household_member(household_id));
grant all on public.shadow_image_verifications to service_role;
revoke update on public.shadow_image_verifications from service_role;

-- 費用の集計に、画像の書き起こしの費用も含める（日次・月次の上限は、判断と画像の合計で守る）
create or replace function public.shadow_spent(p_household uuid, p_since timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select sum(cost_jpy) from public.shadow_judgments where household_id = p_household and created_at >= p_since), 0)
       + coalesce((select sum(cost_jpy) from public.shadow_image_verifications where household_id = p_household and created_at >= p_since), 0);
$$;

-- 保持期限の掃除に、画像の検証記録を追加
create or replace function public.shadow_purge()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  a int;
  b int;
  c int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'shadow_purge はサービス権限のみ';
  end if;
  delete from public.shadow_judgments j using public.shadow_settings s
  where s.household_id = j.household_id and j.created_at < now() - make_interval(days => s.retention_days);
  get diagnostics a = row_count;
  delete from public.shadow_jobs j using public.shadow_settings s
  where s.household_id = j.household_id and j.status in ('done', 'failed', 'skipped') and j.updated_at < now() - make_interval(days => s.retention_days);
  get diagnostics b = row_count;
  delete from public.shadow_image_verifications v using public.shadow_settings s
  where s.household_id = v.household_id and v.created_at < now() - make_interval(days => s.retention_days);
  get diagnostics c = row_count;
  return a + b + c;
end;
$$;

comment on table public.shadow_image_verifications is '画像根拠の検証記録（Stage 10L・追記専用）。元画像の独立した書き起こし（盲検）・画像ハッシュ・取得日時。画像そのものは保存しない。';
