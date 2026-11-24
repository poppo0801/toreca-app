// @vitest-environment node
/** 再収集で、前回の再調査で戻したページを失わない（監査で発見した、再調査結果の巻き戻り）。 */
import { describe, expect, it } from "vitest";
import { buildEvidence, carryOverRechecked, type StoredEvidence } from "./evidence";

const T0 = "2026-11-20T00:00:00.000Z";
const page = (u: string, shop: string) => ({ url: u, text: `【${shop}】拡張パックの抽選受付ページです。応募期間と応募方法を記載しています。お一人様1回まで。` });
const U = ["https://a.example.invalid/e/1", "https://b.example.invalid/e/2", "https://c.example.invalid/e/3"];
const ev = (pages: ReturnType<typeof page>[], ledger: object[] = [], extra: Partial<StoredEvidence> = {}): StoredEvidence => ({ ...buildEvidence({ url: "https://p.example.invalid/1", kind: "x_post", post: { text: "投稿のテキストです。抽選のお知らせ", links: [], linkMap: [] }, linkedPages: pages, linkLedger: ledger as never } as never, T0)!, ...extra });
const led = (u: string, status: string, reason?: string) => ({ url: u, key: u.slice(8), host: new URL(u).hostname, order: 0, origins: ["post"], status, ...(reason ? { reason } : {}) });

describe("carryOverRechecked", () => {
  it("前回の再調査で戻したページが、再収集で未取得（時間切れ・予算）になっていても、引き継ぐ。新しく取得できたページは新しい方を残す（古い版で上書きしない）", () => {
    const prior = ev([page(U[0], "新宿本店"), page(U[1], "渋谷店")], [led(U[0], "fetched"), led(U[1], "fetched")], { recheckSeq: 2 });
    const next = ev([page(U[0], "新宿本店（更新）")], [led(U[0], "fetched"), led(U[1], "skipped", "deadline")]);
    const r = carryOverRechecked(next, prior);
    expect(r.linkedPages!.map((p) => p.url)).toEqual([U[0], U[1]]);
    expect(r.linkedPages![0].text).toContain("更新"); // 新しい取得が正
    expect(r.recheckSeq).toBe(2);
    expect(r.linkLedger!.find((e) => e.url === U[1])).toMatchObject({ status: "fetched", reason: "carried" });
    expect(r.limitHits).toBeUndefined();
  });
  it("新しい取得で恒久的に取得できない（robots・404・ログイン等）と分かったページは引き継がない。再調査の履歴が無い（recheckSeq無し）なら何もしない", () => {
    const prior = ev([page(U[1], "渋谷店")], [led(U[1], "fetched")], { recheckSeq: 1 });
    const gone = ev([page(U[0], "新宿本店")], [led(U[0], "fetched"), led(U[1], "blocked", "robots")]);
    expect(carryOverRechecked(gone, prior).linkedPages!.map((p) => p.url)).toEqual([U[0]]);
    const none = ev([page(U[1], "渋谷店")], [led(U[1], "fetched")]);
    expect(carryOverRechecked(ev([page(U[0], "新宿本店")]), none).linkedPages!.map((p) => p.url)).toEqual([U[0]]);
    expect(carryOverRechecked(ev([page(U[0], "新宿本店")]), null).recheckSeq).toBeUndefined();
  });
  it("台帳に無いページも引き継ぎ、台帳へ『carried』として残す（無言で増えない）。ページ数の上限を超えない", () => {
    const prior = ev([page(U[2], "大阪店")], [], { recheckSeq: 1 });
    const r = carryOverRechecked(ev([page(U[0], "新宿本店")]), prior);
    expect(r.linkedPages).toHaveLength(2);
    expect(r.linkLedger!.some((e) => e.url === U[2] && e.reason === "carried")).toBe(true);
  });
});
