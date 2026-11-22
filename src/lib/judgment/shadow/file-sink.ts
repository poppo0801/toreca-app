/**
 * シャドー記録のローカル保存先（Stage 10F）。ファイルシステムを使うため、通常収集のサーバー側コード（本番のバンドル）からは読み込まない。
 * 評価ランナー・テストだけが使う。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ShadowRecord, ShadowSink } from "./record";

/** ローカルのJSON Lines（eval/runs/shadow/ 配下のみ。Git管理外）。DBには書かない */
export class LocalFileSink implements ShadowSink {
  private readonly root = resolve(process.cwd(), "eval", "runs", "shadow");
  private readonly file: string;
  constructor(name = "shadow.jsonl") {
    if (!/^[\w.-]+\.jsonl$/.test(name)) throw new Error("ファイル名が不正です");
    this.file = join(this.root, name);
    if (!resolve(this.file).startsWith(this.root + sep)) throw new Error("保存先は eval/runs/shadow/ 配下のみです");
  }
  async write(rec: ShadowRecord): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`, "utf8");
  }
}
