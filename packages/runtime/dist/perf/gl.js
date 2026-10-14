/**
 * WebGL 对象与纹理字节记账（可选，只给自己用 WebGL 的宿主）：包住上下文的 create / delete / 上传方法，按创建减删除记
 * GL 纹理、缓冲、帧缓冲的净存活数，按第 0 级上传的宽 × 高 × 4 估算纹理字节，另记峰值。只认 GL 层，不读渲染库
 * （Pixi 等）的内部账本：渲染库以为放了、GL 没放，才是释放路径上的泄漏——两本账背离本身就是线索。
 * 估算口径：压缩纹理、非 RGBA8 格式、mip 链都按 RGBA8 第 0 级算，是量级参考，不是精确显存。
 */
const TEXTURE_2D = 0x0de1;
const TEXTURE_CUBE_MAP = 0x8513;
const TEXTURE0 = 0x84c0;
const CUBE_FIRST = 0x8515;
const CUBE_LAST = 0x851a;
const MB = 1024 * 1024;
export function installGlCounter(gl) {
    const original = {
        createTexture: gl.createTexture,
        deleteTexture: gl.deleteTexture,
        bindTexture: gl.bindTexture,
        activeTexture: gl.activeTexture,
        texImage2D: gl.texImage2D,
        texStorage2D: gl.texStorage2D,
        createBuffer: gl.createBuffer,
        deleteBuffer: gl.deleteBuffer,
        createFramebuffer: gl.createFramebuffer,
        deleteFramebuffer: gl.deleteFramebuffer,
    };
    let tex = 0;
    let buf = 0;
    let fbo = 0;
    let bytes = 0;
    let peak = 0;
    /** 纹理 → 各面（2D 只有一面）第 0 级字节 */
    const sizes = new Map();
    // 绑定是「纹理单元 × 目标」两级：上传写的是当前单元上绑定的纹理
    let unit = TEXTURE0;
    const bound = new Map();
    const boundOn = (target) => bound.get(unit)?.get(target);
    // 只对装上计数器之后创建的对象计数：删一个之前就有的对象不该让计数减成负数
    const buffers = new WeakSet();
    const framebuffers = new WeakSet();
    const setBytes = (texture, face, b) => {
        if (!texture)
            return;
        const faces = sizes.get(texture);
        if (faces === undefined)
            return;
        bytes += b - (faces.get(face) ?? 0);
        faces.set(face, b);
        if (bytes > peak)
            peak = bytes;
    };
    const textureFor = (target) => target >= CUBE_FIRST && target <= CUBE_LAST ? boundOn(TEXTURE_CUBE_MAP) : boundOn(target);
    gl.createTexture = function () {
        const t = original.createTexture.call(gl);
        if (t) {
            tex++;
            sizes.set(t, new Map());
        }
        return t;
    };
    gl.deleteTexture = function (t) {
        const faces = t ? sizes.get(t) : undefined;
        if (t && faces !== undefined) {
            tex--;
            for (const b of faces.values())
                bytes -= b;
            sizes.delete(t);
        }
        original.deleteTexture.call(gl, t);
    };
    gl.activeTexture = function (texture) {
        unit = texture;
        original.activeTexture.call(gl, texture);
    };
    gl.bindTexture = function (target, t) {
        let targets = bound.get(unit);
        if (targets === undefined)
            bound.set(unit, (targets = new Map()));
        targets.set(target, t);
        original.bindTexture.call(gl, target, t);
    };
    gl.texImage2D = function (...args) {
        const [target, level] = args;
        if (level === 0) {
            let w;
            let h;
            if (args.length >= 9) {
                w = Number(args[3]);
                h = Number(args[4]);
            }
            else {
                // 图像源的真实像素尺寸：img 取 natural*（width 可能是 CSS 缩放后的），video 取 video*，VideoFrame 取 display*，
                // 其余（canvas、ImageBitmap、ImageData）取 width / height
                const src = args[5];
                w = Number(src?.naturalWidth ?? src?.videoWidth ?? src?.displayWidth ?? src?.width ?? 0);
                h = Number(src?.naturalHeight ?? src?.videoHeight ?? src?.displayHeight ?? src?.height ?? 0);
            }
            if (Number.isFinite(w) && Number.isFinite(h))
                setBytes(textureFor(target), target === TEXTURE_2D ? 0 : target, w * h * 4);
        }
        original.texImage2D.apply(gl, args);
    };
    if (original.texStorage2D !== undefined) {
        const storage = original.texStorage2D;
        gl.texStorage2D = function (target, levels, internalformat, width, height) {
            if (target === TEXTURE_2D)
                setBytes(boundOn(TEXTURE_2D), 0, width * height * 4);
            storage.call(gl, target, levels, internalformat, width, height);
        };
    }
    gl.createBuffer = function () {
        const b = original.createBuffer.call(gl);
        if (b) {
            buf++;
            buffers.add(b);
        }
        return b;
    };
    gl.deleteBuffer = function (b) {
        if (b && buffers.delete(b))
            buf--;
        original.deleteBuffer.call(gl, b);
    };
    gl.createFramebuffer = function () {
        const f = original.createFramebuffer.call(gl);
        if (f) {
            fbo++;
            framebuffers.add(f);
        }
        return f;
    };
    gl.deleteFramebuffer = function (f) {
        if (f && framebuffers.delete(f))
            fbo--;
        original.deleteFramebuffer.call(gl, f);
    };
    const mb = (b) => Math.round((b / MB) * 10) / 10;
    return {
        counts: () => ({ tex, buf, fbo, texMB: mb(bytes), peakMB: mb(peak) }),
        uninstall() {
            Object.assign(gl, original);
        },
    };
}
