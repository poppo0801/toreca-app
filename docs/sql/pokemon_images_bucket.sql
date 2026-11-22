-- ポケモン画像の非公開バケット（Storage）。**自動では適用されない**（supabase/migrations には置かない）。
-- 画像の利用権限（ライセンス）の確認が済み、利用者が本番への導入を承認したときだけ、手動で適用する。
-- 既存のバケット・ポリシー（product-images 等）には触れない。ロールバック: 下の「ロールバック」を実行（バケット内のオブジェクトを先に削除）。
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('pokemon-images', 'pokemon-images', false, 524288, array['image/webp'])
    on conflict (id) do nothing;

    -- パスの先頭フォルダ = 世帯ID。自世帯のメンバーだけが読める（匿名・他世帯・形式が不正なパスは常に拒否）。書き込みはポリシーなし（service role のアップロード専用）
    create policy pokemon_images_select on storage.objects for select to authenticated
      using (bucket_id = 'pokemon-images' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end);
  end if;
end;
$$;

-- ロールバック（バケットが空であること）:
--   drop policy if exists pokemon_images_select on storage.objects;
--   delete from storage.buckets where id = 'pokemon-images';
