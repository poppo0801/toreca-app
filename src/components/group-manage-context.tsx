"use client";

import { createContext, useContext } from "react";
import type { Lottery } from "@/types/domain";

/**
 * 抽選グループの管理画面を、一覧（抽選管理のボード）側で開くための窓口（Stage 8U-2）。
 * グループ化すると、そのカードは親カードの中（折りたたみ）へ移り、カードが持っていた画面（詳細・管理）が消えてしまうため、管理画面は一覧側が持つ。
 * 一覧の外（通知からの表示など）では null（その場合は、詳細の中で開く）。
 */
export const GroupManageContext = createContext<((anchor: Lottery) => void) | null>(null);
export const useGroupManage = () => useContext(GroupManageContext);
