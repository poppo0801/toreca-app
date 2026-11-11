import type { EntityKey } from "@/lib/masters";

/** マスター管理で1行目に常時出す種類（Stage 7S）。それ以外は「その他」に畳む */
export const MAIN_MASTER_KEYS: EntityKey[] = ["profiles", "chains", "stores", "products"];

export const isMainMasterKey = (k: EntityKey): boolean => MAIN_MASTER_KEYS.includes(k);
