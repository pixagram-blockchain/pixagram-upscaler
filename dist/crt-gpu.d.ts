/**
 * CRT GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 */
import type { CrtOptions, ImageOutput, Renderer, RenderSource } from './types.js';
/** CRT GPU Renderer */
export declare class CrtGpuRenderer implements Renderer<CrtOptions> {
    private initialized;
    private texture;
    private textureSize;
    /** Context generation our GPU resources belong to (see context loss handling). */
    private contextGen;
    static create(): CrtGpuRenderer;
    private init;
    /**
     * (Re)creates GPU resources. Called on init and again after the WebGL
     * context was lost and restored - the shared program cache is cleared on
     * loss, so registerProgram recompiles, and our input texture is recreated.
     */
    private ensureResources;
    isReady(): boolean;
    /** Submit the draw call (shared by all output paths). Returns output size. */
    private submit;
    render(input: RenderSource, options?: CrtOptions): ImageOutput;
    /**
     * Non-blocking variant using asynchronous PBO readback. Concurrent calls
     * are safe: GPU work is serialized internally.
     */
    renderAsync(input: RenderSource, options?: CrtOptions, out?: Uint8ClampedArray): Promise<ImageOutput>;
    /**
     * Render straight to an ImageBitmap with no GPU->CPU readback at all.
     * This is by far the cheapest path when the result is going to be drawn
     * to a canvas / used as a texture: the backbuffer is handed over zero-copy.
     */
    renderToBitmap(input: RenderSource, options?: CrtOptions): Promise<ImageBitmap>;
    dispose(): void;
}
export declare const CRT_PRESETS: Record<string, Partial<CrtOptions>>;
//# sourceMappingURL=crt-gpu.d.ts.map