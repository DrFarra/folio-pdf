//! iOS file access is mediated by UIKit. External provider URLs are copied while
//! security-scoped access is active; recent documents never retain provider paths.
use super::*;
use tauri_plugin_folio_ios::FolioIosExt;

#[cfg(feature = "native-qa")]
#[tauri::command]
pub async fn ios_native_status(app: tauri::AppHandle) -> Result<Value, String> {
    mobile_call(app, "nativeStatus", serde_json::json!({})).await
}

#[tauri::command]
pub async fn set_mobile_theme(theme: String, app: tauri::AppHandle) -> Result<(), String> {
    if !["light", "dark", "system"].contains(&theme.as_str()) { return Err("Tema inválido.".into()); }
    mobile_call(app, "setTheme", serde_json::json!({"theme":theme})).await.map(|_| ())
}

async fn mobile_call(app: tauri::AppHandle, command: &'static str, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || app.folio_ios().call(command, args))
        .await.map_err(|_| "No se pudo completar la operación de iOS.".to_string())?
        .map_err(|e| format!("iOS: {e}"))
}

fn register_imports(desktop: &Desktop, response: Value) -> Result<Vec<DocumentInfo>, String> {
    let paths = response["paths"].as_array().ok_or("iOS no devolvió los archivos elegidos.")?;
    paths.iter().map(|p| p.as_str().ok_or("Ruta de importación inválida.").and_then(|p| register(desktop, PathBuf::from(p)))).collect()
}

#[tauri::command]
pub async fn pick_documents(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Vec<DocumentInfo>, String> {
    let response = mobile_call(app, "pickDocuments", serde_json::json!({"multiple":true})).await?;
    register_imports(&desktop, response)
}

#[tauri::command]
pub async fn pick_document(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<DocumentInfo>, String> {
    let response = mobile_call(app, "pickDocuments", serde_json::json!({"multiple":false})).await?;
    Ok(register_imports(&desktop, response)?.into_iter().next())
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
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Contenido binario inválido.".into()); };
    if pdf { validate_pdf(bytes)?; }
    else if bytes.is_empty() || bytes.len() > 128 * 1024 * 1024 { return Err("El archivo está vacío o excede 128 MiB.".into()); }
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(token).ok_or("Destino vencido.")?;
    if (output.format == "pdf") != pdf { return Err("El tipo de archivo no coincide con el destino.".into()); }
    if let Some(original) = &output.source { protect_original(original, &output.path)?; }
    atomic_write(&output.path, bytes, output.fingerprint.as_deref())?;
    Ok(output.path)
}

fn remove_export(desktop: &Desktop, path: &Path) {
    if let Some(folder) = path.parent().filter(|folder| folder.parent() == Some(desktop.data.join("exports").as_path())) {
        let _ = fs::remove_dir_all(folder);
    }
}

pub fn cleanup_unreferenced_exports(desktop: &Desktop) {
    let retained = read_recents(desktop).into_iter().map(|r| r.path).collect::<Vec<_>>();
    if let Ok(entries) = fs::read_dir(desktop.data.join("exports")) {
        for entry in entries.flatten() {
            let folder = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_dir()) && !retained.iter().any(|p| p.parent() == Some(folder.as_path())) {
                let _ = fs::remove_dir_all(folder);
            }
        }
    }
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

fn source_path(desktop: &Desktop, token: &str) -> Result<PathBuf, String> {
    desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.get(token).map(|s| s.path.clone()).ok_or("El documento no está disponible.".into())
}

#[tauri::command]
pub async fn share_document(token: String, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<bool, String> {
    let path = source_path(&desktop, &token)?;
    let response = mobile_call(app, "shareFile", serde_json::json!({"path":path})).await?;
    Ok(response["completed"].as_bool() == Some(true))
}

#[tauri::command]
pub async fn print_document(token: String, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<bool, String> {
    let path = source_path(&desktop, &token)?;
    let response = mobile_call(app, "printFile", serde_json::json!({"path":path})).await?;
    Ok(response["completed"].as_bool() == Some(true))
}

pub fn open_urls(app: tauri::AppHandle, urls: Vec<tauri::Url>) {
    let paths = file_url_paths(urls).into_iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>();
    if paths.is_empty() { return; }
    tauri::async_runtime::spawn(async move {
        match mobile_call(app.clone(), "importPaths", serde_json::json!({"paths":paths})).await {
            Ok(response) => {
                let copies = response["paths"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(PathBuf::from)).collect();
                open_from_system(&app, copies);
            }
            Err(error) => { let _ = app.emit("folio-open-error", error); }
        }
    });
}
