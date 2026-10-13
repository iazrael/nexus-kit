process.env.NODE_ENV = "test";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 测试管道里没有 vite-plugin-pwa，virtual 模块指到空桩
    alias: { "virtual:pwa-register": new URL("./src/test/virtual-pwa-register.ts", import.meta.url).pathname },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("test"),
    // 构建指纹在真实构建期注入，单测给确定值
    __APP_VERSION__: JSON.stringify("v0.0.0-test"),
    __APP_BUILD__: JSON.stringify(0),
    __BUILD_TIME__: JSON.stringify("1970-01-01T00:00:00.000Z"),
    __APP_NOTES_DIGEST__: JSON.stringify("testdigest"),
  },
  test: { env: { NODE_ENV: "test" }, include: ["src/**/*.test.{ts,tsx}"] },
});
