import type { ReactNode } from 'react';
import { FOOTER_NOTE_COPY } from './uploads';

/**
 * 情感安全提示的常驻一行小字（`docs/prd/pages/P01-上传与身份确认.md` §4.1、§4.2、
 * `spec/06-合规与风控.md` §9.2）：语义固定为「我们会尽力还原照片的样子，但这是基于照片的重建，
 * 无法替代真实。」措辞可调、语义不可改。
 *
 * 本行**常驻**，不新增「已读」状态、不写任何存储（`pages/P00-设计基准与路由.md` §6）。
 */
export function FooterNote(): ReactNode {
  return <p className="text-note text-ink-soft">{FOOTER_NOTE_COPY}</p>;
}
