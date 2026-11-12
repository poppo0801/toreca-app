/**
 * テスト・評価用の架空データの組み立て（Stage 8F）。実在の店舗・企画は使わない。
 */
import { pairKey } from "@/lib/agent/lottery-grouping/compare";
import type { GGroup, GLottery, GWorld, GroupOrigin } from "@/lib/agent/lottery-grouping/types";

let seq = 0;
export const resetSeq = (): void => {
  seq = 0;
};
const uuid = (n: number, prefix = "a"): string => `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function mkLottery(over: Partial<GLottery> & { n?: number } = {}): GLottery {
  const n = over.n ?? ++seq;
  const { n: _n, ...rest } = over;
  void _n;
  return {
    id: uuid(n),
    chainId: uuid(1, "c"),
    storeId: uuid(n, "5"),
    storeName: `店舗${n}`,
    storeMode: "fixed",
    items: [{ productId: uuid(1, "p"), quantity: 1, unit: "box" }],
    campaignId: null,
    applyStart: { precision: "date_only", date: "2026-12-01" },
    applyDeadline: { precision: "date_only", date: "2026-12-07" },
    resultDate: { precision: "date_only", date: "2026-12-10" },
    applyMethod: "web",
    receiveMethod: "store",
    kind: null,
    requirementTags: ["member"],
    requirementLogic: "all",
    conditionsText: "会員登録が必要です。1人1口まで。",
    sourceUrls: [`https://example.invalid/post/${n}`],
    groupId: null,
    archived: false,
    hasApplication: false,
    createdAt: "2026-11-20T00:00:00.000Z",
    ...rest,
  };
}

export interface WorldOpts {
  groups?: GGroup[];
  evidence?: Record<string, string[]>;
  separated?: [string, string][];
  knownKeys?: Record<string, string>;
}
export function mkGroup(id: string, origin: GroupOrigin, memberIds: string[], chainId: string | null = uuid(1, "c")): GGroup {
  return { id, chainId, origin, title: "", memberIds };
}
export function mkWorld(subject: GLottery, others: GLottery[], o: WorldOpts = {}): GWorld {
  return {
    subject,
    lotteries: others,
    groups: o.groups ?? [],
    evidence: new Map(Object.entries(o.evidence ?? {})),
    separated: new Set((o.separated ?? []).map(([a, b]) => pairKey(a, b))),
    knownKeys: new Map(Object.entries(o.knownKeys ?? {})),
    productNames: new Map([[uuid(1, "p"), "架空BOX A"], [uuid(2, "p"), "架空BOX B"]]),
  };
}
export const PRODUCT_A = uuid(1, "p");
export const PRODUCT_B = uuid(2, "p");
export const item = (productId: string, quantity = 1): GLottery["items"][number] => ({ productId, quantity, unit: "box" });
/** 企画名を含む情報源の文章（架空） */
export const postText = (title: string, store: string, extra = ""): string => `【${store}】『${title}』の抽選販売を実施します。${extra}`;
