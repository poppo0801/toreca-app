/**
 * Stage 9H-3F: 3方式（A 従来／B AI調査＋従来の統合処理／C AI調査＋統合処理）の比較の実行部品。実AIの検証と、モックでの動作確認が同じ部品を使う。
 * 初期条件を揃える: 全方式で、同じ抽選の候補（members）の初期の読み取りは、収集の抽出結果の再現（同一）。BとCは**同じ調査結果**を使う（調査はCで1回だけ実行し、Bは保存した結果を再生する）。
 *  A: フラグ無効の従来経路（調査なし・統合なし）
 *  B: 調査あり・従来の合流規則（mergeMode=legacy）・同じ抽選の別の候補は統合しない
 *  C: 調査あり・統合処理（同じ抽選の別の候補も統合）
 * 登録はしない（自動登録オフ）。DBはローカルのテスト世帯だけ。
 */
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS, type CollectionConditions } from "@/lib/collector/conditions";
import type { InvestigateFn, InvestigationResponse } from "@/lib/case-model/investigation-types";
import type { Judgment } from "@/lib/case-model/judgment";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import type { HumanKnowledge } from "@/lib/case-model/human-knowledge";

export interface PlanMember {
  id: string;
  status: string;
  url: string | null;
  title: string;
  input: { chain: string; store: string; storeMode: string; selectable: string[]; products: string[]; applyStart: string | null; applyDeadline: string | null; resultDate: string | null; resultEnd: string | null; conditions: string; receiveMethod: string; applyMethod: string };
  /** 本番の初期読み取りで得た根拠の抜粋（項目名・原文）。評価では、これを初期読み取りの根拠として再現する（9H-3K） */
  evidence?: { field: string; quote: string }[];
}
export interface PlanCase {
  caseId: string;
  group: string;
  patterns: string[];
  members: PlanMember[];
  anchorId: string;
  /** true のとき、メンバーの系列名からは系列マスターを作らない（呼び出し側が登録済みの系列を用意する） */
  skipChainMasters?: boolean;
  target: { id: string; chain: string; products: string[] };
  classify?: { officialHosts: string[]; officialAccounts: string[]; aggregatorHosts: string[]; aggregatorAccounts: string[] };
}

const flex = (v: string | null | undefined) => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(v) : null;
  return m ? { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : null, minute: m[5] ? +m[5] : null } : { year: null, month: null, day: null, hour: null, minute: null };
};

export interface ArmResult {
  arm: "A" | "B" | "C";
  status: string;
  /** 利用者が見る確認待ちの候補（カード）の数。同じ抽選が何枚に分かれているか */
  openCards: number;
  /** 登録候補の下書き全体（警告・理解の記録を確認するため） */
  draft?: unknown;
  input: unknown;
  judgment: Judgment | null;
  reasons: unknown;
}
export interface ThreewayResult {
  caseId: string;
  arms: Record<"A" | "B" | "C", ArmResult>;
  /** BとCで共有した調査結果（Cで実行したもの） */
  investigation: InvestigationResponse | null;
  investigationCalls: number;
}

export interface Env {
  sys: Db;
  u1: Db;
  hid: string;
  knowledge?: HumanKnowledge;
  /** true のとき、地域の条件を全都道府県にする（抽出の精度を評価するため。9H-3J）。地域外の案件が、情報を取得する前に除外され、最終候補が空になるのを避ける */
  allRegions?: boolean;
  /** 収集条件（地域など）を、本番相当の値で指定する（9H-3K。指定時は allRegions より優先） */
  conditions?: CollectionConditions;
}

const ALL_PREFECTURES = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];

export function makeThreeway(env: Env) {
  const { sys, u1, hid } = env;
  let current: PlanMember | null = null;
  const U = (n: string) => `https://q9h3f.example.invalid/${n}`;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const extractor = {
    engine: "mock" as const,
    extract: async (r: never) => {
      const o = await getExtractor({ AI_PROVIDER: "mock" })!.extract(r);
      const i = current!.input;
      const select = i.storeMode === "select_on_apply";
      const raw = JSON.parse(JSON.stringify(o.raw)) as Record<string, unknown>;
      raw.is_lottery_announcement = true;
      raw.chain_name = i.chain;
      raw.store_name = select ? "" : i.store;
      raw.products = i.products.map((name) => ({ name, code: "", quantity: 1, unit: "box" }));
      raw.apply_start = flex(i.applyStart);
      raw.apply_deadline = flex(i.applyDeadline);
      raw.result_date = flex(i.resultDate);
      raw.result_end_date = flex(i.resultEnd);
      raw.apply_url = "";
      raw.conditions_text = i.conditions;
      raw.receive_method = i.receiveMethod || "unknown";
      raw.apply_method = i.applyMethod || "unknown";
      raw.apply_unit = select ? "store_select" : "unknown";
      raw.selectable_stores = i.selectable;
      raw.notes = "";
      // 9H-3K: 本番の初期読み取りで得た根拠の抜粋（本番のAIが、実際の本文から抜き出したもの）を再現する。評価用の簡略化で根拠が全て空になり、商品の根拠が常に「根拠なし」と判定されるのを避ける
      raw.evidence = Object.fromEntries((current!.evidence ?? []).map((e) => [e.field === "items" ? "products" : e.field, e.quote]));
      raw.warnings = [];
      return { ...o, raw };
    },
  };
  const cond = (): CollectionConditions => env.conditions ?? ({ ...DEFAULT_CONDITIONS, prefectures: env.allRegions ? ALL_PREFECTURES : ["東京都"] });
  const refNow = (m: PlanMember) => new Date(new Date(`${(str(m.input.applyDeadline).slice(0, 10) || "2026-11-10")}T12:00:00+09:00`).getTime() - 86400_000);
  const deps = (m: PlanMember, extra: Partial<CollectDeps>): CollectDeps => ({
    db: sys, householdId: hid, trigger: "cron", now: refNow(m), actor: null, canRegister: false, serviceRegister: false, extractor: extractor as never, xClient: null,
    // 収集側の取得は、初期の読み取りの再現（見出しのみ）。調査側の取得は呼び出し側が決める
    fetchPage: async (u: string) => ({ ok: true, finalUrl: u, status: 200, contentType: "text/html", body: `<html><head><title>${m.title}</title></head><body><p>${m.title} の抽選販売のお知らせです。詳細は応募ページをご確認ください。（収集側の入力は初期の読み取りを再現）</p>${(m.evidence ?? []).map((e) => `<p>${e.quote}</p>`).join("")}</body></html>`, truncated: false }) as never,
    fetchOembed: async (u: string) => ({ ok: true, text: `${m.title} の抽選販売のお知らせです。詳細は応募ページをご確認ください。${(m.evidence ?? []).map((e) => e.quote).join(" ")}`, author: /x\.com\/([^/]+)\/status/.exec(u)?.[1] ?? "", notice: [], postedOn: "" }) as never,
    ...(env.knowledge ? { humanKnowledge: env.knowledge } : {}),
    ...extra,
  });
  const run = async (m: PlanMember, extra: Partial<CollectDeps>) => processQueue(deps(m, extra), { settings: { auto_register: false }, cond: cond(), data: await loadAppData(sys, hid), aiLeft: 8, timeLeft: () => 200_000, perBatch: 4 });
  const add = (n: string, m: PlanMember) => {
    const url = m.url ?? U(n);
    return sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: U(n), source_url: url, title: m.title || n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url, title: m.title || n, context: m.title, card: m.title, sourceName: "eval9h3f", attempts: 0 } } as never });
  };
  const cand = async (n: string) => (await sys.from("collection_candidates").select("id,status,job_state,reasons,draft").eq("household_id", hid).eq("dedupe_key", U(n)).maybeSingle()).data!;
  const open = async () => ((await sys.from("collection_candidates").select("id").eq("household_id", hid).like("dedupe_key", "%q9h3f.example.invalid%").eq("status", "pending").eq("job_state", "review")).data ?? []).length;
  const masters = async (c: PlanCase) => {
    for (const name of c.skipChainMasters ? [] : [...new Set(c.members.map((m) => m.input.chain).filter(Boolean))]) {
      if (!(await sys.from("chains").select("id").eq("household_id", hid).eq("name", name).maybeSingle()).data) {
        const ch = (await u1.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
        await u1.from("stores").insert({ household_id: hid, chain_id: ch, name: "応募時に店舗選択", prefecture: "" });
        const host = c.classify?.officialHosts?.[0];
        if (host) await sys.from("stores").update({ store_url: `https://${host}/` } as never).eq("chain_id", ch);
      }
    }
    for (const p of new Set(c.members.flatMap((m) => m.input.products))) if (!(await sys.from("products").select("id").eq("household_id", hid).eq("official_name", p).maybeSingle()).data) await u1.from("products").insert({ household_id: hid, official_name: p, packs_per_box: 20 });
  };
  const clear = async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q9h3f.example.invalid%");
    await sys.from("lotteries").delete().eq("household_id", hid);
  };
  const flags = (mode: "off" | "on") => {
    process.env.TOREMANE_ENV = "local";
    if (mode === "on") {
      process.env.COLLECT_UNIFIED = "on";
      process.env.COLLECT_INVESTIGATE = "on";
      process.env.COLLECT_SPOTCHECK_RATE = "1";
      process.env.COLLECT_SPOTCHECK_EXECUTE = "on";
    } else for (const k of ["COLLECT_UNIFIED", "COLLECT_INVESTIGATE", "COLLECT_SPOTCHECK_RATE", "COLLECT_SPOTCHECK_EXECUTE"]) delete process.env[k];
  };
  const arm = async (a: "A" | "B" | "C", anchor: string): Promise<ArmResult> => {
    const c = await cand(anchor);
    return { arm: a, status: c.status, openCards: await open(), draft: c.draft, input: (c.draft as { input?: unknown } | null)?.input ?? null, judgment: (c.draft as { judgment?: Judgment } | null)?.judgment ?? null, reasons: c.reasons };
  };

  /** 1つの抽選を3方式で処理する。realInvestigate は実AI調査（またはモック）。BとCで同じ調査結果を使う */
  async function runCase(c: PlanCase, realInvestigate: InvestigateFn): Promise<ThreewayResult> {
    const anchor = c.members.find((m) => m.id === c.anchorId) ?? c.members[0];
    const others = c.members.filter((m) => m !== anchor);
    let captured: InvestigationResponse | null = null;
    let calls = 0;
    // ---- A: 従来の経路（フラグ無効）。同じ抽選の候補は、別々の候補のまま
    await clear();
    await masters(c);
    flags("off");
    for (const m of [...others, anchor]) {
      current = m;
      await add(m.id, m);
      await run(m, {});
    }
    const A = await arm("A", anchor.id);
    // ---- C: 調査＋統合。同じ抽選の別の候補を先に収集し（確認待ちに）、基準の候補で調査して統合する
    await clear();
    await masters(c);
    flags("on");
    for (const m of others) {
      current = m;
      await add(m.id, m);
      await run(m, { investigate: async () => ({ skipped: "sibling_not_investigated" }) });
    }
    current = anchor;
    await add(anchor.id, anchor);
    await run(anchor, {
      investigate: async (req) => {
        calls += 1;
        captured = await realInvestigate(req);
        return captured;
      },
    });
    const C = await arm("C", anchor.id);
    // ---- B: 同じ調査結果を、従来の合流規則で反映（統合しない。同じ抽選の別の候補は別々のまま）
    await clear();
    await masters(c);
    for (const m of [...others, anchor]) {
      current = m;
      await add(m.id, m);
      await run(m, { mergeMode: "legacy", investigate: async () => (m === anchor ? (captured ?? { skipped: "no_investigation_result" }) : { skipped: "sibling_not_investigated" }) });
    }
    const B = await arm("B", anchor.id);
    flags("off");
    await clear();
    return { caseId: c.caseId, arms: { A, B, C }, investigation: captured, investigationCalls: calls };
  }
  /**
   * 9H-3I の3方式。同じ初期の読み取り・同じAI調査結果から:
   *  A: 従来（フラグ無効。調査なし・統合なし）
   *  B: 9H-3F相当 = AI調査＋9H-3Eの統合。9H-3G・3Hの新機能（系列名の解決・店舗選択式の推定・LivePocket構造解析の反映）は無効。
   *     C の調査結果から構造解析で補った項目を除いて再生する（bResponse）。限界: AIが調査中に見たツール出力には構造解析の参考行が含まれる
   *  C: 9H-3H最新版 = AI調査＋統合＋構造解析・系列傾向・双方向学習
   * 調査は C で1回だけ実行し、B は保存した結果を再生する（調査の回数が1を超えたら呼び出し側が中止する）。
   */
  async function runCase3I(c: PlanCase, realInvestigate: InvestigateFn, bResponse: (captured: InvestigationResponse) => InvestigationResponse): Promise<ThreewayResult> {
    const anchor = c.members.find((m) => m.id === c.anchorId) ?? c.members[0];
    const others = c.members.filter((m) => m !== anchor);
    let captured: InvestigationResponse | null = null;
    let calls = 0;
    const skipSibling = async () => ({ skipped: "sibling_not_investigated" }) as never;
    // ---- A
    await clear();
    await masters(c);
    flags("off");
    for (const m of [...others, anchor]) {
      current = m;
      await add(m.id, m);
      await run(m, {});
    }
    const A = await arm("A", anchor.id);
    // ---- C
    await clear();
    await masters(c);
    flags("on");
    delete process.env.COLLECT_FORM_INFERENCE;
    for (const m of others) {
      current = m;
      await add(m.id, m);
      await run(m, { investigate: skipSibling });
    }
    current = anchor;
    await add(anchor.id, anchor);
    await run(anchor, {
      investigate: async (req) => {
        calls += 1;
        captured = await realInvestigate(req);
        return captured;
      },
    });
    const C = await arm("C", anchor.id);
    // ---- B（9H-3F相当）
    await clear();
    await masters(c);
    flags("on");
    process.env.COLLECT_FORM_INFERENCE = "off";
    try {
      for (const m of others) {
        current = m;
        await add(m.id, m);
        await run(m, { investigate: skipSibling });
      }
      current = anchor;
      await add(anchor.id, anchor);
      await run(anchor, { investigate: async () => (captured ? bResponse(captured) : ({ skipped: "no_investigation_result" } as never)) });
    } finally {
      delete process.env.COLLECT_FORM_INFERENCE;
    }
    const B = await arm("B", anchor.id);
    flags("off");
    await clear();
    return { caseId: c.caseId, arms: { A, B, C }, investigation: captured, investigationCalls: calls };
  }
  return { runCase, runCase3I, clear, flags, conditions: cond };
}
