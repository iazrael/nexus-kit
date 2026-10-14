/**
 * WebGL 对象与纹理字节记账（可选，只给自己用 WebGL 的宿主）：包住上下文的 create / delete / 上传方法，按创建减删除记
 * GL 纹理、缓冲、帧缓冲的净存活数，按第 0 级上传的宽 × 高 × 4 估算纹理字节，另记峰值。只认 GL 层，不读渲染库
 * （Pixi 等）的内部账本：渲染库以为放了、GL 没放，才是释放路径上的泄漏——两本账背离本身就是线索。
 * 估算口径：压缩纹理、非 RGBA8 格式、mip 链都按 RGBA8 第 0 级算，是量级参考，不是精确显存。
 */
/** WebGL 上下文中被包住的方法（WebGLRenderingContext 与 WebGL2 都满足） */
export interface GlLike {
    createTexture(): WebGLTexture | null;
    deleteTexture(texture: WebGLTexture | null): void;
    bindTexture(target: number, texture: WebGLTexture | null): void;
    activeTexture(texture: number): void;
    texImage2D(...args: unknown[]): void;
    texStorage2D?(target: number, levels: number, internalformat: number, width: number, height: number): void;
    createBuffer(): WebGLBuffer | null;
    deleteBuffer(buffer: WebGLBuffer | null): void;
    createFramebuffer(): WebGLFramebuffer | null;
    deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void;
}
export interface GlCounts {
    tex: number;
    buf: number;
    fbo: number;
    /** 存活纹理字节估算（MB，一位小数） */
    texMB: number;
    /** 本局峰值 */
    peakMB: number;
}
export declare function installGlCounter(gl: GlLike): {
    counts: () => GlCounts;
    uninstall(): void;
};
export type GlCounter = ReturnType<typeof installGlCounter>;
