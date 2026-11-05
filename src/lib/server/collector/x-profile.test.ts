import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createXClient } from "@/lib/server/collector/x-client";

describe("Stage 6H: プロフィールの取得（X APIクライアント）", () => {
  it("ユーザー名から ID・表示名・所在地を読む。存在しないアカウントは失敗として返す", async () => {
    const c = createXClient("t")!;
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "12345", username: "tsutayatakehara", name: "TSUTAYA 竹原店", location: "広島県竹原市" } }), { status: 200 }));
    expect(await c.lookupProfile!("tsutayatakehara")).toMatchObject({ ok: true, id: "12345", profile: { name: "TSUTAYA 竹原店", location: "広島県竹原市" } });
    expect(String(f.mock.calls[0][0])).toContain("user.fields=id%2Cusername%2Cname%2Clocation%2Cdescription");
    f.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ detail: "Could not find user" }] }), { status: 200 }));
    expect(await c.lookupProfile!("nobody")).toMatchObject({ ok: false, code: "not_found" });
    f.mockRestore();
  });
});
