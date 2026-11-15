//! BGRA (from Windows Graphics Capture) -> NV12 (what H.264 encoders take), with downscaling.
//! Downscaling averages every source pixel that falls into an output pixel (a box filter), which keeps
//! text readable when a 1440p/4K screen is sent at 1080p. Colors use BT.709, the HD standard.

use rayon::prelude::*;

/// Output size for a source, fitting inside `max_height` (16:9 box), never upscaling, even dimensions.
pub fn target_size(src_w: u32, src_h: u32, max_height: u32) -> (u32, u32) {
    let max_w = max_height * 16 / 9;
    let scale = (max_w as f64 / src_w as f64).min(max_height as f64 / src_h as f64).min(1.0);
    let w = ((src_w as f64 * scale) as u32).max(2) & !1;
    let h = ((src_h as f64 * scale) as u32).max(2) & !1;
    (w, h)
}

#[inline]
fn luma(r: u32, g: u32, b: u32) -> u8 {
    // BT.709 limited range, fixed point (x 1/1024).
    ((187 * r + 629 * g + 63 * b + 16 * 1024 + 512) >> 10).min(235) as u8
}

#[inline]
fn chroma(r: u32, g: u32, b: u32) -> (u8, u8) {
    let (r, g, b) = (r as i32, g as i32, b as i32);
    let u = (-103 * r - 347 * g + 450 * b + 128 * 1024 + 512) >> 10;
    let v = (450 * r - 409 * g - 41 * b + 128 * 1024 + 512) >> 10;
    (u.clamp(16, 240) as u8, v.clamp(16, 240) as u8)
}

/// Converts frames on a pool of its own, sized to half the cores (at most 4): enough to fit the frame budget
/// without waking every core of the PC for each frame. The column table is kept while the sizes stay the same.
pub struct Converter {
    pool: Option<rayon::ThreadPool>,
    cols: Vec<(usize, usize)>,
    sizes: (u32, u32),
    pub threads: usize,
}

impl Converter {
    pub fn new() -> Converter {
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get() / 2).clamp(1, 4);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).thread_name(|i| format!("linkord-nv12-{i}")).build().ok();
        Converter { pool, cols: Vec::new(), sizes: (0, 0), threads }
    }

    pub fn convert(&mut self, src: &[u8], src_w: u32, src_h: u32, stride: usize, dst_w: u32, dst_h: u32, out: &mut Vec<u8>) {
        if self.sizes != (src_w, dst_w) || self.cols.len() != dst_w as usize {
            self.cols = columns(src_w, dst_w);
            self.sizes = (src_w, dst_w);
        }
        let cols = &self.cols;
        let mut run = || bgra_to_nv12_with(src, src_h, stride, dst_w, dst_h, cols, out);
        match &self.pool {
            Some(pool) => pool.install(run),
            None => run(),
        }
    }
}

/// Source column span for each output column.
fn columns(src_w: u32, dst_w: u32) -> Vec<(usize, usize)> {
    let (sw, dw) = (src_w as usize, dst_w as usize);
    (0..dw).map(|x| (x * sw / dw, ((x + 1) * sw / dw).max(x * sw / dw + 1).min(sw))).collect()
}

/// Converts a tightly packed or padded BGRA image (`stride` bytes per row) into NV12 of `dst_w` x `dst_h`.
#[cfg(test)]
pub fn bgra_to_nv12(src: &[u8], src_w: u32, src_h: u32, stride: usize, dst_w: u32, dst_h: u32, out: &mut Vec<u8>) {
    bgra_to_nv12_with(src, src_h, stride, dst_w, dst_h, &columns(src_w, dst_w), out);
}

#[allow(clippy::too_many_arguments)]
fn bgra_to_nv12_with(src: &[u8], src_h: u32, stride: usize, dst_w: u32, dst_h: u32, cols: &[(usize, usize)], out: &mut Vec<u8>) {
    let (dw, dh) = (dst_w as usize, dst_h as usize);
    out.resize(dw * dh * 3 / 2, 0);
    let (y_plane, uv_plane) = out.split_at_mut(dw * dh);
    let sh = src_h as usize;

    // Each task handles a pair of output rows: two luma rows and the chroma row they share. The row
    // scratch buffer is made once per worker split, not once per row pair.
    y_plane
        .par_chunks_mut(dw * 2)
        .zip(uv_plane.par_chunks_mut(dw))
        .enumerate()
        .for_each_init(Vec::new, |rgb: &mut Vec<(u32, u32, u32)>, (pair, (y_rows, uv_row))| {
            rgb.resize(dw * 2, (0, 0, 0));
            for half in 0..2 {
                let oy = pair * 2 + half;
                let sy0 = oy * sh / dh;
                let sy1 = ((oy + 1) * sh / dh).max(sy0 + 1).min(sh);
                for (ox, &(sx0, sx1)) in cols.iter().enumerate() {
                    let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                    for sy in sy0..sy1 {
                        let row = &src[sy * stride..];
                        for sx in sx0..sx1 {
                            let p = &row[sx * 4..sx * 4 + 3];
                            b += p[0] as u32;
                            g += p[1] as u32;
                            r += p[2] as u32;
                        }
                    }
                    let n = ((sy1 - sy0) * (sx1 - sx0)) as u32;
                    let px = (r / n, g / n, b / n);
                    rgb[half * dw + ox] = px;
                    y_rows[half * dw + ox] = luma(px.0, px.1, px.2);
                }
            }
            for cx in 0..dw / 2 {
                let quad = [rgb[cx * 2], rgb[cx * 2 + 1], rgb[dw + cx * 2], rgb[dw + cx * 2 + 1]];
                let (r, g, b) = quad.iter().fold((0, 0, 0), |a, p| (a.0 + p.0, a.1 + p.1, a.2 + p.2));
                let (u, v) = chroma(r / 4, g / 4, b / 4);
                uv_row[cx * 2] = u;
                uv_row[cx * 2 + 1] = v;
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(target_size(3840, 2160, 1080), (1920, 1080));
        assert_eq!(target_size(2560, 1440, 720), (1280, 720));
        assert_eq!(target_size(1280, 720, 1080), (1280, 720)); // never upscale
        assert_eq!(target_size(1001, 801, 1080), (1000, 800)); // even
        assert_eq!(target_size(3440, 1440, 1080), (1920, 802)); // ultrawide fits the 16:9 box
    }

    #[test]
    fn white_and_black() {
        // 4x2 BGRA: left half white, right half black, downscaled to 2x2.
        let mut src = Vec::new();
        for _ in 0..2 {
            src.extend_from_slice(&[255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
        }
        let mut out = Vec::new();
        bgra_to_nv12(&src, 4, 2, 16, 2, 2, &mut out);
        assert_eq!(&out[..4], &[235, 16, 235, 16]);
        assert_eq!(out.len(), 6);
    }

    #[test]
    fn converter_matches_and_reuses_columns() {
        // A gradient, converted twice through the pooled converter (second time with the cached columns).
        let (w, h) = (64u32, 36u32);
        let src: Vec<u8> = (0..w * h).flat_map(|i| [(i % 251) as u8, (i % 97) as u8, (i % 13 * 19) as u8, 255]).collect();
        let mut plain = Vec::new();
        bgra_to_nv12(&src, w, h, w as usize * 4, 32, 18, &mut plain);
        let mut conv = Converter::new();
        let mut out = Vec::new();
        conv.convert(&src, w, h, w as usize * 4, 32, 18, &mut out);
        assert_eq!(out, plain);
        out.fill(0);
        conv.convert(&src, w, h, w as usize * 4, 32, 18, &mut out);
        assert_eq!(out, plain);
    }
}
