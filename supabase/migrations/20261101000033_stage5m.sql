-- Stage 5M: 当落発表方法の単一選択化（既存の複数選択データの移行）・系列ロゴ。追加と補足への移動のみ（削除なし）。

-- ---------------------------------------------------------------- 当落発表方法: 主な1つを残し、残りは補足へ
-- 優先順で主な方法を1つ選ぶ。残りの方法名は「他の確認方法: …」として補足(announcement_method)の末尾へ追記する。
-- 既存の補足は消さない。補足が200文字を超える場合は、備考(memo)へ追記する（情報を失わない）。
do $$
declare
  r record;
  prio text[] := array['winner_mail', 'result_mail', 'result_page', 'app', 'x_dm', 'line', 'sms', 'in_store', 'sns_post', 'phone', 'other', 'unknown'];
  lbl jsonb := '{"result_mail":"当落メール","winner_mail":"当選者のみメール","result_page":"結果確認ページ","app":"公式アプリ","x_dm":"XのDM","line":"LINE","sms":"SMS","in_store":"店頭発表","sns_post":"SNS投稿","phone":"電話","other":"その他","unknown":"不明"}';
  m text;
  prim text;
  rest text[];
  note_line text;
  base_note text;
begin
  for r in select id, announcement_methods, announcement_method, memo from public.lotteries where cardinality(announcement_methods) > 1 loop
    prim := null;
    rest := '{}';
    foreach m in array prio loop
      continue when not (m = any (r.announcement_methods));
      continue when m = 'unknown'; -- 他の方法があるので「不明」は外す
      if prim is null then
        prim := m;
      elsif not (prim = 'winner_mail' and m = 'result_mail') and m <> 'other' then
        rest := rest || (lbl ->> m);
      end if;
    end loop;
    if prim is null then
      prim := 'unknown';
    end if;
    base_note := coalesce(r.announcement_method, '');
    if cardinality(rest) = 0 then
      update public.lotteries set announcement_methods = array[prim] where id = r.id;
      continue;
    end if;
    note_line := '他の確認方法: ' || array_to_string(rest, '、');
    if position(note_line in base_note) > 0 then
      update public.lotteries set announcement_methods = array[prim] where id = r.id;
    elsif char_length(case when btrim(base_note) = '' then note_line else btrim(base_note) || E'\n' || note_line end) <= 200 then
      update public.lotteries
        set announcement_methods = array[prim],
            announcement_method = case when btrim(base_note) = '' then note_line else btrim(base_note) || E'\n' || note_line end
        where id = r.id;
    else
      update public.lotteries
        set announcement_methods = array[prim],
            memo = left(case when btrim(coalesce(r.memo, '')) = '' then '当落発表: ' || note_line else btrim(r.memo) || E'\n' || '当落発表: ' || note_line end, 2000)
        where id = r.id;
    end if;
  end loop;
end $$;

alter table public.lotteries
  drop constraint if exists lotteries_announcement_methods_single_chk;
alter table public.lotteries
  add constraint lotteries_announcement_methods_single_chk check (cardinality(announcement_methods) <= 1);

-- ---------------------------------------------------------------- 系列ロゴ
-- 実体は Storage の非公開バケット product-images（パス: <household_id>/chain-logos/<chain_id>-<sha12>.png）。ここは参照のみ。
-- 系列単位で1つ持ち、所属する全店舗で共通に使う（店舗ごとに画像を保存しない）。
alter table public.chains
  add column if not exists logo_path text check (logo_path is null or char_length(logo_path) <= 300),
  add column if not exists logo_sha256 text check (logo_sha256 is null or logo_sha256 ~ '^[0-9a-f]{64}$');
alter table public.chains
  drop constraint if exists chains_logo_pair_chk;
alter table public.chains
  add constraint chains_logo_pair_chk check ((logo_path is null) = (logo_sha256 is null));

-- ---------------------------------------------------------------- Storage: 自世帯フォルダの画像の削除（ロゴの削除・差し替え時に古いファイルを消す）
do $$
begin
  if to_regclass('storage.objects') is not null
     and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'product_images_delete') then
    create policy product_images_delete on storage.objects for delete to authenticated
      using (bucket_id = 'product-images' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end);
  end if;
end;
$$;
