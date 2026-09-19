'use client';

import type { ReactNode } from 'react';
import type { PhotoList } from '../../src/shared/types';

/**
 * 「没走完的照片」区块（`docs/prd/pages/P03-结果历史与下载.md` §7，**本页硬要求**）：
 * 链路只呈现每个锚点第一个未软删的输入原图，上传后停在半路的、以及同一次上传里非基准的那几张原图
 * 会从链路里消失。本区块取链路呈现集的**补集**（`spec/03-接口契约.md` §3.2），
 * 用同一套 `ConfirmDialog` 与同一个 `DELETE /api/photos/:id`，使任何未软删的照片都可见、可彻底删除。
 *
 * 游标**独立**于链路分页（混用 → `400 INVALID_PARAM`，`spec/03-接口契约.md` §3.2）；
 * 空列表时整个区块不渲染。
 */
export interface IncompletePhotosProps {
  list: PhotoList;
  onDelete: (photoId: number) => void;
  onLoadMore: () => void;
}

/** `kind` → 行内文案（`pages/P03` §7）。 */
const KIND_LABEL: Record<'original' | 'preprocessed' | 'generated', string> = {
  original: '原照片',
  preprocessed: '我们读取用的那张',
  generated: '生成的照片',
};

export function IncompletePhotos({ list, onDelete, onLoadMore }: IncompletePhotosProps): ReactNode {
  if (list.items.length === 0) return null;

  return (
    <section className="flex flex-col gap-md">
      <h2 className="font-serif text-heading text-ink">没走完的照片</h2>
      <p className="text-note text-ink-soft">这些照片还在，随时可以删掉。</p>
      {list.items.map((photo) => (
        <div key={photo.id} className="flex items-center gap-md">
          <img src={photo.url} alt={KIND_LABEL[photo.kind]} className="w-16 rounded-lg" />
          <div className="flex flex-col">
            <p className="text-note text-ink">{KIND_LABEL[photo.kind]}</p>
            <p className="text-micro text-ink-soft">{photo.createdAt}</p>
          </div>
          <button type="button" onClick={() => onDelete(photo.id)} className="text-note text-ink-soft hover:text-ink">
            删掉这张
          </button>
        </div>
      ))}
      {list.nextCursor !== null ? (
        <div>
          <button type="button" onClick={onLoadMore} className="text-note text-primary underline">
            再往下看
          </button>
        </div>
      ) : null}
    </section>
  );
}
