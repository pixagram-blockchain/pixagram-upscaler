#!/usr/bin/env sh
# Builds pkg/:
#   depixelize.wasm            scalar build (any WebAssembly engine)
#   depixelize-simd.wasm       simd128 build (Chrome 91+, Firefox 89+, Safari 16.4+, Node 16.4+)
#   depixelize-wasm.mjs/.d.ts  ES module glue + types
#   depixelize-wasm.inline.js  classic <script> with both modules embedded (needs node to generate)
# Needs: rustup target add wasm32-unknown-unknown.
# wasm-opt (binaryen) is used when found on PATH or via WASM_OPT=/path.
set -eu
cd "$(dirname "$0")"
mkdir -p pkg

cargo build --release --lib --target wasm32-unknown-unknown
RUSTFLAGS="-C target-feature=+simd128" \
  cargo build --release --lib --target wasm32-unknown-unknown --target-dir target/simd

cp target/wasm32-unknown-unknown/release/depixelize.wasm pkg/depixelize.wasm
cp target/simd/wasm32-unknown-unknown/release/depixelize.wasm pkg/depixelize-simd.wasm
cp js/depixelize-wasm.mjs js/depixelize-wasm.d.ts pkg/

WASM_OPT="${WASM_OPT:-$(command -v wasm-opt || true)}"
if [ -n "$WASM_OPT" ]; then
  # rustc's default wasm32 features (the target_features section is stripped).
  # Large single-caller functions (e.g. the curve relaxation loop) are kept out
  # of line: engines with tiered wasm compilers optimise small hot functions
  # early, and compile a few big functions much more slowly.
  INLINE="--one-caller-inline-max-function-size=256"
  FEATURES="--enable-bulk-memory --enable-bulk-memory-opt --enable-multivalue --enable-mutable-globals \
    --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext"
  # shellcheck disable=SC2086
  "$WASM_OPT" -O3 $INLINE $FEATURES --strip-debug --strip-producers pkg/depixelize.wasm -o pkg/depixelize.wasm
  # shellcheck disable=SC2086
  "$WASM_OPT" -O3 $INLINE $FEATURES --enable-simd --strip-debug --strip-producers pkg/depixelize-simd.wasm -o pkg/depixelize-simd.wasm
else
  echo "note: wasm-opt not found, modules are not post-optimised" >&2
fi

if command -v node >/dev/null 2>&1; then
  node js/make-inline.mjs pkg/depixelize-wasm.mjs pkg/depixelize.wasm pkg/depixelize-simd.wasm pkg/depixelize-wasm.inline.js
else
  echo "note: node not found, depixelize-wasm.inline.js not generated" >&2
fi
ls -l pkg
