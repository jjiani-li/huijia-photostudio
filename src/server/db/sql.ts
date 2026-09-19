/**
 * SQL 片段小工具（`docs/prd/spec/04-技术基线与目录结构.md` §4.3：`IN (...)` 一律用位置参数绑定，
 * 不把 id 拼进语句）。多处 repository 共用同一写法。
 */
export const placeholders = (count: number): string => new Array(count).fill('?').join(', ');
