//! Per-image analysis: exposure statistics, sharpness, perceptual hash,
//! capture time and thumbnail generation.

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, metadata::Orientation, DynamicImage,
    GrayImage, ImageDecoder, ImageReader,
};
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::BufReader,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

pub const EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "gif"];
const ANALYSIS_SIZE: u32 = 1024;
const THUMB_SIZE: u32 = 512;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub width: u32,
    pub height: u32,
    /// Capture time in ms (EXIF local time interpreted as UTC, or file mtime).
    pub taken_ms: i64,
    /// Mean luma 0..255.
    pub mean: f32,
    /// Fraction of near-white pixels (luma >= 240).
    pub bright: f32,
    /// Fraction of near-black pixels (luma <= 15).
    pub dark: f32,
    /// Variance of the Laplacian on a normalized 1024px image; higher = sharper.
    pub sharp: f32,
    /// 256-bit difference hash as 64 hex chars.
    pub hash: String,
    /// Absolute path of the cached JPEG thumbnail.
    pub thumb: String,
}

pub fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn collect(folders: &[String], recursive: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for f in folders {
        let mut w = WalkDir::new(f).follow_links(false);
        if !recursive {
            w = w.max_depth(1);
        }
        let it = w
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
        for e in it.flatten() {
            if e.file_type().is_file() && is_image(e.path()) {
                out.push(e.into_path());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn capture_ms(path: &Path, meta: &fs::Metadata) -> i64 {
    if let Ok(f) = fs::File::open(path) {
        let mut r = BufReader::new(f);
        if let Ok(ex) = exif::Reader::new().read_from_container(&mut r) {
            let field = ex
                .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
                .or_else(|| ex.get_field(exif::Tag::DateTime, exif::In::PRIMARY));
            if let Some(f) = field {
                let s = f.display_value().to_string();
                if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S")
                {
                    let mut ms = dt.and_utc().timestamp_millis();
                    if let Some(sub) = ex.get_field(exif::Tag::SubSecTimeOriginal, exif::In::PRIMARY)
                    {
                        let digits: String = sub
                            .display_value()
                            .to_string()
                            .chars()
                            .filter(|c| c.is_ascii_digit())
                            .take(3)
                            .collect();
                        if !digits.is_empty() {
                            let scale = 10i64.pow(3 - digits.len() as u32);
                            ms += digits.parse::<i64>().unwrap_or(0) * scale;
                        }
                    }
                    return ms;
                }
            }
        }
    }
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn laplacian_var(g: &GrayImage) -> f32 {
    let (w, h) = (g.width() as usize, g.height() as usize);
    if w < 3 || h < 3 {
        return 0.0;
    }
    let raw = g.as_raw();
    let (mut s, mut s2, mut n) = (0f64, 0f64, 0f64);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x;
            let l = 4 * raw[i] as i32
                - raw[i - 1] as i32
                - raw[i + 1] as i32
                - raw[i - w] as i32
                - raw[i + w] as i32;
            let l = l as f64;
            s += l;
            s2 += l * l;
            n += 1.0;
        }
    }
    let m = s / n;
    (s2 / n - m * m).max(0.0) as f32
}

/// 16x16 difference hash -> 256 bits.
fn dhash(gray: &GrayImage) -> [u8; 32] {
    let small = image::imageops::resize(gray, 17, 16, FilterType::Triangle);
    let mut out = [0u8; 32];
    for y in 0..16u32 {
        for x in 0..16u32 {
            if small.get_pixel(x, y).0[0] < small.get_pixel(x + 1, y).0[0] {
                let bit = (y * 16 + x) as usize;
                out[bit / 8] |= 1 << (bit % 8);
            }
        }
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn thumb_path(dir: &Path, path: &Path, meta: &fs::Metadata) -> PathBuf {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    THUMB_SIZE.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified().ok().hash(&mut h);
    dir.join(format!("{:016x}.jpg", h.finish()))
}

fn fit(img: &DynamicImage, max: u32) -> DynamicImage {
    if img.width().max(img.height()) <= max {
        img.clone()
    } else {
        img.resize(max, max, FilterType::Triangle)
    }
}

pub fn analyze(path: &Path, thumb_dir: &Path) -> Result<Photo, String> {
    let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
    let meta = fs::metadata(path).map_err(|e| err(&e))?;

    let reader = ImageReader::open(path)
        .map_err(|e| err(&e))?
        .with_guessed_format()
        .map_err(|e| err(&e))?;
    let mut dec = reader.into_decoder().map_err(|e| err(&e))?;
    let orient = dec.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| err(&e))?;
    img.apply_orientation(orient);
    let (width, height) = (img.width(), img.height());

    let small = fit(&img, ANALYSIS_SIZE);
    drop(img);
    let gray = small.to_luma8();

    let n = (gray.width() * gray.height()).max(1) as f64;
    let (mut sum, mut br, mut dk) = (0u64, 0u64, 0u64);
    for p in gray.pixels() {
        let v = p.0[0];
        sum += v as u64;
        br += (v >= 240) as u64;
        dk += (v <= 15) as u64;
    }
    let sharp = laplacian_var(&gray);
    let hash = hex(&dhash(&gray));

    let tp = thumb_path(thumb_dir, path, &meta);
    if !tp.exists() {
        let t = fit(&small, THUMB_SIZE).to_rgb8();
        let f = fs::File::create(&tp).map_err(|e| err(&e))?;
        let enc = JpegEncoder::new_with_quality(std::io::BufWriter::new(f), 78);
        t.write_with_encoder(enc).map_err(|e| err(&e))?;
    }

    Ok(Photo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: meta.len(),
        width,
        height,
        taken_ms: capture_ms(path, &meta),
        mean: (sum as f64 / n) as f32,
        bright: (br as f64 / n) as f32,
        dark: (dk as f64 / n) as f32,
        sharp,
        hash,
        thumb: tp.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{imageops, Rgb, RgbImage};

    fn pattern(seed: u32, lo: u8, hi: u8) -> RgbImage {
        // Deterministic pseudo-random blocks: lots of edges.
        RgbImage::from_fn(800, 600, |x, y| {
            let mut v = (x / 8).wrapping_mul(73856093) ^ (y / 8).wrapping_mul(19349663) ^ seed;
            v = v.wrapping_mul(2654435761);
            let g = lo as u32 + (v >> 24) % (hi as u32 - lo as u32 + 1);
            Rgb([g as u8, g as u8, g as u8])
        })
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("photocleaner-test-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    fn run(img: &RgbImage, name: &str) -> Photo {
        let p = tmp(name);
        img.save(&p).unwrap();
        analyze(&p, &tmp("")).unwrap()
    }

    #[test]
    fn exposure_and_blur() {
        let sharp = pattern(1, 40, 220);
        let blurred = imageops::blur(&sharp, 6.0);
        let over = pattern(1, 225, 255);
        let under = pattern(1, 0, 25);

        let ps = run(&sharp, "sharp.png");
        let pb = run(&blurred, "blur.png");
        let po = run(&over, "over.png");
        let pu = run(&under, "under.png");

        assert!(ps.sharp > pb.sharp * 5.0, "{} vs {}", ps.sharp, pb.sharp);
        assert!(po.mean > 225.0 && po.bright > 0.5, "{po:?}");
        assert!(pu.mean < 30.0 && pu.dark > 0.3, "{pu:?}");
        assert!((ps.mean - 130.0).abs() < 20.0);
        assert!(!ps.hash.is_empty() && fs::metadata(&ps.thumb).is_ok());
    }

    /// Manual calibration helper: `PC_DIR=~/Pictures cargo test dump -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dump() {
        let dir = std::env::var("PC_DIR").expect("set PC_DIR");
        let files = collect(&[dir], true);
        let t = std::time::Instant::now();
        let out = tmp("dump-thumbs");
        fs::create_dir_all(&out).unwrap();
        for f in files.iter().take(80) {
            match analyze(f, &out) {
                Ok(p) => println!(
                    "{:>7.1} sharp {:>8.1} mean {:>5.1} br {:.2} dk {:.2} {}x{} {}",
                    0.0, p.sharp, p.mean, p.bright, p.dark, p.width, p.height, p.name
                ),
                Err(e) => println!("ERR {e}"),
            }
        }
        println!("{} files in {:?}", files.len().min(80), t.elapsed());
    }

    #[test]
    fn hash_similarity() {
        let a = pattern(1, 40, 220);
        let mut b = a.clone();
        for p in b.pixels_mut() {
            for c in p.0.iter_mut() {
                *c = c.saturating_add(12);
            }
        }
        let c = pattern(99, 40, 220);
        let (pa, pb, pc) = (run(&a, "a.png"), run(&b, "b.png"), run(&c, "c.png"));
        let dist = |x: &str, y: &str| -> u32 {
            (0..32)
                .map(|i| {
                    let bx = u8::from_str_radix(&x[i * 2..i * 2 + 2], 16).unwrap();
                    let by = u8::from_str_radix(&y[i * 2..i * 2 + 2], 16).unwrap();
                    (bx ^ by).count_ones()
                })
                .sum()
        };
        assert!(dist(&pa.hash, &pb.hash) < 20, "{}", dist(&pa.hash, &pb.hash));
        assert!(dist(&pa.hash, &pc.hash) > 60, "{}", dist(&pa.hash, &pc.hash));
    }
}
