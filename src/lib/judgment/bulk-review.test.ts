// @vitest-environment node
/** 一括確認モード（本人の概略確認＋機械検査）の関門。架空データのみ。 */
import { describe, expect, it } from "vitest";
import { isPublicNotice, prepareForExternal, type StoredRow } from "./eval/phase2";

// @ts-expect-error .mjs（型定義なし）
const mod = (await import("../../../scripts/lib/phase2-extract.mjs")) as { bulkScopeHash: (r: { id: string; text: string | null }[]) => string };

const TEXT = "サンプルゲーム 北店 抽選販売。応募期間 2099-04-01〜2099-04-08。";
const row = (id: string, via: string | null, url: string | null, text = TEXT): StoredRow => ({ id, stratum: "unlabeled", text, fetchedAt: null, meta: { via, url } });

describe("公開告知の機械確認（判別できなければ送らない）", () => {
  it("公開のhttps URL＋既知の取得方法だけ通る。メタデータなし・非公開らしいURL・トークン付き・IP・取得方法不明は除外", () => {
    expect(isPublicNotice({ via: "web_fetch", url: "https://shop.example.com/news/1" })).toBe(true);
    expect(isPublicNotice({ via: "x_api", url: "https://x.com/foo/status/1" })).toBe(true);
    for (const m of [undefined, { via: null, url: "https://a.example.com/" }, { via: "web_fetch", url: null }, { via: "manual", url: "https://a.example.com/" }, { via: "web_fetch", url: "http://a.example.com/" }, { via: "web_fetch", url: "https://localhost/x" }, { via: "web_fetch", url: "https://192.168.0.1/x" }, { via: "web_fetch", url: "https://a.example.com/x?token=abcdef123456" }, { via: "web_fetch", url: "https://user:pw@a.example.com/" }, { via: "web_fetch", url: "not a url" }]) expect(isPublicNotice(m as StoredRow["meta"]), JSON.stringify(m)).toBe(false);
  });
  it("requirePublic のとき、非公開判定の行は ready にならない。漏洩検出も再実行される", () => {
    const ids = new Set(["a", "b", "c"]);
    const p = prepareForExternal([row("a", "web_fetch", "https://a.example.com/1"), row("b", "manual", "https://a.example.com/2"), row("c", "web_fetch", "https://a.example.com/3", `${TEXT} お名前: ダミー太郎`)], ids, { requirePublic: true });
    expect(p.map((x) => x.decision)).toEqual(["ready", "excluded_not_public", "excluded_leak"]);
  });
});

describe("一括確認の対象同一性", () => {
  it("確認した30件と送信対象が同一なら同じハッシュ。1件でも内容・ID・件数が違えば不一致（順序には依存しない）", () => {
    const a = [{ id: "1", text: "x" }, { id: "2", text: "y" }];
    expect(mod.bulkScopeHash(a)).toBe(mod.bulkScopeHash([...a].reverse()));
    expect(mod.bulkScopeHash(a)).not.toBe(mod.bulkScopeHash([{ id: "1", text: "x" }, { id: "2", text: "z" }]));
    expect(mod.bulkScopeHash(a)).not.toBe(mod.bulkScopeHash([a[0]]));
    expect(mod.bulkScopeHash(a)).not.toContain("x");
  });
});
