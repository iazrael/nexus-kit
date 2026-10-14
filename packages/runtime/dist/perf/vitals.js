/**
 * 水位长线（纯逻辑）：每隔一段时间（默认 5 秒）采一个点，环形缓冲留最近 cap 个点（默认 2048 ≈ 2.8 小时）。
 * 泄漏要看走势，截面看不出来——跑十几分钟才发作的问题，最后一分钟的截面只告诉你「现在多少」，不告诉你「涨没涨」。
 * trendOf 给每项指标的首末值、净增与峰值：峰值单列，是因为换页时新旧资源叠加的高峰只出现在中间，只看首末净增会
 * 整个漏掉。读数为 null 的点（浏览器不提供这项，如 Safari 的 JS 堆）跳过，不当作 0。
 */
export class VitalRing {
    items;
    cap;
    head = 0;
    size = 0;
    constructor(cap) {
        this.cap = cap;
        this.items = new Array(cap);
    }
    push(sample) {
        this.items[(this.head + this.size) % this.cap] = sample;
        if (this.size < this.cap)
            this.size++;
        else
            this.head = (this.head + 1) % this.cap;
    }
    series() {
        return Array.from({ length: this.size }, (_, i) => this.items[(this.head + i) % this.cap]);
    }
    clear() {
        this.items.fill(undefined);
        this.head = 0;
        this.size = 0;
    }
}
const round1 = (n) => Math.round(n * 10) / 10;
export function trendOf(series) {
    if (series.length === 0)
        return { samples: 0, spanSec: 0, metrics: {} };
    const t0 = series[0].t;
    const names = new Set(series.flatMap((s) => Object.keys(s.v)));
    const metrics = {};
    for (const name of names) {
        let first = null;
        let last = null;
        let peak = null;
        let peakAt = null;
        for (const s of series) {
            const x = s.v[name];
            if (x === null || x === undefined)
                continue;
            if (first === null)
                first = x;
            last = x;
            if (peak === null || x > peak) {
                peak = x;
                peakAt = Math.round((s.t - t0) / 1000);
            }
        }
        metrics[name] = { first, last, delta: first === null || last === null ? null : round1(last - first), peak, peakAt };
    }
    return { samples: series.length, spanSec: Math.round((series[series.length - 1].t - t0) / 1000), metrics };
}
