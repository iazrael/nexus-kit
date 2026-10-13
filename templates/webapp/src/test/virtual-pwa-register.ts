/** 单测桩：vitest 管道没有 vite-plugin-pwa，virtual:pwa-register 指到这里 */
export function registerSW(): () => Promise<void> {
  return async () => {};
}
