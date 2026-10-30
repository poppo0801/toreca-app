-- Stage 5H: 縦長画像を分割して1件の抽選として解析するため、1項目に使える画像の上限を5枚から12枚に広げる。
-- 既存の行・データには影響しない（制約の付け替えのみ）。
alter table public.ai_job_items drop constraint if exists ai_job_items_image_paths_check;
alter table public.ai_job_items add constraint ai_job_items_image_paths_check check (cardinality(image_paths) <= 12);
