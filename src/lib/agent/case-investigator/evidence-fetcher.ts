import type { FetchedPage, PageFetcher } from "@/lib/agent/store-location/tools";
import { normalizeEvidenceUrl, type StoredEvidence } from "@/lib/collector/evidence";

/**
 * Stage 9Z: 取得部品の包み（既存の取得部品 PageFetcher を再利用する）。調査エージェントの「ページを取得する」操作に対して、
 *  1. 初回収集で保存した原文（StoredEvidence）が同じURLにあれば、ネットワークへ出ずにそれを返す（再利用。取得日時・取得方法を本文の冒頭に明示）
 *  2. 保存が無く、過去の取得失敗の記録（ロボット制限・ログイン必須）がある情報源は、再取得しない（制限の回避はしない）。AIには理由つきの失敗として返し、代替の探索を促す
 *  3. それ以外は元の取得部品で取得し、ホストごとの成否を記録する
 * どの情報源へ行くか・何を調べるかはAIが選ぶ。ここは「すでに分かっていること」と「過去に失敗したこと」を使って、同じ無駄を繰り返さないだけ。
 */
export interface HostStat {
  attempts: number;
  ok: number;
  fail: number;
  reused: number;
  suppressed: number;
}
export interface EvidenceFetchStats {
  /** 保存済みの原文から返した回数 */
  reused: number;
  /** 過去の取得失敗の記録により、ネットワークへ出なかった回数 */
  suppressed: number;
  /** 実際にネットワークへ出た回数 / うち失敗 */
  network: number;
  networkFailed: number;
  /** 取得制限（ロボット制限・ログイン必須）と分かっていながらネットワークへ出た回数（記録が無い初回の失敗） */
  blockedAttempts: number;
  byHost: Record<string, HostStat>;
}

export interface EvidenceFetcherOptions {
  /** 過去の取得失敗の記録（永続）から、再取得しない情報源か。未指定なら記録は使わない */
  knownBlocked?: (url: string) => boolean;
  /** 取得制限と分かった失敗を記録する（永続の記録へ。失敗しても本処理は止めない） */
  onBlocked?: (url: string, message: string) => void;
  /** false にすると、取得制限と分かった情報源へも再び取得しにいく（従来の挙動。改善前後の比較評価でだけ使う。既定は true） */
  suppress?: boolean;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
export const isBlockedMessage = (m: string) => /robots|ロボット|ログイン|login|認証/i.test(m);

export class EvidenceReuseFetcher implements PageFetcher {
  private stored = new Map<string, StoredEvidence>();
  /** この実行の中で取得制限と分かったホスト（同じ実行で何度も試さない） */
  private runBlocked = new Set<string>();
  readonly stats: EvidenceFetchStats = { reused: 0, suppressed: 0, network: 0, networkFailed: 0, blockedAttempts: 0, byHost: {} };

  constructor(private inner: PageFetcher, private opts: EvidenceFetcherOptions = {}) {}

  /** 永続の記録（取得制限の一覧・記録先）を後から接続する（DBを読み込んだあと） */
  setOptions(o: EvidenceFetcherOptions): void {
    this.opts = { ...this.opts, ...o };
  }

  /** 調査する案件の保存済み原文を設定する（案件ごとに入れ替える。他の案件の原文は使わない） */
  setStored(list: StoredEvidence[]): void {
    this.stored = new Map(list.map((e) => [normalizeEvidenceUrl(e.url), e]));
  }

  private host(url: string): HostStat {
    const h = hostOf(url) || "(unknown)";
    return (this.stats.byHost[h] ??= { attempts: 0, ok: 0, fail: 0, reused: 0, suppressed: 0 });
  }

  async fetchPage(url: string): Promise<FetchedPage> {
    const hs = this.host(url);
    const ev = this.stored.get(normalizeEvidenceUrl(url));
    if (ev) {
      this.stats.reused++;
      hs.reused++;
      const how = { x_api: "X公式API", x_oembed: "X公開埋め込み（本文のみ）", web_fetch: "ページの直接取得", list_card: "まとめサイトの一覧の表示（二次情報）" }[ev.via];
      const head = `【初回収集時に保存した原文（取得日時 ${ev.fetchedAt.slice(0, 16).replace("T", " ")}・取得方法 ${how}${ev.truncated ? "・長文のため途中まで" : ""}${ev.imageCount > 0 ? `・添付画像${ev.imageCount}枚は保存なし` : ""}）。今回あらためて取得した内容ではありません】`;
      return { ok: true, url, finalUrl: url, title: "", text: `${head}\n${ev.text}`, links: ev.links.map((href) => ({ text: "", href })), cached: true, stored: true, fetchedAt: ev.fetchedAt };
    }
    const h = hostOf(url);
    if (this.opts.suppress !== false && (this.runBlocked.has(h) || this.opts.knownBlocked?.(url))) {
      this.stats.suppressed++;
      hs.suppressed++;
      return { ok: false, message: "ロボット制限・ログイン必須のため取得できません（過去の取得失敗の記録により再取得しません。制限は回避しません。別の情報源を探してください）" };
    }
    this.stats.network++;
    hs.attempts++;
    const r = await this.inner.fetchPage(url);
    if (r.ok) {
      hs.ok++;
      return r;
    }
    hs.fail++;
    this.stats.networkFailed++;
    if (isBlockedMessage(r.message)) {
      this.stats.blockedAttempts++;
      if (h) this.runBlocked.add(h);
      try {
        this.opts.onBlocked?.(url, r.message);
      } catch {
        /* 記録の失敗で調査は止めない */
      }
    }
    return r;
  }
}
