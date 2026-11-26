-- Phase 3 RUNTIME_CORRECTNESS（利用者の承認 2026-11-26: 1件25円・日次60円・通算130円）。
-- shadow_settings.per_case_cap_jpy の許容範囲を ¥10 → ¥25 に広げる（制約の置き換えのみ。既存の行・値は変更しない。現在の値10円は新しい制約を満たす）。
-- 理由: 判断モデルの比較（Sonnet 5.5）で、1回の最悪費用（約¥10）を自己修正を含め2回分、事前に引当てる必要がある（引当は使わなければ戻る）。
-- 逆戻し（参考・本番では実行しない）: 制約を `<= 10` に戻す（10を超える行が無いことを確認してから）。

alter table public.shadow_settings drop constraint if exists shadow_settings_per_case_cap_jpy_check;
alter table public.shadow_settings add constraint shadow_settings_per_case_cap_jpy_check check (per_case_cap_jpy > 0 and per_case_cap_jpy <= 25);
