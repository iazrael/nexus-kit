/**
 * 引擎宿主（机制见 docs/架构算法/音频.md）：只管 AudioContext 的生命周期，合成类宿主（振荡器）与样本播放器共用。
 *
 * - 惰性创建；unlock() 由宿主在用户手势里调（幂等），老 Safari 退 webkitAudioContext。
 * - 回前台：同时听 visibilitychange 与 statechange（iOS 上前者会漏）；不在 running 一律 resume——iOS 切后台/锁屏的
 *   interrupted 是标准外的第四种状态，只判 suspended 永远唤不醒。回到 running 通知 onRunning，供播放器校对被系统
 *   掐死的声源（通知可能重复，订阅方的校对必须幂等）。
 * - resume 落地仍不 running 或被拒：关旧 context 换新的（上限 maxRebuilds，超过放弃并记 warn），广播 onRebuild。
 * - 总线：master + 宿主声明的分轨，增益 = 偏好音量 × 下潜系数；下潜按来源登记，多源取最深，全撤才回升。
 * - whenRunning(fn)：发声前置门，引擎挂着时先 resume、落地 running 才执行，不把音符排在冻结的时间轴上。
 * - resetSession()：iOS 停麦后输出被压到极轻而 state 仍是 running，挂起 120ms 再恢复逼系统重建会话。
 *
 * 取材 旧项目A load/audio.ts 与旧项目B soundEngine.ts / bgmEngine.ts。
 */
import type { Logger } from "../log/store.ts";
import { type VolumePrefs } from "./prefs.ts";
export interface AudioHostOptions {
    /** 分轨总线名，如 ["music", "sfx", "voice"] */
    buses: readonly string[];
    /** 初始音量偏好；默认全 1、未静音 */
    prefs?: VolumePrefs;
    /** 假死重建上限（整个会话不复位），默认 3 */
    maxRebuilds?: number;
    /** 切后台时淡出并挂起 context（省电），回前台恢复；默认 false */
    suspendWhenHidden?: boolean;
    /** 建 context；返回 null 表示环境不支持。默认 AudioContext / webkitAudioContext */
    createContext?: () => AudioContext | null;
    log?: Logger;
}
export declare function createAudioHost(options: AudioHostOptions): {
    readonly context: AudioContext | null;
    readonly master: GainNode | null;
    /** 分轨总线节点；没解锁或未声明的总线返回 null */
    bus(name: string): GainNode | null;
    /** 在用户手势里调（幂等）：首次创建引擎；已有引擎但不在 running 就 resume，落地仍不行就重建 */
    unlock(): void;
    readonly prefs: VolumePrefs;
    setPrefs(next: VolumePrefs): void;
    /** 下潜：level 为 0..1 的系数，null 撤销该来源 */
    duck(bus: string, source: string, level: number | null): void;
    /**
     * 发声前置门：running 立即执行；挂起时先 resume，落地 running 且引擎没换才执行。返回是否执行了。
     * fn 抛错（节点所在的引擎刚被关）不外泄：记 warn 返回 false，调用方 void 掉返回值也不会出未处理的拒绝
     */
    whenRunning(fn: (ctx: AudioContext) => void): Promise<boolean>;
    onRunning(fn: () => void): () => void;
    onRebuild(fn: (ctx: AudioContext) => void): () => void;
    /** iOS 停麦后输出被压低：挂起 120ms 再恢复，逼系统以播放类别重建会话 */
    resetSession(): void;
    snapshot(): {
        state: string | null;
        unlocked: boolean;
        rebuilds: number;
    };
    dispose(): void;
};
export type AudioHost = ReturnType<typeof createAudioHost>;
