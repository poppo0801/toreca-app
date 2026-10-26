import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("初回Excelは自動移行されない", () => {
  it("ソースにxlsx取込コードや実データ参照がない", () => {
    const files = fs.globSync("src/**/*.{ts,tsx}").filter((f) => !f.endsWith(".test.ts"));
    for (const f of files) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/Book\.xlsx|from ["']xlsx["']/);
    }
    expect(existsSync("src/services/import")).toBe(false);
  });
});
