/**
 * 音量偏好的纯函数：主音量、各总线音量（0..1）与静音。存在哪里由宿主决定（存档、localStorage），
 * 这里只管解析、钳制与「全默认不写」的序列化。取材 旧项目A load/audio.ts 与旧项目B soundEngine.ts。
 */
export interface VolumePrefs {
    master: number;
    muted: boolean;
    buses: Record<string, number>;
}
/** 钳到 0..1；不是有限数回退到 fallback */
export declare function clampVolume(v: unknown, fallback: number): number;
/** 默认偏好：未给的总线为 1，主音量默认 1，未静音 */
export declare function defaultVolumePrefs(buses: readonly string[], over?: {
    master?: number;
    muted?: boolean;
    buses?: Record<string, number>;
}): VolumePrefs;
/** 外部数据 → 偏好：坏字段逐项回默认，defaults 里没有的总线丢掉 */
export declare function parseVolumePrefs(raw: unknown, defaults: VolumePrefs): VolumePrefs;
/** 偏好 → 待存对象：与默认全部相同返回 undefined（不写），否则写完整对象 */
export declare function serializeVolumePrefs(p: VolumePrefs, defaults: VolumePrefs): VolumePrefs | undefined;
