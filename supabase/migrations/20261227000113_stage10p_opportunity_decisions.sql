-- Stage 10P: 応募機会の判断（自動登録プレビュー／欠落つき候補／確認待ち／除外／更新提案）と日時の正規化の保存（**ローカルの開発DBでのみ適用・検証。本番へは、利用者の承認・直前の完全バックアップのうえ、108〜112の後に別途適用する**）
-- 方針: 追加のみ（既存の列・データを変えない）。**既存の登録・応募・当選・購入・通知には書かない**。判断は「プレビュー」で、登録・通知は実行されない。
--   公式性は判断の条件ではないため、公式性の列は持たない（抽選詳細の任意バッジは、確認済みの根拠があるときだけ別に表示する設計。ここでは保存しない）。
--   除外（excluded）の行も保存し、理由コードを残す（誤除外を後から監査できる）。原文・URLは保存しない。
-- 逆戻し（参考・本番では実行しない）: alter table shadow_opportunities drop column decision, decision_reasons, notifiable, deadline_norm, independent_sources;

alter table public.shadow_opportunities
  add column decision text not null default 'needs_review' check (decision in ('auto_register_preview', 'candidate_with_gaps', 'needs_review', 'excluded', 'update_proposals')),
  add column decision_reasons text[] not null default '{}' check (cardinality(decision_reasons) <= 16),
  -- 通知に使ってよい締切か（役割が締切・年が明示/曜日で確認・時刻あり・原文の根拠が確認済み）
  add column notifiable boolean not null default false,
  -- 締切の正規化（date/time/precision/yearBasis/role。JST）。原文の日時そのものは持たない
  add column deadline_norm jsonb check (deadline_norm is null or jsonb_typeof(deadline_norm) = 'object'),
  add column independent_sources int not null default 1 check (independent_sources between 0 and 50);

create index shadow_opportunities_decision on public.shadow_opportunities (household_id, decision, updated_at desc);

comment on column public.shadow_opportunities.decision is '判断のプレビュー（Stage 10P）。実際の登録・通知は行わない。公式性は条件ではない。';
