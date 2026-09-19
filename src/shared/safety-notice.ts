/**
 * 首次情感安全提示的**会话态**（`docs/prd/spec/06-合规与风控.md` §9.2、
 * `docs/prd/pages/P04-失败与情绪安全路径.md` §4）：每会话一次、状态放**模块级内存态**——
 * 不落 `localStorage` / `sessionStorage`，不落 cookie，不引入「已读」这类持久状态
 * （`docs/prd/pages/P00-设计基准与路由.md` §6）。刷新页面即新会话，会再展示一次，这是有意的。
 *
 * 语义固定、措辞可调：不得指涉 `逝者` / `离开的人`（`spec/06-合规与风控.md` §9.1）。
 */

/** 情感安全提示的语义句（唯一落点，检查项 `CMP-06`）。 */
export const SAFETY_NOTICE_TEXT = '我们会尽力还原照片的样子，但这是基于照片的重建，无法替代真实。';

let shown = false;

/**
 * 本次会话是否需要展示（首帧返回 `true`，`markSafetyNoticeShown()` 之后返回 `false`）。
 * 读一次不改变状态——展示与否由调用方在 `useEffect` 里决定，避免服务端渲染期间标记进程级内存。
 */
export const shouldShowSafetyNotice = (): boolean => !shown;

/** 标记本次会话已展示（模块级内存态，进程内有效）。 */
export const markSafetyNoticeShown = (): void => {
  shown = true;
};

/** 测试钩子：复位会话态（生产代码不调用）。 */
export const resetSafetyNotice = (): void => {
  shown = false;
};
