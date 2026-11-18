-- Stage 8F-6: 抽選形態（店舗選択式／店舗別独立抽選／その他）の分類の記録（開発DBのみで検証。本番へは、利用者の承認・事前バックアップのうえ別途適用する）。
-- 目的: 利用者が手動で修正した分類を、AI・収集・再解析が根拠なく上書きしないために、「分類」と「誰が決めたか」を記録する。
-- 方針: 追加のみ（NULL許容の列2つ）。既存の行・応募・当選・購入・通知・期限・store_mode には一切触れない。未設定（NULL）は従来どおり store_mode と構造の判別で扱う。
alter table public.lotteries
  add column lottery_form text check (lottery_form in ('store_select', 'store_independent', 'other')),
  add column lottery_form_source text check (lottery_form_source in ('manual', 'rule', 'ai')),
  add constraint lotteries_lottery_form_pair check ((lottery_form is null) = (lottery_form_source is null));
comment on column public.lotteries.lottery_form is '抽選形態: store_select=店舗選択式（応募時に店舗を選ぶ・カード1件）/ store_independent=店舗別独立抽選 / other=通販・単独など。NULL=未設定';
comment on column public.lotteries.lottery_form_source is '分類を決めたもの: manual=利用者（最優先。AI・収集は上書きしない）/ rule=収集・固定ロジック / ai=AI';
