// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  ssr: false,
  // Tauri devUrl 固定指向 http://localhost:54900（见 tauri.conf.json），
  // 端口必须一致且不可漂移，因此 strictPort 开启、端口统一由 TAURI_DEV_PORT 提供。
  devServer: {
    host: process.env.TAURI_DEV_HOST || 'localhost',
    port: Number(process.env.TAURI_DEV_PORT) || 54900,
  },
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
