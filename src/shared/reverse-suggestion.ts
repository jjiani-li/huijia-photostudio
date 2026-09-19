/**
 * 反推推荐的**初值**（`docs/prd/pages/P00-设计基准与路由.md` §6 允许的两处模块级内存态之一）。
 *
 * 写入方：上传页 `/upload` 的用户采纳（`docs/prd/pages/P01-上传与身份确认.md` §4.4，归 `tickets/T15`）；
 * 读取方：选择页 `/choose/[anchorId]` 接住的初值（`docs/prd/pages/P02-年代与场景选择.md` §7，归 `tickets/T16`）。
 *
 * **不落任何存储**：不碰 `localStorage` / `sessionStorage` / cookie，刷新即丢；采纳只是初值，
 * 用户手选优先（URL 一旦带上 `era` / `scene`，本模块不再参与）。
 * `resultPrompt` 不在这里：它只作展示、不回传、不参与拼装（`docs/prd/spec/05-Prompt工程.md` §11）。
 */
export interface ReverseSuggestion {
  /** 推荐年代代号（`E1`–`E4`），无法判断为 `null`。 */
  eraCode: string | null;
  /** 推荐的场景 id（`scenes.id`，整数），无法判断为 `null`。 */
  sceneId: number | null;
}

let pending: ReverseSuggestion | null = null;

/** 上传页采纳时写入（覆盖上一次）；`tickets/T15` 调用。 */
export const adoptReverseSuggestion = (suggestion: ReverseSuggestion): void => {
  pending = { ...suggestion };
};

/** 只读一次（不消费）；返回副本，调用方改不动内部状态。 */
export const peekReverseSuggestion = (): ReverseSuggestion | null =>
  pending === null ? null : { ...pending };

/** 取用并清空（`pages/P02-年代与场景选择.md` §7：返回后内存态不再参与）。 */
export const takeReverseSuggestion = (): ReverseSuggestion | null => {
  const taken = pending;
  pending = null;
  return taken === null ? null : { ...taken };
};

/** 测试用：复位模块级状态。 */
export const resetReverseSuggestion = (): void => {
  pending = null;
};
