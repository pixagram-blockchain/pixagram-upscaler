//! Non-premultiplied "over" blending, as libwebp's animation decoder does it
//! (`BlendPixelRowNonPremult` / `BlendPixelNonPremult` in
//! `src/demux/anim_decode.c`).

/// Blends `src` over `dst` (both RGBA, not premultiplied).
#[inline]
pub(crate) fn over_nonpremult(src: [u8; 4], dst: [u8; 4]) -> [u8; 4] {
    let src_a = src[3] as u32;
    // libwebp only blends partially transparent pixels: its integer formula
    // is not exact at full alpha (it would turn 1 into 0).
    if src_a == 255 {
        return src;
    }
    if src_a == 0 {
        return dst;
    }
    let dst_a = dst[3] as u32;
    // Integer approximation of dst_a * (255 - src_a) / 255, as libwebp.
    let dst_factor_a = (dst_a * (256 - src_a)) >> 8;
    let blend_a = src_a + dst_factor_a; // < 256
    let scale = (1u32 << 24) / blend_a;
    let channel = |i: usize| -> u8 {
        let unscaled = src[i] as u32 * src_a + dst[i] as u32 * dst_factor_a;
        // unscaled <= 255 * blend_a, so the product stays below 2^32.
        ((unscaled as u64 * scale as u64) >> 24) as u8
    };
    [channel(0), channel(1), channel(2), blend_a as u8]
}

#[cfg(test)]
mod tests {
    use super::over_nonpremult;

    #[test]
    fn opaque_and_transparent_sources() {
        assert_eq!(over_nonpremult([1, 2, 3, 255], [9, 9, 9, 255]), [1, 2, 3, 255]);
        assert_eq!(over_nonpremult([1, 2, 3, 0], [9, 8, 7, 6]), [9, 8, 7, 6]);
        assert_eq!(over_nonpremult([200, 100, 50, 255], [0, 0, 0, 0]), [200, 100, 50, 255]);
    }

    #[test]
    fn half_alpha_over_opaque_is_close_to_the_exact_mix() {
        for (s, d) in [(0u8, 255u8), (255, 0), (100, 200), (37, 191)] {
            let out = over_nonpremult([s, s, s, 128], [d, d, d, 255]);
            let exact = (s as f64 * 128.0 + d as f64 * 127.0) / 255.0;
            assert!((out[0] as f64 - exact).abs() <= 1.5, "{s} over {d}: {out:?} vs {exact}");
            assert_eq!(out[3], 255);
        }
    }

    #[test]
    fn never_overflows() {
        for sa in 0..=255u32 {
            for da in [0u32, 1, 2, 127, 254, 255] {
                let out = over_nonpremult([255, 255, 255, sa as u8], [255, 255, 255, da as u8]);
                if sa > 0 {
                    assert!(out[0] >= 254, "sa={sa} da={da} -> {out:?}");
                }
            }
        }
    }
}
