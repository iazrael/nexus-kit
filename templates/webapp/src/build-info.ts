/**
 * 构建指纹：构建期由 @nexus-kit/vite 的 nexusPwa 经 define 注入，源码里没有可改的值。
 * - APP_VERSION：产品版本（package.json，人工进位，带 v 前缀）
 * - APP_BUILD：构建序号（.build-number，每次构建自动 +1）
 * - APP_NOTES_DIGEST：本版对外条目指纹（同版本重发时判「修复 / 内容有更新」）
 */
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: number;
declare const __BUILD_TIME__: string;
declare const __APP_NOTES_DIGEST__: string;

export const APP_VERSION: string = __APP_VERSION__;
export const APP_BUILD: number = __APP_BUILD__;
export const APP_BUILD_TIME: string = __BUILD_TIME__;
export const APP_NOTES_DIGEST: string = __APP_NOTES_DIGEST__;
