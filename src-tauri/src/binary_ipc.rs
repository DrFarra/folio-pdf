use std::borrow::Cow;
use tauri::ipc::InvokeBody;
use base64::Engine;
use std::{collections::HashMap, sync::{LazyLock, Mutex}, time::Instant};

// Android's bridge carries JSON text: a PDF arrives as base64 slices staged
// here, each one a small message.
const BRIDGE_MAX: usize = 128 * 1024 * 1024;
static UPLOADS: LazyLock<Mutex<HashMap<String, (Instant, Vec<u8>)>>> = LazyLock::new(Default::default);

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
    let mut uploads = UPLOADS.lock().map_err(|_| "No se pudo preparar el archivo.")?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(&base64).map_err(|_| "El archivo contiene bytes inválidos.");
    let (touched, staged) = uploads.get_mut(&id).ok_or("El envío del archivo se interrumpió. Vuelve a intentarlo.")?;
    match decoded {
        Ok(chunk) if staged.len() + chunk.len() <= BRIDGE_MAX => { staged.extend_from_slice(&chunk); *touched = Instant::now(); Ok(()) }
        result => { uploads.remove(&id); Err(result.err().unwrap_or("Este PDF supera 128 MB y no se puede guardar en este dispositivo.").into()) }
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
                .ok_or_else(|| "El envío del archivo se interrumpió. Vuelve a intentarlo.".into())
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
