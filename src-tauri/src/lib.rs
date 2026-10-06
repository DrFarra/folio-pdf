use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::Mutex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
mod binary_ipc;
mod drive;
mod drive_auth;
use drive::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "ios")]
mod ios_commands;
#[cfg(target_os = "ios")]
use ios_commands::{pick_document, pick_documents, choose_output, write_pdf_copy, choose_export, write_export, print_document, share_document, share_pdf_copy, print_pdf_copy, set_mobile_theme, set_mobile_chrome, prune_private_copies, copy_text, native_pdf_open, native_pdf_page_info, native_pdf_render, native_pdf_text, native_pdf_outline, native_pdf_close, native_pdf_present, open_external_url};
#[cfg(target_os = "android")]
mod android_commands;
#[cfg(target_os = "android")]
use android_commands::*;
use folio_core::{atomic_write, protect_original, read_pdf, validate_pdf, inspect_pdf_file, read_pdf_range, file_snapshot, write_private, FileSnapshot, PdfFileInfo};

#[derive(Clone, Serialize)]
struct DocumentInfo { token: String, name: String, size: u64, id: String, revision: String }
struct Source { path: PathBuf, digest: String, info: DocumentInfo, snapshot: FileSnapshot }
struct Output { path: PathBuf, fingerprint: Option<String>, source: Option<PathBuf>, format: String }
#[derive(Default)]
struct SystemOpen { documents: Vec<DocumentInfo>, errors: Vec<String> }
#[derive(Default)]
struct Files {
    sources: HashMap<String, Source>,
    outputs: HashMap<String, Output>,
    startup: Vec<DocumentInfo>,
    pending: SystemOpen,
    frontend_ready: bool,
}
impl Files {
    fn queue_system_open(&mut self, opened: SystemOpen) -> Option<SystemOpen> {
        if self.frontend_ready { return Some(opened); }
        self.pending.documents.extend(opened.documents);
        self.pending.errors.extend(opened.errors);
        None
    }
    fn frontend_started(&mut self) -> SystemOpen {
        let pending = std::mem::take(&mut self.pending);
        self.startup.extend(pending.documents);
        self.frontend_ready = true;
        // Keep the initial snapshot for a webview reload; pending events are
        // acknowledged once and never also emitted to the same frontend.
        SystemOpen { documents: self.startup.clone(), errors: pending.errors }
    }
}
struct Desktop { files: Mutex<Files>, store: Mutex<()>, data: PathBuf }
#[derive(Default)]
struct EarlyOpenPaths(Mutex<Vec<PathBuf>>);

fn register(desktop: &Desktop, path: PathBuf) -> Result<DocumentInfo, String> {
    let file = inspect_pdf_file(&path)?;
    register_file(desktop, path, file)
}
fn register_file(desktop: &Desktop, path: PathBuf, file: PdfFileInfo) -> Result<DocumentInfo, String> {
    let token = uuid::Uuid::new_v4().to_string();
    let info = DocumentInfo { token: token.clone(), name: path.file_name().ok_or("Nombre de archivo inválido.")?.to_string_lossy().into(), size: file.snapshot.size, id: file.digest.clone(), revision: file.digest.clone() };
    desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.insert(token, Source { path, digest: file.digest, info: info.clone(), snapshot: file.snapshot });
    Ok(info)
}
/// A PDF Folio has just written is identified from the bytes in memory instead of reading it back.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn register_written(desktop: &Desktop, path: PathBuf, bytes: &[u8]) -> Result<DocumentInfo, String> {
    let snapshot = file_snapshot(&path)?;
    register_file(desktop, path, PdfFileInfo { snapshot, digest: folio_core::digest(bytes) })
}

/// Opens from the system and from the app menu reach the frontend once it listens.
fn deliver(app: &tauri::AppHandle, opened: SystemOpen) {
    let desktop = app.state::<Desktop>();
    let Ok(mut files) = desktop.files.lock() else { return; };
    let deliver = files.queue_system_open(opened);
    drop(files);
    if let Some(opened) = deliver {
        for error in opened.errors { let _ = app.emit("folio-open-error", error); }
        if !opened.documents.is_empty() { let _ = app.emit("folio-open-documents", opened.documents); }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn pick(app: tauri::AppHandle) -> Result<SystemOpen, String> {
    let dialog = app.clone();
    let paths = tauri::async_runtime::spawn_blocking(move || dialog.dialog().file().add_filter("Documentos PDF", &["pdf"]).blocking_pick_files()).await.map_err(|_| "No se pudo abrir el diálogo.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let mut opened = SystemOpen::default();
        for path in paths.unwrap_or_default() {
            match path.into_path().map_err(|_| "El archivo elegido no tiene una ruta local.".to_string()).and_then(|path| register(&desktop, path)) {
                Ok(info) => opened.documents.push(info),
                Err(error) => opened.errors.push(error),
            }
        }
        opened
    }).await.map_err(|_| "No se pudieron abrir los archivos elegidos.".to_string())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command]
async fn pick_documents(app: tauri::AppHandle) -> Result<Vec<DocumentInfo>, String> {
    let opened = pick(app.clone()).await?;
    // A file that cannot be opened is reported on its own; the others still open.
    for error in opened.errors { let _ = app.emit("folio-open-error", error); }
    Ok(opened.documents)
}

#[tauri::command]
fn startup_documents(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Vec<DocumentInfo>, String> {
    let opened = desktop.files.lock().map_err(|_| "No se pudieron leer los documentos iniciales.")?.frontend_started();
    for error in opened.errors { let _ = app.emit("folio-open-error", error); }
    Ok(opened.documents)
}

fn source_file(desktop: &Desktop, token: &str, missing: &str) -> Result<(PathBuf, FileSnapshot), String> {
    let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let source = files.sources.get(token).ok_or(missing)?;
    Ok((source.path.clone(), source.snapshot.clone()))
}

#[tauri::command(async)]
fn read_document(token: String, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    let (path, snapshot) = source_file(&desktop, &token, "Vuelve a elegir el archivo para abrirlo.")?;
    #[cfg(target_os = "ios")]
    if snapshot.size > 32 * 1024 * 1024 { return Err("Este documento se abre con el lector nativo de Folio; utiliza native_pdf_open.".into()); }
    let bytes = read_pdf(&path)?;
    // read_pdf refuses a file that changes while it reads; this, one changed since it was opened.
    if file_snapshot(&path)? != snapshot { return Err("El archivo cambió en disco. Vuelve a abrirlo.".into()); }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
fn read_document_range(token: String, offset: u64, length: usize, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    let (path, snapshot) = source_file(&desktop, &token, "El documento no está disponible.")?;
    read_pdf_range(&path, &snapshot, offset, length).map(tauri::ipc::Response::new)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command]
async fn choose_output(source: Option<String>, name: String, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<String>, String> {
    let filename = Path::new(&name).file_name().ok_or("Nombre de copia inválido.")?.to_string_lossy().into_owned();
    let destination = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Documento PDF", &["pdf"]).set_file_name(filename).blocking_save_file()).await.map_err(|_| "No se pudo abrir el diálogo de guardado.")?;
    let Some(destination) = destination else { return Ok(None); };
    let mut path = destination.into_path().map_err(|_| "Elige una carpeta local.")?;
    if path.extension().and_then(|s| s.to_str()).map(|s| !s.eq_ignore_ascii_case("pdf")).unwrap_or(true) { path.set_extension("pdf"); }
    let original = match source { Some(id) => Some(desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.get(&id).ok_or("El documento de origen ya no está disponible.")?.path.clone()), None => None };
    if let Some(original) = &original { protect_original(original, &path)?; }
    let expected = folio_core::fingerprint(&path)?;
    let token = uuid::Uuid::new_v4().to_string();
    desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.insert(token.clone(), Output { path, fingerprint: expected, source: original, format: "pdf".into() });
    Ok(Some(token))
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command(async)]
fn write_pdf_copy(request: tauri::ipc::Request<'_>, desktop: State<'_, Desktop>) -> Result<DocumentInfo, String> {
    let token = request.headers().get("x-folio-output-token").and_then(|s| s.to_str().ok()).ok_or("No se eligió un destino de guardado.")?;
    let bytes = crate::binary_ipc::bytes(request.body())?;
    validate_pdf(&bytes)?;
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(token).ok_or("El destino venció. Elige nuevamente dónde guardar.")?;
    if output.format != "pdf" { return Err("Destino de PDF inválido.".into()); }
    if let Some(original) = &output.source { protect_original(original, &output.path)?; }
    atomic_write(&output.path, &bytes, output.fingerprint.as_deref())?;
    register_written(&desktop, output.path, &bytes)
}

/// Guardar on Windows and macOS replaces the opened PDF in place, without a
/// dialog. It is refused if the file changed on disk since Folio read it.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command(async)]
fn write_pdf_original(request: tauri::ipc::Request<'_>, desktop: State<'_, Desktop>) -> Result<DocumentInfo, String> {
    let token = request.headers().get("x-folio-source-token").and_then(|s| s.to_str().ok()).ok_or(REOPEN)?;
    replace_original(&desktop, token, &crate::binary_ipc::bytes(request.body())?)
}
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const REOPEN: &str = "Vuelve a abrir el PDF para guardarlo.";
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn replace_original(desktop: &Desktop, token: &str, bytes: &[u8]) -> Result<DocumentInfo, String> {
    validate_pdf(bytes)?;
    let (path, digest) = {
        let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
        let source = files.sources.get(token).ok_or(REOPEN)?;
        (source.path.clone(), source.digest.clone())
    };
    // A symbolic link keeps pointing to the saved file.
    let target = if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) { fs::canonicalize(&path).map_err(|_| REOPEN)? } else { path.clone() };
    atomic_write(&target, &bytes, Some(&digest)).map_err(|error| match error.as_str() {
        folio_core::DESTINATION_CHANGED if target.exists() => "Otro programa modificó este PDF después de abrirlo. Usa «Guardar una copia…» para no perder tus cambios.".into(),
        folio_core::DESTINATION_CHANGED => "El PDF original ya no está en su carpeta. Usa «Guardar una copia…» para no perder tus cambios.".into(),
        _ => error,
    })?;
    register_written(desktop, path, bytes)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command]
async fn choose_export(source: Option<String>, name: String, format: String, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<String>, String> {
    if !["txt", "zip", "docx"].contains(&format.as_str()) { return Err("Formato no admitido.".into()); }
    let filename = Path::new(&name).file_name().ok_or("Nombre inválido.")?.to_string_lossy().into_owned();
    let extension = format.clone();
    let destination = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Archivo exportado", &[extension.as_str()]).set_file_name(filename).blocking_save_file()).await.map_err(|_| "No se pudo abrir el diálogo.")?;
    let Some(destination) = destination else { return Ok(None); };
    let mut path = destination.into_path().map_err(|_| "Elige una carpeta local.")?;
    path.set_extension(&format);
    let original = match source { Some(id) => Some(desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.get(&id).ok_or("Origen no disponible.")?.path.clone()), None => None };
    if let Some(original) = &original { protect_original(original, &path)?; }
    let expected = folio_core::fingerprint(&path)?; let token = uuid::Uuid::new_v4().to_string();
    desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.insert(token.clone(), Output { path, fingerprint: expected, source: original, format });
    Ok(Some(token))
}
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command(async)]
fn write_export(request: tauri::ipc::Request<'_>, desktop: State<'_, Desktop>) -> Result<(), String> {
    let token = request.headers().get("x-folio-output-token").and_then(|s| s.to_str().ok()).ok_or("Destino ausente.")?;
    let bytes = crate::binary_ipc::bytes(request.body())?;
    if bytes.is_empty() { return Err("El archivo exportado está vacío.".into()); }
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(token).ok_or("Destino vencido.")?;
    if output.format == "pdf" { return Err("Usa el guardado de PDF.".into()); }
    if let Some(original) = &output.source { protect_original(original, &output.path)?; }
    atomic_write(&output.path, &bytes, output.fingerprint.as_deref())
}
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command]
fn print_document(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|_| "No se pudo abrir el diálogo de impresión.".into())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn validated_external_url(value: &str) -> Result<tauri::Url, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) { return Err("Enlace externo inválido.".into()); }
    let url = tauri::Url::parse(value).map_err(|_| "Enlace externo inválido.")?;
    if !["http", "https", "mailto", "tel"].contains(&url.scheme()) {
        return Err("Este tipo de enlace no se puede abrir desde Folio.".into());
    }
    if ["http", "https"].contains(&url.scheme()) && url.host_str().is_none() { return Err("El enlace no tiene un destino válido.".into()); }
    Ok(url)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let url = validated_external_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer.exe");
        #[cfg(target_os = "macos")]
        let mut command = { let mut command = std::process::Command::new("open"); command.arg("--"); command };
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let mut command = std::process::Command::new("xdg-open");
        // The URL is one argument to an OS launcher, never shell source.
        command.arg(url.as_str());
        #[cfg(target_os = "windows")]
        {
            // Explorer forwards to the existing shell and its exit status does
            // not reliably describe whether that handoff opened the URL.
            command.spawn().map_err(|_| "No se pudo abrir la aplicación para este enlace.".to_string())?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let status = command.status().map_err(|_| "No se pudo abrir la aplicación para este enlace.".to_string())?;
            if !status.success() { return Err("El sistema no pudo abrir este enlace.".into()); }
        }
        Ok(())
    }).await.map_err(|_| "No se pudo abrir el enlace externo.".to_string())?
}

fn session_path(desktop: &Desktop, id: &str) -> Result<PathBuf, String> {
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("Identificador de documento inválido.".into()); }
    Ok(desktop.data.join("sessions").join(format!("{id}.json")))
}

fn draft_path(desktop: &Desktop, id: &str) -> Result<PathBuf, String> {
    session_path(desktop, id)?;
    Ok(desktop.data.join("drafts").join(format!("{id}.pdf")))
}
#[tauri::command(async)]
fn load_draft(id: String, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    Ok(tauri::ipc::Response::new(if path.exists() { read_pdf(&path)? } else { Vec::new() }))
}

#[tauri::command(async)]
fn native_draft_document(id: String, name: String, desktop: State<'_, Desktop>) -> Result<Option<DocumentInfo>, String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    if !path.exists() { return Ok(None); }
    let mut info = register(&desktop, path)?;
    info.name = Path::new(&name).file_name().ok_or("Nombre de borrador inválido.")?.to_string_lossy().into();
    if let Some(source) = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.get_mut(&info.token) { source.info.name = info.name.clone(); }
    Ok(Some(info))
}
#[tauri::command(async)]
fn store_draft(request: tauri::ipc::Request<'_>, desktop: State<'_, Desktop>) -> Result<(), String> {
    let id = request.headers().get("x-folio-draft-id").and_then(|s| s.to_str().ok()).ok_or("Identificador de borrador ausente.")?;
    let bytes = crate::binary_ipc::bytes(request.body())?;
    validate_pdf(&bytes)?;
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, id)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|_| "No se pudo crear la carpeta de borradores.")?;
    write_private(&path, &bytes)
}
#[tauri::command(async)]
fn discard_draft(id: String, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    if path.exists() { fs::remove_file(path).map_err(|_| "No se pudo borrar el borrador.")?; }
    let mut entries = read_recents(&desktop); entries.retain(|r| !(r.draft && r.id == id)); save_recents(&desktop, &entries)?;
    Ok(())
}

#[tauri::command(async)]
fn load_session(id: String, desktop: State<'_, Desktop>) -> Result<Option<Value>, String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = session_path(&desktop, &id)?;
    if !path.exists() { return Ok(None); }
    let bytes = fs::read(&path).map_err(|_| "No se pudo recuperar la sesión.")?;
    // A damaged session is set aside: the PDF still opens, without its previous state.
    serde_json::from_slice(&bytes).map(Some).or_else(|_| fs::rename(&path, path.with_extension("json.corrupt")).map(|_| None).map_err(|_| "La sesión guardada está dañada.".into()))
}

#[tauri::command(async)]
fn store_session(id: String, session: Value, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = session_path(&desktop, &id)?;
    let bytes = serde_json::to_vec(&session).map_err(|_| "No se pudo preparar la sesión.")?;
    if bytes.len() > 4 * 1024 * 1024 { return Err("La sesión es demasiado grande. Guarda una copia del PDF.".into()); }
    if let Ok(old) = fs::read(&path) {
        if let Ok(previous) = serde_json::from_slice::<Value>(&old) {
            if previous["revision"].as_u64().unwrap_or(0) > session["revision"].as_u64().unwrap_or(0) { return Ok(()); }
        }
    }
    fs::create_dir_all(path.parent().unwrap()).map_err(|_| "No se pudo crear el almacenamiento de sesiones.")?;
    write_private(&path, &bytes)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recent { id: String, name: String, size: u64, pages: usize, opened_at: u64, path: PathBuf, #[serde(default)] draft: bool, #[serde(default)] hidden: bool }
fn read_recents(desktop: &Desktop) -> Vec<Recent> {
    fs::read(desktop.data.join("recent.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn save_recents(desktop: &Desktop, entries: &[Recent]) -> Result<(), String> {
    write_private(&desktop.data.join("recent.json"), &serde_json::to_vec(entries).map_err(|_| "No se pudo guardar la biblioteca.")?)
}
/// The durable catalog is metadata-only; opening registers just the selected document.
fn catalog_entries(desktop: &Desktop) -> Result<Vec<Value>, String> {
    let mut entries = {
        let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
        read_recents(desktop)
    };
    entries.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
    // Keep an unavailable original in the catalog. Hiding history or a
    // missing external file must never erase its session or local draft.
    Ok(entries.into_iter().map(|r| serde_json::json!({"id":r.id,"name":r.name,"size":r.size,"pages":r.pages,"openedAt":r.opened_at,"draft":r.draft,"hidden":r.hidden})).collect())
}
#[tauri::command]
async fn list_library(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || catalog_entries(&app.state::<Desktop>())).await.map_err(|_| "No se pudo leer la biblioteca.".to_string())?
}
fn open_library_entry(desktop: &Desktop, id: &str) -> Result<DocumentInfo, String> {
    session_path(desktop, id)?;
    let record = {
        let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
        read_recents(desktop).into_iter().find(|record| record.id == id)
            .ok_or("Este documento ya no está en la biblioteca.")?
    };
    // A draft record already points to the local modified copy. Missing source
    // files return an error without deleting their catalog, session or draft.
    let mut source = register(desktop, record.path)?;
    source.name = record.name;
    if let Some(registered) = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.get_mut(&source.token) {
        registered.info.name = source.name.clone();
    }
    Ok(source)
}
#[tauri::command]
async fn open_library_document(id: String, app: tauri::AppHandle) -> Result<DocumentInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        open_library_entry(&desktop, &id)
    }).await.map_err(|_| "No se pudo abrir el documento de la biblioteca.".to_string())?
}
fn hide_recent_entry(desktop: &Desktop, id: &str) -> Result<(), String> {
    let mut entries = read_recents(desktop);
    if let Some(entry) = entries.iter_mut().find(|entry| entry.id == id) {
        entry.hidden = true;
        save_recents(desktop, &entries)?;
    }
    Ok(())
}
#[tauri::command(async)]
fn hide_recent(id: String, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    hide_recent_entry(&desktop, &id)
}
fn remember_catalog_entry(desktop: &Desktop, record: Recent) -> Result<(), String> {
    let mut entries = read_recents(desktop);
    // A PDF changed outside Folio gets a new id: its previous entry for the same file goes.
    entries.retain(|entry| entry.id != record.id && (entry.draft || entry.path != record.path));
    entries.insert(0, record);
    // recent.json is also the durable library catalog: opening another PDF
    // must not evict an earlier document.
    save_recents(desktop, &entries)
}
#[tauri::command(async)]
fn remember_document(id: String, token: String, pages: usize, opened_at: u64, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let record = {
        let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
        let source = files.sources.get(&token).ok_or("El documento ya no está disponible.")?;
        Recent { id, name: source.info.name.clone(), size: source.info.size, pages, opened_at, path: source.path.clone(), draft: false, hidden: false }
    };
    remember_catalog_entry(&desktop, record)
}
#[tauri::command(async)]
fn remember_draft(id: String, name: String, pages: usize, opened_at: u64, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    let size = file_snapshot(&path)?.size;
    let name = Path::new(&name).file_name().ok_or("Nombre inválido.")?.to_string_lossy().into_owned();
    let record = Recent { id, name, size, pages, opened_at, path, draft: true, hidden: false };
    remember_catalog_entry(&desktop, record)
}
#[tauri::command(async)]
fn forget_document(id: String, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let mut entries = read_recents(&desktop); entries.retain(|r| r.id != id); save_recents(&desktop, &entries)?;
    let path = session_path(&desktop, &id)?;
    if path.exists() { fs::remove_file(path).map_err(|_| "No se pudo borrar la sesión.")?; }
    let draft = draft_path(&desktop, &id)?;
    if draft.exists() { fs::remove_file(draft).map_err(|_| "No se pudo borrar el borrador.")?; }
    Ok(())
}
#[tauri::command(async)]
fn clear_saved_state(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<(), String> {
    {
        let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
        save_recents(&desktop, &[])?;
        let sessions = desktop.data.join("sessions");
        if sessions.exists() { fs::remove_dir_all(sessions).map_err(|_| "No se pudieron borrar todas las sesiones.")?; }
        let drafts = desktop.data.join("drafts");
        if drafts.exists() { fs::remove_dir_all(drafts).map_err(|_| "No se pudieron borrar todos los borradores.")?; }
    }
    drive::clear_copies(&app, &desktop)
}

const NOT_PDF: &str = "Solo se pueden abrir archivos PDF.";
fn open_from_system(app: &tauri::AppHandle, paths: Vec<PathBuf>) { open_paths(app, paths, false) }
/// `dropped` files that are not PDFs are already reported by the frontend.
fn open_paths(app: &tauri::AppHandle, paths: Vec<PathBuf>, dropped: bool) {
    {
        let incoming = app.state::<EarlyOpenPaths>();
        let Ok(mut early) = incoming.0.lock() else { return; };
        // Launch Services and the single-instance callback can arrive before
        // Ready runs setup. Publish Desktop and drain this queue under this lock.
        if app.try_state::<Desktop>().is_none() { early.extend(paths); return; }
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let mut opened = SystemOpen::default();
        for path in paths {
            let pdf = path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("pdf"));
            // Arguments that are not files are launch flags. A PDF without its extension still opens.
            if !pdf && (dropped || !path.is_file()) { continue; }
            match register(&desktop, path) {
                Ok(info) => opened.documents.push(info),
                Err(_) if !pdf => if !opened.errors.iter().any(|e| e == NOT_PDF) { opened.errors.push(NOT_PDF.into()); },
                Err(error) => opened.errors.push(error),
            }
        }
        deliver(&app, opened);
    });
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn resolve_arguments(argv: Vec<String>, cwd: &Path) -> Vec<PathBuf> {
    argv.into_iter().skip(1).map(|argument| {
        let path = PathBuf::from(argument);
        if path.is_absolute() { path } else { cwd.join(path) }
    }).collect()
}

#[cfg(any(target_os = "macos", target_os = "ios", test))]
fn file_url_paths(urls: Vec<tauri::Url>) -> Vec<PathBuf> {
    urls.into_iter().filter_map(|url| url.to_file_path().ok()).collect()
}

/// The macOS menu bar, in Spanish. Abrir… and Salir de Folio work natively;
/// Folio's other items reach the frontend as a `folio-menu` event with their id.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    let item = |id: &str, text: &str, accelerator: Option<&str>| MenuItem::with_id(app, id, text, true, accelerator);
    let separator = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata { name: Some("Folio".into()), version: Some(app.package_info().version.to_string()), copyright: app.config().bundle.copyright.clone(), ..Default::default() };
    Menu::with_items(app, &[
        &Submenu::with_items(app, "Folio", true, &[
            &PredefinedMenuItem::about(app, Some("Acerca de Folio"), Some(about))?,
            &separator()?,
            &item("settings", "Ajustes…", Some("CmdOrCtrl+,"))?,
            &separator()?,
            &PredefinedMenuItem::services(app, Some("Servicios"))?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some("Ocultar Folio"))?,
            &PredefinedMenuItem::hide_others(app, Some("Ocultar otros"))?,
            &PredefinedMenuItem::show_all(app, Some("Mostrar todo"))?,
            &separator()?,
            &item("quit", "Salir de Folio", Some("CmdOrCtrl+Q"))?,
        ])?,
        &Submenu::with_items(app, "Archivo", true, &[
            &item("open", "Abrir…", Some("CmdOrCtrl+O"))?,
            &separator()?,
            &item("save", "Guardar", Some("CmdOrCtrl+S"))?,
            &item("save-copy", "Guardar una copia…", Some("CmdOrCtrl+Shift+S"))?,
            &separator()?,
            &item("print", "Imprimir…", Some("CmdOrCtrl+P"))?,
            &separator()?,
            &item("close-tab", "Cerrar pestaña", Some("CmdOrCtrl+W"))?,
        ])?,
        &Submenu::with_items(app, "Edición", true, &[
            &PredefinedMenuItem::undo(app, Some("Deshacer"))?,
            &PredefinedMenuItem::redo(app, Some("Rehacer"))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some("Cortar"))?,
            &PredefinedMenuItem::copy(app, Some("Copiar"))?,
            &PredefinedMenuItem::paste(app, Some("Pegar"))?,
            &PredefinedMenuItem::select_all(app, Some("Seleccionar todo"))?,
            &separator()?,
            &item("find", "Buscar…", Some("CmdOrCtrl+F"))?,
        ])?,
        &Submenu::with_items(app, "Visualización", true, &[
            &item("zoom-in", "Ampliar", Some("CmdOrCtrl+="))?,
            &item("zoom-out", "Reducir", Some("CmdOrCtrl+-"))?,
            &item("zoom-reset", "Tamaño real", Some("CmdOrCtrl+0"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, Some("Pantalla completa"))?,
        ])?,
        &Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, "Ventana", true, &[
            &PredefinedMenuItem::minimize(app, Some("Minimizar"))?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
        ])?,
        &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Ayuda", true, &[&item("help", "Ayuda de Folio", None)?])?,
    ])
}

#[cfg(target_os = "macos")]
fn menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "open" => { let app = app.clone(); tauri::async_runtime::spawn(async move { match pick(app.clone()).await { Ok(opened) => deliver(&app, opened), Err(error) => { let _ = app.emit("folio-open-error", error); } } }); }
        // Closing the window runs the frontend's close flow, which keeps open tabs and edits.
        "quit" => match app.get_webview_window("main") { Some(window) => { let _ = window.close(); } None => app.exit(0) },
        id @ ("settings" | "save" | "save-copy" | "print" | "close-tab" | "find" | "zoom-in" | "zoom-out" | "zoom-reset" | "help") => { let _ = app.emit("folio-menu", id); }
        _ => {}
    }
}

/// Tauri could not create the window, usually because WebView2 is missing on Windows.
fn startup_failed() -> ! {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" { fn MessageBoxW(window: *mut std::ffi::c_void, text: *const u16, caption: *const u16, kind: u32) -> i32; }
        let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
        const MB_ICONERROR: u32 = 0x10;
        unsafe { MessageBoxW(std::ptr::null_mut(), wide("Folio no pudo iniciarse. Reinstala Folio o instala Microsoft Edge WebView2.").as_ptr(), wide("Folio").as_ptr(), MB_ICONERROR); }
    }
    #[cfg(not(windows))]
    eprintln!("Folio no pudo iniciarse. Reinstala Folio.");
    std::process::exit(1)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(EarlyOpenPaths::default()).manage(DriveState::default());
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_from_system(app, resolve_arguments(argv, Path::new(&cwd)));
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(menu_event);
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_folio_android::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_folio_ios::init());
    #[cfg(feature = "native-qa")]
    let builder = builder.plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("native-qa")
        .js_init_script(include_str!("native_qa.js"))
        .build());
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.invoke_handler(tauri::generate_handler![drive_status, drive_connect, drive_cancel_connect, drive_disconnect, drive_list, drive_open, drive_cached, drive_lookup, drive_stage, drive_stage_native, drive_sync, drive_discard, drive_pending_open, pick_documents, startup_documents, read_document, read_document_range, choose_output, write_pdf_copy, write_pdf_original, choose_export, write_export, print_document, open_external_url, load_session, store_session, load_draft, native_draft_document, store_draft, discard_draft, list_library, open_library_document, hide_recent, remember_document, remember_draft, forget_document, clear_saved_state]);
    #[cfg(all(target_os = "ios", not(feature = "native-qa")))]
    let builder = builder.invoke_handler(tauri::generate_handler![drive_status, drive_connect, drive_cancel_connect, drive_disconnect, drive_list, drive_open, drive_cached, drive_lookup, drive_stage, drive_stage_native, drive_sync, drive_discard, drive_pending_open, pick_document, pick_documents, startup_documents, read_document, read_document_range, choose_output, write_pdf_copy, choose_export, write_export, print_document, share_document, share_pdf_copy, print_pdf_copy, set_mobile_theme, set_mobile_chrome, prune_private_copies, copy_text, native_pdf_open, native_pdf_page_info, native_pdf_render, native_pdf_text, native_pdf_outline, native_pdf_close, native_pdf_present, open_external_url, load_session, store_session, load_draft, native_draft_document, store_draft, discard_draft, list_library, open_library_document, hide_recent, remember_document, remember_draft, forget_document, clear_saved_state]);
    #[cfg(all(target_os = "ios", feature = "native-qa"))]
    let builder = builder.invoke_handler(tauri::generate_handler![drive_status, drive_connect, drive_cancel_connect, drive_disconnect, drive_list, drive_open, drive_cached, drive_lookup, drive_stage, drive_stage_native, drive_sync, drive_discard, drive_pending_open, pick_document, pick_documents, startup_documents, read_document, read_document_range, choose_output, write_pdf_copy, choose_export, write_export, print_document, share_document, share_pdf_copy, print_pdf_copy, set_mobile_theme, set_mobile_chrome, prune_private_copies, copy_text, native_pdf_open, native_pdf_page_info, native_pdf_render, native_pdf_text, native_pdf_outline, native_pdf_close, native_pdf_present, open_external_url, ios_commands::ios_native_status, ios_commands::ios_native_file_probe, load_session, store_session, load_draft, native_draft_document, store_draft, discard_draft, list_library, open_library_document, hide_recent, remember_document, remember_draft, forget_document, clear_saved_state]);
    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![drive_status, drive_connect, drive_cancel_connect, drive_disconnect, drive_list, drive_open, drive_cached, drive_lookup, drive_stage, drive_stage_native, drive_sync, drive_discard, drive_pending_open, pick_document, pick_documents, startup_documents, read_document, read_document_range, choose_output, write_pdf_copy, choose_export, write_export, write_pdf_original, share_pdf_copy, print_pdf_copy, set_mobile_theme, set_mobile_chrome, android_safe_area, open_external_url, binary_ipc::upload_begin, binary_ipc::upload_chunk, load_session, store_session, load_draft, native_draft_document, store_draft, discard_draft, list_library, open_library_document, hide_recent, remember_document, remember_draft, forget_document, clear_saved_state, prune_private_copies]);
    builder
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            #[cfg(feature = "native-qa")]
            let data = data.join("native-qa");
            fs::create_dir_all(&data)?;
            let desktop = Desktop { files: Mutex::new(Files::default()), store: Mutex::new(()), data };
            #[cfg(target_os = "ios")]
            ios_commands::cleanup_unreferenced_exports(&desktop);
            // No tab is open yet: Drive copies that nothing uses can go.
            drive::prune(&desktop, true);
            let paths = {
                let incoming = app.state::<EarlyOpenPaths>();
                let mut early = incoming.0.lock().map_err(|_| "No se pudieron leer las aperturas iniciales.")?;
                app.manage(desktop);
                // Launch arguments open like later system requests, off the main thread.
                std::env::args_os().skip(1).map(PathBuf::from).chain(std::mem::take(&mut *early)).collect::<Vec<_>>()
            };
            if !paths.is_empty() { open_from_system(app.handle(), paths); }
            #[cfg(target_os = "android")]
            android_commands::watch_system_documents(app.handle().clone());
            // Removes the private copies left by earlier versions, saves and deletions.
            #[cfg(target_os = "android")]
            tauri::async_runtime::spawn(android_commands::prune_private_copies(Vec::new(), app.handle().clone()));
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
                if let Some(desktop) = webview.app_handle().try_state::<Desktop>() {
                    if let Ok(mut files) = desktop.files.lock() { files.frontend_ready = false; }
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event { open_paths(window.app_handle(), paths.clone(), true); }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|_| startup_failed())
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::Opened { urls } => {
                    open_from_system(app, file_url_paths(urls));
                    show_main_window(app);
                }
                tauri::RunEvent::Reopen { .. } => show_main_window(app),
                _ => {}
            }
            #[cfg(target_os = "ios")]
            if let tauri::RunEvent::Opened { urls } = event { ios_commands::open_urls(app.clone(), urls); }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestLibrary(Desktop);
    impl TestLibrary {
        fn new() -> Self {
            let data = std::env::temp_dir().join(format!("folio-library-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&data).unwrap();
            Self(Desktop { files: Mutex::new(Files::default()), store: Mutex::new(()), data })
        }
    }
    impl Drop for TestLibrary {
        fn drop(&mut self) {
            let temp = std::env::temp_dir();
            if self.0.data.starts_with(&temp) && self.0.data.file_name().is_some_and(|name| name.to_string_lossy().starts_with("folio-library-test-")) {
                let _ = fs::remove_dir_all(&self.0.data);
            }
        }
    }
    fn catalog_record(desktop: &Desktop, number: usize) -> Recent {
        Recent { id: format!("{number:064x}"), name: format!("Documento {number}.pdf"), size: 42, pages: 2, opened_at: number as u64, path: desktop.data.join(format!("original-{number}.pdf")), draft: false, hidden: false }
    }

    #[test]
    fn legacy_catalog_entries_remain_visible_without_hidden_flag() {
        let record: Recent = serde_json::from_value(serde_json::json!({"id":"a".repeat(64),"name":"Antes.pdf","size":42,"pages":2,"openedAt":10,"path":"original.pdf"})).unwrap();
        assert!(!record.hidden);
        assert!(!record.draft);
    }

    #[test]
    fn hiding_recent_preserves_catalog_original_session_and_draft() {
        let store = TestLibrary::new();
        let record = catalog_record(&store.0, 1);
        let session = session_path(&store.0, &record.id).unwrap();
        let draft = draft_path(&store.0, &record.id).unwrap();
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::create_dir_all(draft.parent().unwrap()).unwrap();
        fs::write(&record.path, b"original untouched").unwrap();
        fs::write(&session, b"session unchanged").unwrap();
        fs::write(&draft, b"modified PDF unchanged").unwrap();
        remember_catalog_entry(&store.0, record.clone()).unwrap();
        hide_recent_entry(&store.0, &record.id).unwrap();
        let saved = read_recents(&store.0);
        assert_eq!(saved.len(), 1);
        assert!(saved[0].hidden);
        assert_eq!(fs::read(&record.path).unwrap(), b"original untouched");
        assert_eq!(fs::read(&session).unwrap(), b"session unchanged");
        assert_eq!(fs::read(&draft).unwrap(), b"modified PDF unchanged");
        assert_eq!(catalog_entries(&store.0).unwrap()[0]["hidden"], true);
        remember_catalog_entry(&store.0, record).unwrap();
        assert!(!read_recents(&store.0)[0].hidden);
    }

    #[test]
    fn opening_many_documents_never_evicts_the_library() {
        let store = TestLibrary::new();
        for number in 1..=25 { remember_catalog_entry(&store.0, catalog_record(&store.0, number)).unwrap(); }
        assert_eq!(read_recents(&store.0).len(), 25);
        let listed = catalog_entries(&store.0).unwrap();
        assert_eq!(listed.len(), 25);
        assert_eq!(listed[0]["openedAt"], 25);
    }

    #[test]
    fn a_pdf_changed_outside_folio_replaces_its_entry_but_keeps_drafts() {
        let store = TestLibrary::new();
        let before = catalog_record(&store.0, 1);
        let mut draft = catalog_record(&store.0, 2);
        draft.draft = true; draft.path = draft_path(&store.0, &draft.id).unwrap();
        remember_catalog_entry(&store.0, before.clone()).unwrap();
        remember_catalog_entry(&store.0, draft).unwrap();
        let after = Recent { id: format!("{:064x}", 3), ..before };
        remember_catalog_entry(&store.0, after.clone()).unwrap();
        let ids = read_recents(&store.0).into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids, [after.id, format!("{:064x}", 2)]);
    }

    #[test]
    fn library_listing_uses_metadata_and_registers_only_the_selected_pdf() {
        let store = TestLibrary::new();
        for number in 1..=2 {
            let record = catalog_record(&store.0, number);
            fs::write(&record.path, format!("%PDF-1.7\noriginal {number}\n%%EOF\n")).unwrap();
            remember_catalog_entry(&store.0, record).unwrap();
        }
        let mut draft_record = catalog_record(&store.0, 3);
        draft_record.draft = true;
        draft_record.path = draft_path(&store.0, &draft_record.id).unwrap();
        fs::create_dir_all(draft_record.path.parent().unwrap()).unwrap();
        fs::write(&draft_record.path, b"%PDF-1.7\nlocal modified copy\n%%EOF\n").unwrap();
        remember_catalog_entry(&store.0, draft_record.clone()).unwrap();
        let missing_record = catalog_record(&store.0, 4);
        remember_catalog_entry(&store.0, missing_record.clone()).unwrap();
        let catalog_before = fs::read(store.0.data.join("recent.json")).unwrap();

        let listed = catalog_entries(&store.0).unwrap();
        assert_eq!(listed.len(), 4);
        assert!(listed.iter().all(|record| record.get("nativeSource").is_none()));
        assert!(store.0.files.lock().unwrap().sources.is_empty(), "Listing must not register or hash PDF files");
        let selected = catalog_record(&store.0, 2);
        let source = open_library_entry(&store.0, &selected.id).unwrap();
        assert_eq!(source.name, selected.name);
        assert_eq!(source.id, folio_core::digest(&fs::read(&selected.path).unwrap()));
        {
            let files = store.0.files.lock().unwrap();
            assert_eq!(files.sources.len(), 1);
            assert_eq!(files.sources.get(&source.token).unwrap().path, selected.path);
        }
        let draft_source = open_library_entry(&store.0, &draft_record.id).unwrap();
        assert_eq!(draft_source.name, draft_record.name);
        assert_eq!(store.0.files.lock().unwrap().sources.get(&draft_source.token).unwrap().path, draft_record.path);
        assert!(open_library_entry(&store.0, &missing_record.id).is_err());
        assert!(open_library_entry(&store.0, &format!("{:064x}", 99)).is_err());
        assert!(open_library_entry(&store.0, "../invalid").is_err());
        assert_eq!(store.0.files.lock().unwrap().sources.len(), 2);
        assert_eq!(fs::read(store.0.data.join("recent.json")).unwrap(), catalog_before, "Listing, opening and failures must preserve catalog metadata");
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    #[test]
    fn external_links_reject_local_and_executable_schemes_before_launching() {
        for url in ["https://example.com/path?q=1&second=2", "http://example.com", "mailto:user@example.com", "tel:+595123456"] {
            assert!(validated_external_url(url).is_ok(), "Allowed link: {url}");
        }
        for url in ["file:///tmp/document.pdf", "javascript:alert(1)", "data:text/html,hello", "cmd:calc", "not a url", "https://example.com\nmalicious", "https://example.com\0"] {
            assert!(validated_external_url(url).is_err(), "Rejected link: {url}");
        }
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    #[test]
    fn saving_replaces_the_opened_pdf_unless_it_changed_on_disk() {
        let store = TestLibrary::new();
        let path = store.0.data.join("Informe.pdf");
        fs::write(&path, b"%PDF-1.7\noriginal\n%%EOF\n").unwrap();
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap(); }
        let opened = register(&store.0, path.clone()).unwrap();
        let saved = replace_original(&store.0, &opened.token, b"%PDF-1.7\nsaved\n%%EOF\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-1.7\nsaved\n%%EOF\n");
        assert_eq!((saved.name.as_str(), saved.id.as_str()), ("Informe.pdf", folio_core::digest(b"%PDF-1.7\nsaved\n%%EOF\n").as_str()));
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640); }
        fs::write(&path, b"%PDF-1.7\nanother app\n%%EOF\n").unwrap();
        let refused = replace_original(&store.0, &saved.token, b"%PDF-1.7\nmine\n%%EOF\n").err().unwrap();
        assert!(refused.contains("Guardar una copia"), "{refused}");
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-1.7\nanother app\n%%EOF\n");
        assert!(replace_original(&store.0, "unknown", b"%PDF-1.7\n%%EOF\n").is_err());
    }

    fn document(token: &str) -> DocumentInfo {
        DocumentInfo { token: token.into(), name: format!("{token}.pdf"), size: 42, id: "a".repeat(64), revision: "a".repeat(64) }
    }

    #[test]
    fn system_open_waits_for_the_frontend_and_acknowledges_once() {
        let mut files = Files::default();
        files.startup.push(document("cli"));
        assert!(files.queue_system_open(SystemOpen { documents: vec![document("finder")], errors: vec!["No se puede acceder al archivo.".into()] }).is_none());
        let first = files.frontend_started();
        assert_eq!(first.documents.iter().map(|d| d.token.as_str()).collect::<Vec<_>>(), ["cli", "finder"]);
        assert_eq!(first.errors.len(), 1);
        assert!(files.pending.documents.is_empty());
        assert!(files.pending.errors.is_empty());
        let next = files.queue_system_open(SystemOpen { documents: vec![document("later")], errors: vec![] }).unwrap();
        assert_eq!(next.documents[0].token, "later");
        assert_eq!(files.startup.len(), 2);
    }

    #[test]
    fn reload_restores_initial_documents_without_repeating_pending_events() {
        let mut files = Files::default();
        files.queue_system_open(SystemOpen { documents: vec![document("first"), document("second")], errors: vec!["initial error".into()] });
        assert_eq!(files.frontend_started().documents.len(), 2);
        files.frontend_ready = false;
        files.queue_system_open(SystemOpen { documents: vec![document("while-reloading")], errors: vec![] });
        let reloaded = files.frontend_started();
        assert_eq!(reloaded.documents.iter().map(|d| d.token.as_str()).collect::<Vec<_>>(), ["first", "second", "while-reloading"]);
        assert!(reloaded.errors.is_empty());
        files.frontend_ready = false;
        assert_eq!(files.frontend_started().documents.len(), 3);
    }

    #[test]
    fn second_instance_resolves_relative_paths_from_its_own_directory() {
        let cwd = PathBuf::from("other-instance");
        let absolute = std::env::current_dir().unwrap().join("absolute.pdf");
        let paths = resolve_arguments(vec!["folio".into(), "Clínica renal.pdf".into(), absolute.to_string_lossy().into_owned()], &cwd);
        assert_eq!(paths, [cwd.join("Clínica renal.pdf"), absolute]);
    }

    #[test]
    fn file_urls_decode_names_without_treating_remote_urls_as_local_files() {
        let path = std::env::current_dir().unwrap().join("Clínica renal #1.pdf");
        let local = tauri::Url::from_file_path(&path).unwrap();
        let remote = tauri::Url::parse("https://example.com/document.pdf").unwrap();
        assert_eq!(file_url_paths(vec![local, remote]), [path]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_percent_encoded_url_is_a_local_macos_path() {
        let url = tauri::Url::parse("file:///Users/Emilio/Documents/Cl%C3%ADnica%20renal%20%231.pdf").unwrap();
        assert_eq!(file_url_paths(vec![url]), [PathBuf::from("/Users/Emilio/Documents/Clínica renal #1.pdf")]);
    }
}
