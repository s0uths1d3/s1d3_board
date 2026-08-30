// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  ssr: false,
  // 开发端口 12321 由 dev script 显式指定（nuxt dev --port 12321，见 package.json），
  // Nuxt 4 新 CLI 的端口由命令行层管理；此处与 tauri.conf.json 的 devUrl 必须一致。
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  vite: {
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
