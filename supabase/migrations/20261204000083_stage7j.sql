-- Stage 7J: 管理者プロフィール（抽選候補ページの管理操作を管理者に限定する）
--  profiles.is_admin: 管理者プロフィールか。判定は表示名ではなくプロフィールID（この列）で行うので、表示名を変更しても権限は変わらない。
--  既存の「はとむぎ」を管理者に設定する（この移行時点の名前での1回限りの設定。以後は名前を参照しない）。テスト世帯は対象外。
alter table public.profiles add column is_admin boolean not null default false;
update public.profiles set is_admin = true where label = 'はとむぎ' and not public.is_test_household(household_id);
