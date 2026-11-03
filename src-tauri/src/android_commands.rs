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
    remember_catalog_entry(&desktop, Recent { id, name, size: file.snapshot.size, pages, opened_at, path, draft: false, hidden: false, known: None })
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
/// Keeps the screen on while a document is read.
#[tauri::command]
pub async fn set_keep_awake(on: bool, app: tauri::AppHandle) -> Result<(), String> { mobile_call(app, "setKeepAwake", serde_json::json!({"on":on})).await.map(|_| ()) }
/// A short system haptic: selection, light, medium or success.
#[tauri::command]
pub async fn haptic(kind: String, app: tauri::AppHandle) -> Result<(), String> { mobile_call(app, "haptic", serde_json::json!({"kind":kind})).await.map(|_| ()) }
#[tauri::command]
pub async fn android_safe_area(app: tauri::AppHandle) -> Result<Value, String> { mobile_call(app, "getSafeArea", serde_json::json!({})).await }
#[tauri::command]
pub async fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Enlace inválido.")?;
    if !["http", "https", "mailto", "tel"].contains(&parsed.scheme()) { return Err("Enlace no compatible.".into()); }
    mobile_call(app, "openUrl", serde_json::json!({"url":url})).await.map(|_| ())
}

// Large PDFs stay in their file, read page by page by MuPDF (native_reader.rs):
// the same commands and payloads as iOS's PDFKit reader.
fn pdf_source(desktop: &Desktop, token: &str) -> Result<(PathBuf, DocumentInfo), String> {
    let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let source = files.sources.get(token).ok_or("El documento no está disponible.")?;
    if folio_core::file_snapshot(&source.path)? != source.snapshot { return Err("El archivo cambió en disco. Vuelve a abrirlo.".into()); }
    Ok((source.path.clone(), source.info.clone()))
}
async fn reading<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "No se pudo leer el PDF.".to_string())?
}

#[tauri::command]
pub async fn native_pdf_open(token: String, password: Option<String>, desktop: State<'_, Desktop>) -> Result<Value, String> {
    let (path, info) = pdf_source(&desktop, &token)?;
    reading(move || crate::native_reader::open(&token, &path, password.as_deref().unwrap_or(""), &info.id, &info.revision, info.size)).await
}

#[tauri::command]
pub async fn native_pdf_page_info(token: String, page: u32, desktop: State<'_, Desktop>) -> Result<Value, String> {
    pdf_source(&desktop, &token)?;
    reading(move || crate::native_reader::with(&token, |reader| reader.page_info(page))).await
}

#[tauri::command]
pub async fn native_pdf_text(token: String, page: u32, desktop: State<'_, Desktop>) -> Result<Value, String> {
    pdf_source(&desktop, &token)?;
    reading(move || crate::native_reader::with(&token, |reader| reader.text(page))).await
}

#[tauri::command]
pub async fn native_pdf_outline(token: String, desktop: State<'_, Desktop>) -> Result<Value, String> {
    pdf_source(&desktop, &token)?;
    reading(move || crate::native_reader::with(&token, |reader| reader.outline())).await
}

#[tauri::command]
pub async fn native_pdf_close(token: String) -> Result<(), String> {
    reading(move || { crate::native_reader::close(&token); Ok(()) }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_pdf_render(token: String, page: u32, width: u32, height: u32, rotation: u16, full_width: Option<u32>, full_height: Option<u32>, x: Option<u32>, y: Option<u32>, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    pdf_source(&desktop, &token)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 4_000_000 { return Err("La página debe renderizarse en un máximo de 4 megapíxeles.".into()); }
    if rotation % 90 != 0 || rotation >= 360 { return Err("La rotación de la página no es válida.".into()); }
    // Optional window of a larger page raster (the visible part when zoomed in).
    let (full_width, full_height, x, y) = (full_width.unwrap_or(width), full_height.unwrap_or(height), x.unwrap_or(0), y.unwrap_or(0));
    if full_width > 65_536 || full_height > 65_536 || x >= full_width || y >= full_height { return Err("La zona de la página no es válida.".into()); }
    let png = reading(move || crate::native_reader::with(&token, |reader| reader.render(page, width, height, rotation, full_width, full_height, x, y))).await?;
    Ok(tauri::ipc::Response::new(png))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_pdf_present(token: String, name: String, action: String, annotations: Value, removed_source_refs: Vec<String>, anchor: Option<Vec<f64>>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
    let _ = anchor; // Android's sheets are not anchored.
    if !["save", "share", "print"].contains(&action.as_str()) { return Err("Acción de PDF no admitida.".into()); }
    if !annotations.is_array() || annotations.to_string().len() > 4 * 1024 * 1024 { return Err("Las anotaciones de la copia son inválidas o demasiado numerosas.".into()); }
    let (source, _) = pdf_source(&desktop, &token)?;
    if action == "print" {
        let reader = token.clone();
        let printable = reading(move || crate::native_reader::with(&reader, |r| Ok(r.metadata["permissions"]["canPrint"] == true))).await?;
        if !printable { return Err("Este PDF no permite imprimir.".into()); }
    }
    let output_token = reserve_output(&desktop, Some(token.clone()), name, "pdf".into())?;
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(&output_token).ok_or("Destino vencido.")?;
    protect_original(&source, &output.path)?;
    let path = output.path.clone();
    let exported = reading(move || crate::native_reader::with(&token, |reader| reader.export(&path, &annotations, &removed_source_refs))).await;
    if let Err(error) = exported { remove_export(&desktop, &output.path); return Err(error); }
    let command = match action.as_str() { "save" => "exportFile", "share" => "shareFile", _ => "printFile" };
    let response = mobile_call(app, command, serde_json::json!({"path":output.path})).await;
    let completed = response.as_ref().ok().and_then(|r| r["completed"].as_bool()) == Some(true);
    if action == "save" && completed { return register(&desktop, output.path).and_then(|d| serde_json::to_value(d).map_err(|_| "No se pudo registrar la copia.".into())); }
    remove_export(&desktop, &output.path);
    response.map(|_| if action == "save" { Value::Null } else { Value::Bool(completed) })
}
