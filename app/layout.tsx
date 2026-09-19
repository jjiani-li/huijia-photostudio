import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * 根布局（`docs/prd/pages/P00-设计基准与路由.md` §2、§4.2）：
 * `<html lang="zh-CN">` + 全局底色 / 正文字体（Token 见 `tailwind.config.ts`）+ `ErrorNotice` 的全局挂载位。
 * 页面骨架与登录软重定向在 `app/(pages)/layout.tsx`。
 */
export const metadata: Metadata = {
  title: '回家照相馆',
  description: '把旧照片里的面孔放进新的年代与场景，保留真实的样子',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-background text-ink font-sans text-body">
        {/* 全局提示挂载位：轮询状态与页面级错误消息的 polite 播报区（P00 §12）。 */}
        <div id="global-notice" aria-live="polite" />
        {children}
      </body>
    </html>
  );
}
