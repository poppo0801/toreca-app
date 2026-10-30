-- Stage 5I: 商品画像の一覧用サムネイル。追加のみ（元画像 storage_path は変更・削除しない）。
-- thumb_path は同じ非公開バケット product-images 内の軽量WebP（高さ約288px）。NULL = サムネイルなし（元画像を表示）。
alter table public.product_images
  add column thumb_path text check (thumb_path is null or char_length(thumb_path) <= 300);
