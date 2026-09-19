'use client';

import type { ReactNode } from 'react';
import type { HistoryItem } from '../../src/shared/types';
import { generationStatusNotice } from '../../src/shared/result';
import { EraCheckBadge } from '../result/era-check-badge';
import { HistoryActions } from './history-actions';

/**
 * 一条历史链路（`docs/prd/pages/P03-结果历史与下载.md` §7）：
 * 三段顺序连接 `sourcePhoto → preprocessedPhoto + anchorText → generations[].results[]`；
 * 链路标签 `原照片` → `人物特征` → `生成的照片`。
 *
 * 每条 generation 标注 `eraName` × `sceneName`、`status`（`partial` / `failed` 文案同 §6）与
 * 年代徽标（同 §6 口径，**只标注不阻断**），并给 `用同样设定再生成`。
 */
export interface HistoryChainProps {
  item: HistoryItem;
  onRegenerate: (generationId: number) => void;
  onDeletePhoto: () => void;
  onDeleteAnchor: () => void;
}

export function HistoryChain({ item, onRegenerate, onDeletePhoto, onDeleteAnchor }: HistoryChainProps): ReactNode {
  return (
    <article className="flex flex-col gap-lg rounded-md bg-surface p-lg shadow-soft animate-fade-in">
      <section className="flex flex-col gap-sm">
        <p className="text-micro text-ink-soft">原照片</p>
        <img src={item.sourcePhoto.url} alt="原照片" className="w-32 rounded-lg" />
      </section>

      <section className="flex flex-col gap-sm">
        <p className="text-micro text-ink-soft">人物特征</p>
        {item.preprocessedPhoto !== null ? (
          <img src={item.preprocessedPhoto.url} alt="我们读取用的那张" className="w-24 rounded-lg" />
        ) : null}
        <p className="text-note text-ink">{item.anchorText}</p>
      </section>

      <section className="flex flex-col gap-md">
        <p className="text-micro text-ink-soft">生成的照片</p>
        {item.generations.map((generation) => {
          const statusCopy = generationStatusNotice(generation.status);
          return (
            <div key={generation.id} className="flex flex-col gap-sm border-t border-border pt-md">
              <p className="text-note text-ink">
                {generation.eraName} · {generation.sceneName}
              </p>
              {statusCopy !== null ? <p className="text-note text-ink-soft">{statusCopy}</p> : null}
              <div className="flex flex-wrap gap-md">
                {generation.results.map((result) => (
                  <div key={result.id} className="flex flex-col gap-xs">
                    <img src={result.url} alt={`第 ${result.id} 张`} className="w-24 rounded-lg" />
                    <EraCheckBadge eraCheck={result.eraCheck} />
                  </div>
                ))}
              </div>
              <div>
                <button type="button" onClick={() => onRegenerate(generation.id)} className="text-note text-primary underline">
                  用同样设定再生成
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <HistoryActions item={item} onDeletePhoto={onDeletePhoto} onDeleteAnchor={onDeleteAnchor} />
    </article>
  );
}
