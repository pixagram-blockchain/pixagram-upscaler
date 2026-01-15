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

/** Base renderer interface */
export interface Renderer<TOptions = object> {
  /** Check if renderer is ready for use */
  isReady(): boolean;
  /** Render image with given options */
  render(input: ImageInput | ImageData, options?: TOptions): ImageOutput;
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
  /** Output scale factor (2-6, default: 2) */
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
