import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData } from "@/types/domain";
import type { CandidateView } from "@/components/auto-collect-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-09T03:00:00Z");
let data: AppData = createMockData(NOW);
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries/candidates", useRouter: () => ({ refresh, push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: { ...data.profiles[0], isAdmin: true }, settings: {}, persistent: true, reload: async () => null }),
}));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: (p: { candidateId?: string | null }) => createElement("div", { "data-testid": "mock-form", "data-candidate": p.candidateId ?? "" }) }));

import { CandidatesView } from "@/components/candidates-view";

let root: Root;
let host: HTMLDivElement;
const calls: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  data = createMockData(NOW);
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      calls.push({ url, body });
      if (body.action === "excludeReason") return { json: async () => ({ ok: true, prev: [], rule: { table: "collection_exclusions", id: "r1", created: true }, reason: (body.input as { reason: string }).reason }) };
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
const typeInto = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

type Over = { chain?: string; chainId?: string | null; store?: string; product?: string; url?: string; input?: Record<string, unknown>; reasons?: string[]; missingItems?: string[] };
const cand = (id: string, o: Over = {}): CandidateView =>
  ({
    id,
    source_id: null,
    title: `${o.chain ?? "系列"} ${o.product ?? "商品"}`,
    source_url: o.url ?? `https://example.invalid/${id}`,
    status: "pending",
    reasons: o.reasons ?? ["応募受付が終了していません"],
    lottery_id: null,
    fetched_at: "2026-11-09T01:00:00Z",
    job_state: "review",
    kind: "new",
    draft: {
      input: {
        chain: { id: o.chainId ?? null, name: o.chain ?? "ドラスタ" },
        store: { id: null, name: o.store ?? "神戸三宮店", prefecture: "" },
        items: [{ product: { id: null, name: o.product ?? "テスト弾 BOX" } }],
        applyStart: { precision: "date_only", date: "2026-11-01", time: "" },
        applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" },
        resultDate: { precision: "date_only", date: "2026-11-25", time: "" },
        applyMethod: "web",
        receiveMethod: "store",
        ...o.input,
      },
    },
    assess: { rank: "C", rankLabel: "", missing: "", missingItems: o.missingItems ?? [], conflict: null, priority: { label: "締切まで余裕あり", sort: 5, alert: false }, stageLabel: "受付中", tracking: false, related: 0, sourceLabel: "公式X", fields: [], reasons: [], flags: {} },
  }) as unknown as CandidateView;
const mount = (cs: CandidateView[]) => act(async () => root.render(createElement(CandidatesView, { candidates: cs })));

describe("Stage 7L: 抽選候補カードの不足情報バッジ", () => {
  it("不足項目がバッジとして並び（重要度の順・件数で打ち切らない）、ボタンとは別の領域に置かれる", async () => {
    await mount([cand("c1", { input: { items: [], applyDeadline: { precision: "unknown", date: "", time: "" }, applyMethod: "unknown", store: { id: null, name: "" }, resultDate: { precision: "unknown", date: "", time: "" }, limitBasis: "unknown", sourceUrls: [] } })]);
    const list = q("candidate-badges")!;
    const labels = [...list.querySelectorAll("li")].map((x) => x.textContent);
    expect(labels).toEqual(["商品不明", "応募締切", "応募方法", "店舗不明", "応募制限", "発表日"]);
    expect(list.contains(q("candidate-exclude"))).toBe(false); // 操作ボタンとは別
    expect(q("candidate-exclude")!.parentElement).not.toBe(list.parentElement); // ボタンは右側のまとまり
    expect(document.body.textContent).not.toContain("要確認："); // 従来の文章表示は廃止
  });
  it("不足が無い候補にはバッジが出ない（空の領域だけ）", async () => {
    await mount([cand("c1")]);
    expect(q("candidate-badges")!.querySelectorAll("li")).toHaveLength(0);
  });
});

describe("Stage 7L: 信頼性なしの除外（系列・情報元を区別）", () => {
  it("情報元が不明でも、系列名・別名を系列マスターと照合して系列を除外対象にできる（初期選択は系列）", async () => {
    const chain = data.chains[0];
    data = { ...data, chains: [{ ...chain, aliases: ["ドラスタ"] }, ...data.chains.slice(1)] };
    await mount([cand("c1", { chain: "ドラスタ", chainId: null, url: "https://example.invalid/shop" })]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-untrusted"));
    const form = q("reason-untrusted-form")!;
    expect(form.textContent).toContain(`系列「${chain.name}」`);
    expect(form.textContent).toContain("取得した名称: ドラスタ");
    expect((form.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(true); // 系列が初期選択
    await click(q("exclude-submit"));
    await flush();
    expect(calls.find((x) => x.body.action === "excludeReason")!.body.input).toMatchObject({ reason: "untrusted", target: "chain", key: chain.id, chainName: chain.name, registerChain: false });
  });
  it("系列マスターに未登録の系列は、登録して除外する（確認して確定）", async () => {
    await mount([cand("c1", { chain: "未登録の新系列", chainId: null })]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-untrusted"));
    expect(q("reason-untrusted-form")!.textContent).toContain("系列マスターに未登録");
    await click(q("exclude-submit"));
    await flush();
    expect(calls.find((x) => x.body.action === "excludeReason")!.body.input).toMatchObject({ reason: "untrusted", target: "chain", key: "", chainName: "未登録の新系列", registerChain: true });
  });
  it("情報元（Xアカウント）だけを選んで除外できる", async () => {
    await mount([cand("c1", { chain: "ドラスタ", chainId: null, url: "https://x.com/some_shop/status/123" })]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-untrusted"));
    const radios = [...q("reason-untrusted-form")!.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(2); // 系列・Xアカウント
    await click(radios[1]);
    await click(q("exclude-submit"));
    await flush();
    expect(calls.find((x) => x.body.action === "excludeReason")!.body.input).toMatchObject({ reason: "untrusted", target: "x_account", key: "some_shop" });
  });
});

describe("Stage 7L: 重複の手動検索と系列の別名登録", () => {
  it("自動で候補が見つからなくても、検索欄から統合先を探して確定できる（店舗が異なるものは選べない）", async () => {
    const chain = data.chains[0];
    const lot = data.lotteries[0];
    data = { ...data, lotteries: [{ ...lot, chainId: chain.id, sourceUrls: ["https://example.invalid/lot/777"] }] };
    await mount([cand("c1", { chain: "ドラスタ", chainId: null, product: "全く別の商品", input: { applyDeadline: { precision: "date_only", date: "2027-03-01", time: "" } } })]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-duplicate"));
    expect(q("dup-none")).not.toBeNull(); // 自動候補なし
    await typeInto(q("dup-search") as HTMLInputElement, "lot/777");
    const opts = qa("dup-option");
    expect(opts).toHaveLength(1);
    expect((opts[0].querySelector("input") as HTMLInputElement).disabled).toBe(false); // 店舗が不明な抽選は選べる
    await click(opts[0].querySelector("input"));
    // 系列名が違う → 別名として登録するか確認できる
    expect(q("dup-alias")!.textContent).toContain("「ドラスタ」");
    expect(q("dup-alias")!.textContent).toContain(chain.name);
    await click(q("dup-alias")!.querySelector("input"));
    await click(q("exclude-submit"));
    await flush();
    const input = calls.find((x) => x.body.action === "excludeReason")!.body.input as { reason: string; target: { kind: string; id: string }; registerChainAlias?: { chainId: string; alias: string } };
    expect(input.reason).toBe("duplicate");
    expect(input.target).toEqual({ kind: "lottery", id: lot.id });
    expect(input.registerChainAlias).toEqual({ chainId: chain.id, alias: "ドラスタ" });
  });
  it("別名の登録は利用者が選んだときだけ（既定ではしない）", async () => {
    const chain = data.chains[0];
    const lot = data.lotteries[0];
    data = { ...data, lotteries: [{ ...lot, chainId: chain.id, sourceUrls: ["https://example.invalid/lot/778"] }] };
    await mount([cand("c1", { chain: "ドラスタ", chainId: null, url: "https://example.invalid/lot/778" })]);
    await click(qa("candidate-exclude")[0]);
    await click(q("reason-duplicate"));
    await click(q("exclude-submit")); // 同じ情報源URLの抽選が自動候補の先頭
    await flush();
    expect((calls.find((x) => x.body.action === "excludeReason")!.body.input as { registerChainAlias?: unknown }).registerChainAlias).toBeUndefined();
  });
});
