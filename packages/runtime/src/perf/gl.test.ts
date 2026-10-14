import { describe, expect, it } from "vitest";
import { installGlCounter, type GlLike } from "./gl.ts";

const TEXTURE_2D = 0x0de1;
const TEXTURE_CUBE_MAP = 0x8513;
const CUBE_POSITIVE_X = 0x8515;
const TEXTURE0 = 0x84c0;

function fakeGl(): GlLike & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    createTexture: () => (calls.push("createTexture"), { id: ++n }) as unknown as WebGLTexture,
    deleteTexture: () => void calls.push("deleteTexture"),
    bindTexture: () => void calls.push("bindTexture"),
    activeTexture: () => void calls.push("activeTexture"),
    texImage2D: () => void calls.push("texImage2D"),
    texStorage2D: () => void calls.push("texStorage2D"),
    createBuffer: () => ({ b: ++n }) as unknown as WebGLBuffer,
    deleteBuffer: () => undefined,
    createFramebuffer: () => ({ f: ++n }) as unknown as WebGLFramebuffer,
    deleteFramebuffer: () => undefined,
  };
}

describe("installGlCounter", () => {
  it("绑定按纹理单元分别记：切单元后上传记到该单元绑定的纹理上", () => {
    const gl = fakeGl();
    const c = installGlCounter(gl);
    const a = gl.createTexture()!;
    const b = gl.createTexture()!;
    gl.activeTexture(TEXTURE0);
    gl.bindTexture(TEXTURE_2D, a);
    gl.activeTexture(TEXTURE0 + 1);
    gl.bindTexture(TEXTURE_2D, b);
    gl.activeTexture(TEXTURE0);
    gl.texImage2D(TEXTURE_2D, 0, 0, 512, 512, 0, 0, 0, null); // 1MB 记到 a
    gl.deleteTexture(b);
    expect(c.counts().texMB).toBe(1);
    gl.deleteTexture(a);
    expect(c.counts().texMB).toBe(0);
  });

  it("图像源尺寸取自然尺寸：img 用 naturalWidth（不是 CSS 缩放后的 width），VideoFrame 用 displayWidth", () => {
    const gl = fakeGl();
    const c = installGlCounter(gl);
    gl.bindTexture(TEXTURE_2D, gl.createTexture());
    gl.texImage2D(TEXTURE_2D, 0, 0, 0, 0, { width: 10, height: 10, naturalWidth: 1024, naturalHeight: 1024 });
    expect(c.counts().texMB).toBe(4);
    gl.texImage2D(TEXTURE_2D, 0, 0, 0, 0, { displayWidth: 512, displayHeight: 512 });
    expect(c.counts().texMB).toBe(1);
  });

  it("纹理、缓冲、帧缓冲按创建减删除记净存活；原方法照常被调用", () => {
    const gl = fakeGl();
    const c = installGlCounter(gl);
    const t1 = gl.createTexture()!;
    gl.createTexture();
    gl.deleteTexture(t1);
    const b = gl.createBuffer()!;
    gl.deleteBuffer(b);
    gl.createBuffer();
    gl.createFramebuffer();
    expect(c.counts()).toMatchObject({ tex: 1, buf: 1, fbo: 1 });
    expect(gl.calls.filter((x) => x === "createTexture")).toHaveLength(2);
    expect(gl.calls).toContain("deleteTexture");
  });

  it("纹理字节：按绑定的纹理记第 0 级上传（两种 texImage2D 签名与 texStorage2D）；删除即扣；重复上传以最后一次为准", () => {
    const gl = fakeGl();
    const c = installGlCounter(gl);
    const a = gl.createTexture()!;
    gl.bindTexture(TEXTURE_2D, a);
    gl.texImage2D(TEXTURE_2D, 0, 0, 512, 512, 0, 0, 0, null); // 1MB
    gl.texImage2D(TEXTURE_2D, 1, 0, 256, 256, 0, 0, 0, null); // mip 不计
    const b = gl.createTexture()!;
    gl.bindTexture(TEXTURE_2D, b);
    gl.texImage2D(TEXTURE_2D, 0, 0, 0, 0, { width: 1024, height: 512 }); // 图像源签名，2MB
    expect(c.counts().texMB).toBe(3);
    gl.texImage2D(TEXTURE_2D, 0, 0, 0, 0, { width: 512, height: 512 }); // b 重新上传成 1MB
    expect(c.counts().texMB).toBe(2);
    gl.deleteTexture(a);
    expect(c.counts().texMB).toBe(1);
    const s = gl.createTexture()!;
    gl.bindTexture(TEXTURE_2D, s);
    gl.texStorage2D!(TEXTURE_2D, 1, 0, 1024, 1024); // 4MB
    expect(c.counts()).toMatchObject({ tex: 2, texMB: 5 });
    expect(c.counts().peakMB).toBe(5);
  });

  it("删除装计数器之前就创建的对象：不计，计数不会减成负数", () => {
    const gl = fakeGl();
    const early = { buf: gl.createBuffer(), fbo: gl.createFramebuffer(), tex: gl.createTexture() };
    const c = installGlCounter(gl);
    gl.deleteBuffer(early.buf);
    gl.deleteFramebuffer(early.fbo);
    gl.deleteTexture(early.tex);
    expect(c.counts()).toMatchObject({ tex: 0, buf: 0, fbo: 0 });
  });

  it("立方体贴图六个面分别计；uninstall 恢复原方法", () => {
    const gl = fakeGl();
    const original = gl.createTexture;
    const c = installGlCounter(gl);
    const cube = gl.createTexture()!;
    gl.bindTexture(TEXTURE_CUBE_MAP, cube);
    for (let f = 0; f < 6; f++) gl.texImage2D(CUBE_POSITIVE_X + f, 0, 0, 256, 256, 0, 0, 0, null);
    expect(c.counts().texMB).toBe(1.5);
    c.uninstall();
    expect(gl.createTexture).toBe(original);
  });
});
