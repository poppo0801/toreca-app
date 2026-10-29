// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import manifest from "@/app/manifest";

/** アプリアイコン: 原本(toremane_icon.jpg)から生成した画像だけを参照し、旧アイコンへの参照が残っていない */
describe("アプリアイコン", () => {
  const dir = "public/icons/v2";
  it("原本が残っていて、必要なサイズの画像が原本から生成されている", async () => {
    expect(existsSync("public/icons/toremane_icon.jpg")).toBe(true);
    for (const [file, size] of [["favicon-16.png", 16], ["favicon-32.png", 32], ["favicon-48.png", 48], ["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512]] as const) {
      const m = await sharp(join(dir, file)).metadata();
      expect([m.width, m.height]).toEqual([size, size]);
    }
  });
  it("manifest は v2 の画像（通常とmaskable）を参照し、実在する", () => {
    const m = manifest();
    const srcs = (m.icons ?? []).map((i) => i.src);
    expect(srcs).toEqual(expect.arrayContaining(["/icons/v2/icon-192.png", "/icons/v2/icon-512.png", "/icons/v2/maskable-512.png"]));
    for (const s of srcs) expect(existsSync(join("public", s))).toBe(true);
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });
  it("旧アイコンのファイル・参照が残っていない（旧SVGロゴ・旧パス）", () => {
    for (const f of ["logo.svg", "mark-dark.svg", "mark-light.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "maskable-512.png"]) expect(existsSync(join("public/icons", f))).toBe(false);
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const files = [...walk("src"), "public/sw.js"].filter((f) => /\.(ts|tsx|js)$/.test(f) && !f.endsWith("icons.test.ts"));
    const offenders = files.filter((f) => /["'`]\/icons\/(?!v2\/|toremane_icon)/.test(readFileSync(f, "utf8")) || /brand-svg|mark-(light|dark)\.svg/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
