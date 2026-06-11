use std::sync::OnceLock;

use super::pixel::Pixel;

/// Reinterpret u8 bits as i8
#[inline(always)]
fn u8_as_i8(v: u8) -> i8 {
    v as i8
}

/// Reinterpret i8 bits as u8
#[inline(always)]
fn i8_as_u8(v: i8) -> u8 {
    v as u8
}

pub(crate) enum YCbCrLookup {
    IDiff555(Box<[f32]>),
    IDiff888(Box<[f32]>),
}

/// `OnceLock` replaces the previous `static mut Option<..> + parking_lot::Once`
/// pair. It is safe for concurrent readers (required by the `parallel`
/// feature), guarantees single initialisation, and removes the
/// `static_mut_refs` undefined behaviour the old code had.
static LOOKUP_INSTANCE: OnceLock<YCbCrLookup> = OnceLock::new();

/// `i as f32 / 255.0` for every i, precomputed at compile time.
///
/// `dist` runs ~10+ times per source pixel in the xBRZ hot path and previously
/// performed two f32 *divisions* per call (LLVM cannot turn `x / 255.0` into a
/// multiply because 1/255 is not exactly representable). Indexing this table
/// is bit-identical to the original division, so output bytes do not change.
static ALPHA_UNORM: [f32; 256] = {
    let mut t = [0.0f32; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = i as f32 / 255.0;
        i += 1;
    }
    t
};

#[inline]
fn dist_ycbcr(r_diff: i16, g_diff: i16, b_diff: i16) -> f64 {
    let r_diff = r_diff as f64;
    let g_diff = g_diff as f64;
    let b_diff = b_diff as f64;

    // using Rec.2020 RGB -> YCbCr conversion
    const K_B: f64 = 0.0593;
    const K_R: f64 = 0.2627;
    const K_G: f64 = 1.0 - K_B - K_R;

    const SCALE_B: f64 = 0.5 / (1.0 - K_B);
    const SCALE_R: f64 = 0.5 / (1.0 - K_R);

    let y = K_R * r_diff + K_G * g_diff + K_B * b_diff;
    let c_b = SCALE_B * (b_diff - y);
    let c_r = SCALE_R * (r_diff - y);

    (y * y + c_b * c_b + c_r * c_r).sqrt()
}

impl YCbCrLookup {
    #[inline]
    pub(crate) fn instance() -> &'static Self {
        LOOKUP_INSTANCE.get_or_init(Self::new)
    }

    /// Build the table now (used to warm it up on the calling thread before
    /// the parallel scaler reads it through [`instance_unchecked`]).
    #[inline]
    pub(crate) fn initialise() {
        let _ = Self::instance();
    }

    /// # Safety
    /// [`initialise`](Self::initialise) (or any call to
    /// [`instance`](Self::instance)) must have completed first.
    #[inline]
    pub(crate) unsafe fn instance_unchecked() -> &'static Self {
        // SAFETY: caller guarantees the cell is populated.
        unsafe { LOOKUP_INSTANCE.get().unwrap_unchecked() }
    }

    pub(crate) fn instance_is_initialised() -> bool {
        LOOKUP_INSTANCE.get().is_some()
    }

    fn new() -> Self {
        #[cfg(feature = "large_lut")]
        {
            Self::new_large()
        }
        #[cfg(not(feature = "large_lut"))]
        {
            Self::new_small()
        }
    }

    pub(crate) fn new_small() -> Self {
        let mut lookup = Vec::with_capacity(0x8000);

        for i in 0..0x8000 {
            let r_diff = u8_as_i8((((i >> 10) & 0x1F) << 3) as u8) as i16 * 2;
            let g_diff = u8_as_i8((((i >> 5) & 0x1F) << 3) as u8) as i16 * 2;
            let b_diff = u8_as_i8(((i & 0x1F) << 3) as u8) as i16 * 2;

            lookup.push(dist_ycbcr(r_diff, g_diff, b_diff) as f32);
        }

        Self::IDiff555(lookup.into_boxed_slice())
    }

    pub(crate) fn new_large() -> Self {
        let mut lookup = Vec::with_capacity(0x100_0000);

        for i in 0..0x100_0000 {
            let r_diff = u8_as_i8(((i >> 16) & 0xFF) as u8) as i16 * 2;
            let g_diff = u8_as_i8(((i >> 8) & 0xFF) as u8) as i16 * 2;
            let b_diff = u8_as_i8((i & 0xFF) as u8) as i16 * 2;

            lookup.push(dist_ycbcr(r_diff, g_diff, b_diff) as f32);
        }

        Self::IDiff888(lookup.into_boxed_slice())
    }

    #[inline]
    pub(crate) fn dist_rgb(&self, rgb1: [u8; 3], rgb2: [u8; 3]) -> f32 {
        let [r1, g1, b1] = rgb1;
        let [r2, g2, b2] = rgb2;
        let r_part: u8 = i8_as_u8((((r1 as i16) - (r2 as i16)) / 2) as i8);
        let g_part: u8 = i8_as_u8((((g1 as i16) - (g2 as i16)) / 2) as i8);
        let b_part: u8 = i8_as_u8((((b1 as i16) - (b2 as i16)) / 2) as i8);

        match self {
            YCbCrLookup::IDiff555(lookup) => {
                lookup[(((r_part as usize) >> 3) << 10)
                    | (((g_part as usize) >> 3) << 5)
                    | ((b_part as usize) >> 3)]
            }
            YCbCrLookup::IDiff888(lookup) => {
                lookup[((r_part as usize) << 16) | ((g_part as usize) << 8) | (b_part as usize)]
            }
        }
    }

    pub(crate) fn dist<P: Pixel>(&self, pix1: P, pix2: P) -> f32 {
        // Table lookup instead of `alpha() as f32 / 255.0`: same bits, no divide.
        let a1 = ALPHA_UNORM[pix1.alpha() as usize];
        let a2 = ALPHA_UNORM[pix2.alpha() as usize];

        let d = self.dist_rgb(pix1.to_rgb(), pix2.to_rgb());
        if a1 < a2 {
            a1 * d + 255.0 * (a2 - a1)
        } else {
            a2 * d + 255.0 * (a1 - a2)
        }
    }
}

#[cfg(test)]
mod test {
    use super::super::pixel::Rgb8;
    use super::{dist_ycbcr, YCbCrLookup, ALPHA_UNORM};

    #[test]
    fn alpha_unorm_matches_division() {
        for i in 0..=255usize {
            assert_eq!(ALPHA_UNORM[i], i as f32 / 255.0);
        }
    }

    fn test_lut(lut: &YCbCrLookup, rgb1: (u8, u8, u8), rgb2: (u8, u8, u8)) {
        let (r1, g1, b1) = rgb1;
        let (r2, g2, b2) = rgb2;
        let r_diff = (r1 as i16) - (r2 as i16);
        let g_diff = (g1 as i16) - (g2 as i16);
        let b_diff = (b1 as i16) - (b2 as i16);

        let dist = dist_ycbcr(r_diff, g_diff, b_diff) as f32;
        let lut_dist = lut.dist(Rgb8::from_parts(r1, g1, b1), Rgb8::from_parts(r2, g2, b2));
        assert_eq!(dist, lut_dist)
    }

    fn test_whole_lut(lut: &YCbCrLookup) {
        for r1 in (0..=0xFF).step_by(16) {
            for g1 in (0..=0xFF).step_by(16) {
                for b1 in (0..=0xFF).step_by(16) {
                    for r2 in (0..=0xFF).step_by(16) {
                        for g2 in (0..=0xFF).step_by(16) {
                            for b2 in (0..=0xFF).step_by(16) {
                                test_lut(lut, (r1, g1, b1), (r2, g2, b2))
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn test_large_lut() {
        let lookup = YCbCrLookup::new_large();
        test_whole_lut(&lookup);
    }

    #[test]
    fn test_small_lut() {
        let lookup = YCbCrLookup::new_small();
        test_whole_lut(&lookup);
    }
}
