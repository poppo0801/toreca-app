import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTarget, isLocalSupabaseUrl, jwtRef } from "@/lib/supabase/target";
// @ts-expect-error スクリプト側（.mjs）の実装。アプリ側と判定が一致することを確認する
import * as script from "../../../scripts/lib/target.mjs";
import { supabaseEnv } from "@/lib/supabase/env";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const PROD = "https://yofqgfarflrlhzufjhqs.supabase.co";
const LOCAL = "http://127.0.0.1:55321";
const DEMO_KEY = jwt({ iss: "supabase-demo", role: "service_role" });
const PROD_KEY = jwt({ ref: "yofqgfarflrlhzufjhqs", role: "service_role" });

describe("接続先の判定（Stage 8C）", () => {
  const cases: [string | undefined, (string | undefined)[], string][] = [
    [PROD, [], "production"],
    [PROD + "/", [], "production"],
    ["https://abcdefghij.supabase.co", [], "hosted-other"],
    [LOCAL, [DEMO_KEY], "local"],
    ["http://localhost:55321", [], "local"],
    [LOCAL, [PROD_KEY], "production"], // URL がローカルでも、鍵が本番なら本番扱い（鍵の取り違え）
    ["https://toreca-app.vercel.app", [], "unknown"],
    ["http://127.0.0.1.evil.example:55321", [], "unknown"],
    ["http://abc.supabase.co", [], "unknown"],
    ["", [], "unset"],
    [undefined, [], "unset"],
  ];
  it.each(cases)("%s %j → %s（アプリ側とスクリプト側で一致）", (url, keys, expected) => {
    expect(classifyTarget(url, ...keys)).toBe(expected);
    expect(script.classifyTarget(url, ...keys)).toBe(expected);
  });
  it("鍵の本文は返さず ref だけを読む。壊れた値・ローカルのデモ鍵は null", () => {
    expect(jwtRef(PROD_KEY)).toBe("yofqgfarflrlhzufjhqs");
    expect(jwtRef(DEMO_KEY)).toBeNull();
    expect(jwtRef("not-a-jwt")).toBeNull();
    expect(jwtRef(undefined)).toBeNull();
  });
  it("ローカルURLの形式（http・127.0.0.1/localhost・ポート必須）", () => {
    expect(isLocalSupabaseUrl(LOCAL)).toBe(true);
    expect(isLocalSupabaseUrl("https://127.0.0.1:55321")).toBe(false);
    expect(isLocalSupabaseUrl("http://127.0.0.1")).toBe(false);
  });
  it("スクリプト側: ローカル以外は例外・本番専用の入口は本番のみ許可", () => {
    expect(() => script.assertLocalTarget("t", { NEXT_PUBLIC_SUPABASE_URL: PROD })).toThrow(/接続先ガード/);
    expect(() => script.assertLocalTarget("t", { NEXT_PUBLIC_SUPABASE_URL: LOCAL, SUPABASE_SERVICE_ROLE_KEY: DEMO_KEY })).not.toThrow();
    expect(() => script.assertLocalTarget("t", {})).toThrow();
    expect(() => script.assertTargetForRun("t", { NEXT_PUBLIC_SUPABASE_URL: PROD })).toThrow();
    expect(() => script.assertTargetForRun("t", { TOREMANE_TARGET: "production", NEXT_PUBLIC_SUPABASE_URL: PROD })).not.toThrow();
    expect(() => script.assertTargetForRun("t", { TOREMANE_TARGET: "production", NEXT_PUBLIC_SUPABASE_URL: LOCAL })).toThrow();
  });
});

describe("アプリの接続先検証 supabaseEnv（Stage 8C）", () => {
  afterEach(() => vi.unstubAllEnvs());
  const setup = (nodeEnv: string, url: string, extra: Record<string, string> = {}) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", DEMO_KEY);
    for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  };
  it("本番ビルド（Vercel）: 従来どおり公式ホストのみ。ローカルURLは拒否", () => {
    setup("production", PROD);
    expect(supabaseEnv().url).toBe(PROD);
    setup("production", LOCAL);
    expect(() => supabaseEnv()).toThrow(/Supabase のURL/);
  });
  it("開発（next dev）: ローカルは許可、本番は拒否（解除手段なし）", () => {
    setup("development", LOCAL);
    expect(supabaseEnv().url).toBe(LOCAL);
    setup("development", PROD);
    expect(() => supabaseEnv()).toThrow(/本番/);
  });
  it("ローカル設定でのビルド・起動（TOREMANE_ENV=local）: ローカルは許可、本番は拒否", () => {
    setup("production", LOCAL, { TOREMANE_ENV: "local" });
    expect(supabaseEnv().url).toBe(LOCAL);
    setup("production", PROD, { TOREMANE_ENV: "local" });
    expect(() => supabaseEnv()).toThrow(/本番/);
  });
  it("開発でも、鍵が本番のものなら拒否（URLだけローカルに向けても通さない）", () => {
    setup("development", LOCAL, { SUPABASE_SERVICE_ROLE_KEY: PROD_KEY });
    expect(() => supabaseEnv()).toThrow(/本番/);
  });
});
