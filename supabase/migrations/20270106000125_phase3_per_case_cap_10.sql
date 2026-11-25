-- Phase 3 FOUNDATION_RECOVERY（利用者の承認: 1件10円・日次30円・通算100円）。
-- ① shadow_settings.per_case_cap_jpy の許容範囲を ¥5 → ¥10 に広げる（制約の置き換えのみ。既存の値は3円で、新しい制約を満たす。範囲を狭める変更ではない）。
-- ② shadow_settings.judge_model（NULL可）を追加: 登録判断だけに使うモデル。比較・切り戻しを環境変数の変更なしに、DBの設定で行うため。NULL=従来どおり（調査と同じモデル）。
--    値の形だけを検査する（実際に使えるモデルかはアプリ側が料金表で検査し、未知のモデルは採用しない）。
-- 逆戻し（参考・本番では実行しない）: 制約を `per_case_cap_jpy > 0 and per_case_cap_jpy <= 5` に戻す（5を超える行が無いことを確認してから）／judge_model 列は未使用なら残してよい。

alter table public.shadow_settings drop constraint if exists shadow_settings_per_case_cap_jpy_check;
alter table public.shadow_settings add constraint shadow_settings_per_case_cap_jpy_check check (per_case_cap_jpy > 0 and per_case_cap_jpy <= 10);
alter table public.shadow_settings add column if not exists judge_model text check (judge_model is null or judge_model ~ '^claude-[a-z0-9.-]{3,60}$');
