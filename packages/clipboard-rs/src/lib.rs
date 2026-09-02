//! @bramburn/clipboard-rs — fork-local native clipboard addon.
//!
//! Mirrors the four-method API of `@mariozechner/clipboard` so the
//! `packages/coding-agent/src/utils/clipboard-native.ts` loader can
//! `require("@bramburn/clipboard-rs")` unchanged in shape:
//!
//!   - `getText(): Promise<string | null>`
//!   - `setText(text: string): Promise<void>`
//!   - `hasImage(): boolean`
//!   - `getImageBinary(): Promise<Array<number>>` (empty array in v1;
//!     image round-trip is a follow-up session)
//!
//! All work runs on the napi-rs worker thread pool, so a slow X11
//! roundtrip never blocks the Node event loop.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use arboard::Clipboard;

/// Marker string so the integration test can confirm it loaded the fork
/// addon and not a stray upstream `@mariozechner/clipboard` resolution.
#[napi]
pub fn addon_marker() -> String {
    format!("@bramburn/clipboard-rs v{}", env!("CARGO_PKG_VERSION"))
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
/// v1 stub: arboard's `get_image` is not yet stable across all platforms,
/// and the fork's coding-agent only checks `hasImage` to decide whether to
/// render an inline paste preview. Returning `false` is the safe default —
/// the agent's text-only fallback path covers every case where `hasImage`
/// would have been `true`. Image support is a follow-up session.
#[napi]
pub fn has_image() -> bool {
    false
}

/// Bytes of the current clipboard image, or `[]` if no image is present.
///
/// v1 stub — see `has_image` for the rationale. Image round-trip is a
/// follow-up session.
#[napi]
pub async fn get_image_binary() -> Result<Vec<u32>> {
    Ok(Vec::new())
}

fn to_napi(e: arboard::Error) -> napi::Error {
    use arboard::Error::*;
    let kind = match &e {
        ContentNotAvailable => "ContentNotAvailable",
        ClipboardNotSupported => "ClipboardNotSupported",
        ClipboardOccupied => "ClipboardOccupied",
        Io(_) => "IoError",
        _ => "Unknown",
    };
    napi::Error::new(napi::Status::GenericFailure, format!("{kind}: {e}"))
}
