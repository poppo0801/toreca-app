/**
 * 本番シャドーの調査道具（実ページ取得・画像解析）の「承認済みの入口を通して作った」印。
 * 本番シャドーの許可証つきの生成（generateProposalsForCandidate）は、この印のある道具だけを受け付ける（偽造・素の関数の注入を拒否）。
 * 印を付けられるのは、本番の多重ゲートを通した入口（live-fetch.ts の makeShadowLivePublicFetch・shadow/proposal-job.ts）だけ。
 */
const MARKED = new WeakSet<object>();
export function markShadowTool<T extends object>(tool: T): T {
  MARKED.add(tool);
  return tool;
}
export const isShadowTool = (tool: unknown): boolean => (typeof tool === "function" || (typeof tool === "object" && tool !== null)) && MARKED.has(tool as object);
