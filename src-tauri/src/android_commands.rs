use super::*;
use tauri_plugin_folio_android::FolioAndroidExt;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::mobile::PluginInvokeError;

fn incoming_error(app: &tauri::AppHandle, error: String) {
    let desktop = app.state::<Desktop>();
    if let Ok(mut files) = desktop.files.lock() {
        if let Some(opened) = files.queue_system_open(SystemOpen { documents: vec![], errors: vec![error] }) {
            for error in opened.errors { let _ = app.emit("folio-open-error", error); }
        }
    };
}

pub fn watch_system_documents(app: tauri::AppHandle) {
    let receiver = app.clone();
    // A Rust-owned channel survives WebView loading/reloading. The existing
    // system-open queue waits until React has registered its event listeners.
    let channel = Channel::<Value>::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let value: Value = serde_json::from_str(&json)?;
            if let Some(error) = value["error"].as_str() { incoming_error(&receiver, error.to_owned()); }
            for error in value["errors"].as_array().into_iter().flatten().filter_map(Value::as_str) { incoming_error(&receiver, error.to_owned()); }
            let paths = value["paths"].as_array().into_iter().flatten().filter_map(|path| path.as_str().map(PathBuf::from)).collect::<Vec<_>>();
            if !paths.is_empty() { open_from_system(&receiver, paths); }
            for path in value["recovered"].as_array().into_iter().flatten().filter_map(|path| path.as_str().map(PathBuf::from)) {
                let app = receiver.clone();
                tauri::async_runtime::spawn_blocking(move || if keep_recovered(&app, path).is_err() { incoming_error(&app, "No se pudo añadir la versión anterior a la biblioteca.".into()); });
            }
        }
        Ok(())
    });
    tauri::async_runtime::spawn(async move {
        if let Err(error) = mobile_call(app.clone(), "watchDocuments", serde_json::json!({"channel":channel})).await {
            incoming_error(&app, error);
        }
    });
}

/// The previous version Kotlin recovered after a failed save may be the only
/// intact copy. A library entry of its own keeps it from being pruned, whatever
/// the library preference.
fn keep_recovered(app: &tauri::AppHandle, path: PathBuf) -> Result<(), String> {
    let desktop = app.state::<Desktop>();
    let file = inspect_pdf_file(&path)?;
    let name = path.file_name().ok_or("Nombre de archivo inválido.")?.to_string_lossy().into_owned();
    let opened_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let pages = read_recents(&desktop).into_iter().find(|r| r.id == file.digest).map_or(0, |r| r.pages);
    // A separate id leaves the document's own entry and draft untouched.
    let id = folio_core::digest(format!("recovered:{}", path.display()).as_bytes());
    remember_catalog_entry(&desktop, Recent { id, name, size: file.snapshot.size, pages, opened_at, path, draft: false, hidden: false })
}

async fn mobile_call(app: tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    const FAILED: &str = "No se pudo completar la operación.";
    let command = command.to_owned();
    // Kotlin rejects with text written for the user; bridge errors are technical English.
    tauri::async_runtime::spawn_blocking(move || app.folio_android().call(&command, args).map_err(|error| match error {
        PluginInvokeError::InvokeRejected(response) => response.message.unwrap_or_else(|| FAILED.into()),
        _ => FAILED.into(),
    })).await.map_err(|_| FAILED.to_string())?
}
/// Kotlin keeps the copies that worked and reports each PDF that failed.
fn register_imports(desktop: &Desktop, response: Value) -> Result<SystemOpen, String> {
    let paths = response["paths"].as_array().ok_or("No se recibieron los archivos elegidos.")?;
    let mut opened = SystemOpen { documents: Vec::new(), errors: response["errors"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(str::to_owned)).collect() };
    for path in paths {
        match path.as_str().ok_or_else(|| "Ruta de importación inválida.".to_string()).and_then(|p| register(desktop, PathBuf::from(p))) {
            Ok(info) => opened.documents.push(info),
            Err(error) => opened.errors.push(error),
        }
    }
    Ok(opened)
}

#[tauri::command]
pub async fn pick_documents(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Vec<DocumentInfo>, String> {
    let response = mobile_call(app.clone(), "pickDocuments", serde_json::json!({"multiple":true})).await?;
    let opened = register_imports(&desktop, response)?;
    // A file that cannot be opened is reported on its own; the others still open.
    for error in opened.errors { let _ = app.emit("folio-open-error", error); }
    Ok(opened.documents)
}

fn reserve_output(desktop: &Desktop, source: Option<String>, name: String, format: String) -> Result<String, String> {
    let filename = Path::new(&name).file_name().filter(|n| !n.is_empty()).ok_or("Nombre de archivo inválido.")?;
    let token = uuid::Uuid::new_v4().to_string();
    let folder = desktop.data.join("exports").join(&token);
    fs::create_dir_all(&folder).map_err(|_| "No se pudo preparar la copia para exportar.")?;
    let mut path = folder.join(filename);
    path.set_extension(&format);
    let mut files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let original = source.map(|id| files.sources.get(&id).map(|s| s.path.clone()).ok_or("El documento de origen no está disponible.")).transpose()?;
    if let Some(original) = &original { protect_original(original, &path)?; }
    files.outputs.insert(token.clone(), Output { path, fingerprint: None, source: original, format });
    Ok(token)
}

#[tauri::command]
pub fn choose_output(source: Option<String>, name: String, desktop: State<'_, Desktop>) -> Result<Option<String>, String> {
    reserve_output(&desktop, source, name, "pdf".into()).map(Some)
}

#[tauri::command]
pub fn choose_export(source: Option<String>, name: String, format: String, desktop: State<'_, Desktop>) -> Result<Option<String>, String> {
    if !["txt", "html", "png", "jpg", "zip", "docx", "json"].contains(&format.as_str()) { return Err("Formato no admitido.".into()); }
    reserve_output(&desktop, source, name, format).map(Some)
}

fn write_reserved(request: tauri::ipc::Request<'_>, desktop: &Desktop, pdf: bool) -> Result<PathBuf, String> {
    let token = request.headers().get("x-folio-output-token").and_then(|s| s.to_str().ok()).ok_or("Destino ausente.")?;
    let bytes = crate::binary_ipc::bytes(request.body())?;
    if pdf { validate_pdf(&bytes)?; }
    else if bytes.is_empty() || bytes.len() > 128 * 1024 * 1024 { return Err("El archivo está vacío o excede 128 MiB.".into()); }
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(token).ok_or("Destino vencido.")?;
    if (output.format == "pdf") != pdf { return Err("El tipo de archivo no coincide con el destino.".into()); }
    if let Some(original) = &output.source { protect_original(original, &output.path)?; }
    atomic_write(&output.path, &bytes, output.fingerprint.as_deref())?;
    Ok(output.path)
}

fn remove_export(desktop: &Desktop, path: &Path) {
    if let Some(folder) = path.parent().filter(|folder| folder.parent() == Some(desktop.data.join("exports").as_path())) {
        let _ = fs::remove_dir_all(folder);
    }
}

/// Deletes the private PDF copies (FolioImports/ and exports/) that neither the
/// library nor an open tab uses, with the document access kept for them. The
/// frontend calls it after forget_document, clear_saved_state and replacing a
/// saved document, passing the source tokens of its open tabs; setup runs it
/// with none. Copies being written or opened right now are kept.
#[tauri::command]
pub async fn prune_private_copies(keep: Vec<String>, app: tauri::AppHandle) -> Result<(), String> {
    let paths = {
        let desktop = app.state::<Desktop>();
        let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
        // An unreadable library may still name any copy: every copy stays.
        let Some(recents) = stored_recents(&desktop) else { return Ok(()) };
        let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
        recents.into_iter().map(|r| r.path)
            .chain(keep.iter().filter_map(|token| files.sources.get(token).map(|s| s.path.clone())))
            .chain(files.outputs.values().map(|o| o.path.clone()))
            .map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>()
    };
    mobile_call(app, "prunePrivateCopies", serde_json::json!({"keep":paths})).await.map(|_| ())
}

#[tauri::command]
pub async fn write_pdf_original(request: tauri::ipc::Request<'_>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<DocumentInfo>, String> {
    let token = request.headers().get("x-folio-source-token").and_then(|s| s.to_str().ok()).ok_or("Origen ausente.")?;
    let original = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.get(token)
        .map(|s| s.path.clone()).ok_or("Vuelve a abrir el PDF original.")?;
    let path = write_reserved(request, &desktop, true)?;
    let response = mobile_call(app, "saveOriginal", serde_json::json!({"source":original,"path":path})).await;
    if response.as_ref().ok().and_then(|r| r["completed"].as_bool()) != Some(true) {
        remove_export(&desktop, &path);
        return response.map(|_| None);
    }
    register(&desktop, path).map(Some)
}

#[tauri::command]
pub async fn write_pdf_copy(request: tauri::ipc::Request<'_>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<DocumentInfo>, String> {
    let path = write_reserved(request, &desktop, true)?;
    let response = mobile_call(app, "exportFile", serde_json::json!({"path":path})).await;
    if response.as_ref().ok().and_then(|r| r["completed"].as_bool()) != Some(true) {
        remove_export(&desktop, &path);
        return response.map(|_| None);
    }
    register(&desktop, path).map(Some)
}

#[tauri::command]
pub async fn write_export(request: tauri::ipc::Request<'_>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<bool, String> {
    let path = write_reserved(request, &desktop, false)?;
    let response = mobile_call(app, "exportFile", serde_json::json!({"path":path})).await;
    remove_export(&desktop, &path);
    response.map(|r| r["completed"].as_bool() == Some(true))
}

#[tauri::command]
pub async fn share_pdf_copy(request: tauri::ipc::Request<'_>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<bool, String> {
    let path = write_reserved(request, &desktop, true)?;
    let response = mobile_call(app, "shareFile", serde_json::json!({"path":path})).await;
    remove_export(&desktop, &path);
    response.map(|r| r["completed"].as_bool() == Some(true))
}

#[tauri::command]
pub async fn print_pdf_copy(request: tauri::ipc::Request<'_>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<bool, String> {
    let path = write_reserved(request, &desktop, true)?;
    let response = mobile_call(app, "printFile", serde_json::json!({"path":path})).await;
    remove_export(&desktop, &path);
    response.map(|r| r["completed"].as_bool() == Some(true))
}


/// `background` is the CSS colour at the top of the current screen, continued
/// under the status bar.
#[tauri::command]
pub async fn set_mobile_theme(theme: String, background: Option<String>, app: tauri::AppHandle) -> Result<(), String> { mobile_call(app, "setTheme", serde_json::json!({"theme":theme,"background":background})).await.map(|_| ()) }
#[tauri::command]
pub async fn set_mobile_chrome(visible: bool, app: tauri::AppHandle) -> Result<(), String> { mobile_call(app, "setReaderChrome", serde_json::json!({"visible":visible})).await.map(|_| ()) }
#[tauri::command]
pub async fn android_safe_area(app: tauri::AppHandle) -> Result<Value, String> { mobile_call(app, "getSafeArea", serde_json::json!({})).await }
#[tauri::command]
pub async fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Enlace inválido.")?;
    if !["http", "https", "mailto", "tel"].contains(&parsed.scheme()) { return Err("Enlace no compatible.".into()); }
    mobile_call(app, "openUrl", serde_json::json!({"url":url})).await.map(|_| ())
}
