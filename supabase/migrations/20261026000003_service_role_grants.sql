-- service_role（サーバー専用・バックアップ/管理スクリプト用）に表の操作権限を明示付与する。
-- anon / authenticated には付与しない。アプリコードは service_role を使わない。
-- audit_logs の追記専用トリガーは service_role にも適用される（UPDATE/DELETE/TRUNCATE は拒否）。
grant select, insert, update, delete on all tables in schema public to service_role;
