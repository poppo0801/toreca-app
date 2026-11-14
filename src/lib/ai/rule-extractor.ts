/**
 * 無料・オフラインの抽選告知の読み取り（Stage 9D）。AIを使わず、取得したページの**本文に書かれていること**だけを、登録済みのマスター（系列・店舗・商品）との照合と日付の書式で読み取る。
 * 調査エージェントの解析プレビュー（dry-run）と、実APIを使わない動作確認のための部品。書かれていない項目は null / 空にする（推測しない）。
 * 実際のAIによる読み取り（既存の LotteryExtractor・費用が発生）の代わりではなく、同じ出力形式（RawExtraction）を返すだけ。精度の評価は eval9d で別に測る。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { productKey } from "@/lib/lottery-match";
import { classifyPage } from "@/lib/ai/page-kind";
import type { ExtractOutput, ExtractRequest, LotteryExtractor } from "@/lib/ai/provider";

export interface RuleMaster {
  chains: { name: string; aliases?: string[] }[];
  stores: { chainName: string; name: string }[];
  products: string[];
}

type D = { year: number | null; month: number; day: number; hour: number | null; minute: number | null } | null;
const date = (m: number, d: number, year: number | null = null): D => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { year, month: m, day: d, hour: null, minute: null } : null);

const MD = String.raw`(?:(\d{4})\s*[年/.]\s*)?(\d{1,2})\s*[/月.]\s*(\d{1,2})\s*日?`;
const WD = String.raw`(?:\s*[(（][月火水木金土日祝][)）])?`;
const TIME = String.raw`(?:\s*\d{1,2}[:：時]\d{0,2}分?)?`;
/** 終了側は月を省略できる（「11/16〜20」）。グループ: 1-3=開始(年・月・日)、4-6=終了(年・月・日) */
const MD2 = String.raw`(?:(\d{4})\s*[年/.]\s*)?(?:(\d{1,2})\s*[/月.]\s*)?(\d{1,2})\s*日?`;
const RANGE = new RegExp(`(?:応募|受付|エントリー|お?申し?込み|申込|抽選)(?:期間|期限)?\\s*[:：]?\\s*${MD}${WD}${TIME}\\s*(?:[〜~～\\-－ー]|から)\\s*${MD2}`);
const DEADLINE = new RegExp(`(?:応募|受付|エントリー)?(?:締切|締め切り|期限|まで)\\s*[:：]?\\s*${MD}`);
const RESULT = new RegExp(`当選(?:者)?(?:発表|連絡|通知)(?:日)?\\s*[:：]?\\s*${MD}`);

const hasAny = (text: string, key: string, name: string): boolean => {
  const k = chainCanonicalKey(name);
  return !!k && (chainCanonicalKey(text).includes(k) || text.includes(key));
};

export class RuleExtractor implements LotteryExtractor {
  readonly engine = "mock" as const;
  constructor(private readonly master: RuleMaster) {}

  async extract(req: ExtractRequest): Promise<ExtractOutput> {
    const text = (req.text ?? "").normalize("NFKC");
    // 「抽選」の語が出るだけでは抽選の告知としない（ナビゲーション・新着一覧・説明・商品紹介を除く。Stage 9E）。先頭の行をページの題とみなす
    const kind = classifyPage({ text });
    const lottery = kind.actionable;
    // 系列: 本文・タイトルに名称（別名を含む）が書かれているもの。複数あれば名称が長い方（誤一致を避ける）
    const chainHits = this.master.chains
      .flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => ({ canon: c.name, n })))
      .filter((x) => x.n.length >= 2 && hasAny(text, x.n, x.n))
      .sort((a, b) => b.n.length - a.n.length);
    const chainName = chainHits[0]?.canon ?? "";
    const stores = this.master.stores.filter((s) => (!chainName || s.chainName === chainName) && s.name.length >= 2 && text.includes(s.name));
    const products = this.master.products.filter((p) => p.length >= 2 && productKey(text).includes(productKey(p))).slice(0, 5);
    const range = RANGE.exec(text);
    let start: D = null;
    let deadline: D = null;
    if (range) {
      const y1 = range[1] ? Number(range[1]) : null;
      start = date(Number(range[2]), Number(range[3]), y1);
      deadline = date(range[5] ? Number(range[5]) : Number(range[2]), Number(range[6]), range[4] ? Number(range[4]) : y1);
    }
    if (!deadline) {
      const m = DEADLINE.exec(text);
      if (m) deadline = date(Number(m[2]), Number(m[3]), m[1] ? Number(m[1]) : null);
    }
    const rm = RESULT.exec(text);
    const result = rm ? date(Number(rm[2]), Number(rm[3]), rm[1] ? Number(rm[1]) : null) : null;
    const select = /(応募(時|の際)に)?店舗を(選択|選んで|お選び)|店舗選択/.test(text);
    const low = "low" as const;
    const conf = (ok: boolean) => (ok ? ("medium" as const) : low);
    return {
      engine: "mock",
      raw: {
        is_lottery_announcement: lottery,
        chain_name: chainName,
        store_name: stores.length === 1 ? stores[0].name : "",
        prefecture: "",
        products: products.map((name) => ({ name, code: "", quantity: 1, unit: null })),
        multi_mode: products.length > 1 ? "unknown" : "single",
        apply_start: start,
        apply_deadline: deadline,
        result_date: result,
        apply_unit: select ? "store_select" : "unknown",
        apply_method: /WEB|ウェブ|オンライン|応募フォーム/i.test(text) ? "web" : /店頭/.test(text) ? "store" : "unknown",
        receive_method: /店頭(受取|受け取り|お渡し)/.test(text) ? "store" : /配送|発送/.test(text) ? "shipping" : "unknown",
        announcement_url: "",
        apply_url: "",
        conditions_text: "",
        notes: `ページの種類: ${kind.kind}（${kind.reasons[0] ?? ""}）`,
        confidence: { chain: conf(!!chainName), store: conf(stores.length === 1), products: conf(products.length > 0), multi_mode: low, apply_start: conf(!!start), apply_deadline: conf(!!deadline), result_date: conf(!!result), procedure_start: low, procedure_deadline: low, announcement: low, apply_method: low, receive_method: low, limit: low, conditions: low },
        warnings: [],
      },
    };
  }
}
