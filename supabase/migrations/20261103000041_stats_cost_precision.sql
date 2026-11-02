-- Stage 4C 追加: 日別統計の費用の精度を上げる（1回あたり1円未満のため、小数第2位の丸めが積み重ならないよう小数第4位まで保持する）。型の拡張のみ（値は変わらない）。
alter table public.collection_daily_stats alter column cost_jpy type numeric(12, 4);
