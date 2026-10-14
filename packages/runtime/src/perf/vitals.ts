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

export class VitalRing {
  private readonly items: Array<VitalSample | undefined>;
  private readonly cap: number;
  private head = 0;
  private size = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.items = new Array<VitalSample | undefined>(cap);
  }

  push(sample: VitalSample): void {
    this.items[(this.head + this.size) % this.cap] = sample;
    if (this.size < this.cap) this.size++;
    else this.head = (this.head + 1) % this.cap;
  }

  series(): VitalSample[] {
    return Array.from({ length: this.size }, (_, i) => this.items[(this.head + i) % this.cap]!);
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.size = 0;
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function trendOf(series: readonly VitalSample[]): Trend {
  if (series.length === 0) return { samples: 0, spanSec: 0, metrics: {} };
  const t0 = series[0]!.t;
  const names = new Set(series.flatMap((s) => Object.keys(s.v)));
  const metrics: Record<string, MetricTrend> = {};
  for (const name of names) {
    let first: number | null = null;
    let last: number | null = null;
    let peak: number | null = null;
    let peakAt: number | null = null;
    for (const s of series) {
      const x = s.v[name];
      if (x === null || x === undefined) continue;
      if (first === null) first = x;
      last = x;
      if (peak === null || x > peak) {
        peak = x;
        peakAt = Math.round((s.t - t0) / 1000);
      }
    }
    metrics[name] = { first, last, delta: first === null || last === null ? null : round1(last - first), peak, peakAt };
  }
  return { samples: series.length, spanSec: Math.round((series[series.length - 1]!.t - t0) / 1000), metrics };
}
