import { describe, expect, it } from "vitest";
import { dropUsernameChain, isUsernameLike, resolveXChain } from "@/lib/collector/x-chain";
import type { Chain } from "@/types/domain";

const chains: Chain[] = [
  { id: "c1", name: "トレカザウルス", aliases: ["Rises eStore", "トレカザウルスeストア"] },
  { id: "c2", name: "晴れる屋2", aliases: [] },
];

describe("Xユーザー名を系列名にしない（Stage 6N）", () => {
  it("ユーザー名の区切り違いも同一視する", () => {
    expect(isUsernameLike("Rises eStore", "Rises_eStore")).toBe(true);
    expect(isUsernameLike("晴れる屋2", "Rises_eStore")).toBe(false);
  });
  it("表示名が系列名・別名に一致すれば、その正式名称にする", () => {
    const r = resolveXChain({ extracted: "Rises_eStore", username: "Rises_eStore", displayName: "トレカザウルスeストア", chains });
    expect(r).toMatchObject({ chainName: "トレカザウルス", chainId: "c1", basis: "display_name" });
  });
  it("確定済みの対応が最優先", () => {
    const r = resolveXChain({ extracted: "", username: "x", displayName: "晴れる屋2公式", saved: { chainId: "c1", chainName: "トレカザウルス" }, chains });
    expect(r.basis).toBe("saved");
    expect(r.chainId).toBe("c1");
  });
  it("表示名が一致しなければ、告知の系列名（ユーザー名そのものは除く）を使う", () => {
    expect(resolveXChain({ extracted: "晴れる屋2", username: "u", displayName: "不明な名前", chains })).toMatchObject({ chainId: "c2", basis: "extraction" });
    const r = resolveXChain({ extracted: "Rises_eStore", username: "Rises_eStore", displayName: "新しい店", chains: [chains[1]] });
    expect(r.chainName).toBe("");
    expect(r.warnings[0]).toContain("系列を特定できません");
  });
  it("ユーザー名は、マスターの別名と一致するときだけ補助的に使う", () => {
    const r = resolveXChain({ extracted: "", username: "Rises_eStore", displayName: "", chains });
    expect(r).toMatchObject({ chainId: "c1", basis: "username" });
  });
  it("マスターに無いユーザー名の系列名は破棄する（新しい系列名として登録しない）", () => {
    expect(dropUsernameChain("Rises_eStore", "Rises_eStore", [chains[1]])).toBe("");
    expect(dropUsernameChain("Rises_eStore", "Rises_eStore", chains)).toBe("Rises_eStore"); // 別名として登録済み
    expect(dropUsernameChain("晴れる屋2", "Rises_eStore", chains)).toBe("晴れる屋2");
  });
});
