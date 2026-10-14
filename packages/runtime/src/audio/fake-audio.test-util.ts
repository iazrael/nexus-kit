/** 单测用的假 AudioContext：只实现 kit 用到的面，状态与 resume 结果由测试操纵 */

export class FakeParam {
  value: number;
  /** 时间线上还没执行的渐变（真实 AudioParam 里它们会在之后覆盖直接赋的 value） */
  scheduled: number[] = [];
  constructor(v = 1) {
    this.value = v;
  }
  cancelScheduledValues(): void {
    this.scheduled = [];
  }
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
    this.scheduled.push(v);
  }
  setTargetAtTime(v: number): void {
    this.value = v;
  }
}

export class FakeNode {
  connections: unknown[] = [];
  connect(to: unknown): void {
    this.connections.push(to);
  }
  disconnect(): void {
    this.connections = [];
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

export class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  started = false;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  start(): void {
    this.started = true;
  }
  stop(at = 0): void {
    this.stoppedAt = at;
  }
  /** 测试推进：声源播完（或被系统掐死） */
  end(): void {
    this.onended?.();
  }
}

export interface FakeBuffer {
  length: number;
  numberOfChannels: number;
  duration: number;
  tag: string;
}

export type ResumeMode = "running" | "stays" | "reject";

export class FakeContext {
  static created: FakeContext[] = [];
  state: string = "suspended";
  currentTime = 0;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  closed = false;
  /** 下一次 resume 的结果：进 running / 落地仍不 running / 被拒 */
  resumeMode: ResumeMode = "running";
  resumeCalls = 0;
  /** 解码：返回 null 表示解码失败 */
  decoder: (data: ArrayBuffer) => FakeBuffer | null = (data) => ({
    length: data.byteLength * 100,
    numberOfChannels: 2,
    duration: 1,
    tag: new TextDecoder().decode(data),
  });
  private listeners = new Set<() => void>();
  constructor() {
    FakeContext.created.push(this);
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
    const b = this.decoder(data);
    return b === null ? Promise.reject(new Error("EncodingError")) : Promise.resolve(b);
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeMode === "reject") return Promise.reject(new Error("NotAllowedError"));
    if (this.resumeMode === "running") this.setState("running");
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.setState("suspended");
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.setState("closed");
    return Promise.resolve();
  }
  addEventListener(_t: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_t: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
  /** 测试推进：状态变化并触发 statechange */
  setState(s: string): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of [...this.listeners]) fn();
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}

export const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

export const asCtx = (c: FakeContext): AudioContext => c as unknown as AudioContext;
