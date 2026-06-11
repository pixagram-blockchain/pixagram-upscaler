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
    canvasSize: {
        width: number;
        height: number;
    };
    /** Offscreen render target used for the pixel-readback path */
    fbo: WebGLFramebuffer | null;
    fboTexture: WebGLTexture | null;
    fboSize: {
        width: number;
        height: number;
    };
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
export declare function isImageBitmap(source: unknown): source is ImageBitmap;
/**
 * Acquire the shared GPU context.
 * Creates it on first call, increments ref count on subsequent calls.
 */
export declare function acquireContext(): SharedGpuContext;
/**
 * Release the shared context.
 * Destroys it when ref count reaches 0.
 */
export declare function releaseContext(): void;
/**
 * Generation counter for context-loss recovery. Bumped on every
 * 'webglcontextlost' event. Renderers that cache WebGL objects must compare
 * against the value they saw at creation time and rebuild when it differs.
 */
export declare function getContextGeneration(): number;
/**
 * Check if the shared context is available and valid
 */
export declare function isContextReady(): boolean;
/**
 * Get the current shared context (throws if not acquired)
 */
export declare function getContext(): SharedGpuContext;
/**
 * Largest output dimension (width or height) that this device can render
 * and read back. Useful for clamping a scale factor before rendering.
 */
export declare function getMaxOutputDimension(): number;
/**
 * Validate output dimensions against the device's GL limits.
 * Throws a descriptive Error instead of letting the driver OOM or lose the
 * context on an oversized allocation.
 */
export declare function assertOutputSize(width: number, height: number): void;
/**
 * Compile a shader
 */
export declare function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader;
/**
 * Register a shader program for a renderer.
 * Programs are cached by ID to avoid recompilation. The cache is cleared on
 * context loss, so calling this again after a loss recompiles naturally.
 */
export declare function registerProgram(id: string, vertexSource: string, fragmentSource: string, uniformNames: string[]): ProgramInfo;
/**
 * Get a registered program (throws if not registered)
 */
export declare function getProgram(id: string): ProgramInfo;
/**
 * Check if a program is registered
 */
export declare function hasProgram(id: string): boolean;
/**
 * Unregister and delete a program
 */
export declare function unregisterProgram(id: string): void;
/**
 * Bind a program, skipping the GL call when it is already current.
 * Returns true if a state change actually occurred.
 *
 * This both removes redundant driver calls when the same renderer runs
 * repeatedly (e.g. video frames) and guarantees the correct program is
 * bound when several renderers share the context.
 */
export declare function useProgram(program: WebGLProgram): boolean;
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
export declare function bindRenderTarget(width: number, height: number, target: RenderTarget): void;
/**
 * Hand the canvas backbuffer off as an ImageBitmap (zero-copy, no readback).
 * Only valid right after drawing with the 'canvas' render target.
 */
export declare function transferBitmap(): ImageBitmap;
/**
 * Release as much GPU memory as possible without destroying the context.
 * Programs are kept (recompiling is the expensive part); the render target,
 * pack buffer, shared texture and canvas backbuffer are freed. Everything is
 * recreated lazily on the next render.
 */
export declare function trimMemory(): void;
/**
 * Run an async GPU task exclusively: tasks are chained so two renders can
 * never interleave their use of the shared pack buffer, render target or
 * bound GL state. All async render paths go through this, which makes
 * concurrent calls (e.g. several postMessages hitting the render worker)
 * safe - they simply queue.
 */
export declare function runExclusive<T>(task: () => Promise<T> | T): Promise<T>;
/**
 * Get or create the shared texture.
 * Useful for renderers that don't need to maintain separate textures.
 */
export declare function getSharedTexture(): WebGLTexture;
/**
 * Upload image data to the shared texture with smart sub-image updates.
 */
export declare function uploadToSharedTexture(data: Uint8ClampedArray | Uint8Array, width: number, height: number, filter?: 'nearest' | 'linear'): void;
/**
 * Create a dedicated texture for a renderer that needs its own.
 */
export declare function createTexture(filter?: 'nearest' | 'linear'): WebGLTexture;
/**
 * Delete a texture
 */
export declare function deleteTexture(texture: WebGLTexture): void;
/**
 * Read pixels from the currently bound framebuffer synchronously.
 *
 * NOTE: this forces a full GPU -> CPU pipeline flush and stalls the calling
 * thread until rendering completes. Prefer {@link readPixelsAsync} where a
 * Promise-based result is acceptable (e.g. inside a worker).
 */
export declare function readPixels(width: number, height: number, out?: Uint8ClampedArray): Uint8ClampedArray;
/**
 * Read pixels from the currently bound framebuffer asynchronously via a
 * PIXEL_PACK_BUFFER + fence sync. This avoids the hard CPU/GPU stall of the
 * synchronous path: the GPU keeps working while we await the fence, and the
 * calling thread is never blocked.
 *
 * The internal pack buffer is reused across calls (grow-only). Concurrent
 * use is prevented by routing all async renders through {@link runExclusive}.
 */
export declare function readPixelsAsync(width: number, height: number, out?: Uint8ClampedArray): Promise<Uint8ClampedArray>;
/**
 * Draw fullscreen triangle
 */
export declare function draw(): void;
/**
 * Clear the framebuffer
 */
export declare function clear(): void;
//# sourceMappingURL=gpu-context.d.ts.map