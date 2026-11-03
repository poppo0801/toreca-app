import { describe, expect, it } from "vitest";
import { listFor, matchesChain, memberNumberSchema, type MemberNumber } from "@/lib/member-number";

const P = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";

describe("会員番号の入力検証", () => {
  it("先頭のゼロを保持し、数値に変換しない", () => {
    const v = memberNumberSchema.parse({ profileId: P, chainId: C, memberNo: "  0001234567  " });
    expect(v.memberNo).toBe("0001234567");
    expect(typeof v.memberNo).toBe("string");
  });
  it("空・長すぎる・制御文字は拒否する", () => {
    expect(memberNumberSchema.safeParse({ profileId: P, chainId: C, memberNo: "   " }).success).toBe(false);
    expect(memberNumberSchema.safeParse({ profileId: P, chainId: C, memberNo: "1".repeat(65) }).success).toBe(false);
    expect(memberNumberSchema.safeParse({ profileId: P, chainId: C, memberNo: "12\n34" }).success).toBe(false);
  });
  it("ハイフン・英字を含む番号はそのまま通す", () => {
    expect(memberNumberSchema.parse({ profileId: P, chainId: C, memberNo: "AB-0012-34" }).memberNo).toBe("AB-0012-34");
  });
});

describe("会員番号の一覧", () => {
  const names: Record<string, string> = { a: "Joshin", b: "ふるいち", c: "ヨドバシ" };
  const rows: MemberNumber[] = [
    { id: "1", profileId: "p1", chainId: "c", memberNo: "1", note: "" },
    { id: "2", profileId: "p1", chainId: "a", memberNo: "2", note: "" },
    { id: "3", profileId: "p2", chainId: "a", memberNo: "3", note: "" },
  ];
  it("選択中のプロフィールの分だけを系列名順に出す（同じ系列でもプロフィールごとに別の番号）", () => {
    expect(listFor(rows, "p1", (id) => names[id], "").map((r) => r.id)).toEqual(["2", "1"]);
    expect(listFor(rows, "p2", (id) => names[id], "").map((r) => r.memberNo)).toEqual(["3"]);
  });
  it("系列名の検索は全角半角・大文字小文字を区別しない", () => {
    expect(matchesChain("Ｊoshin", "JOSHIN")).toBe(true);
    expect(matchesChain("ふるいち", "ふる")).toBe(true);
    expect(listFor(rows, "p1", (id) => names[id], "よど").length).toBe(0);
    expect(listFor(rows, "p1", (id) => names[id], "ヨド").length).toBe(1);
  });
});
