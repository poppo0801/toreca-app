/** 系列ロゴの保存サイズ（正方形）。カードの表示は20px前後なので、高解像度の画面でもにじまない大きさ */
export const LOGO_SIZE = 192;

/** ロゴの配信URL。内容ハッシュ(v)入りなので、差し替えると自動で新しい画像になり、長期間キャッシュできる */
export const chainLogoUrl = (chainId: string, sha256: string) => `/api/chain-logo/${chainId}?v=${sha256.slice(0, 12)}`;
