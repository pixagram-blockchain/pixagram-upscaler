/**
 * xBRZ GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 *
 * High-performance xBRZ pixel art scaling using fragment shaders.
 * Based on Hyllian's xBRZ algorithm with RGBA alpha support.
 */
import type { ImageOutput, Renderer, RenderSource, XbrzOptions } from './types.js';
/** xBRZ GPU Renderer */
export declare class XbrzGpuRenderer implements Renderer<XbrzOptions> {
    private initialized;
    private texture;
    private textureSize;
    /** Context generation our GPU resources belong to (see context loss handling). */
    private contextGen;
    static create(): XbrzGpuRenderer;
    private init;
    /**
     * (Re)creates GPU resources. Called on init and again after the WebGL
     * context was lost and restored - the shared program cache is cleared on
     * loss, so registerProgram recompiles, and our input texture is recreated.
     */
    private ensureResources;
    isReady(): boolean;
    /**
     * Submit the draw call. Shared by all output paths.
     * Returns the output dimensions.
     */
    private submit;
    render(input: RenderSource, options?: XbrzOptions): ImageOutput;
    /**
     * Non-blocking variant: the GPU keeps working while we await readback.
     * Ideal inside a Web Worker. An optional reusable buffer can be supplied
     * to avoid per-call allocations. Concurrent calls are safe: GPU work is
     * serialized internally.
     */
    renderAsync(input: RenderSource, options?: XbrzOptions, out?: Uint8ClampedArray): Promise<ImageOutput>;
    /**
     * Render straight to an ImageBitmap with no GPU->CPU readback at all.
     * This is by far the cheapest path when the result is going to be drawn
     * to a canvas / used as a texture: the backbuffer is handed over zero-copy.
     */
    renderToBitmap(input: RenderSource, options?: XbrzOptions): Promise<ImageBitmap>;
    dispose(): void;
}
export declare const XBRZ_PRESETS: Record<string, Partial<XbrzOptions>>;
//# sourceMappingURL=xbrz-gpu.d.ts.map