/**
 * 两个与调度器配合的小工具，取材自旧项目A的并发与空闲调度实现。
 */
/**
 * 限并发批量执行，结果严格按输入顺序返回（后项覆盖前项的场景，顺序乱了结果就变了）。
 * 任一项抛错即整体拒绝，之后不再取新项（与串行 for await 同语义；失败那一刻已在跑的项会跑完）。串行在高延迟链路上等于「请求数 × 单次延迟」：
 * 旧项目A真机经隧道每请求约 1 秒，34 页串行吃掉 34.7 秒。
 */
export async function mapLimit(items, limit, fn) {
    if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError(`并发数须为正整数：${String(limit)}`);
    const total = items.length;
    const out = new Array(total);
    let next = 0;
    let failed = false;
    const width = Math.max(1, Math.min(limit, total));
    const workers = Array.from({ length: total === 0 ? 0 : width }, async () => {
        for (;;) {
            if (failed)
                return;
            const i = next++;
            if (i >= total)
                return;
            try {
                out[i] = await fn(items[i], i);
            }
            catch (error) {
                failed = true;
                throw error;
            }
        }
    });
    await Promise.all(workers);
    return out;
}
/**
 * 「首屏跑完再干」：空闲时执行 fn，返回取消函数。requestIdleCallback 在 iOS 16.4 以前没有，退到 fallbackMs 后的
 * 定时器；有它时带 timeoutMs 封顶，长时间不空闲（持续动画、战斗）也不会永远不执行。
 */
export function whenIdle(fn, opts = {}) {
    const g = globalThis;
    if (typeof g.requestIdleCallback === "function") {
        const id = g.requestIdleCallback(fn, { timeout: opts.timeoutMs ?? 3000 });
        return () => g.cancelIdleCallback?.(id);
    }
    const id = setTimeout(fn, opts.fallbackMs ?? 1500);
    return () => clearTimeout(id);
}
