'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError, apiRequest, toErrorNotice } from '../src/shared/api-client';
import type { RealNameStatus, User } from '../src/shared/types';
import { ErrorNotice } from './error-notice';

/**
 * `/login` 的两段式流程（`docs/prd/pages/P00-设计基准与路由.md` §5.2）：
 * 验证码登录段 → 实名段。已登录且已实名 → 回 `next`；已登录未实名 → 直接实名段。
 * 端点与字段以 `spec/03-接口契约.md` §3.1 为准；错误文案一律取服务端 `message`（§9.1 不重写）。
 */
type Notice = { code: string; message: string };

const INLINE_CODES = [
  'CODE_INVALID',
  'CODE_EXPIRED',
  'CODE_RATE_LIMITED',
  'INVALID_PARAM',
  'INVALID_FILE_TYPE',
  'FILE_TOO_LARGE',
];

function InlineError({ error }: { error: Notice | null }): ReactNode {
  if (error === null || !INLINE_CODES.includes(error.code)) return null;
  return <p className="mt-sm text-note text-danger">{error.message}</p>;
}

export function LoginFlow({ hasSession, next }: { hasSession: boolean; next: string }) {
  const router = useRouter();
  const [session, setSession] = useState(hasSession);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<Notice | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    apiRequest<{ realNameStatus: RealNameStatus }>('/api/me/realname')
      .then((data) => {
        if (cancelled) return;
        if (data.realNameStatus.verified) router.replace(next);
        else setChecked(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setChecked(true);
        setError(toErrorNotice(err));
      });
    return () => {
      cancelled = true;
    };
  }, [session, next, router]);

  if (!session) return <LoginPanel onLoggedIn={() => setSession(true)} error={error} setError={setError} />;
  if (!checked) return <p className="text-note text-ink-soft">正在确认登录状态…</p>;
  return <RealNamePanel onDone={() => router.replace(next)} error={error} setError={setError} />;
}

function LoginPanel({
  onLoggedIn,
  error,
  setError,
}: {
  onLoggedIn: () => void;
  error: Notice | null;
  setError: (e: Notice | null) => void;
}): ReactNode {
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), 60_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const requestCode = async (): Promise<void> => {
    setError(null);
    if (identifier.trim() === '') {
      setError({ code: 'INVALID_PARAM', message: '请先填手机号或邮箱' });
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest<{ sent: boolean; expiresInSec: number; devCode?: string }>(
        '/api/auth/code',
        { method: 'POST', body: { identifier: identifier.trim() } },
      );
      setSent(true);
      setCooldown(true);
      // 仅当响应含 devCode 才显示（SMS_PROVIDER=console），生产不返回（SEC-07）。
      setDevCode(typeof res.devCode === 'string' ? res.devCode : null);
    } catch (err) {
      setError(toErrorNotice(err));
      if (err instanceof ApiClientError && err.code === 'CODE_RATE_LIMITED') setCooldown(true);
    } finally {
      setBusy(false);
    }
  };

  const login = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await apiRequest<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: { identifier: identifier.trim(), code: code.trim() },
      });
      onLoggedIn();
    } catch (err) {
      setError(toErrorNotice(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="animate-fade-in">
      <h1 className="font-serif text-title text-ink">回家照相馆</h1>
      <p className="mt-md text-note text-ink-soft">用手机号或邮箱登录，我们会发一个六位数的验证码给你。</p>

      <label className="mt-xl block text-note text-ink" htmlFor="identifier">
        手机号或邮箱
      </label>
      <input
        id="identifier"
        inputMode="tel"
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        className="mt-sm w-full rounded-md border border-border bg-surface px-lg py-md text-body"
      />

      <button
        type="button"
        onClick={() => void requestCode()}
        disabled={busy || cooldown}
        className="mt-md rounded-md border border-primary px-lg py-md text-note text-primary disabled:border-border disabled:text-ink-soft"
      >
        {cooldown ? '稍等一下' : '获取验证码'}
      </button>
      {devCode !== null ? (
        <p className="mt-sm text-micro text-ink-soft">开发模式：验证码是 {devCode}。</p>
      ) : null}

      {sent ? (
        <>
          <label className="mt-xl block text-note text-ink" htmlFor="code">
            验证码
          </label>
          <input
            id="code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="mt-sm w-full rounded-md border border-border bg-surface px-lg py-md text-body"
          />
          <InlineError error={error} />
          <button
            type="button"
            onClick={() => void login()}
            disabled={busy}
            className="mt-md rounded-pill bg-primary px-xl py-md text-note text-background disabled:opacity-60"
          >
            登录
          </button>
        </>
      ) : (
        <InlineError error={error} />
      )}

      {error !== null && !INLINE_CODES.includes(error.code) ? (
        <div className="mt-md">
          <ErrorNotice error={error} />
        </div>
      ) : null}

      <p className="mt-2xl text-micro text-ink-soft">我们不会把你的照片用在别的地方。</p>
    </section>
  );
}

function RealNamePanel({
  onDone,
  error,
  setError,
}: {
  onDone: () => void;
  error: Notice | null;
  setError: (e: Notice | null) => void;
}): ReactNode {
  const [realName, setRealName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await apiRequest<{ realNameStatus: RealNameStatus }>('/api/me/realname', {
        method: 'POST',
        body: { realName: realName.trim(), idNumber: idNumber.trim() },
      });
      onDone();
    } catch (err) {
      setError(toErrorNotice(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="animate-fade-in">
      <h1 className="font-serif text-title text-ink">完成实名认证</h1>
      <p className="mt-md text-note text-ink-soft">按你的证件信息填写，我们只保存校验用的值。</p>

      <label className="mt-xl block text-note text-ink" htmlFor="realName">
        真实姓名
      </label>
      <input
        id="realName"
        value={realName}
        onChange={(e) => setRealName(e.target.value)}
        className="mt-sm w-full rounded-md border border-border bg-surface px-lg py-md text-body"
      />

      <label className="mt-xl block text-note text-ink" htmlFor="idNumber">
        证件号
      </label>
      <input
        id="idNumber"
        value={idNumber}
        onChange={(e) => setIdNumber(e.target.value)}
        className="mt-sm w-full rounded-md border border-border bg-surface px-lg py-md text-body"
      />

      <InlineError error={error} />
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
