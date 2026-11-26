-- Phase 3 ADAPTIVE_REVIEW: 適応型判断の記録・人の正解記録・登録案の版の置き換えの原子化。追加のみ（既存の列・行・値は変更しない。NOT NULL の緩和と CHECK の拡張だけ）。
-- ① shadow_settings.judge_mode: 判断モデルの使い方（single=judge_model か既定の1つ／adaptive=既定で判断し必要時だけ judge_model へ上げる）。既定 single（従来どおり）。
-- ② registration_proposals.judge_trail: 判断の各段（モデル・選んだ理由・判断・検証・費用）。既定は空配列（旧い行は変わらない）。
-- ③ registration_proposal_reviews: 人の「正解」を記録できるよう拡張する（kind=review は従来のレビュー。kind=truth は正解の記録、kind=missed は取りこぼしの記録）。
--    正解の記録はAIの出力とは別に保存し、AIの値・過去の行を書き換えない（追記専用のまま）。取りこぼしは登録案が無い候補にも残せるよう、proposal_id を NULL 可にする（review は従来どおり必須）。
-- ④ registration_proposal_replace: 現行の版の置き換え（古い版に superseded_at を付ける → 新しい版を追加）を1つのトランザクションで行う（途中の失敗・中断で現行の版が無くならない）。サービス権限だけ。
-- 逆戻し（参考・本番では実行しない）: 追加した列・関数・制約を削除し、proposal_id/proposal_key を NOT NULL に戻す（kind<>'review' の行を退避してから）。

alter table public.shadow_settings add column if not exists judge_mode text not null default 'single' check (judge_mode in ('single', 'adaptive'));

alter table public.registration_proposals add column if not exists judge_trail jsonb not null default '[]'::jsonb check (jsonb_typeof(judge_trail) = 'array' and pg_column_size(judge_trail) <= 4000);

alter table public.registration_proposal_reviews alter column proposal_id drop not null;
alter table public.registration_proposal_reviews alter column proposal_key drop not null;
alter table public.registration_proposal_reviews add column if not exists kind text not null default 'review' check (kind in ('review', 'truth', 'missed'));
alter table public.registration_proposal_reviews add column if not exists candidate_id uuid references public.collection_candidates (id) on delete cascade; -- 候補が消えたら取りこぼしの記録も消える（登録案の行と同じ扱い）
alter table public.registration_proposal_reviews add column if not exists verdict text check (verdict is null or verdict in ('correct', 'corrected', 'unknown_later'));
alter table public.registration_proposal_reviews add column if not exists truth_decision text check (truth_decision is null or truth_decision in ('register', 'exclude', 'hold'));
alter table public.registration_proposal_reviews add column if not exists opportunity text check (opportunity is null or opportunity in ('exists', 'absent', 'unknown'));
alter table public.registration_proposal_reviews add column if not exists user_fit text check (user_fit is null or user_fit in ('fit', 'unfit', 'unknown'));
alter table public.registration_proposal_reviews add column if not exists unknown_fields text[] not null default '{}' check (cardinality(unknown_fields) <= 16);
alter table public.registration_proposal_reviews add column if not exists ai_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(ai_snapshot) = 'object' and pg_column_size(ai_snapshot) <= 4000);
alter table public.registration_proposal_reviews drop constraint if exists registration_proposal_reviews_decision_check;
alter table public.registration_proposal_reviews add constraint registration_proposal_reviews_decision_check check (decision in ('hold', 'approve_with_edits', 'reject', 'truth', 'missed'));
alter table public.registration_proposal_reviews add constraint registration_proposal_reviews_kind_shape check (
  (kind = 'review' and proposal_id is not null and proposal_key is not null and decision in ('hold', 'approve_with_edits', 'reject'))
  or (kind = 'truth' and proposal_id is not null and proposal_key is not null and decision = 'truth' and verdict is not null)
  or (kind = 'missed' and candidate_id is not null and decision = 'missed' and char_length(note) >= 1)
);
create index if not exists registration_proposal_reviews_candidate on public.registration_proposal_reviews (household_id, candidate_id, created_at desc);

create or replace function public.registration_proposal_replace(p_old uuid, p_row jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_old is not null then
    update public.registration_proposals set superseded_at = now() where id = p_old and superseded_at is null;
    if not found then
      raise exception 'registration_proposal_replace: 現行の版が見つかりません（同時に置き換えられた可能性）';
    end if;
  end if;
  -- 渡されない列は表の既定値と同じ値を補う（jsonb_populate_record は既定値を使わず NULL にするため）
  insert into public.registration_proposals select (jsonb_populate_record(null::public.registration_proposals, jsonb_build_object('judge_trail', '[]'::jsonb, 'source_urls', '[]'::jsonb, 'link_hosts', '[]'::jsonb, 'held_reasons', '[]'::jsonb, 'fields', '{}'::jsonb, 'unknowns', '[]'::jsonb, 'pages', '[]'::jsonb, 'possibly_same', '[]'::jsonb, 'verified', false, 'apply_unit', 'unknown', 'apply_unit_basis', 'unknown', 'item_label', '', 'version', 1) || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(p_row) e where e.value <> 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('id', gen_random_uuid(), 'created_at', now(), 'judged_at', coalesce(p_row->>'judged_at', now()::text), 'superseded_at', null))).*
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.registration_proposal_replace(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.registration_proposal_replace(uuid, jsonb) to service_role;
