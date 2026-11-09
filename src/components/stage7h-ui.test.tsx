import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData } from "@/types/domain";
import type { CandidateView } from "@/components/auto-collect-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-09T03:00:00Z");
let data: AppData = createMockData(NOW);
/** 操作中のプロフィール（既定は管理者） */
let me = 0;
let admin = true;
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries/candidates", useRouter: () => ({ refresh, push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: { ...data.profiles[me], isAdmin: admin }, settings: {}, persistent: true, reload: async () => null }),
}));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: ({ onSaved }: { onSaved: (id: string) => void }) => createElement("button", { type: "button", "data-testid": "mock-form-save", onClick: () => onSaved("lot-new") }, "保存") }));

import { CandidatesView } from "@/components/candidates-view";

let root: Root;
let host: HTMLDivElement;
const calls: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  data = createMockData(NOW);
  me = 0;
  admin = true;
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      calls.push({ url, body });
      if (body.action === "excludeReason") return { json: async () => ({ ok: true, prev: [{ id: body.id, prev: { status: "pending" } }], rule: body.input && (body.input as { reason: string }).reason === "other" ? null : { table: "collection_rules", id: "rule-1", created: true }, reason: (body.input as { reason: string }).reason }) };
      return { json: async () => ({ ok: true }) };
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (el: Element | null) => act(async () => void (el as HTMLElement).click());
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const cand = (id: string, o: { chain: string; chainId: string | null; store: string; storeId?: string | null; product: string; fetched?: string; deadline?: string }): CandidateView =>
  ({
    id,
    source_id: null,
    title: `${o.chain} ${o.product}`,
    source_url: `https://example.invalid/${id}`,
    status: "pending",
    reasons: ["応募受付が終了していません"],
    lottery_id: null,
    fetched_at: o.fetched ?? "2026-11-09T01:00:00Z",
    job_state: "review",
    kind: "new",
    draft: {
      input: {
        chain: { id: o.chainId, name: o.chain },
        store: { id: o.storeId ?? null, name: o.store, prefecture: "" },
        items: [{ product: { id: null, name: o.product } }],
        applyStart: { precision: "date_only", date: "2026-11-01", time: "" },
        applyDeadline: { precision: "date_only", date: o.deadline ?? "2026-11-20", time: "" },
        resultDate: { precision: "unknown", date: "", time: "" },
      },
    },
    assess: { rank: "C", rankLabel: "", missing: "当選発表日", missingItems: [], conflict: null, priority: { label: "締切まで余裕あり", sort: 5, alert: false }, stageLabel: "受付中", tracking: false, related: 0, sourceLabel: "公式X", fields: [], reasons: [], flags: {} },
  }) as unknown as CandidateView;

const three = () => [
  cand("c1", { chain: "サンプル電機", chainId: "chain-a", store: "梅田店", product: "テスト弾 BOX", fetched: "2026-11-09T02:00:00Z" }),
  cand("c2", { chain: "別の系列", chainId: null, store: "豊橋店", product: "他社カード 拡張パック", fetched: "2026-11-08T02:00:00Z" }),
  cand("c3", { chain: "サンプル電機", chainId: "chain-a", store: "なんば店", product: "テスト弾 BOX", fetched: "2026-11-05T02:00:00Z" }),
];
const mount = (list: CandidateView[]) => act(() => root.render(createElement(CandidatesView, { candidates: list })));

describe("Stage 7J: 抽選候補は管理者のプロフィールのみ", () => {
  it("管理者以外のプロフィールでは候補も操作も表示されず、案内だけが出る。プロフィールの切替で表示が変わる", () => {
    admin = false;
    mount(three());
    expect(q("candidates-admin-only")).not.toBeNull();
    expect(qa("candidate-card")).toHaveLength(0);
    expect(q("candidate-exclude")).toBeNull();
    admin = true;
    act(() => root.render(createElement(CandidatesView, { candidates: three(), key: "admin" })));
    expect(qa("candidate-card")).toHaveLength(3);
  });
});

describe("Stage 7H: 抽選候補ページ", () => {
  it("カード形式で表示し、件数・新着順・新着印を出す。主要操作は「確認・登録」と「除外」の2つだけ（除外理由のボタンは常時表示しない）", () => {
    mount(three());
    expect(q("candidates-count")!.textContent).toBe("3件");
    const cards = qa("candidate-card");
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.textContent?.includes("梅田店"))).toEqual([true, false, false]); // 新着順
    expect(cards[0].querySelector('[data-testid="candidate-new"]')).not.toBeNull();
    expect(cards[2].querySelector('[data-testid="candidate-new"]')).toBeNull();
    for (const c of cards) {
      const buttons = [...c.querySelectorAll("button:not([data-testid=candidate-open])")].map((b) => b.textContent?.trim());
      expect(buttons).toEqual(["除外", "確認・登録"]);
    }
    expect(document.body.textContent).not.toContain("信頼性なし"); // 理由ボタンは「除外」を押すまで出ない
    // 不足している情報は推測せず「未確認」
    expect(cards[0].textContent).toContain("発表 未確認");
    expect(cards[0].textContent).toContain("公式X");
  });

  it("「除外」で理由を選ぶシートが開く: 6種類を2列で表示", async () => {
    mount(three());
    await click(qa("candidate-exclude")[0]);
    const sheet = q("exclude-sheet")!;
    expect(sheet).not.toBeNull();
    const group = sheet.querySelector('[role="radiogroup"][aria-label="除外理由"]')!;
    expect(group.className).toContain("grid-cols-2");
    expect([...group.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(["地域・店舗", "信頼性なし", "エリア外系列", "重複", "別ゲーム", "その他"]);
  });

  it("「その他」は追加入力なしで除外し、ルールは作らない。処理した候補は一覧から外れ、件数が即時に更新される", async () => {
    mount(three());
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-other"));
    await flush();
    const post = calls.find((c) => c.body.action === "excludeReason")!;
    expect(post.body).toMatchObject({ id: "c1", actor: data.profiles[0].id, input: { reason: "other" } });
    expect(qa("candidate-card")).toHaveLength(2);
    expect(q("candidates-count")!.textContent).toBe("2件");
    expect(q("exclude-sheet")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("地域・店舗: 取得済みの系列・店舗が自動入力され、確定するとルールの作成を依頼する", async () => {
    data = { ...data, stores: [...data.stores, { id: "store-umeda", chainId: "chain-a", name: "梅田店", prefecture: "大阪府", address: "大阪市北区1-1" } as never] };
    const c = cand("c1", { chain: "サンプル電機", chainId: "chain-a", store: "梅田店", storeId: "store-umeda", product: "テスト弾 BOX" });
    mount([c]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-region"));
    const form = q("reason-region-form")!;
    const inputs = [...form.querySelectorAll("input")].map((i) => i.value);
    expect(inputs.slice(0, 2)).toEqual(["サンプル電機", "梅田店"]);
    expect(form.querySelector("select")!.value).toBe("大阪府"); // 店舗マスターの都道府県
    expect(inputs[2]).toBe("大阪"); // 住所から判定した市区町村（辞書の表記）
    await click(q("exclude-submit"));
    await flush();
    const post = calls.find((x) => x.body.action === "excludeReason")!;
    expect(post.body.input).toMatchObject({ reason: "region", chainName: "サンプル電機", storeName: "梅田店", prefecture: "大阪府", city: "大阪" });
  });

  it("信頼性なし: 候補の系列を初期表示。系列と情報源（X・サイト）は別の選択肢", async () => {
    const c = cand("c1", { chain: "サンプル電機", chainId: "11111111-1111-4111-8111-111111111111", store: "梅田店", product: "テスト弾 BOX" });
    c.source_url = "https://x.com/sample_acct/status/123456789";
    mount([c]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-untrusted"));
    const labels = [...q("reason-untrusted-form")!.querySelectorAll("label")].map((l) => l.textContent);
    expect(labels).toEqual(["系列「サンプル電機」", "Xアカウント @sample_acct"]);
    expect((q("reason-untrusted-form")!.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(true);
    await click(q("exclude-submit"));
    await flush();
    expect(calls.find((x) => x.body.action === "excludeReason")!.body.input).toMatchObject({ reason: "untrusted", target: "chain", key: "11111111-1111-4111-8111-111111111111" });
  });

  it("エリア外系列: 系列マスターに未登録なら使えず、エラーを出して除外しない", async () => {
    mount([cand("c2", { chain: "別の系列", chainId: null, store: "豊橋店", product: "X" })]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-area_chain"));
    expect(q("reason-area-form")!.textContent).toContain("系列マスターに未登録");
    await click(q("exclude-submit"));
    expect(q("exclude-error")!.textContent).toContain("未登録");
    expect(calls.filter((x) => x.body.action === "excludeReason")).toHaveLength(0);
    expect(qa("candidate-card")).toHaveLength(1);
  });

  it("重複: 同じ系列の登録済み抽選・確認待ちの候補だけが重複先の候補になる（別系列は出ない）", async () => {
    const chain = data.chains[0];
    const lot = data.lotteries[0];
    data = { ...data, lotteries: [{ ...lot, chainId: chain.id }] };
    const mine = cand("c1", { chain: chain.name, chainId: chain.id, store: "梅田店", product: "テスト弾 BOX" });
    const same = cand("c3", { chain: chain.name, chainId: chain.id, store: "なんば店", product: "テスト弾 BOX" });
    const other = cand("c2", { chain: "別の系列", chainId: "other-chain", store: "豊橋店", product: "テスト弾 BOX" });
    mount([mine, same, other]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-duplicate"));
    const opts = [...q("reason-dup-form")!.querySelectorAll('input[type="radio"]')];
    expect(opts.length).toBe(2); // 同じ系列の抽選1件＋候補1件
    expect(q("reason-dup-form")!.textContent).not.toContain("別の系列");
    await click(q("exclude-submit"));
    await flush();
    const input = calls.find((x) => x.body.action === "excludeReason")!.body.input as { reason: string; target: { kind: string; id: string } };
    expect(input.reason).toBe("duplicate");
    expect(["lottery", "candidate"]).toContain(input.target.kind);
  });

  it("別ゲーム: 除外キーワードを商品名から自動入力し、修正して確定できる", async () => {
    mount([cand("c2", { chain: "別の系列", chainId: null, store: "豊橋店", product: "他社カード 拡張パック" })]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-other_game"));
    const input = q("reason-game-form")!.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("他社カード");
    await click(q("exclude-submit"));
    await flush();
    expect(calls.find((x) => x.body.action === "excludeReason")!.body.input).toMatchObject({ reason: "other_game", keywords: ["他社カード"] });
    expect(calls.find((x) => x.body.action === "excludeReason")!.body.actor).toBe(data.profiles[0].id); // 操作者のID（サーバーが管理者か確認する）
  });

  it("確認・登録: 登録フォームで保存すると候補を登録済みにして一覧から外す", async () => {
    mount(three());
    await click(qa("candidate-register")[0]);
    await click(q("mock-form-save"));
    await flush();
    expect(calls.find((x) => x.body.action === "markRegistered")!.body).toMatchObject({ id: "c1", lotteryId: "lot-new" });
    expect(qa("candidate-card")).toHaveLength(2);
    expect(q("candidates-count")!.textContent).toBe("2件");
  });

  it("段階的に表示: 10件ずつ。残りの件数を示す", async () => {
    const many = Array.from({ length: 23 }, (_, i) => cand(`m${i}`, { chain: "サンプル電機", chainId: "chain-a", store: `店${i}`, product: "商品", fetched: `2026-10-${String(10 + (i % 18)).padStart(2, "0")}T00:00:00Z` }));
    mount(many);
    expect(qa("candidate-card")).toHaveLength(10);
    expect(q("candidates-more")!.textContent).toContain("残り13件");
    await click(q("candidates-more"));
    expect(qa("candidate-card")).toHaveLength(20);
  });

  it("候補が無いときは空の表示", () => {
    mount([]);
    expect(q("candidates-empty")).not.toBeNull();
    expect(q("candidates-count")!.textContent).toBe("0件");
  });
});
