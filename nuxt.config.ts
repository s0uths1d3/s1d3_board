// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite';

export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  ssr: false,
  // 遥测同意提示依赖 TTY：IDEA / CI 等无终端环境下 consola 建流抛 ERR_TTY_INIT_FAILED，
  // 会连带 beforeDevCommand 失败、整个 `tauri dev` 起不来；此处直接关闭遥测
  telemetry: false,
  // 开发端口 12321 由 dev script 显式指定（nuxt dev --port 12321，见 package.json），
  // Nuxt 4 新 CLI 的端口由命令行层管理；此处与 tauri.conf.json 的 devUrl 必须一致。
  // Tailwind v4：CSS-first 配置（@theme 见 app/assets/css/main.css），经 Vite 插件接入
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
    // Better support for Tauri CLI output
    clearScreen: false,
    // Enable environment variables
    // Additional environment variables can be found at
    // https://v2.tauri.org.cn/reference/environment-variables/
    envPrefix: ['VITE_', 'TAURI_'],
    server: {
      strictPort: true,
    }
  }
})
