/**
 * 构建产物「构建号自洽」校验（verify-pwa-build 与 deploy 共用）。
 *
 * 构建时同一个 build 号既经 vite define 注入 bundle（__APP_BUILD__ → 无引号数字
 * 字面量），又由 versionManifestPlugin 写进 dist/version.json——两处同一次构建
 * 写出，产物内互证即可确认 dist 完整、口径一致。**不读此刻共享的 .build-number**：
 * 计数器是全工作树软链共享的，并行线会在「构建完 → 校验/部署」的空当把它推走，
 * 拿它比产物必然误报（并行线越多越频繁），而它对「改完代码忘了重新构建」本来
 * 就没有证明力（不构建计数器不动，等值照样放行）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** 读构建产物目录（dist/assets）下全部 JS 文本；目录不存在返回空表（让断言报「找不到」而非 ENOENT） */
export function readBundleCodes(assetsDir) {
    if (!existsSync(assetsDir))
        return [];
    return readdirSync(assetsDir)
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFileSync(join(assetsDir, name), "utf8"));
}
/**
 * 断言 bundle 代码里存在注入的构建号字面量（词边界匹配，10650/6500/0x650 不算
 * 命中 650）。找不到 = dist 半新半旧或 vite define 与 version.json 口径跑偏。
 */
export function assertInjectedBuild(bundleCodes, build) {
    // 0 不收：`\b0\b` 在任何 bundle 里都能误命中，断言形同虚设；真实构建号由计数器递增，恒 ≥1
    if (!Number.isInteger(build) || build < 1) {
        throw new Error(`[dist-fingerprint] version.json 的 build 非法（应为正整数）：${String(build)}`);
    }
    const pattern = new RegExp(`\\b${build}\\b`);
    if (!bundleCodes.some((code) => pattern.test(code))) {
        throw new Error(`[dist-fingerprint] 构建产物 JS 里找不到注入的构建号 ${build}（__APP_BUILD__ define 字面量）` +
            "——dist 半新半旧或 vite define 与 version.json 口径跑偏，重新构建");
    }
}
