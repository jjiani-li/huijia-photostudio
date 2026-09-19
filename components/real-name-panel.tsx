'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApiClientError, apiRequest, getFieldNames, toErrorNotice, type ApiNotice } from '../src/shared/api-client';
import type { RealNameStatus } from '../src/shared/types';

/**
 * `/login` 的实名段（`docs/prd/pages/P00-设计基准与路由.md` §5.2）：`POST /api/me/realname`。
 * 提交成功后展示已实名态（**不回显证件号明文**）；格式 / 唯一性失败 → `INVALID_PARAM`，`details.fields`
 * 仅用于高亮控件、不展示原文（错误文案取服务端 `message`）。
 */
export function RealNamePanel({ onDone }: { onDone: () => void }): ReactNode {
  const [realName, setRealName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [error, setError] = useState<ApiNotice | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setFields([]);
    setBusy(true);
    try {
      const res = await apiRequest<{ realNameStatus: RealNameStatus }>('/api/me/realname', {
        method: 'POST',
        body: { realName: realName.trim(), idNumber: idNumber.trim() },
      });
      if (res.realNameStatus.verified) setVerified(true);
    } catch (err) {
      setError(toErrorNotice(err));
      if (err instanceof ApiClientError) setFields(getFieldNames(err.details));
    } finally {
      setBusy(false);
    }
  };

  const fieldClass = (name: string): string =>
    `mt-sm w-full rounded-md border bg-surface px-lg py-md text-body ${
      fields.includes(name) ? 'border-danger' : 'border-border'
    }`;

  if (verified) {
    return (
      <section className="animate-fade-in">
        <h1 className="font-serif text-title text-ink">已实名</h1>
        <button
          type="button"
          onClick={onDone}
          className="mt-xl rounded-pill bg-primary px-xl py-md text-note text-background"
        >
          继续
        </button>
      </section>
    );
  }

  return (
    <section className="animate-fade-in">
      <h1 className="font-serif text-title text-ink">完成实名认证</h1>

      <label className="mt-xl block text-note text-ink" htmlFor="realName">
        真实姓名
      </label>
      <input
        id="realName"
        value={realName}
        onChange={(e) => setRealName(e.target.value)}
        className={fieldClass('realName')}
      />

      <label className="mt-xl block text-note text-ink" htmlFor="idNumber">
        证件号
      </label>
      <input
        id="idNumber"
        value={idNumber}
        onChange={(e) => setIdNumber(e.target.value)}
        className={fieldClass('idNumber')}
      />

      {error !== null ? <p className="mt-sm text-note text-danger">{error.message}</p> : null}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="mt-md rounded-pill bg-primary px-xl py-md text-note text-background disabled:opacity-60"
      >
        提交
      </button>
    </section>
  );
}
