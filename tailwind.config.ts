import type { Config } from 'tailwindcss';

/**
 * 设计 Token 的唯一落点（`docs/prd/pages/P00-设计基准与路由.md` §3.2–§3.5、§4.1）。
 * **色值字面量只允许出现在本文件**——其余样式的色值一律走这里的语义键（`bg-surface` / `text-ink` 等）。
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './hooks/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // §3.2 九语义色。注意：正文/说明色用 `text-ink` / `text-ink-soft`，不要写 `text-primary`。
      colors: {
        background: '#FBF7F1',
        surface: '#F3EBDD',
        wood: '#D8C3A2',
        primary: { DEFAULT: '#A9704A', soft: '#E8D6C3' },
        ink: { DEFAULT: '#3B2F28', soft: '#7A6A5C' },
        border: '#E3D8C8',
        danger: '#B4553F',
      },
      // §4.1 字体栈：不下载 webfont，只回退系统已装字体。
      fontFamily: {
        serif: ['"Source Han Serif SC"', '"Noto Serif SC"', '"Songti SC"', '"STSong"', 'serif'],
        sans: [
          '"PingFang SC"',
          '"Source Han Sans SC"',
          '"Noto Sans SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
      },
      // §3.3 六档字号。
      fontSize: {
        display: ['32px', { lineHeight: '1.35', fontWeight: '500' }],
        title: ['24px', { lineHeight: '1.4', fontWeight: '500' }],
        heading: ['19px', { lineHeight: '1.5', fontWeight: '500' }],
        body: ['16px', { lineHeight: '1.7', fontWeight: '400' }],
        note: ['14px', { lineHeight: '1.6', fontWeight: '400' }],
        micro: ['12px', { lineHeight: '1.5', fontWeight: '400' }],
      },
      // §3.4 间距（px）/ 圆角 / 阴影 / 动效。
      spacing: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        '2xl': '32px',
        '3xl': '48px',
        '4xl': '64px',
      },
      maxWidth: { content: '720px' },
      borderRadius: { sm: '6px', md: '10px', lg: '16px', pill: '999px' },
      boxShadow: {
        soft: '0 1px 2px rgba(59,47,40,.06)',
        card: '0 2px 10px rgba(59,47,40,.08)',
      },
      keyframes: { fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } } },
      animation: { 'fade-in': 'fadeIn 180ms ease-out both' },
    },
  },
  plugins: [],
};

export default config;
