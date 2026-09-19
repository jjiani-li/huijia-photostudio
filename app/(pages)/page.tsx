import type { ReactNode } from 'react';
import { UploadEntry } from '../../components/upload/upload-entry';

/**
 * `/` 首页（`docs/prd/pages/P01-上传与身份确认.md` §4.1、`pages/P00-设计基准与路由.md` §5.1）：
 * 标题 + 一句话说明 + 上传入口 + 页脚小字，**仅静态渲染**——公开页、不发任何请求
 * （登录态在点按钮时才探测，见 `components/upload/upload-entry.tsx`）。
 *
 * 页脚两行是常驻的情感安全同义小字（`spec/06-合规与风控.md` §9.2 的语义）：
 * 本页不参与「每会话一次」的展示计数，也不写任何存储（`pages/P04-失败与情绪安全路径.md` §4）。
 */
export default function HomePage(): ReactNode {
  return (
    <section className="flex flex-col items-start gap-2xl animate-fade-in">
      <header className="flex flex-col gap-sm">
        <h1 className="font-serif text-display text-ink">回家照相馆</h1>
        <p className="text-note text-ink-soft">上传一张老照片，让他出现在一张从没拍过的新照片里。</p>
      </header>

      <UploadEntry />

      <footer className="flex flex-col gap-xs text-note text-ink-soft">
        <p>生成的是新照片，不是把旧照片修清楚。</p>
        <p>AI 生成，仅供家人留存。</p>
      </footer>
    </section>
  );
}
