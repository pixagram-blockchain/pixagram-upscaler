# xBRZ table tooling

The 7x and 8x xBRZ blend tables extend Zenju's hand-written 2x..6x tables with
the same cut geometry. Two scripts derive and emit them.

## `gen_xbrz_tables.py`

Derives every blend weight analytically, as the area of each destination
sub-pixel covered by the edge shape (canonical rotation = bottom-right corner,
unit source pixel, y down):

| shape | region |
|-------|--------|
| shallow line | `y >= 1 - x/2` |
| steep line | `x >= 1 - y/2` |
| steep + shallow | union of both (exact union area at the crossing pixel) |
| diagonal | `x + y >= 3/2` |
| corner | outside the circle of radius 1/2 inscribed in the source pixel, rounded to /100 |

Before emitting anything it **re-derives Zenju's 2x..6x tables and checks every
constant**. The single waiver is the reference 5x steep+shallow, which uses 2/3
at the crossing pixel where the exact union is 5/6; Zenju's own 2x and 4x use
the exact union, so 7x and 8x do too. It writes `scaler{7,8}x.rs` (macro form)
and `glsl_tables_{7,8}x.txt` to `$XBRZ_WORK_DIR` (default `src/tools/out/`).

## `gen_shaders.py`

Assembles the complete `XBRZ_FRAG_7X` / `XBRZ_FRAG_8X` fragment shaders from the
GLSL tables. Instead of an unrolled `dst[N*N]` register array, each fragment
looks up the weight of its own sub-pixel per rotation. `src/xbrz-shaders.ts`
contains exactly this output.

The shaders follow the same conventions as every other scale and as the Rust
engine:

- pixel identity is exact `vec4` equality (all four channels);
- the line-shape test (`haveShallowLine` / `haveSteepLine`) uses exact
  inequality, as in Zenju's xBRZ 1.8;
- the colour tolerance (`IsPixEqual`) is used only by the insular-pixel and
  L-shape rules.

## Consistency checks

- The Rust engine (`src/wasm/xbrz/scaler.rs`) holds all tables as data. Its
  unit tests check bounds, distinct cells, the rotation mapping and the exact
  integer gradient.
- Cross-check the generator against the engine by comparing the emitted
  `scaler{7,8}x.rs` cells with the `T7_*` / `T8_*` constants.
- The GPU shaders and the WASM engine agree to within +-2 levels in the image
  interior at every scale. They still differ at the image border: the GPU
  clamps to the edge, while WASM treats outside pixels as transparent (the
  ARGB-mode behaviour of Zenju's reference).
