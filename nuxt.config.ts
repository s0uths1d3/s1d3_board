// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  ssr: false,
  devServer: { host: process.env.TAURI_DEV_HOST || 'localhost' },
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
      // Tauri requires a consistent port
      strictPort: false,
    }
  },
  nitro: {
    output: {
      publicDir: '../.output/public'
    }
  },
  plugins:[
      '~/plugins/init.ts'
  ]
})
