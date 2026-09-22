import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 前端测试基建：
 * - alias 与 Nuxt 4 对齐：`~` / `@` → app/（srcDir）
 * - happy-dom 环境：事件总线 / registry 等需要 window 的核心层测试
 * - setup 统一 mock @tauri-apps/plugin-sql（仓储层测试不依赖真实 Tauri 运行时）
 */
export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./app', import.meta.url)),
      '@': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['app/test/vitest.setup.ts'],
    include: ['app/**/*.spec.ts', 'app/**/*.test.ts'],
  },
});
