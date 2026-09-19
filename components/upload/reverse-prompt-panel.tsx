'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ApiClientError, apiRequest, toErrorNotice, type ApiNotice } from '../../src/shared/api-client';
import { adoptReverseSuggestion } from '../../src/shared/reverse-suggestion';
import { hasUnauthenticated, loginPath } from '../../src/shared/session';
import type { Photo, PromptReverseJob } from '../../src/shared/types';
import {
  ANCHOR_POLL_INTERVAL_MS,
  ANCHOR_POLL_TIMEOUT_MS,
  useJobPolling,
  type PollPhase,
} from '../../hooks/use-job-polling';
import { AsyncStatus } from '../async-status';
import { ErrorNotice } from '../error-notice';
import {
  REVERSE_ADOPTED_COPY,
  REVERSE_ADOPT_COPY,
  REVERSE_COLLAPSE_COPY,
  REVERSE_DESCRIPTION,
  REVERSE_NO_ERA_COPY,
  REVERSE_RUNNING_COPY,
  REVERSE_TITLE,
  canAdoptReverse,
  reverseDetails,
  reverseJobNotice,
} from './uploads';

const TERMINAL_STATUSES: ReadonlyArray<PromptReverseJob['status']> = ['succeeded', 'failed'];

/**
 * `/upload` 里的反推入口（`docs/prd/pages/P01-上传与身份确认.md` §4.4）：**折叠辅助入口、不是必经步骤、
 * 不新增路由**，只要有照片上传成功就能用。
 *
 * 展开才建任务（`POST /api/prompt-reverse-jobs`，202），随后按锚点的 1.5s / 90s 轮询
 * （`spec/03-接口契约.md` §2.1、§3.8）；换一张照片即重新建任务。采纳只写
 * `src/shared/reverse-suggestion.ts` 的模块级内存态（`pages/P00` §6），**不写 URL 的 `?era=&scene=`、
 * 不碰 `localStorage` / `sessionStorage`**；`resultPrompt` 仅作展示，不回传服务端（`spec/05-Prompt工程.md` §11）。
 * 面板失败只影响本面板，不影响上传与提取主流程。
 */
export interface ReversePromptPanelProps {
  /** 本页已上传成功的原图（用响应里的 `url` 当缩略图，不构造路径）。 */
  photos: Photo[];
  /** 当前基准图的原图 id：新面板默认选它（`pages/P01` §4.4 步骤 1）。 */
  baselinePhotoId: number | null;
}

export function ReversePromptPanel({ photos, baselinePhotoId }: ReversePromptPanelProps): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  const [expanded, setExpanded] = useState(false);
  const [chosenPhotoId, setChosenPhotoId] = useState<number | null>(null);
  /** 已经为哪张照片建过任务：换一张即重新建（同一张不重复建）。 */
  const [startedPhotoId, setStartedPhotoId] = useState<number | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [startNotice, setStartNotice] = useState<ApiNotice | null>(null);
  const [adopted, setAdopted] = useState(false);

  const selectedPhotoId = chosenPhotoId ?? baselinePhotoId ?? photos[0]?.id ?? null;

  useEffect(() => {
    if (!expanded || selectedPhotoId === null || startedPhotoId === selectedPhotoId) return;
    setStartedPhotoId(selectedPhotoId);
    setJobId(null);
    setStartNotice(null);
    setAdopted(false);
    apiRequest<{ job: PromptReverseJob }>('/api/prompt-reverse-jobs', {
      method: 'POST',
      body: { photoId: selectedPhotoId },
    })
      .then((res) => setJobId(res.job.id))
      .catch((err: unknown) => setStartNotice(toErrorNotice(err)));
  }, [expanded, selectedPhotoId, startedPhotoId]);

  const fetchJob = useCallback((): Promise<PromptReverseJob> => {
    if (jobId === null) return Promise.reject(new ApiClientError('INTERNAL', '', 0));
    return apiRequest<{ job: PromptReverseJob }>(`/api/prompt-reverse-jobs/${jobId}`).then((res) => res.job);
  }, [jobId]);

  const polling = useJobPolling<PromptReverseJob>({
    fetchJob,
    getStatus: (job) => job.status,
    terminalStatuses: TERMINAL_STATUSES,
    intervalMs: ANCHOR_POLL_INTERVAL_MS,
    timeoutMs: ANCHOR_POLL_TIMEOUT_MS,
    enabled: expanded && jobId !== null,
  });

  const job = polling.job;
  const notice = startNotice ?? reverseJobNotice(job) ?? polling.error;

  // 会话失效（cookie 被清掉而布局的软守卫没拦住）：跳登录并保留 `next`（`pages/P00` §5.1 规则 ③）。
  useEffect(() => {
    if (hasUnauthenticated([notice?.code])) router.replace(loginPath(pathname));
  }, [notice, pathname, router]);

  /** 失败后重来一次：清掉「已建过」的标记，上面的 effect 会重新建任务。 */
  const onNoticeRetry = (): void => {
    setStartedPhotoId(null);
    setJobId(null);
    setStartNotice(null);
  };

  const onAdopt = (): void => {
    if (job === null) return;
    adoptReverseSuggestion({ eraCode: job.suggestEraCode, sceneId: job.suggestSceneId });
    setAdopted(true);
  };

  if (photos.length === 0) return null;

  return (
    <ReversePromptSection
      photos={photos}
      selectedPhotoId={selectedPhotoId}
      expanded={expanded}
      phase={polling.phase}
      job={job}
      notice={notice}
      adopted={adopted}
      onToggle={() => setExpanded((current) => !current)}
      onSelectPhoto={setChosenPhotoId}
      onAdopt={onAdopt}
      onNoticeRetry={onNoticeRetry}
      onRefreshNow={polling.refreshNow}
    />
  );
}

/**
 * 反推面板的展示层：**无状态、无取数**，可被静态渲染逐条断言逐字文案（`pages/P01` §4.4 的表格）。
 */
export interface ReversePromptSectionProps {
  photos: Photo[];
  selectedPhotoId: number | null;
  expanded: boolean;
  phase: PollPhase;
  job: PromptReverseJob | null;
  notice: ApiNotice | null;
  /** 已经点过 `用这个年代和场景`。 */
  adopted: boolean;
  onToggle: () => void;
  onSelectPhoto: (photoId: number) => void;
  onAdopt: () => void;
  onNoticeRetry: () => void;
  onRefreshNow: () => void;
}

export function ReversePromptSection({
  photos,
  selectedPhotoId,
  expanded,
  phase,
  job,
  notice,
  adopted,
  onToggle,
  onSelectPhoto,
  onAdopt,
  onNoticeRetry,
  onRefreshNow,
}: ReversePromptSectionProps): ReactNode {
  if (photos.length === 0) return null;

  const details = reverseDetails(job?.resultJson ?? null);
  const inProgress = job === null ? notice === null : job.status === 'queued' || job.status === 'running';
  const succeeded = job !== null && job.status === 'succeeded' ? job : null;

  return (
    <section className="flex flex-col gap-md rounded-md border border-border bg-surface px-lg py-md animate-fade-in">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="font-serif text-heading text-ink">{REVERSE_TITLE}</span>
        {expanded ? <span className="text-note text-ink-soft">{REVERSE_COLLAPSE_COPY}</span> : null}
      </button>

      {expanded ? (
        <div className="flex flex-col gap-lg">
          <p className="text-note text-ink-soft">{REVERSE_DESCRIPTION}</p>

          <div className="flex flex-wrap gap-sm">
            {photos.map((photo) => (
              <button
                key={photo.id}
                type="button"
                aria-pressed={photo.id === selectedPhotoId}
                onClick={() => onSelectPhoto(photo.id)}
                className={
                  photo.id === selectedPhotoId
                    ? 'overflow-hidden rounded-sm border border-primary'
                    : 'overflow-hidden rounded-sm border border-border'
                }
              >
                <img src={photo.url} alt="" className="h-16 w-16 object-cover" />
              </button>
            ))}
          </div>

          <ErrorNotice error={notice} variant="inline" onRetry={onNoticeRetry} />

          {inProgress ? (
            <AsyncStatus label={REVERSE_RUNNING_COPY} timedOut={phase === 'timedOut'} onRefreshNow={onRefreshNow} />
          ) : null}

          {succeeded === null ? null : (
            <div className="flex flex-col gap-sm">
              {details.map((detail) => (
                <p key={detail.key} className="text-note text-ink">
                  {`${detail.label} ${detail.value}`}
                </p>
              ))}
              {succeeded.resultPrompt === null ? null : (
                <p className="text-note text-ink-soft">{succeeded.resultPrompt}</p>
              )}
              {succeeded.suggestEraCode === null ? null : (
                <p className="text-note text-ink">{`年代 ${succeeded.suggestEraCode}`}</p>
              )}
              {succeeded.suggestSceneId === null ? null : (
                <p className="text-note text-ink">{`场景 ${succeeded.suggestSceneId}`}</p>
              )}
              {canAdoptReverse(succeeded) ? (
                <div className="flex flex-col items-start gap-sm">
                  <button
                    type="button"
                    onClick={onAdopt}
                    className="rounded-pill bg-primary px-lg py-sm text-note text-background"
                  >
                    {REVERSE_ADOPT_COPY}
                  </button>
                  {adopted ? <p className="text-note text-ink-soft">{REVERSE_ADOPTED_COPY}</p> : null}
                </div>
              ) : (
                <p className="text-note text-ink-soft">{REVERSE_NO_ERA_COPY}</p>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
