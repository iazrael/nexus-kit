import { describe, expect, it } from "vitest";
import { clampVolume, defaultVolumePrefs, parseVolumePrefs, serializeVolumePrefs } from "./prefs.ts";

const defaults = defaultVolumePrefs(["music", "sfx"], { master: 0.8, buses: { music: 0.5 } });

describe("音量偏好", () => {
  it("默认值：未给的总线为 1，未静音", () => {
    expect(defaults).toEqual({ master: 0.8, muted: false, buses: { music: 0.5, sfx: 1 } });
  });

  it("钳制到 0..1；不是有限数回退到给定默认值", () => {
    expect(clampVolume(1.5, 1)).toBe(1);
    expect(clampVolume(-1, 1)).toBe(0);
    expect(clampVolume(Number.NaN, 0.3)).toBe(0.3);
    expect(clampVolume("0.5", 0.3)).toBe(0.3);
  });

  it("解析外部数据：坏字段逐项回默认，未声明的总线丢掉，整体坏形回全默认", () => {
    expect(parseVolumePrefs({ master: 2, muted: "yes", buses: { music: 0.2, voice: 0.9, sfx: null } }, defaults)).toEqual({
      master: 1,
      muted: false,
      buses: { music: 0.2, sfx: 1 },
    });
    expect(parseVolumePrefs(null, defaults)).toEqual(defaults);
    expect(parseVolumePrefs("坏", defaults)).toEqual(defaults);
    expect(parseVolumePrefs({ buses: [] }, defaults)).toEqual(defaults);
  });

  it("序列化：全默认返回 undefined（不写）；有改动写完整对象，能原样解析回来", () => {
    expect(serializeVolumePrefs(defaults, defaults)).toBeUndefined();
    const changed = { ...defaults, muted: true, buses: { ...defaults.buses, sfx: 0.4 } };
    const out = serializeVolumePrefs(changed, defaults);
    expect(out).toEqual({ master: 0.8, muted: true, buses: { music: 0.5, sfx: 0.4 } });
    expect(parseVolumePrefs(JSON.parse(JSON.stringify(out)), defaults)).toEqual(changed);
  });
});
