//! iOS file access is mediated by UIKit. External provider URLs are copied while
//! security-scoped access is active; recent documents never retain provider paths.
use super::*;
use tauri::plugin::mobile::PluginInvokeError;
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
        if first["annotations"].as_array().map(|a| a.len()) != Some(2) { return Err(format!("No se reconocieron el resaltado y la nota originales de PDFKit. metadata={metadata}; pageInfo={first}")); }
        if !first["annotations"].as_array().into_iter().flatten().all(|a| a["opacity"].as_f64().is_some_and(|v| (v - 0.35).abs() < 0.01)) { return Err(format!("PDFKit no conservó la opacidad original de las anotaciones: {first}")); }
        let mut rasters = Vec::new();
        // The 2x render checks that the page fills a bitmap larger than its crop box.
        for (rotation, scale) in [(0, 1), (90, 1), (180, 1), (270, 1), (0, 2)] {
            let (width, height) = if rotation % 180 == 0 { (572 * scale, 732 * scale) } else { (732 * scale, 572 * scale) };
            let response = mobile_call(app.clone(), "pdfRender", serde_json::json!({"token":info.token,"page":1,"width":width,"height":height,"rotation":rotation})).await?;
            let raster = PathBuf::from(response["path"].as_str().ok_or("PDFKit no generó el fixture PNG.")?);
            let evidence = desktop.data.join(format!("native-pdf-{}-{rotation}{}.png", if info.size > 2 * 1024 * 1024 * 1024 { "2gib" } else { "small" }, if scale > 1 { "-2x" } else { "" }));
            fs::rename(&raster, &evidence).map_err(|e| format!("No se pudo conservar la evidencia PNG: {e}"))?;
            rasters.push(serde_json::json!({"page":1,"rotation":rotation,"width":width,"height":height,"path":evidence}));
        }
        let reference = first["annotations"][0]["nativeSourceRef"].as_str().ok_or("No hay referencia estable del resaltado.")?.to_string();
        let folder = desktop.data.join("pdfkit-probe").join(uuid::Uuid::new_v4().to_string()); fs::create_dir_all(&folder).map_err(|_| "No se pudo preparar la exportación de prueba.")?;
        let output = folder.join("Folio modified.pdf");
        let mut additions = vec![
            serde_json::json!({"id":"native-added-note","page":1,"kind":"note","rect":[420,600,420,600],"color":"#ff0000","text":"Folio native exported note","created":0}),
            serde_json::json!({"id":"native-added-highlight","page":1,"kind":"highlight","rect":[80,580,200,600],"quads":[[80,600,200,600,80,580,200,580]],"color":"#ffff00","text":"Folio native exported highlight","created":0}),
        ];
        // Including an unchanged original overlay must preserve its appearance,
        // original name and opacity rather than unnecessarily recreating it.
        additions.push(first["annotations"][1].clone());
        let writer = mobile_call(app.clone(), "pdfExport", serde_json::json!({"token":info.token,"path":output,"annotations":additions,"removedSourceRefs":[reference]})).await?;
        if writer["annotationWriter"] != "MuPDF 1.28.1" || writer["incremental"] != true { return Err(format!("La copia no confirmó el escritor incremental fijado: {writer}")); }
        let exported = register(&desktop, output.clone())?;
        mobile_call(app.clone(), "pdfOpen", serde_json::json!({"token":exported.token,"path":output,"id":exported.id,"revision":exported.revision,"size":exported.size,"password":""})).await?;
        let modified = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":exported.token,"page":1})).await?;
        let unseen = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":exported.token,"page":2})).await?;
        if modified["annotations"].as_array().map(|a| a.len()) != Some(3) || modified["annotations"].as_array().into_iter().flatten().any(|a| a["originalName"] == "source-highlight") || !modified["annotations"].as_array().into_iter().flatten().any(|a| a["text"] == "Folio native exported note") || unseen["annotations"].as_array().map(|a| a.len()) != Some(1) { return Err(format!("La copia no eliminó/añadió anotaciones o perdió las de la página no visitada: {modified}")); }
        if !modified["annotations"].as_array().into_iter().flatten().any(|a| a["originalName"] == "native-added-highlight" && a["opacity"].as_f64().is_some_and(|v| (v - 0.35).abs() < 0.01)) { return Err(format!("El nuevo resaltado no conservó la transparencia predeterminada: {modified}")); }
        if !modified["annotations"].as_array().into_iter().flatten().any(|a| a["originalName"] == "source-note" && a["opacity"].as_f64().is_some_and(|v| (v - 0.35).abs() < 0.01)) || !unseen["sourceAnnotationTypes"].as_array().into_iter().flatten().any(|t| t == "Square") { return Err(format!("La copia alteró la opacidad/nombre originales o perdió una anotación no editable: {modified}; unseen={unseen}; export={}", output.display())); }
        // Only inspect page 2 after exporting, so the preservation assertion
        // above really covers original annotations absent from the overlays.
        let second = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":info.token,"page":2})).await?;
        let second_text = mobile_call(app.clone(), "pdfText", serde_json::json!({"token":info.token,"page":2})).await?;
        if second["rotation"] != 90 { return Err("No se reconoció la rotación intrínseca de la segunda página.".into()); }
        for rotation in [90, 270] {
            let response = mobile_call(app.clone(), "pdfRender", serde_json::json!({"token":info.token,"page":2,"width":792,"height":612,"rotation":rotation})).await?;
            let raster = PathBuf::from(response["path"].as_str().ok_or("PDFKit no generó la página rotada.")?);
            let evidence = desktop.data.join(format!("native-pdf-{}-page2-{rotation}.png", if info.size > 2 * 1024 * 1024 * 1024 { "2gib" } else { "small" }));
            fs::rename(&raster, &evidence).map_err(|e| format!("No se pudo conservar la página rotada: {e}"))?;
            rasters.push(serde_json::json!({"page":2,"rotation":rotation,"width":792,"height":612,"path":evidence}));
        }
        let source = inspect_pdf_file(&path)?;
        if source.digest != info.id { return Err("La exportación nativa modificó el original.".into()); }
        // Exercise InkList with both the small fixture and a file-backed 2 GiB PDF.
        let ink_paths = serde_json::json!([[80,300,120,325,170,310],[190,320,230,345]]);
        let ink_path = folder.join("ink-added.pdf");
        let mut ink_annotations = modified["annotations"].as_array().ok_or("Faltan las anotaciones exportadas.")?.clone();
        ink_annotations.push(serde_json::json!({"id":"native-ink","page":1,"kind":"ink","rect":[77,297,233,348],"color":"#2357a1","text":"","created":1700000000000i64,"strokeWidth":3,"inkPaths":ink_paths}));
        mobile_call(app.clone(), "pdfExport", serde_json::json!({"token":exported.token,"path":ink_path,"annotations":ink_annotations,"removedSourceRefs":[]})).await?;
        let ink_info = register(&desktop, ink_path.clone())?;
        mobile_call(app.clone(), "pdfOpen", serde_json::json!({"token":ink_info.token,"path":ink_path,"id":ink_info.id,"revision":ink_info.revision,"size":ink_info.size,"password":""})).await?;
        let ink_page = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":ink_info.token,"page":1})).await?;
        let ink = ink_page["annotations"].as_array().into_iter().flatten().find(|a| a["kind"] == "ink").ok_or("El dibujo no se guardó en el PDF nativo.")?;
        if serde_json::from_value::<Vec<Vec<f64>>>(ink["inkPaths"].clone()).ok() != Some(vec![vec![80.0,300.0,120.0,325.0,170.0,310.0],vec![190.0,320.0,230.0,345.0]]) || ink["strokeWidth"].as_f64() != Some(3.0) { return Err(format!("El dibujo nativo cambió sus trazos o grosor: {ink}")); }
        let erased_path = folder.join("ink-erased.pdf");
        let retained: Vec<_> = ink_page["annotations"].as_array().into_iter().flatten().filter(|a| a["kind"] != "ink").cloned().collect();
        mobile_call(app.clone(), "pdfExport", serde_json::json!({"token":ink_info.token,"path":erased_path,"annotations":retained,"removedSourceRefs":[ink["nativeSourceRef"]]})).await?;
        let erased = register(&desktop, erased_path.clone())?;
        mobile_call(app.clone(), "pdfOpen", serde_json::json!({"token":erased.token,"path":erased_path,"id":erased.id,"revision":erased.revision,"size":erased.size,"password":""})).await?;
        let erased_page = mobile_call(app.clone(), "pdfPageInfo", serde_json::json!({"token":erased.token,"page":1})).await?;
        if erased_page["annotations"].as_array().map(|a| a.len()) != Some(3) || erased_page["annotations"].as_array().into_iter().flatten().any(|a| a["kind"] == "ink") { return Err("La goma nativa no eliminó el dibujo conservando las otras anotaciones.".into()); }
        mobile_call(app.clone(), "pdfClose", serde_json::json!({"token":erased.token})).await?;
        mobile_call(app.clone(), "pdfClose", serde_json::json!({"token":ink_info.token})).await?;
        mobile_call(app.clone(), "pdfClose", serde_json::json!({"token":exported.token})).await?;
        mobile_call(app.clone(), "pdfClose", serde_json::json!({"token":info.token})).await?;
        reports.push(serde_json::json!({"nativeInkRoundTrip":true,"nativeInkErased":true,"document":info,"sourcePath":path,"metadata":metadata,"pageInfo":first,"text":text,"secondPageInfo":second,"secondPageText":second_text,"rasters":rasters,"removedSourceAnnotation":true,"addedNote":true,"addedHighlightDefaultOpacity":true,"unseenHighlightPreserved":true,"unseenNonOverlayPreserved":true,"originalOpacityAndNamePreserved":true,"sourceUnchanged":true,"exportedPath":output,"annotationWriter":writer["annotationWriter"],"incremental":writer["incremental"]}));
    }
    Ok(serde_json::json!({"swiftImportExecuted":true,"pdfKitExecuted":true,"wholeDocumentIPC":false,"UIKitInteractionTested":false,"documents":reports}))
}

#[tauri::command]
pub async fn set_mobile_theme(theme: String, app: tauri::AppHandle) -> Result<(), String> {
    if !["light", "dark", "system"].contains(&theme.as_str()) { return Err("Tema inválido.".into()); }
    mobile_call(app, "setTheme", serde_json::json!({"theme":theme})).await.map(|_| ())
}

#[tauri::command]
pub async fn set_mobile_chrome(visible: bool, app: tauri::AppHandle) -> Result<(), String> {
    mobile_call(app, "setReaderChrome", serde_json::json!({"visible":visible})).await.map(|_| ())
}

#[tauri::command]
pub async fn copy_text(text: String, app: tauri::AppHandle) -> Result<(), String> {
    if text.len() > 1024 * 1024 { return Err("El texto seleccionado es demasiado grande para copiarlo.".into()); }
    mobile_call(app, "copyText", serde_json::json!({"text":text})).await.map(|_| ())
}

#[tauri::command]
pub async fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    if url.len() > 8192 || url.chars().any(char::is_control) { return Err("El enlace no es válido.".into()); }
    let scheme = url.split_once(':').map(|(scheme, _)| scheme.to_ascii_lowercase()).unwrap_or_default();
    if !["http", "https", "mailto", "tel"].contains(&scheme.as_str()) { return Err("El enlace no es compatible.".into()); }
    mobile_call(app, "openExternalUrl", serde_json::json!({"url":url})).await.map(|_| ())
}

async fn mobile_call(app: tauri::AppHandle, command: &'static str, args: Value) -> Result<Value, String> {
    const FAILED: &str = "No se pudo completar la operación.";
    // Swift rejects with text written for the user; bridge errors are technical English.
    tauri::async_runtime::spawn_blocking(move || app.folio_ios().call(command, args).map_err(|error| match error {
        PluginInvokeError::InvokeRejected(response) => response.message.unwrap_or_else(|| FAILED.into()),
        _ => FAILED.into(),
    })).await.map_err(|_| FAILED.to_string())?
}

fn register_imports(desktop: &Desktop, response: Value) -> Result<Vec<DocumentInfo>, String> {
    let paths = response["paths"].as_array().ok_or("No se recibieron los archivos elegidos.")?;
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

/// Swift copies each imported PDF to Documents/Imports/<uuid>/ and saved copies
/// go to exports/<uuid>/; each folder holds one private copy. Deletes those that
/// neither the library, a pending output nor `open` uses. Folders changed in
/// the last minute may still be on their way to a tab.
fn remove_unused_copies(desktop: &Desktop, mut open: Vec<PathBuf>) {
    open.extend(read_recents(desktop).into_iter().map(|r| r.path));
    if let Ok(files) = desktop.files.lock() { open.extend(files.outputs.values().map(|o| o.path.clone())); }
    // Compare resolved paths: Swift and HOME may spell the sandbox differently.
    let kept = open.iter().filter_map(|p| fs::canonicalize(p.parent()?).ok()).collect::<Vec<_>>();
    let imports = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Documents").join("Imports"));
    for root in [Some(desktop.data.join("exports")), imports].into_iter().flatten() {
        for entry in fs::read_dir(root).into_iter().flatten().flatten() {
            let fresh = entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age.as_secs() < 60));
            if fresh || !entry.file_type().is_ok_and(|t| t.is_dir()) || uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() { continue; }
            if fs::canonicalize(entry.path()).is_ok_and(|folder| !kept.contains(&folder)) { let _ = fs::remove_dir_all(entry.path()); }
        }
    }
}

/// Setup runs before any tab is open.
pub fn cleanup_unreferenced_exports(desktop: &Desktop) { remove_unused_copies(desktop, Vec::new()) }

/// Deletes the imported and saved copies that neither the library nor an open
/// tab uses. The frontend calls it after forget_document, clear_saved_state
/// and replacing a saved document, passing the source tokens of its open tabs.
#[tauri::command]
pub fn prune_private_copies(keep: Vec<String>, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let open = {
        let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
        keep.iter().filter_map(|token| files.sources.get(token).map(|s| s.path.clone())).collect()
    };
    remove_unused_copies(&desktop, open);
    Ok(())
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

/// iPad shows Share and Print as popovers from the control that opened them:
/// `x,y,width,height` in CSS pixels of the webview.
fn anchor(request: &tauri::ipc::Request<'_>) -> Option<Vec<f64>> {
    let values = request.headers().get("x-folio-anchor")?.to_str().ok()?.split(',').map(|v| v.trim().parse::<f64>().ok()).collect::<Option<Vec<_>>>()?;
    (values.len() == 4 && values.iter().all(|v| v.is_finite())).then_some(values)
}

#[tauri::command]
pub async fn share_pdf_copy(request: tauri::ipc::Request<'_>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<bool, String> {
    let anchor = anchor(&request);
    let path = write_reserved(request, &desktop, true)?;
    let response = mobile_call(app, "shareFile", serde_json::json!({"path":path,"anchor":anchor})).await;
    remove_export(&desktop, &path);
    response.map(|r| r["completed"].as_bool() == Some(true))
}

#[tauri::command]
pub async fn print_pdf_copy(request: tauri::ipc::Request<'_>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<bool, String> {
    let anchor = anchor(&request);
    let path = write_reserved(request, &desktop, true)?;
    let response = mobile_call(app, "printFile", serde_json::json!({"path":path,"anchor":anchor})).await;
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
    let path = PathBuf::from(response["path"].as_str().ok_or("No se pudo mostrar esta página.")?);
    let resolved = fs::canonicalize(&path).map_err(|_| "No se pudo leer la imagen de la página.")?;
    let temporary = app.path().temp_dir().map_err(|_| "No se pudo comprobar la carpeta temporal.")?.join("FolioPageRasters");
    let root = fs::canonicalize(&temporary).map_err(|_| "No se pudo comprobar la carpeta de imágenes.")?;
    if resolved.parent() != Some(root.as_path()) { return Err("La imagen devuelta no está en la carpeta de Folio.".into()); }
    let result = (|| {
        if fs::metadata(&resolved).map_err(|_| "No se pudo comprobar la imagen.")?.len() > 20 * 1024 * 1024 { return Err("La imagen generada excede el tamaño de una página.".into()); }
        let bytes = fs::read(&resolved).map_err(|_| "No se pudo leer la imagen.")?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("No se pudo mostrar esta página.".into()); }
        Ok(tauri::ipc::Response::new(bytes))
    })();
    let _ = fs::remove_file(resolved);
    result
}

#[tauri::command]
pub async fn native_pdf_present(token: String, name: String, action: String, annotations: Value, removed_source_refs: Vec<String>, anchor: Option<Vec<f64>>, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Value, String> {
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
    let response = mobile_call(app, command, serde_json::json!({"path":output.path,"anchor":anchor})).await;
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
