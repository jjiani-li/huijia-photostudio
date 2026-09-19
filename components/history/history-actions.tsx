'use client';

import type { ReactNode } from 'react';
import type { HistoryItem } from '../../src/shared/types';

/**
 * 链路卡上的两级删除入口（`docs/prd/pages/P03-结果历史与下载.md` §8）：
 * 链路级 `删掉这次记录` → `DELETE /api/photos/:id`（`id` = `sourcePhoto.id`）；
 * 生成部分级 `只删生成的这几张` → `DELETE /api/anchors/:id`。
 * 两个入口都只负责**打开确认弹层**，真正的删除由宿主页在确认后发起（`pages/P03` §8）。
 */
export interface HistoryActionsProps {
  item: HistoryItem;
  onDeletePhoto: () => void;
  onDeleteAnchor: () => void;
}

export function HistoryActions({ item, onDeletePhoto, onDeleteAnchor }: HistoryActionsProps): ReactNode {
  return (
    <div className="flex items-center gap-lg">
      <button type="button" onClick={onDeletePhoto} className="text-note text-ink-soft hover:text-ink">
        删掉这次记录
      </button>
      {item.generations.length > 0 ? (
        <button type="button" onClick={onDeleteAnchor} className="text-note text-ink-soft hover:text-ink">
          只删生成的这几张
        </button>
      ) : null}
    </div>
  );
}
