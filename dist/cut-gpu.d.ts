/**
 * CUT3 GPU Renderer using WebGL2 — Cheap Upscaling Triangulation, level 3.
 *
 * Three-pass content-adaptive upscaler: pass 0 triangulates the luma plane
 * of every 2x2 quad and detects soft edges, pass 1 walks along hard edges
 * to refine per-side weights, pass 2 interpolates the output inside each
 * quad / triangle. Passes 0 and 1 render to input-sized RGBA8 textures
 * owned by this renderer; the final pass uses the shared render target so
 * every output path (readPixels / async readback / ImageBitmap transfer)
 * works exactly like the other renderers.
 *
 * Ported from "Cheap Upscaling Triangulation",
 * Copyright (c) Filippo Scognamiglio 2024,
 * https://github.com/Swordfish90/cheap-upscaling-triangulation
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
import type { CutOptions, ImageOutput, Renderer, RenderSource } from './types.js';
/**
 * Fully-resolved CUT3 parameters. The same normalisation lives in the Rust
 * implementation (`sanitize` in cut.rs) so the WASM and GPU paths always
 * agree on what a given option set means.
 */
interface ResolvedCutOptions {
    scale: number;
    useDynamicBlend: boolean;
    blendMinContrastEdge: number;
    blendMaxContrastEdge: number;
    blendMinSharpness: number;
    blendMaxSharpness: number;
    staticBlendSharpness: number;
    edgeUseFastLuma: boolean;
    softEdgesSharpening: boolean;
    softEdgesSharpeningAmount: number;
    hardEdgesSearchMaxError: number;
    hardEdgesSearchMaxDistance: number;
}
/** Defaults match the upstream demo's `#define` block. */
export declare function resolveCutOptions(options: CutOptions): ResolvedCutOptions;
/** CUT3 GPU Renderer */
export declare class CutGpuRenderer implements Renderer<CutOptions> {
    private initialized;
    private inputTexture;
    private inputSize;
    /** Input-sized RGBA8 targets for pass 0 and pass 1 output. */
    private passTextures;
    private passFbos;
    private passSize;
    /** Context generation our GPU resources belong to (see context loss handling). */
    private contextGen;
    static create(): CutGpuRenderer;
    private init;
    /**
     * (Re)creates GPU resources. Called on init and again after the WebGL
     * context was lost and restored - the shared program cache is cleared on
     * loss, so registerProgram recompiles, and the textures/FBOs are
     * recreated.
     */
    private ensureResources;
    /** (Re)allocates the two intermediate render targets at input size. */
    private ensurePassTargets;
    isReady(): boolean;
    /**
     * Submit the three passes. Shared by all output paths.
     * Returns the output dimensions.
     */
    private submit;
    render(input: RenderSource, options?: CutOptions): ImageOutput;
    /**
     * Non-blocking variant: the GPU keeps working while we await readback.
     * Ideal inside a Web Worker. An optional reusable buffer can be supplied
     * to avoid per-call allocations. Concurrent calls are safe: GPU work is
     * serialized internally.
     */
    renderAsync(input: RenderSource, options?: CutOptions, out?: Uint8ClampedArray): Promise<ImageOutput>;
    /**
     * Render straight to an ImageBitmap with no GPU->CPU readback at all.
     * This is by far the cheapest path when the result is going to be drawn
     * to a canvas / used as a texture: the backbuffer is handed over zero-copy.
     */
    renderToBitmap(input: RenderSource, options?: CutOptions): Promise<ImageBitmap>;
    dispose(): void;
}
/**
 * Presets. 'default' is the upstream demo configuration; the others are
 * reasonable variations of the documented parameters.
 */
export declare const CUT_PRESETS: Record<string, Partial<CutOptions>>;
export {};
//# sourceMappingURL=cut-gpu.d.ts.map