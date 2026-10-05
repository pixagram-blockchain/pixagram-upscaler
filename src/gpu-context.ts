/**
 * Shared GPU Context Manager
 *
 * Provides a single WebGL2 context shared across all GPU renderers.
 * This prevents hitting browser WebGL context limits and reduces memory usage.
 *
 * Works on the main thread or inside a Web Worker (uses OffscreenCanvas).
 *
 * Key crash-safety properties:
 *  - Pixel readback renders into an exactly-sized FBO texture; the canvas
 *    backbuffer stays at 1x1, so no giant drawing buffer is ever allocated
 *    (the old grow-only canvas was the main source of GPU OOM / context loss).
 *  - Output dimensions are validated against the device's real GL limits
 *    before any allocation, producing a clear Error instead of a crash.
 *  - Context loss is handled: GPU-object caches are invalidated, a generation
 *    counter lets renderers rebuild lazily, and restoration is permitted.
 *  - All async GPU work can be serialized through {@link runExclusive} so the
 *    shared pack buffer / render target are never used concurrently.
 */

export interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export interface GpuLimits {
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportWidth: number;
  maxViewportHeight: number;
}

export interface SharedGpuContext {
  gl: WebGL2RenderingContext;
  canvas: OffscreenCanvas;
  /** Current canvas backbuffer size (kept exact, 1x1 when unused) */
  canvasSize: { width: number; height: number };
  /** Offscreen render target used for the pixel-readback path */
  fbo: WebGLFramebuffer | null;
  fboTexture: WebGLTexture | null;
  fboSize: { width: number; height: number };
  /** Reusable PIXEL_PACK_BUFFER for asynchronous readback */
  packBuffer: WebGLBuffer | null;
  packBufferSize: number;
  /** Currently bound program, used to skip redundant gl.useProgram calls */
  lastProgram: WebGLProgram | null;
  /** Device limits captured at context creation */
  limits: GpuLimits;
}

/** Render destination for a draw call. */
export type RenderTarget = 'texture' | 'canvas';

/** Safe ImageBitmap check (ImageBitmap may not exist in every environment). */
export function isImageBitmap(source: unknown): source is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap;
}

/** Singleton shared GPU context */
let sharedContext: SharedGpuContext | null = null;
let contextRefCount = 0;

/**
 * Incremented every time the WebGL context is lost. Renderers snapshot this
 * value when they create GPU resources and rebuild them when it changes.
 */
let contextGeneration = 0;

/** Registered programs by renderer ID */
const programs = new Map<string, ProgramInfo>();

/** Shared texture (optional - renderers can manage their own) */
let sharedTexture: WebGLTexture | null = null;
let sharedTextureSize = { width: 0, height: 0 };

/** Applies the base GL state we rely on (initial setup and context-restore). */
function setupBaseState(gl: WebGL2RenderingContext): void {
  // Tightly packed RGBA rows (no 4-byte row padding surprises on odd widths).
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  // Setup shared vertex buffer (fullscreen triangle - same for all renderers)
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.clearColor(0, 0, 0, 0);
}

/** Drops every cached GPU object reference. Used when the context is lost. */
function invalidateGpuObjects(): void {
  programs.clear();
  sharedTexture = null;
  sharedTextureSize = { width: 0, height: 0 };
  if (sharedContext) {
    sharedContext.fbo = null;
    sharedContext.fboTexture = null;
    sharedContext.fboSize = { width: 0, height: 0 };
    sharedContext.packBuffer = null;
    sharedContext.packBufferSize = 0;
    sharedContext.lastProgram = null;
    sharedContext.canvasSize = { width: 1, height: 1 };
  }
}

/**
 * Acquire the shared GPU context.
 * Creates it on first call, increments ref count on subsequent calls.
 */
export function acquireContext(): SharedGpuContext {
  if (!sharedContext) {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas not supported');
    }

    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      antialias: false,
      // We read pixels back ourselves; the drawing buffer never needs preserving.
      preserveDrawingBuffer: false,
    });

    if (!gl) throw new Error('WebGL2 not supported');

    // Allow the browser to restore the context after a loss; without
    // preventDefault() a lost context is permanent.
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      contextGeneration++;
      invalidateGpuObjects();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // The same gl object becomes usable again with default state.
      setupBaseState(gl);
    });

    setupBaseState(gl);

    const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const limits: GpuLimits = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      maxViewportWidth: maxViewport[0],
      maxViewportHeight: maxViewport[1],
    };

    sharedContext = {
      gl,
      canvas,
      canvasSize: { width: 1, height: 1 },
      fbo: null,
      fboTexture: null,
      fboSize: { width: 0, height: 0 },
      packBuffer: null,
      packBufferSize: 0,
      lastProgram: null,
      limits,
    };
  }

  contextRefCount++;
  return sharedContext;
}

/**
 * Release the shared context.
 * Destroys it when ref count reaches 0.
 */
export function releaseContext(): void {
  if (contextRefCount > 0) {
    contextRefCount--;
  }

  if (contextRefCount <= 0 && sharedContext) {
    const { gl } = sharedContext;

    // Clean up all registered programs
    for (const { program } of programs.values()) {
      gl.deleteProgram(program);
    }
    programs.clear();

    // Clean up shared texture
    if (sharedTexture) {
      gl.deleteTexture(sharedTexture);
      sharedTexture = null;
      sharedTextureSize = { width: 0, height: 0 };
    }

    // Clean up render target and readback buffer
    if (sharedContext.fboTexture) gl.deleteTexture(sharedContext.fboTexture);
    if (sharedContext.fbo) gl.deleteFramebuffer(sharedContext.fbo);
    if (sharedContext.packBuffer) gl.deleteBuffer(sharedContext.packBuffer);

    sharedContext = null;
  }
}

/**
 * Generation counter for context-loss recovery. Bumped on every
 * 'webglcontextlost' event. Renderers that cache WebGL objects must compare
 * against the value they saw at creation time and rebuild when it differs.
 */
export function getContextGeneration(): number {
  return contextGeneration;
}

/**
 * Check if the shared context is available and valid
 */
export function isContextReady(): boolean {
  return sharedContext !== null && !sharedContext.gl.isContextLost();
}

/**
 * Get the current shared context (throws if not acquired)
 */
export function getContext(): SharedGpuContext {
  if (!sharedContext) {
    throw new Error('GPU context not acquired. Call acquireContext() first.');
  }
  if (sharedContext.gl.isContextLost()) {
    throw new Error(
      'WebGL context lost. Rendering will recover automatically once the ' +
      'browser restores the context; reduce the output size or scale if ' +
      'losses keep happening.'
    );
  }
  return sharedContext;
}

/**
 * Largest output dimension (width or height) that this device can render
 * and read back. Useful for clamping a scale factor before rendering.
 */
export function getMaxOutputDimension(): number {
  const { limits } = getContext();
  return Math.min(
    limits.maxTextureSize,
    limits.maxRenderbufferSize,
    limits.maxViewportWidth,
    limits.maxViewportHeight
  );
}

/**
 * Validate output dimensions against the device's GL limits.
 * Throws a descriptive Error instead of letting the driver OOM or lose the
 * context on an oversized allocation.
 */
export function assertOutputSize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid output size ${width}x${height}`);
  }
  const max = getMaxOutputDimension();
  if (width > max || height > max) {
    throw new Error(
      `Output size ${width}x${height} exceeds this GPU's limit of ${max}px per side. ` +
      'Reduce the scale factor or input size (see getMaxOutputDimension()).'
    );
  }
}

/**
 * Compile a shader
 */
export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader');

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile failed: ' + info);
  }

  return shader;
}

/**
 * Register a shader program for a renderer.
 * Programs are cached by ID to avoid recompilation. The cache is cleared on
 * context loss, so calling this again after a loss recompiles naturally.
 */
export function registerProgram(
  id: string,
  vertexSource: string,
  fragmentSource: string,
  uniformNames: string[]
): ProgramInfo {
  // Return cached program if exists
  const existing = programs.get(id);
  if (existing) return existing;

  const { gl } = getContext();

  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create program');

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  // Shaders can be deleted after linking
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Shader program link failed [${id}]: ${info}`);
  }

  // Cache uniform locations
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  for (const name of uniformNames) {
    uniforms.set(name, gl.getUniformLocation(program, name));
  }

  const info: ProgramInfo = { program, uniforms };
  programs.set(id, info);
  return info;
}

/**
 * Get a registered program (throws if not registered)
 */
export function getProgram(id: string): ProgramInfo {
  const info = programs.get(id);
  if (!info) throw new Error(`Program not registered: ${id}`);
  return info;
}

/**
 * Check if a program is registered
 */
export function hasProgram(id: string): boolean {
  return programs.has(id);
}

/**
 * Unregister and delete a program
 */
export function unregisterProgram(id: string): void {
  const info = programs.get(id);
  if (info && sharedContext) {
    sharedContext.gl.deleteProgram(info.program);
    programs.delete(id);
    if (sharedContext.lastProgram === info.program) {
      sharedContext.lastProgram = null;
    }
  }
}

/**
 * Bind a program, skipping the GL call when it is already current.
 * Returns true if a state change actually occurred.
 *
 * This both removes redundant driver calls when the same renderer runs
 * repeatedly (e.g. video frames) and guarantees the correct program is
 * bound when several renderers share the context.
 */
export function useProgram(program: WebGLProgram): boolean {
  const ctx = getContext();
  if (ctx.lastProgram === program) return false;
  ctx.gl.useProgram(program);
  ctx.lastProgram = program;
  return true;
}

/**
 * Bind the render destination for a draw of `width` x `height` pixels and set
 * the viewport.
 *
 * - 'texture': renders into an exactly-sized FBO-backed texture. Used by the
 *   pixel-readback paths. The canvas backbuffer is untouched (stays tiny), so
 *   the GPU never holds a screen-sized drawing buffer for readback work.
 * - 'canvas': renders into the canvas backbuffer, resized to exactly
 *   `width` x `height` (only when it differs). Used by the ImageBitmap output
 *   path, which hands the buffer off zero-copy via transferToImageBitmap().
 *
 * Both targets are reallocated only when the requested size changes, so
 * steady-state rendering (e.g. video frames) performs no allocations.
 *
 * Callers must validate dimensions with {@link assertOutputSize} first.
 */
export function bindRenderTarget(width: number, height: number, target: RenderTarget): void {
  const ctx = getContext();
  const { gl } = ctx;

  if (target === 'texture') {
    if (!ctx.fbo) {
      ctx.fbo = gl.createFramebuffer();
      if (!ctx.fbo) throw new Error('Failed to create framebuffer');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.fbo);

    if (!ctx.fboTexture) {
      ctx.fboTexture = gl.createTexture();
      if (!ctx.fboTexture) throw new Error('Failed to create render texture');
      gl.bindTexture(gl.TEXTURE_2D, ctx.fboTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      ctx.fboSize = { width: 0, height: 0 };
    }

    if (ctx.fboSize.width !== width || ctx.fboSize.height !== height) {
      gl.bindTexture(gl.TEXTURE_2D, ctx.fboTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ctx.fboTexture, 0);
      ctx.fboSize = { width, height };

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Render target incomplete (status 0x${status.toString(16)}) at ${width}x${height}`);
      }
    }
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (ctx.canvasSize.width !== width || ctx.canvasSize.height !== height) {
      ctx.canvas.width = width;
      ctx.canvas.height = height;
      ctx.canvasSize = { width, height };
    }
  }

  gl.viewport(0, 0, width, height);
}

/**
 * Hand the canvas backbuffer off as an ImageBitmap (zero-copy, no readback).
 * Only valid right after drawing with the 'canvas' render target.
 */
export function transferBitmap(): ImageBitmap {
  const ctx = getContext();
  return ctx.canvas.transferToImageBitmap();
}

/**
 * Release as much GPU memory as possible without destroying the context.
 * Programs are kept (recompiling is the expensive part); the render target,
 * pack buffer, shared texture and canvas backbuffer are freed. Everything is
 * recreated lazily on the next render.
 */
export function trimMemory(): void {
  if (!sharedContext) return;
  const ctx = sharedContext;
  const { gl } = ctx;
  if (gl.isContextLost()) return;

  if (ctx.fboTexture) {
    gl.deleteTexture(ctx.fboTexture);
    ctx.fboTexture = null;
    ctx.fboSize = { width: 0, height: 0 };
  }
  if (ctx.packBuffer) {
    gl.deleteBuffer(ctx.packBuffer);
    ctx.packBuffer = null;
    ctx.packBufferSize = 0;
  }
  if (sharedTexture) {
    gl.deleteTexture(sharedTexture);
    sharedTexture = null;
    sharedTextureSize = { width: 0, height: 0 };
  }
  if (ctx.canvasSize.width !== 1 || ctx.canvasSize.height !== 1) {
    ctx.canvas.width = 1;
    ctx.canvas.height = 1;
    ctx.canvasSize = { width: 1, height: 1 };
  }
}

/** Serialized GPU work queue (see runExclusive). */
let gpuQueue: Promise<unknown> = Promise.resolve();

/**
 * Run an async GPU task exclusively: tasks are chained so two renders can
 * never interleave their use of the shared pack buffer, render target or
 * bound GL state. All async render paths go through this, which makes
 * concurrent calls (e.g. several postMessages hitting the render worker)
 * safe - they simply queue.
 */
export function runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
  const run = gpuQueue.then(task);
  // Keep the chain alive even when a task rejects.
  gpuQueue = run.catch(() => undefined);
  return run;
}

/**
 * Get or create the shared texture.
 * Useful for renderers that don't need to maintain separate textures.
 */
export function getSharedTexture(): WebGLTexture {
  if (!sharedTexture) {
    const { gl } = getContext();
    sharedTexture = gl.createTexture();
    if (!sharedTexture) throw new Error('Failed to create texture');

    gl.bindTexture(gl.TEXTURE_2D, sharedTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  return sharedTexture;
}

/**
 * Upload image data to the shared texture with smart sub-image updates.
 */
export function uploadToSharedTexture(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  filter: 'nearest' | 'linear' = 'nearest'
): void {
  const { gl } = getContext();
  const texture = getSharedTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);

  // Set filter mode
  const filterMode = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);

  // Use texSubImage2D if dimensions match, otherwise reallocate
  if (sharedTextureSize.width === width && sharedTextureSize.height === height) {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    sharedTextureSize = { width, height };
  }
}

/**
 * Create a dedicated texture for a renderer that needs its own.
 */
export function createTexture(
  filter: 'nearest' | 'linear' = 'nearest'
): WebGLTexture {
  const { gl } = getContext();
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  const filterMode = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
}

/**
 * Delete a texture
 */
export function deleteTexture(texture: WebGLTexture): void {
  if (sharedContext && !sharedContext.gl.isContextLost()) {
    sharedContext.gl.deleteTexture(texture);
  }
}

/**
 * Read pixels from the currently bound framebuffer synchronously.
 *
 * NOTE: this forces a full GPU -> CPU pipeline flush and stalls the calling
 * thread until rendering completes. Prefer {@link readPixelsAsync} where a
 * Promise-based result is acceptable (e.g. inside a worker).
 */
export function readPixels(
  width: number,
  height: number,
  out?: Uint8ClampedArray
): Uint8ClampedArray {
  const { gl } = getContext();
  const size = width * height * 4;
  const pixels = out && out.length >= size ? out : new Uint8ClampedArray(size);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels.length === size ? pixels : pixels.subarray(0, size);
}

/**
 * Poll a fence sync without blocking the event loop.
 * Rejects promptly if the context is lost while waiting (otherwise a lost
 * context can leave the poll spinning forever on TIMEOUT_EXPIRED).
 */
function clientWaitAsync(
  gl: WebGL2RenderingContext,
  sync: WebGLSync,
  intervalMs = 0
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (gl.isContextLost()) {
        reject(new Error('WebGL context lost during readback'));
        return;
      }
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.WAIT_FAILED) {
        reject(new Error('clientWaitSync failed'));
        return;
      }
      if (status === gl.TIMEOUT_EXPIRED) {
        setTimeout(check, intervalMs);
        return;
      }
      resolve();
    };
    check();
  });
}

/**
 * Read pixels from the currently bound framebuffer asynchronously via a
 * PIXEL_PACK_BUFFER + fence sync. This avoids the hard CPU/GPU stall of the
 * synchronous path: the GPU keeps working while we await the fence, and the
 * calling thread is never blocked.
 *
 * The internal pack buffer is reused across calls (grow-only). Concurrent
 * use is prevented by routing all async renders through {@link runExclusive}.
 */
export async function readPixelsAsync(
  width: number,
  height: number,
  out?: Uint8ClampedArray
): Promise<Uint8ClampedArray> {
  const ctx = getContext();
  const { gl } = ctx;
  const size = width * height * 4;

  if (!ctx.packBuffer) {
    ctx.packBuffer = gl.createBuffer();
    if (!ctx.packBuffer) throw new Error('Failed to create pack buffer');
  }

  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ctx.packBuffer);
  if (ctx.packBufferSize < size) {
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
    ctx.packBufferSize = size;
  }

  // Kick off the readback into the PBO (returns immediately).
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) throw new Error('Failed to create fence sync');
  gl.flush();

  try {
    await clientWaitAsync(gl, sync);
  } finally {
    if (!gl.isContextLost()) gl.deleteSync(sync);
  }

  const pixels = out && out.length >= size ? out : new Uint8ClampedArray(size);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ctx.packBuffer);
  gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels, 0, size);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

  return pixels.length === size ? pixels : pixels.subarray(0, size);
}

/**
 * Draw fullscreen triangle
 */
export function draw(): void {
  const { gl } = getContext();
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/**
 * Clear the framebuffer
 */
export function clear(): void {
  const { gl } = getContext();
  gl.clear(gl.COLOR_BUFFER_BIT);
}
