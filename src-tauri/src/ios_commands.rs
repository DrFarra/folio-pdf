//! iOS file access is mediated by UIKit. External provider URLs are copied while
//! security-scoped access is active; recent documents never retain provider paths.
use super::*;
use tauri_plugin_folio_ios::FolioIosExt;

#[cfg(feature = "native-qa")]
#[tauri::command]
pub async fn ios_native_status(app: tauri::AppHandle) -> Result<Value, String> {
    let mut status = mobile_call(app, "nativeStatus", serde_json::json!({})).await?;
    status["fileProbeEnabled"] = Value::Bool(std::env::args().any(|a| a == "--folio-native-file-probe"));
    Ok(status)
}

/// CI calls the real Swift import/copy and file-backed PDFKit APIs. This probe
/// is excluded from production and is distinct from the UIKit tap tests.
#[cfg(feature = "native-qa")]
#[tauri::command]
pub async fn ios_native_file_probe(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
    let home = app.path().home_dir().map_err(|_| "No se pudo localizar el sandbox de la prueba.")?;
    let input = home.join("Documents").join("FolioNativeFixtures");
    let paths = [input.join("Folio native pequeño.PDF"), input.join("Folio native 2GiB.pdf")];
    let response = mobile_call(app.clone(), "importPaths", serde_json::json!({"paths":paths})).await?;
    let documents = register_imports(&desktop, response)?;
    let mut reports = Vec::new();
    for info in documents {
        let (path, _) = pdf_source(&desktop, &info.token)?;
        let metadata = mobile_call(app.clone(), "pdfOpen", serde_json::json!({"token":info.token,"path":path,"id":info.id,"revision":info.revision,"size":info.size,"password":""})).await?;
        if metadata["numPages"].as_u64() != Some(2) || metadata["locked"] != false { return Err("PDFKit no abrió las dos páginas del fixture.".into()); }
        let text = mobile_call(app.clone(), "pdfText", serde_json::json!({"token":info.token,"page":1})).await?;
        if !text["lines"].as_array().into_iter().flatten().filter_map(|v| v["text"].as_str()).collect::<String>().contains("Folio native PDFKit") { return Err("PDFKit no extrajo el texto del fixture.".into()); }
        let first = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":info.token,"page":1})).await?;
        if first["annotations"].as_array().map(|a| a.len()) != Some(2) { return Err("No se reconocieron el resaltado y la nota originales de PDFKit.".into()); }
        let mut rasters = Vec::new();
        for rotation in [0, 90, 180, 270] {
            let (width, height) = if rotation % 180 == 0 { (572, 732) } else { (732, 572) };
            let response = mobile_call(app.clone(), "pdfRender", serde_json::json!({"token":info.token,"page":1,"width":width,"height":height,"rotation":rotation})).await?;
            let raster = PathBuf::from(response["path"].as_str().ok_or("PDFKit no generó el fixture PNG.")?);
            let evidence = desktop.data.join(format!("native-pdf-{}-{rotation}.png", if info.size > 2 * 1024 * 1024 * 1024 { "2gib" } else { "small" }));
            fs::rename(&raster, &evidence).map_err(|e| format!("No se pudo conservar la evidencia PNG: {e}"))?;
            rasters.push(serde_json::json!({"rotation":rotation,"width":width,"height":height,"path":evidence}));
        }
        let reference = first["annotations"][0]["nativeSourceRef"].as_str().ok_or("No hay referencia estable del resaltado.")?.to_string();
        let folder = desktop.data.join("pdfkit-probe").join(uuid::Uuid::new_v4().to_string()); fs::create_dir_all(&folder).map_err(|_| "No se pudo preparar la exportación de prueba.")?;
        let output = folder.join("Folio modified.pdf");
        let additions = serde_json::json!([{"id":"native-added-note","page":1,"kind":"note","rect":[420,600,420,600],"color":"#ff0000","text":"Folio native exported note","created":0}]);
        mobile_call(app.clone(), "pdfExport", serde_json::json!({"token":info.token,"path":output,"annotations":additions,"removedSourceRefs":[reference]})).await?;
        let exported = register(&desktop, output.clone())?;
        mobile_call(app.clone(), "pdfOpen", serde_json::json!({"token":exported.token,"path":output,"id":exported.id,"revision":exported.revision,"size":exported.size,"password":""})).await?;
        let modified = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":exported.token,"page":1})).await?;
        let unseen = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":exported.token,"page":2})).await?;
        if modified["annotations"].as_array().map(|a| a.len()) != Some(2) || !modified["annotations"].as_array().into_iter().flatten().any(|a| a["text"] == "Folio native exported note") || unseen["annotations"].as_array().map(|a| a.len()) != Some(1) { return Err("La copia no eliminó/añadió anotaciones o perdió las de la página no visitada.".into()); }
        let source = inspect_pdf_file(&path)?;
        if source.digest != info.id { return Err("La exportación nativa modificó el original.".into()); }
        mobile_call(app.clone(), "pdfClose", serde_json::json!({"token":exported.token})).await?;
        mobile_call(app.clone(), "pdfClose", serde_json::json!({"token":info.token})).await?;
        reports.push(serde_json::json!({"document":info,"metadata":metadata,"pageInfo":first,"text":text,"rasters":rasters,"removedSourceAnnotation":true,"addedNote":true,"unseenHighlightPreserved":true,"sourceUnchanged":true,"exportedPath":output}));
    }
    Ok(serde_json::json!({"swiftImportExecuted":true,"pdfKitExecuted":true,"wholeDocumentIPC":false,"UIKitInteractionTested":false,"documents":reports}))
}

#[tauri::command]
pub async fn set_mobile_theme(theme: String, app: tauri::AppHandle) -> Result<(), String> {
    if !["light", "dark", "system"].contains(&theme.as_str()) { return Err("Tema inválido.".into()); }
    mobile_call(app, "setTheme", serde_json::json!({"theme":theme})).await.map(|_| ())
}

#[tauri::command]
pub async fn copy_text(text: String, app: tauri::AppHandle) -> Result<(), String> {
    if text.len() > 1024 * 1024 { return Err("El texto seleccionado es demasiado grande para copiarlo.".into()); }
    mobile_call(app, "copyText", serde_json::json!({"text":text})).await.map(|_| ())
}

async fn mobile_call(app: tauri::AppHandle, command: &'static str, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || app.folio_ios().call(command, args))
        .await.map_err(|_| "No se pudo completar la operación de iOS.".to_string())?
        .map_err(|e| format!("iOS: {e}"))
}

fn register_imports(desktop: &Desktop, response: Value) -> Result<Vec<DocumentInfo>, String> {
    let paths = response["paths"].as_array().ok_or("iOS no devolvió los archivos elegidos.")?;
    paths.iter().map(|p| p.as_str().ok_or_else(|| "Ruta de importación inválida.".to_string()).and_then(|p| register(desktop, PathBuf::from(p)))).collect()
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

fn pdf_source(desktop: &Desktop, token: &str) -> Result<(PathBuf, DocumentInfo), String> {
    let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let source = files.sources.get(token).ok_or("El documento no está disponible.")?;
    if folio_core::file_snapshot(&source.path)? != source.snapshot { return Err("El archivo cambió en disco. Vuelve a abrirlo.".into()); }
    Ok((source.path.clone(), source.info.clone()))
}

#[tauri::command]
pub async fn native_pdf_open(token: String, password: Option<String>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
    let (path, info) = pdf_source(&desktop, &token)?;
    mobile_call(app, "pdfOpen", serde_json::json!({"token":token,"path":path,"password":password,"id":info.id,"revision":info.revision,"size":info.size})).await
}

#[tauri::command]
pub async fn native_pdf_page_info(token: String, page: u32, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
    pdf_source(&desktop, &token)?;
    mobile_call(app, "pdfPageInfo", serde_json::json!({"token":token,"page":page})).await
}

#[tauri::command]
pub async fn native_pdf_text(token: String, page: u32, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
    pdf_source(&desktop, &token)?;
    mobile_call(app, "pdfText", serde_json::json!({"token":token,"page":page})).await
}

#[tauri::command]
pub async fn native_pdf_outline(token: String, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
    pdf_source(&desktop, &token)?;
    mobile_call(app, "pdfOutline", serde_json::json!({"token":token})).await.map(|r| r["entries"].clone())
}

#[tauri::command]
pub async fn native_pdf_close(token: String, app: tauri::AppHandle) -> Result<(), String> {
    mobile_call(app, "pdfClose", serde_json::json!({"token":token})).await.map(|_| ())
}

#[tauri::command]
pub async fn native_pdf_render(token: String, page: u32, width: u32, height: u32, rotation: u16, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    pdf_source(&desktop, &token)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 4_000_000 { return Err("La página debe renderizarse en un máximo de 4 megapíxeles.".into()); }
    let response = mobile_call(app.clone(), "pdfRender", serde_json::json!({"token":token,"page":page,"width":width,"height":height,"rotation":rotation})).await?;
    let path = PathBuf::from(response["path"].as_str().ok_or("PDFKit no devolvió la imagen de la página.")?);
    let resolved = fs::canonicalize(&path).map_err(|_| "No se pudo leer la imagen de la página.")?;
    let temporary = app.path().temp_dir().map_err(|_| "No se pudo comprobar la carpeta temporal.")?.join("FolioPageRasters");
    let root = fs::canonicalize(&temporary).map_err(|_| "No se pudo comprobar la carpeta de imágenes.")?;
    if resolved.parent() != Some(root.as_path()) { return Err("La imagen devuelta no está en la carpeta de Folio.".into()); }
    let result = (|| {
        if fs::metadata(&resolved).map_err(|_| "No se pudo comprobar la imagen.")?.len() > 20 * 1024 * 1024 { return Err("La imagen generada excede el tamaño de una página.".into()); }
        let bytes = fs::read(&resolved).map_err(|_| "No se pudo leer la imagen.")?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("PDFKit no devolvió una imagen PNG válida.".into()); }
        Ok(tauri::ipc::Response::new(bytes))
    })();
    let _ = fs::remove_file(resolved);
    result
}

#[tauri::command]
pub async fn native_pdf_present(token: String, name: String, action: String, annotations: Value, removed_source_refs: Vec<String>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
    if !["save", "share", "print"].contains(&action.as_str()) { return Err("Acción de PDF no admitida.".into()); }
    if !annotations.is_array() || annotations.to_string().len() > 4 * 1024 * 1024 { return Err("Las anotaciones de la copia son inválidas o demasiado numerosas.".into()); }
    let (source, _) = pdf_source(&desktop, &token)?;
    if action == "print" {
        let permission = mobile_call(app.clone(), "pdfPermissions", serde_json::json!({"token":token})).await?;
        if permission["canPrint"] != true { return Err("Este PDF no permite imprimir.".into()); }
    }
    let output_token = reserve_output(&desktop, Some(token.clone()), name, "pdf".into())?;
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(&output_token).ok_or("Destino vencido.")?;
    protect_original(&source, &output.path)?;
    let export = mobile_call(app.clone(), "pdfExport", serde_json::json!({"token":token,"path":output.path,"annotations":annotations,"removedSourceRefs":removed_source_refs})).await;
    if let Err(error) = export { remove_export(&desktop, &output.path); return Err(error); }
    let command = match action.as_str() { "save" => "exportFile", "share" => "shareFile", _ => "printFile" };
    let response = mobile_call(app, command, serde_json::json!({"path":output.path})).await;
    let completed = response.as_ref().ok().and_then(|r| r["completed"].as_bool()) == Some(true);
    if action == "save" && completed { return register(&desktop, output.path).and_then(|d| serde_json::to_value(d).map_err(|_| "No se pudo registrar la copia.".into())); }
    remove_export(&desktop, &output.path);
    response.map(|_| if action == "save" { Value::Null } else { Value::Bool(completed) })
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
            Err(error) => {
                let opened = SystemOpen { documents: Vec::new(), errors: vec![error] };
                if let Ok(mut files) = app.state::<Desktop>().files.lock() {
                    if let Some(opened) = files.queue_system_open(opened) { for error in opened.errors { let _ = app.emit("folio-open-error", error); } }
                };
            }
        }
    });
}
