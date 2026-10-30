// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LOW_RES_WIDTH, MAX_SOURCE_PIXELS, MAX_TILES, MIN_TILE_WIDTH, TILE_HEIGHT, TILE_OVERLAP, coversWholeImage, lowResolutionNotice, planImage } from "@/lib/image-tiles";
import { buildUserText, type ExtractRequest, type LotteryExtractor } from "@/lib/ai/provider";
import { splitTallImages } from "@/lib/server/image-split";
import { runExtraction } from "@/lib/server/lottery-extract-service";

/** 縦長画像の高解像度AI解析（Stage 5H）。幅786×高さ10,810pxの長いスクリーンショットが読めなかった問題の再現と対策 */

describe("画像の扱いの計画（planImage）", () => {
  it("通常の画像は従来どおり長辺1,600px以内に縮小して1枚にする", () => {
    expect(planImage(1000, 1000)).toMatchObject({ kind: "single", scale: 1 });
    expect(planImage(3000, 1000)).toMatchObject({ kind: "single", outW: 1600 });
    // iPhoneの普通のスクリーンショット（縮小しても幅739pxが残る）は分割しない
    expect(planImage(1170, 2532)).toMatchObject({ kind: "single", outW: 739 });
    expect(planImage(786, 1500)).toMatchObject({ kind: "single", scale: 1 });
  });

  it("問題の再現: 786×10,810pxを長辺で縮小すると幅が約116pxになり読めない（従来方式）", () => {
    const naiveWidth = Math.round(786 * (1600 / 10810));
    expect(naiveWidth).toBeLessThan(150);
  });

  it("786×10,810px: 幅を保ち、1,200px・重なり160pxで上から順に11枚に分割する。全体を隙間なく覆う", () => {
    const plan = planImage(786, 10810);
    if (plan.kind !== "tiles") throw new Error("分割されるはず");
    expect(plan.scale).toBe(1); // 幅は縮小しない
    expect(plan.outW).toBe(786);
    expect(plan.tiles).toHaveLength(11);
    expect(plan.tiles.length).toBeLessThanOrEqual(MAX_TILES);
    expect(plan.tileOutH).toBe(TILE_HEIGHT);
    expect(coversWholeImage(10810, plan.tiles)).toBe(true);
    // 順序どおり（上から下）で、隣り合う分割画像は必ず重なる（境目の文字が切れない）
    for (let i = 1; i < plan.tiles.length; i++) {
      const prev = plan.tiles[i - 1];
      const cur = plan.tiles[i];
      expect(cur.sy).toBeGreaterThan(prev.sy);
      expect(prev.sy + prev.sh - cur.sy).toBeGreaterThanOrEqual(TILE_OVERLAP - 2);
    }
    // 最後の1枚は下端に揃える（極端に短い切れ端にならない）
    const last = plan.tiles[plan.tiles.length - 1];
    expect(last.sy + last.sh).toBe(10810);
    expect(last.sh).toBe(TILE_HEIGHT);
  });

  it("幅が広い縦長は幅1,000pxに縮小してから分割。枚数の上限を超える長さは幅を縮小して収める。それでも読めない細さなら受け付けない", () => {
    const wide = planImage(2000, 9000);
    expect(wide).toMatchObject({ kind: "tiles", outW: 1000 });
    const long = planImage(786, 14000); // 786pxのままでは13枚以上 → 幅を縮小して12枚以内
    if (long.kind !== "tiles") throw new Error("分割されるはず");
    expect(long.tiles.length).toBeLessThanOrEqual(MAX_TILES);
    expect(long.outW).toBeGreaterThanOrEqual(MIN_TILE_WIDTH);
    expect(coversWholeImage(14000, long.tiles)).toBe(true);
    const tooTall = planImage(786, 30000);
    expect(tooTall).toMatchObject({ kind: "error", code: "too_tall" });
    expect(tooTall.kind === "error" && tooTall.message).toContain("上下で分けて");
  });

  it("画素数が多すぎる画像は受け付けない（メモリ保護）。小さすぎる元画像は、縮小が原因ではないと案内する", () => {
    expect(planImage(5000, 20000).kind).toBe("error");
    expect(5000 * 20000).toBeGreaterThan(MAX_SOURCE_PIXELS);
    expect(planImage(0, 100).kind).toBe("error");
    expect(lowResolutionNotice(LOW_RES_WIDTH - 1)).toContain("縮小が原因ではありません");
    expect(lowResolutionNotice(786)).toBeNull();
  });
});

/** 行ごとに色が変わる縦長画像。y=境目付近に黒い帯（文字の代わり）を置く */
async function tallImage(w: number, h: number, markers: number[]): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3, 255);
  for (let y = 0; y < h; y++) {
    const shade = 200 + (y % 50); // 行ごとに違う明るさ（位置の検証用）
    for (let x = 0; x < w; x++) raw.fill(shade, (y * w + x) * 3, (y * w + x) * 3 + 3);
  }
  for (const m of markers) for (let y = m; y < m + 20 && y < h; y++) raw.fill(0, y * w * 3, (y + 1) * w * 3);
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("サーバー側の分割（実際の786×10,810pxの画像）", () => {
  it("分割画像は幅786px・高さ1,200px以内のJPEG。順序は上から下で、境目の帯は前後の両方に写る", async () => {
    // 1,100〜1,120行目は1枚目(0〜1,200)と2枚目(1,040〜2,240)の重なりの中
    const png = await tallImage(786, 10810, [1100, 5000]);
    const r = await splitTallImages([{ mediaType: "image/png", base64: png.toString("base64") }]);
    if (!r.ok) throw new Error(r.message);
    expect(r.images).toHaveLength(11);
    expect(r.notices[0]).toContain("786×10810px");
    expect(r.notices[0]).toContain("11枚に分割");
    const metas = await Promise.all(r.images.map((i) => sharp(Buffer.from(i.base64, "base64")).metadata()));
    for (const m of metas) {
      expect(m.format).toBe("jpeg");
      expect(m.width).toBe(786);
      expect(m.height).toBeLessThanOrEqual(TILE_HEIGHT);
      expect(m.height).toBeGreaterThanOrEqual(TILE_HEIGHT - 1);
    }
    // 1,100行目の黒い帯: 1枚目では1,100行目、2枚目では (1,100 − 1,040)=60行目に写る
    const rowDark = async (i: number, y: number) => {
      const { data } = await sharp(Buffer.from(r.images[i].base64, "base64")).extract({ left: 100, top: y + 5, width: 4, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return data[0];
    };
    expect(await rowDark(0, 1100)).toBeLessThan(40);
    expect(await rowDark(1, 60)).toBeLessThan(40);
    // 帯のない場所は明るいまま（取り違えていない）
    expect(await rowDark(0, 600)).toBeGreaterThan(150);
    // 5,000行目の帯は5枚目(4,160〜5,360)の中(840行目)に写る
    expect(await rowDark(4, 840)).toBeLessThan(40);
  });

  it("通常の画像・分割済みの画像は触らない。破損した画像・上限を超える枚数は理由つきで拒否する", async () => {
    const normal = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#fff" } }).jpeg().toBuffer()).toString("base64");
    const r = await splitTallImages([{ mediaType: "image/jpeg", base64: normal }]);
    expect(r).toMatchObject({ ok: true, notices: [] });
    expect(r.ok && r.images[0].base64).toBe(normal);

    const broken = await splitTallImages([{ mediaType: "image/png", base64: Buffer.from("not an image").toString("base64") }]);
    expect(broken.ok).toBe(false);

    const many = await splitTallImages(Array.from({ length: MAX_TILES + 1 }, () => ({ mediaType: "image/jpeg" as const, base64: normal })));
    expect(many.ok).toBe(false);
    expect(!many.ok && many.message).toContain(`${MAX_TILES}枚`);

    const tooTall = await tallImage(786, 30000, []);
    const rejected = await splitTallImages([{ mediaType: "image/png", base64: tooTall.toString("base64") }]);
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.message).toContain("縦に長すぎます");
  });
});

describe("AIへの渡し方（1件の抽選として全部を順に渡す）", () => {
  const NOW = new Date("2026-10-31T03:00:00Z");
  const raw = { is_lottery_announcement: true, chain_name: "サンプル電機", store_name: "三宮店", products: [{ name: "商品A", quantity: 1, unit: "box" }], apply_deadline: { year: null, month: 11, day: 5, hour: 23, minute: 59 } };

  it("複数枚のときは枚数・順序・重なりを二重に数えない指示を添える。1枚のときは従来の文面", () => {
    const base: ExtractRequest = { kind: "image", now: NOW, images: [{ mediaType: "image/jpeg", base64: "x" }] };
    expect(buildUserText(base)).not.toContain("重なって");
    const many = buildUserText({ ...base, images: Array.from({ length: 11 }, () => ({ mediaType: "image/jpeg" as const, base64: "x" })) });
    expect(many).toContain("11枚");
    expect(many).toContain("同じ1件の告知");
    expect(many).toContain("1回だけ数え");
  });

  it("縦長画像1枚が、分割された全画像（順序どおり）として1回の解析に渡る。分割したことは通知に出る", async () => {
    let seen: ExtractRequest | null = null;
    let calls = 0;
    const fake: LotteryExtractor = {
      engine: "mock",
      async extract(req) {
        calls++;
        seen = req;
        return { raw, engine: "mock" };
      },
    };
    const png = await tallImage(786, 10810, []);
    const r = await runExtraction({ kind: "image", images: [{ mediaType: "image/png", base64: png.toString("base64") }] }, { extractor: fake, now: NOW });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1); // 1件の抽選として1回の解析（結果は1件）
    expect(seen!.images).toHaveLength(11);
    expect(r.ok && r.notices.join("")).toContain("11枚に分割");
  });

  it("上限(12枚)を超える入力・分割できない画像は、AIを呼ばずに理由を返す", async () => {
    let calls = 0;
    const fake: LotteryExtractor = { engine: "mock", async extract() { calls++; return { raw, engine: "mock" }; } };
    const tall = (await tallImage(786, 30000, [])).toString("base64");
    const r = await runExtraction({ kind: "image", images: [{ mediaType: "image/png", base64: tall }] }, { extractor: fake, now: NOW });
    expect(r).toMatchObject({ ok: false, code: "empty_input" });
    expect(calls).toBe(0);
  });
});
