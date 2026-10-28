-- Stage 4.5: 抽選の「初期値のまま保存した項目」の記録、商品画像の透明余白（表示範囲）。追加のみ。既存データは変更しない。

-- 応募方法・受取方法などを初期値（未確認の仮設定）のまま保存したかを記録する。
-- 利用者が選び直す（確認する）と、アプリが外す。既存の抽選は空配列（=確認済みとして扱う）。
alter table public.lotteries
  add column unconfirmed_fields text[] not null default '{}';
alter table public.lotteries
  add constraint lotteries_unconfirmed_fields_chk
  check (unconfirmed_fields <@ array['applyMethod', 'receiveMethod', 'limitBasis']::text[]);

-- 商品画像の透明でない範囲（元画像のピクセル座標 {x,y,w,h}）。表示時に余白を詰めるための情報で、画像ファイルは変更しない。
-- NULL は補正なし（未計算・余白なし）。
alter table public.product_images
  add column content_box jsonb;
alter table public.product_images
  add constraint product_images_content_box_chk
  check (
    content_box is null
    or (
      jsonb_typeof(content_box) = 'object'
      and (content_box ->> 'x') ~ '^[0-9]{1,6}$'
      and (content_box ->> 'y') ~ '^[0-9]{1,6}$'
      and (content_box ->> 'w') ~ '^[1-9][0-9]{0,5}$'
      and (content_box ->> 'h') ~ '^[1-9][0-9]{0,5}$'
    )
  );
