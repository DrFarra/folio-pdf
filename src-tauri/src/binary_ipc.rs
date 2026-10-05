use std::borrow::Cow;
use tauri::ipc::InvokeBody;
use base64::Engine;

// Android's Tauri bridge uses postMessage, which serializes typed arrays as
// JSON arrays. Desktop normally uses an octet-stream request, but can fall
// back to that same bridge. Validate both transports before touching files.
pub fn bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    const MAX: usize = 128 * 1024 * 1024;
    match body {
        InvokeBody::Raw(data) if data.len() <= MAX => Ok(Cow::Borrowed(data)),
        InvokeBody::Json(serde_json::Value::Object(value)) => {
            let encoded = value.get("base64").and_then(|value| value.as_str())
                .filter(|encoded| value.len() == 1 && encoded.len() <= MAX.div_ceil(3) * 4)
                .ok_or("El contenido del archivo es inválido o excede 128 MiB.")?;
            let decoded = base64::engine::general_purpose::STANDARD.decode(encoded)
                .map_err(|_| "El archivo contiene bytes inválidos.")?;
            if decoded.len() > MAX { return Err("El archivo excede 128 MiB.".into()); }
            Ok(Cow::Owned(decoded))
        }
        InvokeBody::Json(serde_json::Value::Array(values)) if values.len() <= MAX => {
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
    fn rejects_non_bytes_instead_of_coercing_them() {
        for invalid in [json!([-1]), json!([256]), json!([1.5]), json!(["1"]), json!([null]), json!({"0": 37}), json!("%PDF-"), json!({"base64": "!!!"}), json!({"base64": "AA==", "extra": true})] {
            assert!(bytes(&InvokeBody::Json(invalid)).is_err());
        }
    }
}
