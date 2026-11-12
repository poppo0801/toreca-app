/** モック用の架空のWeb（eval/store-location/world.json）。開発用の調査画面と評価で共用する */
import type { MockWorldData } from "@/lib/agent/store-location/mock";
import worldJson from "../../../../eval/store-location/world.json";

export const EVAL_WORLD = worldJson as unknown as MockWorldData;
