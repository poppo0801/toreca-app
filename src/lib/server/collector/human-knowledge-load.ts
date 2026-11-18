import "server-only";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHumanKnowledge, type AnswersFileLike, type HumanKnowledge } from "@/lib/case-model/human-knowledge";

/**
 * 人間の評価JSON（評価ツールの書き出し。backups/review-answers/ に置く）を読み込み、AIへ渡す参考情報の元データを作る（Stage 9H-3B）。
 * 毎回コピーしなくても、フォルダに置くだけで使われる。開発環境で、収集の共通基盤フラグが有効なときだけ呼ばれる。
 * 読み込みに失敗しても空の知識を返す（収集を止めない）。個人情報・認証情報は含まれない評価データだけを対象にする。
 */
let cache: { key: string; value: HumanKnowledge } | null = null;

export function loadHumanKnowledge(dir: string = process.env.HUMAN_KNOWLEDGE_DIR ?? join(process.cwd(), "backups", "review-answers")): HumanKnowledge {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    // 更新（評価の追記・無効化リストの編集）を次回の収集から反映するため、ファイル名だけでなく更新時刻も鍵にする
    const key = files.map((f) => { try { return `${f}:${statSync(join(dir, f)).mtimeMs}`; } catch { return f; } }).join("|");
    if (cache?.key === key) return cache.value;
    const parsed: AnswersFileLike[] = [];
    for (const f of files) {
      try {
        parsed.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as AnswersFileLike);
      } catch {
        /* 壊れたファイルは無視する */
      }
    }
    // 方式を伏せた評価は、対応表で実際の事例IDに戻す（同じ抽選の評価は1件にまとまり、事例IDによる除外も効く）
    const keys = loadBlindKeys();
    const value = buildHumanKnowledge(parsed.map((f) => ({ ...f, results: (f.results ?? []).map((r) => ({ ...r, caseId: keys[r.caseId ?? ""]?.caseId ?? (r.caseId ?? "").replace(/^b-/, "") })) })));
    cache = { key, value };
    return value;
  } catch {
    return { version: 1, entries: [] };
  }
}

/** 方式を伏せた評価（9H-3Dなど）の対応表を読み込み、評価の事例IDを実際の事例IDに戻す。対応表は backups の eval-で始まるフォルダの review-key-で始まるJSON（評価が済んだものだけ使う） */
export function loadBlindKeys(root: string = join(process.cwd(), "backups")): Record<string, { caseId: string; arm: string }> {
  const keys: Record<string, { caseId: string; arm: string }> = {};
  try {
    for (const d of readdirSync(root).filter((x) => x.startsWith("eval-"))) {
      for (const f of readdirSync(join(root, d)).filter((x) => /^review-key-.*\.json$/.test(x))) {
        try {
          const j = JSON.parse(readFileSync(join(root, d, f), "utf8")) as { key?: Record<string, { caseId?: string; arm?: string; lotteryId?: string }> };
          for (const [id, v] of Object.entries(j.key ?? {})) if (v.caseId) keys[id] = { caseId: v.caseId, arm: v.arm ?? "" };
        } catch {
          /* 壊れたファイルは無視 */
        }
      }
    }
  } catch {
    /* backups が無い環境 */
  }
  return keys;
}
