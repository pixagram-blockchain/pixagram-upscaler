/**
 * Hexagonal GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 */
import type { HexOptions, HexOrientation, ImageOutput, Renderer, RenderSource } from './types.js';
export declare function hexGetDimensions(srcWidth: number, srcHeight: number, scale: number, orientation?: HexOrientation): {
    width: number;
    height: number;
};
/** Hex GPU Renderer */
export declare class HexGpuRenderer implements Renderer<HexOptions> {
    private initialized;
    private texture;
    private textureSize;
    /** Context generation our GPU resources belong to (see context loss handling). */
    private contextGen;
    static create(): HexGpuRenderer;
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
    render(input: RenderSource, options?: HexOptions): ImageOutput;
    /**
     * Non-blocking variant using asynchronous PBO readback. Concurrent calls
     * are safe: GPU work is serialized internally.
     */
    renderAsync(input: RenderSource, options?: HexOptions, out?: Uint8ClampedArray): Promise<ImageOutput>;
    /**
     * Render straight to an ImageBitmap with no GPU->CPU readback at all.
     * This is by far the cheapest path when the result is going to be drawn
     * to a canvas / used as a texture: the backbuffer is handed over zero-copy.
     */
    renderToBitmap(input: RenderSource, options?: HexOptions): Promise<ImageBitmap>;
    dispose(): void;
}
export declare const HEX_PRESETS: Record<string, Partial<HexOptions>>;
//# sourceMappingURL=hex-gpu.d.ts.map