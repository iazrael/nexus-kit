/**
 * 水位长线（纯逻辑）：每隔一段时间（默认 5 秒）采一个点，环形缓冲留最近 cap 个点（默认 2048 ≈ 2.8 小时）。
 * 泄漏要看走势，截面看不出来——跑十几分钟才发作的问题，最后一分钟的截面只告诉你「现在多少」，不告诉你「涨没涨」。
 * trendOf 给每项指标的首末值、净增与峰值：峰值单列，是因为换页时新旧资源叠加的高峰只出现在中间，只看首末净增会
 * 整个漏掉。读数为 null 的点（浏览器不提供这项，如 Safari 的 JS 堆）跳过，不当作 0。
 */
export interface VitalSample {
    /** 墙钟时刻（epoch ms） */
    t: number;
    /** 指标名 → 读数；null = 读不到 */
    v: Record<string, number | null>;
}
export interface MetricTrend {
    first: number | null;
    last: number | null;
    delta: number | null;
    peak: number | null;
    /** 峰值所在点的时刻（相对首点的秒数） */
    peakAt: number | null;
}
export interface Trend {
    samples: number;
    /** 首点到末点的秒数 */
    spanSec: number;
    metrics: Record<string, MetricTrend>;
}
export declare class VitalRing {
    private readonly items;
    private readonly cap;
    private head;
    private size;
    constructor(cap: number);
    push(sample: VitalSample): void;
    series(): VitalSample[];
    clear(): void;
}
export declare function trendOf(series: readonly VitalSample[]): Trend;
