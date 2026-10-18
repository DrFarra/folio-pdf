use std::borrow::Cow;
use tauri::ipc::InvokeBody;
use base64::Engine;
use std::{collections::HashMap, sync::{LazyLock, Mutex}, time::Instant};

// Android's bridge carries JSON text: a PDF arrives as base64 slices staged
// here, each one a small message.
const BRIDGE_MAX: usize = 128 * 1024 * 1024;
static UPLOADS: LazyLock<Mutex<HashMap<String, (Instant, Vec<u8>)>>> = LazyLock::new(Default::default);
const INTERRUPTED: &str = "El envío del archivo se interrumpió. Vuelve a intentarlo.";

/// Starts a chunked upload. Uploads abandoned for a minute are dropped.
#[cfg(any(target_os = "android", test))]
#[tauri::command]
pub fn upload_begin() -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut uploads = UPLOADS.lock().map_err(|_| "No se pudo preparar el archivo.")?;
    uploads.retain(|_, (touched, _)| touched.elapsed().as_secs() < 60);
    uploads.insert(id.clone(), (Instant::now(), Vec::new()));
    Ok(id)
}

#[cfg(any(target_os = "android", test))]
#[tauri::command]
pub fn upload_chunk(id: String, base64: String) -> Result<(), String> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(&base64).map_err(|_| "El archivo contiene bytes inválidos.");
    stage(&id, decoded, BRIDGE_MAX, "Este PDF supera 128 MB y no se puede guardar en este dispositivo.")
}

// Windows' WebView hands Folio a request's body only as fast as its main process
// lets go of it, on the window's thread: a PDF of 238 MB sent in 4 MiB requests held
// the window for seconds at a time until the WebView closed. A large PDF goes instead
// through memory Folio shares with the page, which writes it there in slices.
#[cfg(windows)]
#[tauri::command(async)]
pub fn upload_shared(id: String, size: u64, webview: tauri::Webview) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_| INTERRUPTED)?;
    if size > folio_core::MAX_OUTPUT_BYTES as u64 { return Err("El archivo supera 1 GB y no se puede guardar.".into()); }
    shared::post(&webview, id, size)
}

/// The page has written the shared memory: its bytes become an upload the next command takes.
#[cfg(windows)]
#[tauri::command(async)]
pub fn upload_shared_end(id: String, webview: tauri::Webview) -> Result<(), String> {
    let bytes = shared::take(&webview, &id)?;
    UPLOADS.lock().map_err(|_| "No se pudo preparar el archivo.")?.insert(id, (Instant::now(), bytes));
    Ok(())
}

/// The page has copied a PDF Folio shared with it (`read_document_shared`).
#[cfg(windows)]
#[tauri::command(async)]
pub fn release_shared(id: String, webview: tauri::Webview) { shared::release(&webview, &id) }

#[cfg(windows)]
pub use shared::deliver;

#[cfg(windows)]
mod shared {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::{Interface, HSTRING};

    // The buffer's object belongs to the window's thread; its memory, mapped until
    // the buffer is closed, is read from any thread.
    struct Shared { buffer: ICoreWebView2SharedBuffer, data: *const u8, size: usize, posted: Instant }
    unsafe impl Send for Shared {}
    static SHARED: LazyLock<Mutex<HashMap<String, Shared>>> = LazyLock::new(Default::default);

    fn on_window_thread<T: Send + 'static>(webview: &tauri::Webview, f: impl FnOnce(tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (sender, receiver) = std::sync::mpsc::channel();
        webview.with_webview(move |platform| { let _ = sender.send(f(platform)); }).map_err(|_| INTERRUPTED)?;
        receiver.recv().map_err(|_| INTERRUPTED)?
    }

    /// Creates `size` bytes of shared memory, kept under `id`; returns their address.
    fn create(platform: &tauri::webview::PlatformWebview, id: &str, size: u64) -> Result<usize, String> {
        let mut shared = SHARED.lock().map_err(|_| "No se pudo preparar el archivo.")?;
        // Memory a page never handed back is released after a minute.
        shared.retain(|_, old| old.posted.elapsed().as_secs() < 60 || { let _ = unsafe { old.buffer.Close() }; false });
        let created = (|| -> windows_core::Result<(ICoreWebView2SharedBuffer, *mut u8)> { unsafe {
            let buffer = platform.environment().cast::<ICoreWebView2Environment12>()?.CreateSharedBuffer(size)?;
            let mut data = std::ptr::null_mut(); buffer.Buffer(&mut data)?;
            Ok((buffer, data))
        } })();
        let (buffer, data) = created.map_err(|_| "No se pudo preparar el archivo. Actualiza Microsoft Edge WebView2.")?;
        shared.insert(id.into(), Shared { buffer, data, size: size as usize, posted: Instant::now() });
        Ok(data as usize)
    }
    /// Hands the memory under `id` to the page as `sharedbufferreceived` with `message`; on failure it is released.
    fn send(platform: &tauri::webview::PlatformWebview, id: &str, access: COREWEBVIEW2_SHARED_BUFFER_ACCESS, message: String) -> Result<(), String> {
        let mut shared = SHARED.lock().map_err(|_| "No se pudo preparar el archivo.")?;
        let buffer = shared.get(id).ok_or(INTERRUPTED)?.buffer.clone();
        unsafe { platform.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_17>()).and_then(|core| core.PostSharedBufferToScript(&buffer, access, &HSTRING::from(message))) }
            .map_err(|_| { if let Some(failed) = shared.remove(id) { let _ = unsafe { failed.buffer.Close() }; } "No se pudo preparar el archivo.".to_string() })
    }

    /// Shares `size` bytes with the page, which receives them as `sharedbufferreceived` with `{folioUpload: id}`.
    pub fn post(webview: &tauri::Webview, id: String, size: u64) -> Result<(), String> {
        on_window_thread(webview, move |platform| {
            create(&platform, &id, size)?;
            send(&platform, &id, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, format!(r#"{{"folioUpload":"{id}"}}"#))
        })
    }

    /// The reverse: `fill` writes `size` bytes off the window's thread, then the page receives them
    /// read-only as `sharedbufferreceived` with `{folioDownload: id}` and gives them back (`release`).
    pub fn deliver(webview: &tauri::Webview, id: String, size: u64, fill: impl FnOnce(&mut [u8]) -> Result<(), String>) -> Result<(), String> {
        let key = id.clone();
        let data = on_window_thread(webview, move |platform| create(&platform, &key, size))?;
        if let Err(error) = fill(unsafe { std::slice::from_raw_parts_mut(data as *mut u8, size as usize) }) { release(webview, &id); return Err(error); }
        on_window_thread(webview, move |platform| send(&platform, &id, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, format!(r#"{{"folioDownload":"{id}"}}"#)))
    }

    pub fn release(webview: &tauri::Webview, id: &str) {
        let Some(shared) = SHARED.lock().ok().and_then(|mut shared| shared.remove(id)) else { return; };
        let _ = webview.with_webview(move |_| { let shared = shared; unsafe { let _ = shared.buffer.Close(); } });
    }

    /// Copies what the page wrote and closes the buffer.
    pub fn take(webview: &tauri::Webview, id: &str) -> Result<Vec<u8>, String> {
        let shared = SHARED.lock().map_err(|_| "No se pudo preparar el archivo.")?.remove(id).ok_or(INTERRUPTED)?;
        let bytes = unsafe { std::slice::from_raw_parts(shared.data, shared.size) }.to_vec();
        let _ = webview.with_webview(move |_| { let shared = shared; unsafe { let _ = shared.buffer.Close(); } });
        Ok(bytes)
    }
}

/// Adds a slice to an upload; a slice that fails drops the whole upload.
#[cfg(any(target_os = "android", test))]
fn stage(id: &str, chunk: Result<Vec<u8>, &str>, limit: usize, too_large: &str) -> Result<(), String> {
    let mut uploads = UPLOADS.lock().map_err(|_| "No se pudo preparar el archivo.")?;
    let (touched, staged) = uploads.get_mut(id).ok_or(INTERRUPTED)?;
    match chunk {
        Ok(chunk) if staged.len() + chunk.len() <= limit => { staged.extend_from_slice(&chunk); *touched = Instant::now(); Ok(()) }
        result => { uploads.remove(id); Err(result.err().unwrap_or(too_large).into()) }
    }
}

// Android's Tauri bridge uses postMessage, which serializes typed arrays as
// JSON arrays. Desktop normally uses an octet-stream request, but can fall
// back to that same bridge. Validate both transports before touching files.
pub fn bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(data) if data.len() <= folio_core::MAX_OUTPUT_BYTES => Ok(Cow::Borrowed(data)),
        InvokeBody::Raw(_) => Err("El archivo supera 1 GB y no se puede guardar.".into()),
        InvokeBody::Json(serde_json::Value::Object(value)) if value.len() == 1 && value.get("upload").is_some_and(|id| id.is_string()) => {
            let id = value["upload"].as_str().unwrap_or_default();
            UPLOADS.lock().map_err(|_| "No se pudo preparar el archivo.")?.remove(id).map(|(_, data)| Cow::Owned(data))
                .ok_or_else(|| INTERRUPTED.into())
        }
        InvokeBody::Json(serde_json::Value::Object(value)) => {
            let encoded = value.get("base64").and_then(|value| value.as_str())
                .filter(|encoded| value.len() == 1 && encoded.len() <= BRIDGE_MAX.div_ceil(3) * 4)
                .ok_or("El contenido del archivo es inválido o excede 128 MiB.")?;
            let decoded = base64::engine::general_purpose::STANDARD.decode(encoded)
                .map_err(|_| "El archivo contiene bytes inválidos.")?;
            if decoded.len() > BRIDGE_MAX { return Err("El archivo excede 128 MiB.".into()); }
            Ok(Cow::Owned(decoded))
        }
        InvokeBody::Json(serde_json::Value::Array(values)) if values.len() <= BRIDGE_MAX => {
            values.iter().map(|value| value.as_u64().and_then(|n| u8::try_from(n).ok())
                .ok_or_else(|| "El archivo contiene bytes inválidos.".to_string()))
                .collect::<Result<Vec<_>, _>>().map(Cow::Owned)
        }
        _ => Err("El contenido del archivo es inválido o excede 128 MiB.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn android_json_and_native_raw_preserve_every_byte() {
        let data: Vec<u8> = (0..=255).collect();
        assert_eq!(bytes(&InvokeBody::Raw(data.clone())).unwrap().as_ref(), data);
        assert_eq!(bytes(&InvokeBody::Json(json!(data))).unwrap().as_ref(), data);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
        assert_eq!(bytes(&InvokeBody::Json(json!({"base64": encoded}))).unwrap().as_ref(), data);
    }

    #[test]
    fn chunked_uploads_are_assembled_once_in_order() {
        let data: Vec<u8> = (0..=255).cycle().take(5000).collect();
        let id = upload_begin().unwrap();
        for chunk in data.chunks(1024) { upload_chunk(id.clone(), base64::engine::general_purpose::STANDARD.encode(chunk)).unwrap(); }
        assert_eq!(bytes(&InvokeBody::Json(json!({"upload": id.clone()}))).unwrap().as_ref(), data);
        assert!(bytes(&InvokeBody::Json(json!({"upload": id.clone()}))).is_err(), "A staged upload is consumed by one write");
        assert!(upload_chunk(id, "AA==".into()).is_err());
        let invalid = upload_begin().unwrap();
        assert!(upload_chunk(invalid.clone(), "!!!".into()).is_err());
        assert!(upload_chunk(invalid, "AA==".into()).is_err(), "A failed chunk drops its upload");
    }

    #[test]
    fn rejects_non_bytes_instead_of_coercing_them() {
        for invalid in [json!([-1]), json!([256]), json!([1.5]), json!(["1"]), json!([null]), json!({"0": 37}), json!("%PDF-"), json!({"base64": "!!!"}), json!({"base64": "AA==", "extra": true}), json!({"upload": 1}), json!({"upload": "missing"})] {
            assert!(bytes(&InvokeBody::Json(invalid)).is_err());
        }
    }
}
