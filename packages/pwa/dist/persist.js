export async function requestPersistentStorage(logger) {
    if (typeof navigator === "undefined" || navigator.storage?.persist === undefined)
        return "unsupported";
    try {
        const granted = await navigator.storage.persist();
        const est = await navigator.storage.estimate();
        const quota = { usageMB: Math.round((est.usage ?? 0) / 1048576), quotaMB: Math.round((est.quota ?? 0) / 1048576) };
        if (granted)
            logger?.info("持久化存储已授予", quota);
        else
            logger?.warn("持久化存储被浏览器拒绝（不阻塞使用，缓存可能被系统清理）", quota);
        return granted ? "granted" : "denied";
    }
    catch (error) {
        logger?.warn("持久化存储请求失败（不阻塞使用）", { error: String(error).slice(0, 200) });
        return "failed";
    }
}
