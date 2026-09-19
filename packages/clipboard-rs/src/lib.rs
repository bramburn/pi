//! @bramburn/clipboard-rs — fork-local native clipboard addon.
//!
//! Mirrors the four-method API of `@mariozechner/clipboard` so the
//! `packages/coding-agent/src/utils/clipboard-native.ts` loader can
//! `require("@bramburn/clipboard-rs")` unchanged in shape:
//!
//!   - `getText(): Promise<string | null>`
//!   - `setText(text: string): Promise<void>`
//!   - `hasImage(): boolean`
//!   - `getImageBinary(): Promise<Array<number>>` (PNG-encoded RGBA bytes)
//!
//! All work runs on the napi-rs worker thread pool, so a slow X11
//! roundtrip never blocks the Node event loop.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use arboard::Clipboard;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};

/// Marker string so the integration test can confirm it loaded the fork
/// addon and not a stray upstream `@mariozechner/clipboard` resolution.
///
/// The cargo package name is `pi-clipboard-rs` (Cargo forbids `@` and `/`
/// in `[package].name`). The npm-distribution name has `@earendil-works/`
/// or `@bramburn/` prepended by `fork-publish-rename.mjs` at publish time.
/// The integration test asserts the marker starts with `pi-clipboard-rs v`
/// to accept both pre- and post-rename forms.
#[napi]
pub fn addon_marker() -> String {
    format!("{} v{}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
}

/// Read plain text from the system clipboard. Returns `null` if the
/// clipboard is empty or holds a non-text payload.
#[napi]
pub async fn get_text() -> Result<Option<String>> {
    let mut cb = Clipboard::new().map_err(to_napi)?;
    match cb.get_text() {
        Ok(text) => Ok(Some(text)),
        // arboard returns ContentNotAvailable when the clipboard holds a
        // non-text payload. We treat that as `null` to match the upstream
        // @mariozechner/clipboard contract.
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(to_napi(e)),
    }
}

/// Write plain text to the system clipboard.
#[napi]
pub async fn set_text(text: String) -> Result<()> {
    let mut cb = Clipboard::new().map_err(to_napi)?;
    cb.set_text(text).map_err(to_napi)
}

/// `true` if the clipboard currently holds an image.
///
/// Probes `Clipboard::get_image()` and returns `false` on any error,
/// including `ContentNotAvailable`. The TS-side contract treats both "no
/// image" and "transfer failed" the same way: try the next clipboard
/// backend, fall back to PowerShell on Windows, etc.
#[napi]
pub fn has_image() -> bool {
    let Ok(mut cb) = Clipboard::new() else {
        return false;
    };
    matches!(cb.get_image(), Ok(img) if img.width > 0 && img.height > 0)
}

/// Bytes of the current clipboard image encoded as PNG, or `[]` if no
/// image is present.
///
/// arboard hands back raw RGBA pixels. We wrap them with the `image`
/// crate (PNG encoder only, no JPEG/GIF/WebP) and emit a PNG byte
/// stream. The TS-side contract treats the result as `Array<number>` so
/// we keep the napi-rs `number[]` shape (`Vec<u32>`).
#[napi]
pub async fn get_image_binary() -> Result<Vec<u32>> {
    let mut cb = Clipboard::new().map_err(to_napi)?;
    let img = match cb.get_image() {
        Ok(img) => img,
        // arboard returns ContentNotAvailable when the clipboard holds a
        // non-image payload. We surface that as an empty PNG byte stream
        // (`Ok(Vec::new())`) so the TS layer can treat it the same as a
        // miss rather than throwing.
        Err(arboard::Error::ContentNotAvailable) => return Ok(Vec::new()),
        Err(e) => return Err(to_napi(e)),
    };

    let width = img.width as u32;
    let height = img.height as u32;
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }

    // arboard's RGBA buffer length must be exactly width*height*4. If
    // not, we bail with a napi error rather than panic in the encoder.
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4));
    let Some(expected) = expected else {
        return Err(napi::Error::new(
            napi::Status::GenericFailure,
            format!("image dimensions overflow: {width}x{height}"),
        ));
    };
    if img.bytes.len() != expected {
        return Err(napi::Error::new(
            napi::Status::GenericFailure,
            format!(
                "RGBA buffer length mismatch: got {}, expected {} for {}x{}",
                img.bytes.len(),
                expected,
                width,
                height
            ),
        ));
    }

    let mut png = Vec::with_capacity(expected / 4);
    let encoder = PngEncoder::new(&mut png);
    encoder
        .write_image(&img.bytes, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("PNG encode failed: {e}")))?;

    // Convert the PNG byte stream to `Vec<u32>` so the napi-rs TS binding
    // continues to expose `Array<number>` (one slot per byte). The TS
    // loader converts it back to Uint8Array.
    Ok(png.into_iter().map(u32::from).collect())
}

fn to_napi(e: arboard::Error) -> napi::Error {
    let kind = match &e {
        arboard::Error::ContentNotAvailable => "ContentNotAvailable",
        arboard::Error::ClipboardNotSupported => "ClipboardNotSupported",
        arboard::Error::ClipboardOccupied => "ClipboardOccupied",
        _ => "Unknown",
    };
    napi::Error::new(napi::Status::GenericFailure, format!("{kind}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_napi_maps_known_variants() {
        // arboard::Error doesn't implement PartialEq, but we can check
        // the message starts with the expected kind label.
        let err = to_napi(arboard::Error::ContentNotAvailable);
        assert!(err.to_string().contains("ContentNotAvailable"));

        let err = to_napi(arboard::Error::ClipboardOccupied);
        assert!(err.to_string().contains("ClipboardOccupied"));
    }

    #[test]
    fn png_byte_length_matches_buffer() {
        // Sanity check: 1x1 RGBA PNG is small but non-empty.
        let rgba: Vec<u8> = vec![255, 0, 0, 255];
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&rgba, 1, 1, ExtendedColorType::Rgba8)
            .unwrap();
        // PNG signature is 8 bytes; we expect a few more for IHDR + IDAT.
        assert!(png.len() > 8, "PNG output too small: {} bytes", png.len());
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    }
}