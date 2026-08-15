/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./components/**/*.{js,ts,vue}",
    "./pages/**/*.vue",
    "./layouts/**/*.vue",
    "./app.vue",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#f0e9e1",
        secondary: "#e8e0d5",
        accent: "#d4c9b8",
        // 非选中卡片面：比米白背景深一档的暖褐实色，提升与背景的区分度
        surface: "#ece1d0",
        // 卡片内层（输入框/编辑区）：比卡片面略亮的暖面，形成层次
        "surface-field": "#f6efe3",
        // 描边：accent 再深一档的暖褐，提供清晰轮廓
        line: "#cbbfa9",
        gold: {
          DEFAULT: "#c4a77d",
          soft: "#d9c3a3",
        },
        ink: {
          DEFAULT: "#4a4438",
          soft: "#6b6354",
          faint: "#9a9080",
        },
        code: "#2d2d2d",
      },
      boxShadow: {
        soft: "0 4px 16px rgba(74,64,52,0.14)",
        float: "0 14px 36px rgba(74,64,52,0.16)",
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
