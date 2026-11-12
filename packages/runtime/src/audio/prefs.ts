/**
 * 音量偏好的纯函数：主音量、各总线音量（0..1）与静音。存在哪里由宿主决定（存档、localStorage），
 * 这里只管解析、钳制与「全默认不写」的序列化。取材自旧项目A与旧项目B的音频实现。
 */

export interface VolumePrefs {
  master: number;
  muted: boolean;
  buses: Record<string, number>;
}

/** 钳到 0..1；不是有限数回退到 fallback */
export function clampVolume(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** 默认偏好：未给的总线为 1，主音量默认 1，未静音 */
export function defaultVolumePrefs(
  buses: readonly string[],
  over: { master?: number; muted?: boolean; buses?: Record<string, number> } = {},
): VolumePrefs {
  const out: Record<string, number> = {};
  for (const b of buses) out[b] = clampVolume(over.buses?.[b], 1);
  return { master: clampVolume(over.master, 1), muted: over.muted ?? false, buses: out };
}

/** 外部数据 → 偏好：坏字段逐项回默认，defaults 里没有的总线丢掉 */
export function parseVolumePrefs(raw: unknown, defaults: VolumePrefs): VolumePrefs {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawBuses = typeof o.buses === "object" && o.buses !== null && !Array.isArray(o.buses) ? (o.buses as Record<string, unknown>) : {};
  const buses: Record<string, number> = {};
  for (const [name, d] of Object.entries(defaults.buses)) buses[name] = clampVolume(rawBuses[name], d);
  return {
    master: clampVolume(o.master, defaults.master),
    muted: typeof o.muted === "boolean" ? o.muted : defaults.muted,
    buses,
  };
}

/** 偏好 → 待存对象：与默认全部相同返回 undefined（不写），否则写完整对象 */
export function serializeVolumePrefs(p: VolumePrefs, defaults: VolumePrefs): VolumePrefs | undefined {
  const same =
    p.master === defaults.master &&
    p.muted === defaults.muted &&
    Object.entries(defaults.buses).every(([name, d]) => (p.buses[name] ?? d) === d);
  if (same) return undefined;
  const buses: Record<string, number> = {};
  for (const [name, d] of Object.entries(defaults.buses)) buses[name] = p.buses[name] ?? d;
  return { master: p.master, muted: p.muted, buses };
}
