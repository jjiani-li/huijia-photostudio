'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ApiClientError, apiRequest, toErrorNotice, type ApiNotice } from '../../src/shared/api-client';
import { hasUnauthenticated, loginPath } from '../../src/shared/session';
import type { Anchor, ConsentScope } from '../../src/shared/types';
import { ANCHOR_POLL_INTERVAL_MS, ANCHOR_POLL_TIMEOUT_MS, useJobPolling } from '../../hooks/use-job-polling';
import { ErrorNotice } from '../error-notice';
import { ConfirmSkeleton, ConfirmView } from './confirm-view';
import {
  chooseHref,
  confirmHref,
  consentScopes,
  invalidConsentScopes,
  TERMINAL_ANCHOR_STATUSES,
  UNCHECKED_CONSENTS,
} from './confirm-logic';

/**
 * `/confirm/[anchorId]` 的客户端容器（`docs/prd/pages/P01-上传与身份确认.md` §4.3、§5）：
 * 轮询 `GET /api/anchors/:id`（1.5s / 90s）、确认与授权写入、retry、会话失效跳登录。
 * 展示与文案全在 `confirm-view.tsx`。
 *
 * 轮询规则来自 `docs/prd/spec/03-接口契约.md` §2.1：请求串行不叠加、终态 `{succeeded, failed}` 即停
 * （`useJobPolling` 在终态不再排下一次，故已终态的锚点不会被重复轮询）。
 */
export interface ConfirmPanelProps {
  anchorId: number;
}

export function ConfirmPanel({ anchorId }: ConfirmPanelProps): ReactNode {
  const router = useRouter();
  const [pollId, setPollId] = useState(anchorId);

  // 直接改 URL（刷新 / 回退到别的锚点）时同步；retry 后由下面先切本地 id。
  useEffect(() => {
    setPollId(anchorId);
  }, [anchorId]);

  return (
    <ConfirmSession
      key={pollId}
      anchorId={pollId}
      onRetried={(newAnchorId) => {
        // retry 返回**新行**（`docs/prd/spec/03-接口契约.md` §3.3）：用 `replace` 换到新 id，
        // 旧锚点留在历史；`key` 换掉 poller，后续轮询对准新 id。
        setPollId(newAnchorId);
        router.replace(confirmHref(newAnchorId));
      }}
    />
  );
}

interface ConfirmSessionProps {
  anchorId: number;
  onRetried: (newAnchorId: number) => void;
}

function ConfirmSession({ anchorId, onRetried }: ConfirmSessionProps): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  // 两项授权初始都未勾选、绝不预勾选（`docs/prd/modules/M04-身份确认与授权.md` §10），
  // 也绝不写 URL / `localStorage`（`pages/P00` §6）。
  const [checked, setChecked] = useState<Record<ConsentScope, boolean>>(() => ({ ...UNCHECKED_CONSENTS }));
  const [invalidScopes, setInvalidScopes] = useState<ConsentScope[]>([]);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [submitError, setSubmitError] = useState<ApiNotice | null>(null);
  const [actionError, setActionError] = useState<ApiNotice | null>(null);

  const fetchJob = useCallback(
    (): Promise<Anchor> => apiRequest<{ anchor: Anchor }>(`/api/anchors/${anchorId}`).then((res) => res.anchor),
    [anchorId],
  );

  const polling = useJobPolling<Anchor>({
    fetchJob,
    getStatus: (job) => job.status,
    terminalStatuses: TERMINAL_ANCHOR_STATUSES,
    intervalMs: ANCHOR_POLL_INTERVAL_MS,
    timeoutMs: ANCHOR_POLL_TIMEOUT_MS,
    enabled: true,
  });

  const anchor = polling.job;
  const visibleNotice = submitError ?? actionError ?? polling.error;

  // 会话失效（cookie 被清掉而布局的软守卫没拦住）：按 §5 跳登录并保留 `next`，不留白屏。
  const sessionExpired = hasUnauthenticated([visibleNotice?.code]);
  useEffect(() => {
    if (sessionExpired) router.replace(loginPath(pathname));
  }, [sessionExpired, pathname, router]);

  const onToggleConsent = (scope: ConsentScope, next: boolean): void => {
    setChecked((current) => ({ ...current, [scope]: next }));
    // 重新勾选即清掉高亮（`pages/P00` §8：高亮只跟随最近一次 `INVALID_PARAM`）。
    setInvalidScopes((current) => current.filter((item) => item !== scope));
  };

  const onConfirm = async (): Promise<void> => {
    setBusy(true);
    setSubmitError(null);
    setInvalidScopes([]);
    try {
      // 只提交勾上的 scope；按钮置灰保证两项都勾上（`modules/M04` §10：服务端仍是唯一裁判）。
      await apiRequest<{ anchor: Anchor; consents: string[] }>(`/api/anchors/${anchorId}/confirm`, {
        method: 'POST',
        body: { confirmed: true, consents: consentScopes(checked) },
      });
      router.push(chooseHref(anchorId));
    } catch (err) {
      const next = toErrorNotice(err);
      setSubmitError(next);
      if (next.code === 'INVALID_PARAM') {
        setInvalidScopes(invalidConsentScopes(err instanceof ApiClientError ? err.details : undefined));
      }
    } finally {
      setBusy(false);
    }
  };

  const onRetry = async (): Promise<void> => {
    setRetryBusy(true);
    setActionError(null);
    try {
      const res = await apiRequest<{ anchor: Anchor }>(`/api/anchors/${anchorId}/retry`, { method: 'POST' });
      onRetried(res.anchor.id);
    } catch (err) {
      setActionError(toErrorNotice(err));
    } finally {
      setRetryBusy(false);
    }
  };

  // 一次都没取到时页面无法继续：`404` 按错误码形态呈现且**不给重试入口**（§4.3，避免对他人资源探测）；
  // 其余（网络层按 `INTERNAL`）给重试，不白屏。
  if (anchor === null && (visibleNotice !== null || sessionExpired)) {
    if (sessionExpired) return null; // 已 `replace` 到登录页
    const notFound = visibleNotice?.code === 'NOT_FOUND' || visibleNotice?.code === 'ANCHOR_NOT_FOUND';
    return <ErrorNotice error={visibleNotice} onRetry={notFound ? undefined : polling.refreshNow} />;
  }
  if (anchor === null) return <ConfirmSkeleton />;

  return (
    <ConfirmView
      anchor={anchor}
      phase={polling.phase}
      notice={visibleNotice}
      checked={checked}
      invalidScopes={invalidScopes}
      featuresOpen={featuresOpen}
      busy={busy}
      retryBusy={retryBusy}
      onToggleConsent={onToggleConsent}
      onToggleFeatures={() => setFeaturesOpen((current) => !current)}
      onConfirm={() => void onConfirm()}
      onRetry={() => void onRetry()}
      onRefreshNow={polling.refreshNow}
    />
  );
}
