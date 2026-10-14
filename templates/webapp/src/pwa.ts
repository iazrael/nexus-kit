/**
 * PWA 控制器单例：整个应用只创建这一个。SW 注册推到空闲期（首访时预缓存与首屏抢带宽）。
 * 弹窗由 UpdateDialog 订阅快照驱动；需要专注、不被打断的流程里调 pwa.setPromptBlocked(true)。
 */
import { createPwaController } from "@nexus-kit/pwa";
import { registerSW } from "virtual:pwa-register";
import { APP_ID } from "../pwa.config.ts";
import { APP_BUILD, APP_NOTES_DIGEST, APP_VERSION } from "./build-info.ts";
import { logs } from "./observe.ts";

export const pwa = createPwaController({
  local: { version: APP_VERSION, build: APP_BUILD, notesDigest: APP_NOTES_DIGEST },
  registerSW,
  storagePrefix: APP_ID,
  logger: logs.log("pwa"),
});
