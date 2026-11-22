// @vitest-environment node
/** 本番の相場調査メモのカード名（読み取り専用で書き出したローカルの一覧。Git管理外）を、照合に通して結果を出力する。ファイルが無ければスキップ。 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { ALL_POKEMON_NAMES } from "./pokemon-names";
import { matchPokemonByCardName } from "./pokemon-match";

const FILE = "eval/real-data/market-card-names.json";
describe.skipIf(!existsSync(FILE))("本番カード名の照合（実データ）", () => {
  it("各カード名の特定結果と、画像の実在を書き出す", () => {
    const { names, imageNumbers } = JSON.parse(readFileSync(FILE, "utf8")) as { names: string[]; imageNumbers: number[] };
    const have = new Set(imageNumbers);
    const rows = names.map((n) => {
      const m = matchPokemonByCardName(n);
      return { card: n, no: m?.no ?? null, pokemon: m ? ALL_POKEMON_NAMES[m.no - 1] : null, imageInStorage: m ? have.has(m.no) : null };
    });
    writeFileSync("eval/real-data/market-card-names-result.json", JSON.stringify(rows, null, 1));
  });
});
