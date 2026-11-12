/**
 * 两个与调度器配合的小工具，取材自旧项目A的并发与空闲调度实现。
 */
/**
 * 限并发批量执行，结果严格按输入顺序返回（后项覆盖前项的场景，顺序乱了结果就变了）。
 * 任一项抛错即整体拒绝，之后不再取新项（与串行 for await 同语义；失败那一刻已在跑的项会跑完）。串行在高延迟链路上等于「请求数 × 单次延迟」：
 * 旧项目A真机经隧道每请求约 1 秒，34 页串行吃掉 34.7 秒。
 */
export declare function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
/**
 * 「首屏跑完再干」：空闲时执行 fn，返回取消函数。requestIdleCallback 在 iOS 16.4 以前没有，退到 fallbackMs 后的
 * 定时器；有它时带 timeoutMs 封顶，长时间不空闲（持续动画、战斗）也不会永远不执行。
 */
export declare function whenIdle(fn: () => void, opts?: {
    timeoutMs?: number;
    fallbackMs?: number;
}): () => void;
