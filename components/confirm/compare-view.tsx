import type { ReactNode } from 'react';
import type { Photo } from '../../src/shared/types';
import { COMPARE_LABELS, PHOTO_PENDING_COPY } from './confirm-logic';

/**
 * 原图 / 预处理图对比区（`docs/prd/pages/P01-上传与身份确认.md` §4.3）：
 * 左侧 `sourcePhotos[0]`、右侧 `preprocessedPhoto`；**只用响应里的 `url`**，不构造图片路径
 * （`docs/prd/spec/03-接口契约.md` §6 第 3 条）。
 *
 * 措辞硬约束（`docs/prd/spec/06-合规与风控.md` §9.1）：两侧标签只说明「哪张」，**不得**出现任何
 * 暗示「变清楚了 / 被修过 / 更清晰」的标签或说明。
 */
export interface CompareViewProps {
  /** `sourcePhotos[0]`；未回为 `null`。 */
  before: Photo | null;
  /** `preprocessedPhoto`；未回为 `null` 时右侧写占位。 */
  after: Photo | null;
}

function PhotoFrame({ photo, label }: { photo: Photo | null; label: string }): ReactNode {
  return (
    <figure className="flex flex-col gap-sm">
      <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg bg-surface">
        {photo === null ? (
          <span className="text-note text-ink-soft">{PHOTO_PENDING_COPY}</span>
        ) : (
          <img src={photo.url} alt={label} className="h-full w-full object-cover" />
        )}
      </div>
      <figcaption className="text-note text-ink-soft">{label}</figcaption>
    </figure>
  );
}

export function CompareView({ before, after }: CompareViewProps): ReactNode {
  return (
    <section className="grid gap-lg md:grid-cols-2">
      <PhotoFrame photo={before} label={COMPARE_LABELS.before} />
      <PhotoFrame photo={after} label={COMPARE_LABELS.after} />
    </section>
  );
}
