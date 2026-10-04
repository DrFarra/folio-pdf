use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::Mutex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
#[cfg(not(target_os = "ios"))]
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "ios")]
mod ios_commands;
#[cfg(target_os = "ios")]
use ios_commands::{pick_document, pick_documents, choose_output, write_pdf_copy, choose_export, write_export, print_document, share_document, share_pdf_copy, print_pdf_copy, set_mobile_theme, copy_text, native_pdf_open, native_pdf_page_info, native_pdf_render, native_pdf_text, native_pdf_outline, native_pdf_close, native_pdf_present};
use folio_core::{atomic_write, digest, fingerprint, protect_original, read_pdf, validate_pdf, inspect_pdf_file, read_pdf_range, FileSnapshot};

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
    let token = uuid::Uuid::new_v4().to_string();
    let info = DocumentInfo { token: token.clone(), name: path.file_name().ok_or("Nombre de archivo inválido.")?.to_string_lossy().into(), size: file.snapshot.size, id: file.digest.clone(), revision: file.digest.clone() };
    desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.insert(token, Source { path, digest: file.digest, info: info.clone(), snapshot: file.snapshot });
    Ok(info)
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn pick_document(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<DocumentInfo>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Documento PDF", &["pdf"]).blocking_pick_file()).await.map_err(|_| "No se pudo abrir el diálogo.")?;
    result.map(|p| p.into_path().map_err(|_| "El archivo elegido no tiene una ruta local.".to_string()).and_then(|p| register(&desktop, p))).transpose()
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn pick_documents(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Vec<DocumentInfo>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Documentos PDF", &["pdf"]).blocking_pick_files()).await.map_err(|_| "No se pudo abrir el diálogo.")?;
    result.unwrap_or_default().into_iter().map(|p| p.into_path().map_err(|_| "El archivo elegido no tiene una ruta local.".to_string()).and_then(|p| register(&desktop, p))).collect()
}

#[tauri::command]
fn startup_document(desktop: State<'_, Desktop>) -> Result<Option<DocumentInfo>, String> {
    Ok(desktop.files.lock().map_err(|_| "No se pudo leer el documento inicial.")?.startup.first().cloned())
}

#[tauri::command]
fn startup_documents(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Vec<DocumentInfo>, String> {
    let opened = desktop.files.lock().map_err(|_| "No se pudieron leer los documentos iniciales.")?.frontend_started();
    for error in opened.errors { let _ = app.emit("folio-open-error", error); }
    Ok(opened.documents)
}

#[tauri::command]
fn read_document(token: String, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let source = files.sources.get(&token).ok_or("Vuelve a elegir el archivo para abrirlo.")?;
    #[cfg(target_os = "ios")]
    if source.info.size > 32 * 1024 * 1024 { return Err("Este documento se abre con el lector nativo de Folio; utiliza native_pdf_open.".into()); }
    let bytes = read_pdf(&source.path)?;
    if digest(&bytes) != source.digest { return Err("El archivo cambió en disco. Vuelve a abrirlo.".into()); }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn read_document_range(token: String, offset: u64, length: usize, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let source = files.sources.get(&token).ok_or("El documento no está disponible.")?;
    read_pdf_range(&source.path, &source.snapshot, offset, length).map(tauri::ipc::Response::new)
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn choose_output(source: Option<String>, name: String, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<String>, String> {
    let filename = Path::new(&name).file_name().ok_or("Nombre de copia inválido.")?.to_string_lossy().into_owned();
    let destination = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Documento PDF", &["pdf"]).set_file_name(filename).blocking_save_file()).await.map_err(|_| "No se pudo abrir el diálogo de guardado.")?;
    let Some(destination) = destination else { return Ok(None); };
    let mut path = destination.into_path().map_err(|_| "Elige una carpeta local.")?;
    if path.extension().and_then(|s| s.to_str()).map(|s| !s.eq_ignore_ascii_case("pdf")).unwrap_or(true) { path.set_extension("pdf"); }
    let mut files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let original = match source { Some(id) => Some(files.sources.get(&id).ok_or("El documento de origen ya no está disponible.")?.path.clone()), None => None };
    if let Some(original) = &original { protect_original(original, &path)?; }
    let expected = fingerprint(&path)?;
    let token = uuid::Uuid::new_v4().to_string();
    files.outputs.insert(token.clone(), Output { path, fingerprint: expected, source: original, format: "pdf".into() });
    Ok(Some(token))
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn write_pdf_copy(request: tauri::ipc::Request<'_>, desktop: State<'_, Desktop>) -> Result<DocumentInfo, String> {
    let token = request.headers().get("x-folio-output-token").and_then(|s| s.to_str().ok()).ok_or("No se eligió un destino de guardado.")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("El contenido del PDF no es binario.".into()); };
    validate_pdf(bytes)?;
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(token).ok_or("El destino venció. Elige nuevamente dónde guardar.")?;
    if output.format != "pdf" { return Err("Destino de PDF inválido.".into()); }
    if let Some(original) = &output.source { protect_original(original, &output.path)?; }
    atomic_write(&output.path, bytes, output.fingerprint.as_deref())?;
    register(&desktop, output.path)
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn choose_export(source: Option<String>, name: String, format: String, app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<Option<String>, String> {
    if !["txt", "html", "png", "jpg", "zip", "docx", "json"].contains(&format.as_str()) { return Err("Formato no admitido.".into()); }
    let filename = Path::new(&name).file_name().ok_or("Nombre inválido.")?.to_string_lossy().into_owned();
    let extension = format.clone();
    let destination = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Archivo exportado", &[extension.as_str()]).set_file_name(filename).blocking_save_file()).await.map_err(|_| "No se pudo abrir el diálogo.")?;
    let Some(destination) = destination else { return Ok(None); };
    let mut path = destination.into_path().map_err(|_| "Elige una carpeta local.")?;
    path.set_extension(&format);
    let mut files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let original = match source { Some(id) => Some(files.sources.get(&id).ok_or("Origen no disponible.")?.path.clone()), None => None };
    if let Some(original) = &original { protect_original(original, &path)?; }
    let expected = fingerprint(&path)?; let token = uuid::Uuid::new_v4().to_string();
    files.outputs.insert(token.clone(), Output { path, fingerprint: expected, source: original, format });
    Ok(Some(token))
}
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn write_export(request: tauri::ipc::Request<'_>, desktop: State<'_, Desktop>) -> Result<(), String> {
    let token = request.headers().get("x-folio-output-token").and_then(|s| s.to_str().ok()).ok_or("Destino ausente.")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Contenido inválido.".into()); };
    if bytes.is_empty() || bytes.len() > 128 * 1024 * 1024 { return Err("El archivo está vacío o excede 128 MiB.".into()); }
    let output = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.outputs.remove(token).ok_or("Destino vencido.")?;
    if output.format == "pdf" { return Err("Usa el guardado de PDF.".into()); }
    if let Some(original) = &output.source { protect_original(original, &output.path)?; }
    atomic_write(&output.path, bytes, output.fingerprint.as_deref())
}
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn print_document(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|_| "No se pudo abrir el diálogo de impresión.".into())
}

fn session_path(desktop: &Desktop, id: &str) -> Result<PathBuf, String> {
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("Identificador de documento inválido.".into()); }
    Ok(desktop.data.join("sessions").join(format!("{id}.json")))
}

fn draft_path(desktop: &Desktop, id: &str) -> Result<PathBuf, String> {
    session_path(desktop, id)?;
    Ok(desktop.data.join("drafts").join(format!("{id}.pdf")))
}
#[tauri::command]
fn load_draft(id: String, desktop: State<'_, Desktop>) -> Result<tauri::ipc::Response, String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    Ok(tauri::ipc::Response::new(if path.exists() { read_pdf(&path)? } else { Vec::new() }))
}

#[tauri::command]
fn native_draft_document(id: String, name: String, desktop: State<'_, Desktop>) -> Result<Option<DocumentInfo>, String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    if !path.exists() { return Ok(None); }
    let mut info = register(&desktop, path)?;
    info.name = Path::new(&name).file_name().ok_or("Nombre de borrador inválido.")?.to_string_lossy().into();
    if let Some(source) = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?.sources.get_mut(&info.token) { source.info.name = info.name.clone(); }
    Ok(Some(info))
}
#[tauri::command]
fn store_draft(request: tauri::ipc::Request<'_>, desktop: State<'_, Desktop>) -> Result<(), String> {
    let id = request.headers().get("x-folio-draft-id").and_then(|s| s.to_str().ok()).ok_or("Identificador de borrador ausente.")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Borrador inválido.".into()); };
    validate_pdf(bytes)?;
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, id)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|_| "No se pudo crear la carpeta de borradores.")?;
    atomic_write(&path, bytes, fingerprint(&path)?.as_deref())
}
#[tauri::command]
fn discard_draft(id: String, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    if path.exists() { fs::remove_file(path).map_err(|_| "No se pudo borrar el borrador.")?; }
    let mut entries = read_recents(&desktop); entries.retain(|r| !(r.draft && r.id == id)); save_recents(&desktop, &entries)?;
    Ok(())
}

#[tauri::command]
fn load_session(id: String, desktop: State<'_, Desktop>) -> Result<Option<Value>, String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = session_path(&desktop, &id)?;
    if !path.exists() { return Ok(None); }
    let bytes = fs::read(path).map_err(|_| "No se pudo recuperar la sesión.")?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "La sesión guardada está dañada.".to_string())
}

#[tauri::command]
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
    let expected = fingerprint(&path)?;
    atomic_write(&path, &bytes, expected.as_deref())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recent { id: String, name: String, size: u64, pages: usize, opened_at: u64, path: PathBuf, #[serde(default)] draft: bool }
fn read_recents(desktop: &Desktop) -> Vec<Recent> {
    fs::read(desktop.data.join("recent.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn save_recents(desktop: &Desktop, entries: &[Recent]) -> Result<(), String> {
    let path = desktop.data.join("recent.json");
    let expected = fingerprint(&path)?;
    atomic_write(&path, &serde_json::to_vec(entries).map_err(|_| "No se pudo guardar la lista de recientes.")?, expected.as_deref())
}
#[tauri::command]
async fn recent_documents(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    // Identity checks of large files must not block UIKit/the webview thread.
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let recents = {
            let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
            read_recents(&desktop)
        };
        Ok(recents.into_iter().filter_map(|r| {
            register(&desktop, r.path).ok().map(|d| serde_json::json!({"id":r.id,"name":r.name,"size":r.size,"pages":r.pages,"openedAt":r.opened_at,"nativeSource":d.token,"draft":r.draft}))
        }).collect())
    }).await.map_err(|_| "No se pudo leer la lista de recientes.".to_string())?
}
#[tauri::command]
fn remember_document(id: String, token: String, pages: usize, opened_at: u64, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let files = desktop.files.lock().map_err(|_| "El acceso a archivos está ocupado.")?;
    let source = files.sources.get(&token).ok_or("El documento ya no está disponible.")?;
    let record = Recent { id: id.clone(), name: source.info.name.clone(), size: source.info.size, pages, opened_at, path: source.path.clone(), draft: false };
    let mut entries = read_recents(&desktop); entries.retain(|r| r.id != id); entries.insert(0, record); entries.truncate(5);
    save_recents(&desktop, &entries)
}
#[tauri::command]
fn remember_draft(id: String, name: String, pages: usize, opened_at: u64, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let path = draft_path(&desktop, &id)?;
    let bytes = read_pdf(&path)?;
    let name = Path::new(&name).file_name().ok_or("Nombre inválido.")?.to_string_lossy().into_owned();
    let record = Recent { id: id.clone(), name, size: bytes.len() as u64, pages, opened_at, path, draft: true };
    let mut entries = read_recents(&desktop); entries.retain(|r| r.id != id); entries.insert(0, record); entries.truncate(5);
    save_recents(&desktop, &entries)
}
#[tauri::command]
fn forget_document(id: String, desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    let mut entries = read_recents(&desktop); entries.retain(|r| r.id != id); save_recents(&desktop, &entries)?;
    let path = session_path(&desktop, &id)?;
    if path.exists() { fs::remove_file(path).map_err(|_| "No se pudo borrar la sesión.")?; }
    let draft = draft_path(&desktop, &id)?;
    if draft.exists() { fs::remove_file(draft).map_err(|_| "No se pudo borrar el borrador.")?; }
    Ok(())
}
#[tauri::command]
fn clear_saved_state(desktop: State<'_, Desktop>) -> Result<(), String> {
    let _guard = desktop.store.lock().map_err(|_| "El almacenamiento está ocupado.")?;
    save_recents(&desktop, &[])?;
    let sessions = desktop.data.join("sessions");
    if sessions.exists() { fs::remove_dir_all(sessions).map_err(|_| "No se pudieron borrar todas las sesiones.")?; }
    let drafts = desktop.data.join("drafts");
    if drafts.exists() { fs::remove_dir_all(drafts).map_err(|_| "No se pudieron borrar todos los borradores.")?; }
    Ok(())
}

fn open_from_system(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
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
        for path in paths.into_iter().filter(|p| p.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("pdf"))) {
            match register(&desktop, path) {
                Ok(info) => opened.documents.push(info),
                Err(error) => opened.errors.push(error),
            }
        }
        let Ok(mut files) = desktop.files.lock() else { return; };
        let deliver = files.queue_system_open(opened);
        drop(files);
        if let Some(opened) = deliver {
            for error in opened.errors { let _ = app.emit("folio-open-error", error); }
            if !opened.documents.is_empty() { let _ = app.emit("folio-open-documents", opened.documents); }
        }
    });
}

#[cfg(not(target_os = "ios"))]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(EarlyOpenPaths::default());
    #[cfg(not(target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_from_system(app, resolve_arguments(argv, Path::new(&cwd)));
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_folio_ios::init());
    #[cfg(feature = "native-qa")]
    let builder = builder.plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("native-qa")
        .js_init_script(include_str!("native_qa.js"))
        .build());
    #[cfg(not(target_os = "ios"))]
    let builder = builder.invoke_handler(tauri::generate_handler![pick_document, pick_documents, startup_document, startup_documents, read_document, read_document_range, choose_output, write_pdf_copy, choose_export, write_export, print_document, load_session, store_session, load_draft, native_draft_document, store_draft, discard_draft, recent_documents, remember_document, remember_draft, forget_document, clear_saved_state]);
    #[cfg(all(target_os = "ios", not(feature = "native-qa")))]
    let builder = builder.invoke_handler(tauri::generate_handler![pick_document, pick_documents, startup_document, startup_documents, read_document, read_document_range, choose_output, write_pdf_copy, choose_export, write_export, print_document, share_document, share_pdf_copy, print_pdf_copy, set_mobile_theme, copy_text, native_pdf_open, native_pdf_page_info, native_pdf_render, native_pdf_text, native_pdf_outline, native_pdf_close, native_pdf_present, load_session, store_session, load_draft, native_draft_document, store_draft, discard_draft, recent_documents, remember_document, remember_draft, forget_document, clear_saved_state]);
    #[cfg(all(target_os = "ios", feature = "native-qa"))]
    let builder = builder.invoke_handler(tauri::generate_handler![pick_document, pick_documents, startup_document, startup_documents, read_document, read_document_range, choose_output, write_pdf_copy, choose_export, write_export, print_document, share_document, share_pdf_copy, print_pdf_copy, set_mobile_theme, copy_text, native_pdf_open, native_pdf_page_info, native_pdf_render, native_pdf_text, native_pdf_outline, native_pdf_close, native_pdf_present, ios_commands::ios_native_status, ios_commands::ios_native_file_probe, load_session, store_session, load_draft, native_draft_document, store_draft, discard_draft, recent_documents, remember_document, remember_draft, forget_document, clear_saved_state]);
    builder
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            #[cfg(feature = "native-qa")]
            let data = data.join("native-qa");
            fs::create_dir_all(&data)?;
            let desktop = Desktop { files: Mutex::new(Files::default()), store: Mutex::new(()), data };
            #[cfg(target_os = "ios")]
            ios_commands::cleanup_unreferenced_exports(&desktop);
            for path in std::env::args_os().skip(1).map(PathBuf::from).filter(|p| p.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("pdf"))) {
                match register(&desktop, path) {
                    Ok(info) => desktop.files.lock().unwrap().startup.push(info),
                    Err(error) => desktop.files.lock().unwrap().pending.errors.push(error),
                }
            }
            let paths = {
                let incoming = app.state::<EarlyOpenPaths>();
                let mut early = incoming.0.lock().map_err(|_| "No se pudieron leer las aperturas iniciales.")?;
                app.manage(desktop);
                std::mem::take(&mut *early)
            };
            if !paths.is_empty() { open_from_system(app.handle(), paths); }
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
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event { open_from_system(window.app_handle(), paths.clone()); }
        })
        .build(tauri::generate_context!())
        .expect("No se pudo iniciar Folio")
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
