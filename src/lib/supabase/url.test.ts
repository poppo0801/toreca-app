import { describe, expect, it } from "vitest";
import { isSupabaseUrl } from "@/lib/supabase/url";

describe("SupabaseのURL検証（設定ミスの検出）", () => {
  it("公式ホストの形式のみ許可する", () => {
    expect(isSupabaseUrl("https://yofqgfarflrlhzufjhqs.supabase.co")).toBe(true);
    expect(isSupabaseUrl("https://yofqgfarflrlhzufjhqs.supabase.co/")).toBe(true);
    expect(isSupabaseUrl("  https://abc.supabase.in ")).toBe(true);
  });
  it("アプリ自身のURL・別サービス・HTTP・パス付き・未設定は拒否する", () => {
    expect(isSupabaseUrl("https://toreca-app.vercel.app")).toBe(false);
    expect(isSupabaseUrl("http://abc.supabase.co")).toBe(false);
    expect(isSupabaseUrl("https://abc.supabase.co.evil.example")).toBe(false);
    expect(isSupabaseUrl("https://abc.supabase.co/rest/v1")).toBe(false);
    expect(isSupabaseUrl("https://evil.example/https://abc.supabase.co")).toBe(false);
    expect(isSupabaseUrl("")).toBe(false);
    expect(isSupabaseUrl(undefined)).toBe(false);
  });
});
