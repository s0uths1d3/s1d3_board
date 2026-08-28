/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./app/components/**/*.{js,ts,vue}",
    "./app/pages/**/*.vue",
    "./app/layouts/**/*.vue",
    "./app/app.vue",
  ],
  theme: {
    extend: {
      // 颜色令牌全部指向 CSS 变量（RGB 通道组，见 main.css :root / [data-scheme]），
      // 配色切换即切换变量组；<alpha-value> 使 bg-gold/15 等透明度修饰符继续可用
      colors: {
        primary: "rgb(var(--c-primary) / <alpha-value>)",
        secondary: "rgb(var(--c-secondary) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        "surface-field": "rgb(var(--c-surface-field) / <alpha-value>)",
        line: "rgb(var(--c-line) / <alpha-value>)",
        gold: {
          DEFAULT: "rgb(var(--c-gold) / <alpha-value>)",
          soft: "rgb(var(--c-gold-soft) / <alpha-value>)",
        },
        // 金色面上的文字色：深色配色下金色变亮，需改用深色字保证对比度
        "on-gold": "rgb(var(--c-on-gold) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--c-ink) / <alpha-value>)",
          soft: "rgb(var(--c-ink-soft) / <alpha-value>)",
          faint: "rgb(var(--c-ink-faint) / <alpha-value>)",
        },
        // 语义色：危险（删除类按钮）/ 成功（低优先级等），随配色自适应明暗
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        success: "rgb(var(--c-success) / <alpha-value>)",
        code: "rgb(var(--c-code) / <alpha-value>)",
      },
      boxShadow: {
        soft: "0 4px 16px rgb(var(--c-shadow) / 0.14)",
        float: "0 14px 36px rgb(var(--c-shadow) / 0.16)",
      },
      transitionTimingFunction: {
        soft: "cubic-bezier(0.4,0,0.2,1)",
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
      keyframes: {
        curtainIn: {
          "0%": { clipPath: "inset(0 0 100% 0)", opacity: "0" },
          "100%": { clipPath: "inset(0 0 0% 0)", opacity: "1" },
        },
        curtainOut: {
          "0%": { clipPath: "inset(0 0 0% 0)", opacity: "1" },
          "100%": { clipPath: "inset(100% 0 0 0)", opacity: "0" },
        },
      },
      animation: {
        "curtain-in": "curtainIn 0.5s cubic-bezier(0.4,0,0.2,1) both",
        "curtain-out": "curtainOut 0.5s cubic-bezier(0.4,0,0.2,1) both",
      },
    },
  },
  plugins: [],
};
