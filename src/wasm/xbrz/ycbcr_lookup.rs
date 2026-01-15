use parking_lot::Once;

use super::pixel::Pixel;

/// Reinterpret u8 bits as i8
#[inline(always)]
fn u8_as_i8(v: u8) -> i8 {
    v as i8
}

pub(crate) enum YCbCrLookup {
    IDiff555(Box<[u32]>),
    // IDiff888(Box<[u32]>), // Large LUT disabled for WASM compactness
}

// Fixed point scale factor for distance calculations (8 bits of precision)
const SCALE_SHIFT: u32 = 8;
const SCALE: f64 = (1 << SCALE_SHIFT) as f64;

// SAFETY: Only written to once by the closure in instance(), which is mediated by a parking_lot::Once.
static mut LOOKUP_INSTANCE: Option<YCbCrLookup> = None;
static LOOKUP_LOCK: Once = Once::new();

#[inline]
fn dist_ycbcr(r_diff: i16, g_diff: i16, b_diff: i16) -> u32 {
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

    let dist = (y * y + c_b * c_b + c_r * c_r).sqrt();
    
    // Store as fixed point u32
    (dist * SCALE + 0.5) as u32
}

impl YCbCrLookup {
    #[inline]
    pub(crate) fn instance() -> &'static Self {
        Self::initialise();

        unsafe { Self::instance_unchecked() }
    }

    #[inline]
    pub(crate) fn initialise() {
        LOOKUP_LOCK.call_once(|| unsafe {
            // Defaulting to small LUT for WASM
            LOOKUP_INSTANCE = Some(Self::new_small());
        });
    }

    #[inline]
    pub(crate) unsafe fn instance_unchecked() -> &'static Self {
        unsafe { LOOKUP_INSTANCE.as_ref().unwrap_unchecked() }
    }

    pub(crate) fn instance_is_initialised() -> bool {
        unsafe { LOOKUP_INSTANCE.is_some() }
    }

    pub(crate) fn new_small() -> Self {
        let mut lookup = Vec::with_capacity(0x8000);

        for i in 0..0x8000 {
            let r_diff = u8_as_i8((((i >> 10) & 0x1F) << 3) as u8) as i16 * 2;
            let g_diff = u8_as_i8((((i >> 5) & 0x1F) << 3) as u8) as i16 * 2;
            let b_diff = u8_as_i8(((i & 0x1F) << 3) as u8) as i16 * 2;

            lookup.push(dist_ycbcr(r_diff, g_diff, b_diff));
        }

        Self::IDiff555(lookup.into_boxed_slice())
    }

    #[inline(always)]
    pub(crate) fn dist_rgb(&self, rgb1: [u8; 3], rgb2: [u8; 3]) -> u32 {
        let [r1, g1, b1] = rgb1;
        let [r2, g2, b2] = rgb2;
        
        // Correct casting: (diff / 2) -> i8 -> u8 (bitwise reinterpretation)
        let r_part = (((r1 as i16) - (r2 as i16)) / 2) as i8 as u8;
        let g_part = (((g1 as i16) - (g2 as i16)) / 2) as i8 as u8;
        let b_part = (((b1 as i16) - (b2 as i16)) / 2) as i8 as u8;

        match self {
            YCbCrLookup::IDiff555(lookup) => {
                unsafe {
                    *lookup.get_unchecked(
                        (((r_part as usize) >> 3) << 10)
                        | (((g_part as usize) >> 3) << 5)
                        | ((b_part as usize) >> 3)
                    )
                }
            }
        }
    }

    #[inline(always)]
    pub(crate) fn dist<P: Pixel>(&self, pix1: P, pix2: P) -> u32 {
        let a1 = pix1.alpha();
        let a2 = pix2.alpha();

        if a1 == 255 && a2 == 255 {
            return self.dist_rgb(pix1.to_rgb(), pix2.to_rgb());
        }

        let d = self.dist_rgb(pix1.to_rgb(), pix2.to_rgb());
        
        let (a_min, a_diff) = if a1 < a2 {
            (a1 as u32, (a2 - a1) as u32)
        } else {
            (a2 as u32, (a1 - a2) as u32)
        };

        // (d * a_min) / 255 + (a_diff * 255 * 256)
        // We use >> 8 approx for / 255, and 65280 for 255 * 256
        ((d * a_min) >> 8) + (a_diff * 65280)
    }
}
