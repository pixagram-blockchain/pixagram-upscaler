/**
 * RenderArt Shared Types
 *
 * Common type definitions for all rendering engines.
 */
/** Input image data */
export interface ImageInput {
    /** Raw RGBA pixel data */
    data: Uint8ClampedArray | Uint8Array;
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
}
/** Output image data */
export interface ImageOutput {
    /** Raw RGBA pixel data */
    data: Uint8ClampedArray;
    /** Output width in pixels */
    width: number;
    /** Output height in pixels */
    height: number;
}
/**
 * Anything a renderer can consume as input.
 *
 * ImageBitmap is the most efficient choice when the pixels come from a
 * decoded image, video frame or another canvas: it is uploaded to the GPU
 * directly (often zero-copy) without ever materialising an RGBA array in
 * JS memory.
 */
export type RenderSource = ImageInput | ImageData | ImageBitmap;
/** Base renderer interface */
export interface Renderer<TOptions = object> {
    /** Check if renderer is ready for use */
    isReady(): boolean;
    /** Render image with given options */
    render(input: RenderSource, options?: TOptions): ImageOutput;
    /** Dispose of renderer resources */
    dispose(): void;
}
/** CRT effect options */
export interface CrtOptions {
    /** Output scale factor (2-32, default: 3) */
    scale?: number;
    /** Horizontal warp amount (default: 0.015) */
    warpX?: number;
    /** Vertical warp amount (default: 0.02) */
    warpY?: number;
    /** Scanline hardness, negative values (default: -4.0) */
    scanHardness?: number;
    /** Scanline opacity (0-1, default: 0.5) */
    scanOpacity?: number;
    /** Shadow mask opacity (0-1, default: 0.3) */
    maskOpacity?: number;
    /** Enable barrel distortion (default: true) */
    enableWarp?: boolean;
    /** Enable scanline effect (default: true) */
    enableScanlines?: boolean;
    /** Enable shadow mask (default: true) */
    enableMask?: boolean;
}
/** Hexagonal grid orientation */
export type HexOrientation = 'flat-top' | 'pointy-top';
/** Hexagonal grid options */
export interface HexOptions {
    /** Output scale factor (2-32, default: 16) */
    scale?: number;
    /** Hexagon orientation (default: 'flat-top') */
    orientation?: HexOrientation;
    /** Draw borders between hexagons (default: false) */
    drawBorders?: boolean;
    /** Border color as CSS color string or RGBA number (default: '#282828') */
    borderColor?: string | number;
    /** Border thickness in pixels (default: 1) */
    borderThickness?: number;
    /** Background color for out-of-bounds areas (default: 'transparent') */
    backgroundColor?: string | number;
}
/** xBRZ scaling options */
export interface XbrzOptions {
    /** Output scale factor (2-8, default: 2) */
    scale?: number;
    /** Color equality tolerance (0-255, default: 30) */
    equalColorTolerance?: number;
    /** Center direction bias for corner detection (default: 4.0) */
    centerDirectionBias?: number;
    /** Dominant direction threshold (default: 3.6) */
    dominantDirectionThreshold?: number;
    /** Steep direction threshold (default: 2.2) */
    steepDirectionThreshold?: number;
}
/**
 * Input of the depixelize vectorizer: `ImageData` or any `{ width, height,
 * data }` with RGBA (or RGB: `data.length` of `width * height * 3`) bytes,
 * row-major.
 */
export interface DepixelizeInput {
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
    /** RGBA or RGB pixel data */
    data: Uint8ClampedArray | Uint8Array | ArrayLike<number>;
}
/** How depixelize groups pixels into regions. */
export type DepixelizeMode = 'auto' | 'cell' | 'shape';
/**
 * Depixelize options (pixel art to SVG, Kopf & Lischinski 2011). Same
 * meaning and defaults as `@pixagram/upscaler/depixelize` and depixelize.js.
 */
export interface DepixelizeOptions {
    /** Output size: SVG width/height = image size x scale (default 40). Geometry is in pixel units (viewBox). */
    scale?: number;
    /**
     * Decimals of the coordinates, in pixel units (0-6). 'auto' (default) picks
     * the coarsest grid keeping every point within 1/4 output pixel at `scale`
     * (2 decimals at scale 40, 1 at scale 4).
     */
    precision?: number | 'auto';
    /**
     * Region grouping (default 'auto'): 'cell' = similar pixels, as in the paper
     * (colour varies smoothly inside a region); 'shape' = identical pixels
     * (every colour boundary becomes a curve); 'auto' = decided per region.
     */
    mode?: DepixelizeMode;
    /**
     * Curve smoothing (default true): true = the paper's random relaxation;
     * 'fast' = deterministic pattern search on the same energy, about as
     * smooth in a fraction of the time; false = off.
     */
    smooth?: boolean | 'fast';
    /** Relaxation sweeps (default 20; the maximum in fast mode). */
    iterations?: number;
    /** Random candidates per control point per sweep (default 20; unused in fast mode). */
    guesses?: number;
    /** Maximum displacement of one candidate, in pixels (default 0.05; fast mode starts at 2x this). */
    guessOffset?: number;
    /** Sigma in pixels of the colour interpolation inside multi-colour regions; 0 = flat (default 0.7). */
    shading?: number;
    /** PRNG seed; the output is deterministic (default 1). */
    seed?: number;
    /** Prefix for the ids inside the SVG (default: a hash of image + options). */
    idPrefix?: string;
}
//# sourceMappingURL=types.d.ts.map