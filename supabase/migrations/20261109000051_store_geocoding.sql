-- Stage 5P追加: 店舗住所からの緯度経度の自動取得（追加のみ。既存の店舗ID・抽選・応募履歴は変更しない）
-- geo_status: none=住所なし / pending=取得待ち（取得中を含む）/ ok=取得済み・手入力 / failed=取得失敗 / incomplete=住所不完全（補完待ち）
alter table public.stores
  add column geo_status text not null default 'none' check (geo_status in ('none', 'pending', 'ok', 'failed', 'incomplete')),
  add column geo_attempts int not null default 0 check (geo_attempts >= 0),
  -- 保存済みの座標がどの住所から取得されたか（住所が変わったら座標は破棄される）
  add column geo_address text,
  add column geo_error text check (geo_error is null or char_length(geo_error) <= 40),
  add column geo_checked_at timestamptz;
create index stores_geo_status_idx on public.stores (geo_status) where geo_status in ('pending', 'failed');

-- 住所の登録・変更・削除で位置情報の状態を揃える。画面・Excel取込・AI自動収集のどの経路でも同じ（アプリ側の取得は別処理）。
-- ・住所が変わったとき、同じ操作で座標も指定されていれば手入力として採用、そうでなければ古い座標を破棄して取得待ちにする
-- ・住所が空になったら座標を破棄して「住所なし」にする（古い座標で距離が出続けない）
create function public.stores_geo_reset()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.latitude is not null and new.longitude is not null then
      new.geo_status := 'ok';
      new.geo_address := nullif(btrim(new.address_optional), '');
    elsif nullif(btrim(new.address_optional), '') is not null then
      new.geo_status := 'pending';
    else
      new.geo_status := 'none';
    end if;
    return new;
  end if;
  if new.address_optional is distinct from old.address_optional then
    if (new.latitude, new.longitude) is distinct from (old.latitude, old.longitude) and new.latitude is not null then
      new.geo_status := 'ok';
      new.geo_address := nullif(btrim(new.address_optional), '');
    else
      new.latitude := null;
      new.longitude := null;
      new.geo_address := null;
      new.geo_status := case when nullif(btrim(new.address_optional), '') is null then 'none' else 'pending' end;
    end if;
    new.geo_attempts := 0;
    new.geo_error := null;
    new.geo_checked_at := null;
  end if;
  return new;
end;
$$;
create trigger stores_geo_reset_trg before insert or update on public.stores
  for each row execute function public.stores_geo_reset();

-- 既存店舗の状態を揃える（座標・住所そのものは変更しない）
update public.stores set geo_status = 'ok', geo_address = nullif(btrim(address_optional), '')
  where latitude is not null and longitude is not null;
update public.stores set geo_status = 'pending'
  where (latitude is null or longitude is null) and nullif(btrim(address_optional), '') is not null;
