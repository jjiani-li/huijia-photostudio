import { appError } from '../domain/errors';
import { maskIdentifier } from './mask';

/**
 * 短信通道抽象（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1、`docs/prd/spec/04-技术基线与目录结构.md` §1）：
 * 与 Storage / Ark / IdVerify 四个 Provider 同一惯例，业务代码只依赖接口。
 * 本期只有 `ConsoleSmsSender`：`SMS_PROVIDER=real` 取该值**抛 `INTERNAL`**（无真实通道）。
 */
export interface SmsSender {
  send(identifier: string, code: string): void;
}

/** 把验证码打到终端（`spec/08-本地开发指南.md` §5：`devCode` 的本地替身）。 */
export class ConsoleSmsSender implements SmsSender {
  send(identifier: string, code: string): void {
    console.log(`[SMS] ${maskIdentifier(identifier) ?? ''} 验证码 ${code}（10 分钟内有效）`);
  }
}

/** `SMS_PROVIDER` 的当前取值（缺省 `console`）——本文件内与 `exposeDevCode` 共用同一读取口径。 */
const smsProvider = (): string => process.env.SMS_PROVIDER ?? 'console';

let instance: SmsSender | null = null;

/** `SMS_PROVIDER`（默认 `console`）→ 发送器单例；`real` 未实现，抛 `INTERNAL`。 */
export const getSmsSender = (): SmsSender => {
  if (smsProvider() === 'real') {
    throw appError('INTERNAL', { reason: 'SMS_PROVIDER=real 本期无真实通道' });
  }
  if (instance === null) instance = new ConsoleSmsSender();
  return instance;
};

/** 测试用：清空单例。 */
export const resetSmsSender = (): void => {
  instance = null;
};

/** `devCode` 是否可下发——**仅** `SMS_PROVIDER=console`（`spec/03-接口契约.md` §3.1、`SEC-07`）。 */
export const exposeDevCode = (): boolean => smsProvider() === 'console';

/** `SMS_PROVIDER=console` 时的万能验证码（`modules/M08` §2.1；仍需存在未消费且未过期的记录）。 */
export const devLoginCode = (): string => process.env.DEV_LOGIN_CODE ?? '000000';

/**
 * 实现层断言（`modules/M08` §2.1）：响应体里出现 `devCode` 时，`SMS_PROVIDER` **必须**是 `console`。
 * 失败抛 `INTERNAL`（**不透出 code**，即错误响应的 `details` 不带 `devCode`）。
 */
export const assertDevCodeAllowed = (payload: { devCode?: string }): void => {
  if (payload.devCode !== undefined && !exposeDevCode()) {
    throw appError('INTERNAL', { reason: 'devCode 仅允许在 SMS_PROVIDER=console 时出现' });
  }
};
