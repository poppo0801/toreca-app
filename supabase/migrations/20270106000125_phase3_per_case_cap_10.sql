-- Phase 3 FOUNDATION_RECOVERY: 1件あたりの費用上限（shadow_settings.per_case_cap_jpy）の許容範囲を ¥5 → ¥10 に広げる（利用者が承認: 1件10円・日次30円・通算100円）。
-- 制約の置き換えのみ（既存の行・値・列の型は変更しない。既存の値は3円で、新しい制約を満たす）。範囲を狭める変更ではない。
-- 逆戻し（参考・本番では実行しない）: 制約を `per_case_cap_jpy > 0 and per_case_cap_jpy <= 5` に戻す（値が5を超える行が無いことを確認してから）。

alter table public.shadow_settings drop constraint if exists shadow_settings_per_case_cap_jpy_check;
alter table public.shadow_settings add constraint shadow_settings_per_case_cap_jpy_check check (per_case_cap_jpy > 0 and per_case_cap_jpy <= 10);
