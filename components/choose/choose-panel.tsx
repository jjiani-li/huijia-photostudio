'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { apiRequest, toErrorNotice, type ApiNotice } from '../../src/shared/api-client';
import { takeReverseSuggestion } from '../../src/shared/reverse-suggestion';
import { hasUnauthenticated, loginPath } from '../../src/shared/session';
import type { Anchor, Generation, Quota, User } from '../../src/shared/types';
import { useApiRequest } from '../../hooks/use-api-request';
import { useEraSceneConfig } from '../../hooks/use-era-scene-config';
import { ErrorNotice } from '../error-notice';
import { ChooseSkeleton, ChooseView } from './choose-view';
import {
  applyReverseSuggestion,
  confirmPath,
  EMPTY_CONFIG_COPY,
  matchSelection,
  readSelection,
  shouldRedirectToConfirm,
  startGeneration,
  writeSelection,
  type Count,
  type GenerationRequest,
  type Selection,
} from './selection';

/**
 * `/choose/[anchorId]` 的客户端容器（`docs/prd/pages/P02-年代与场景选择.md` §2、§7、§8）：
 * 取数（配置 / 额度 / 锚点）→ 守卫 → 接住反推推荐 → 提交。展示与文案全在 `choose-view.tsx`。
 *
 * 选择写在 URL 上（`router.replace`，`pages/P00` §6），所以本组件不持有年代 / 场景 / 张数的 local state。
 */
interface MeResponse {
  user: User;
  quota: Quota;
}

const loadMe = (): Promise<MeResponse> => apiRequest<MeResponse>('/api/me');

const loadAnchor = (anchorId: number): Promise<Anchor> =>
  apiRequest<Anchor>(`/api/anchors/${anchorId}`);

export interface ChoosePanelProps {
  anchorId: number;
}

export function ChoosePanel({ anchorId }: ChoosePanelProps): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const configState = useEraSceneConfig();
  const meState = useApiRequest(loadMe);
  const anchorState = useApiRequest(useCallback(() => loadAnchor(anchorId), [anchorId]));

  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<ApiNotice | null>(null);

  const anchor = anchorState.data;

  // 守卫（§2）：未确认的锚点回确认页——`SEC-01` 的服务端判据在 `POST /api/generations` 上。
  useEffect(() => {
    if (anchor !== null && shouldRedirectToConfirm(anchor)) router.replace(confirmPath(anchorId));
  }, [anchor, anchorId, router]);

  // 会话失效（cookie 被清掉而布局的软守卫没拦住）：按 §8 跳登录并保留 `next`，不留一个打不开的页面。
  const sessionExpired = hasUnauthenticated([
    configState.error?.code,
    meState.error?.code,
    anchorState.error?.code,
  ]);
  useEffect(() => {
    if (sessionExpired) router.replace(loginPath(pathname));
  }, [sessionExpired, pathname, router]);

  // 接住反推推荐（§7）：URL 未带 `era` / `scene` 时把内存态初值写进 URL；URL 已带参数则不参与。
  useEffect(() => {
    const href = applyReverseSuggestion(pathname, searchParams, takeReverseSuggestion);
    if (href !== null) router.replace(href);
  }, [pathname, searchParams, router]);

  const config = configState.config;
  const selection = matchSelection(config, readSelection(searchParams));
  const remaining = meState.data?.quota.remaining ?? null;

  /** 写 URL 一律 `replace`（选年代 / 场景不是导航，不该污染历史栈）。 */
  const replaceSelection = (next: Partial<Selection>): void => {
    router.replace(writeSelection(pathname, { ...selection, ...next }));
  };

  const onGenerate = async (): Promise<void> => {
    setBusy(true);
    setSubmitError(null);
    try {
      const outcome = await startGeneration({
        anchorId,
        ...selection,
        remaining,
        busy,
        post: (body: GenerationRequest) =>
          apiRequest<{ generation: Generation }>('/api/generations', { method: 'POST', body }),
      });
      if (outcome.started) router.push(`/result/${outcome.generationId}`);
    } catch (err) {
      setSubmitError(toErrorNotice(err));
    } finally {
      setBusy(false);
    }
  };

  if (anchorState.error !== null || configState.error !== null) {
    // 401 已在上面 `replace` 到登录页；这里只剩网络 / 其他错误码（§8：不白屏）。
    const error = anchorState.error ?? configState.error;
    return <ErrorNotice error={error} variant="page" onRetry={configState.reload} />;
  }
  if (config === null || configState.loading) {
    return <ChooseSkeleton />;
  }
  if (config.eras.length === 0 || config.scenes.length === 0) {
    return <p className="text-note text-ink-soft">{EMPTY_CONFIG_COPY}</p>;
  }

  return (
    <ChooseView
      config={config}
      anchorId={anchorId}
      selection={selection}
      remaining={remaining}
      busy={busy}
      submitError={submitError}
      onSelectEra={(code) => replaceSelection({ eraCode: code })}
      onSelectScene={(id) => replaceSelection({ sceneId: id })}
      onChangeCount={(count: Count) => replaceSelection({ count })}
      onGenerate={() => void onGenerate()}
    />
  );
}
