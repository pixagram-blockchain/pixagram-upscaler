/**
 * xBRZ Shader Constants
 * Separated from renderer for cleaner code organization
 */
export declare const XBRZ_VERTEX_SHADER = "#version 300 es\nlayout(location = 0) in vec2 position;\nuniform vec2 uInputRes;\n// uFlipY: 0.0 -> orientation for top-down readPixels output;\n//         1.0 -> orientation for direct canvas / ImageBitmap presentation.\n// Applied before the neighbour taps are derived, so the whole 5x5 kernel\n// stays consistent in input-texture space.\nuniform float uFlipY;\n\nout vec2 vTexCoord;\nout vec4 t1;\nout vec4 t2;\nout vec4 t3;\nout vec4 t4;\nout vec4 t5;\nout vec4 t6;\nout vec4 t7;\n\nvoid main() {\n    vTexCoord = position * 0.5 + 0.5;\n    vTexCoord.y = mix(vTexCoord.y, 1.0 - vTexCoord.y, uFlipY);\n    gl_Position = vec4(position, 0.0, 1.0);\n\n    vec2 ps = vec2(1.0) / uInputRes;\n    float dx = ps.x;\n    float dy = ps.y;\n\n    // Pre-calculate texture lookups\n    t1 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, -2.0 * dy);\n    t2 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, -dy);\n    t3 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, 0.0);\n    t4 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, dy);\n    t5 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, 2.0 * dy);\n    t6 = vTexCoord.xyyy + vec4(-2.0 * dx, -dy, 0.0, dy);\n    t7 = vTexCoord.xyyy + vec4( 2.0 * dx, -dy, 0.0, dy);\n}";
export declare const XBRZ_FRAG_2X: string;
export declare const XBRZ_FRAG_3X: string;
export declare const XBRZ_FRAG_4X: string;
export declare const XBRZ_FRAG_5X: string;
export declare const XBRZ_FRAG_6X: string;
//# sourceMappingURL=xbrz-shaders.d.ts.map