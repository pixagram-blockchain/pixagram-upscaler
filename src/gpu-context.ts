/**
 * Shared GPU Context Manager
 *
 * Provides a single WebGL2 context shared across all GPU renderers.
 * This prevents hitting browser WebGL context limits and reduces memory usage.
 *
 * Works on the main thread or inside a Web Worker (uses OffscreenCanvas).
 */

export interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export interface SharedGpuContext {
  gl: WebGL2RenderingContext;
  canvas: OffscreenCanvas;
  capacity: { width: number; height: number };
  /** Reusable PIXEL_PACK_BUFFER for asynchronous readback */
  packBuffer: WebGLBuffer | null;
  packBufferSize: number;
  /** Currently bound program, used to skip redundant gl.useProgram calls */
  lastProgram: WebGLProgram | null;
}

/** Singleton shared GPU context */
let sharedContext: SharedGpuContext | null = null;
let contextRefCount = 0;

/** Registered programs by renderer ID */
const programs = new Map<string, ProgramInfo>();

/** Shared texture (optional - renderers can manage their own) */
let sharedTexture: WebGLTexture | null = null;
let sharedTextureSize = { width: 0, height: 0 };

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

    sharedContext = {
      gl,
      canvas,
      capacity: { width: 0, height: 0 },
      packBuffer: null,
      packBufferSize: 0,
      lastProgram: null,
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

    // Clean up readback buffer
    if (sharedContext.packBuffer) {
      gl.deleteBuffer(sharedContext.packBuffer);
    }

    sharedContext = null;
  }
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
    throw new Error('WebGL context lost');
  }
  return sharedContext;
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
 * Programs are cached by ID to avoid recompilation.
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
 * Ensure canvas is at least the specified size (grow-only strategy).
 * Returns true if canvas was resized.
 */
export function ensureCanvasSize(width: number, height: number): boolean {
  const ctx = getContext();
  const { canvas, capacity } = ctx;

  if (width > capacity.width || height > capacity.height) {
    canvas.width = Math.max(capacity.width, width);
    canvas.height = Math.max(capacity.height, height);
    ctx.capacity = { width: canvas.width, height: canvas.height };
    return true;
  }
  return false;
}

/**
 * Set viewport to the specified dimensions
 */
export function setViewport(width: number, height: number): void {
  const { gl } = getContext();
  gl.viewport(0, 0, width, height);
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
  if (sharedContext) {
    sharedContext.gl.deleteTexture(texture);
  }
}

/**
 * Read pixels from the current framebuffer synchronously.
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
 */
function clientWaitAsync(
  gl: WebGL2RenderingContext,
  sync: WebGLSync,
  intervalMs = 0
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
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
 * Read pixels from the current framebuffer asynchronously via a
 * PIXEL_PACK_BUFFER + fence sync. This avoids the hard CPU/GPU stall of the
 * synchronous path: the GPU keeps working while we await the fence, and the
 * calling thread is never blocked.
 *
 * The internal pack buffer is reused across calls (grow-only).
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
    gl.deleteSync(sync);
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
