//! Android's file-backed reader for large PDFs: MuPDF (FolioMuPDF.c, shared with
//! iOS's annotation writer) reads the file on demand, so only page-sized JSON and
//! PNG cross into the WebView. Same commands and payloads as iOS's PDFKit reader
//! (NativePDFService.swift), which nativePdf.ts adapts for PDF.js's viewer.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, ffi::{c_char, CStr, CString}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}, time::Instant};

#[allow(non_camel_case_types)]
#[repr(C)]
struct folio_reader { _private: [u8; 0] }
#[repr(C)]
struct SourceAnnotation {
    index: i32, kind: i32, flags: i32, rect: [f32; 4], color: [f32; 3], opacity: f32, modified_seconds: i64,
    name: *mut c_char, contents: *mut c_char, author: *mut c_char,
    quad_count: usize, quads: *mut f32, stroke_width: f32, path_count: usize, path_sizes: *mut i32, ink_points: *mut f32,
}
#[repr(C)]
struct Overlay {
    page: i32, kind: i32, rect: [f32; 4], color: [f32; 3], opacity: f32, modified_seconds: i64,
    name: *const c_char, contents: *const c_char, author: *const c_char,
    quad_count: usize, quads: *const f32, stroke_width: f32, path_count: usize, path_sizes: *const i32, ink_points: *const f32,
}
#[repr(C)]
struct Removal { page: i32, index: i32 }

extern "C" {
    fn folio_reader_open(path: *const c_char, password: *const c_char, reader: *mut *mut folio_reader, json: *mut *mut c_char, error: *mut c_char, capacity: usize) -> i32;
    fn folio_reader_close(reader: *mut folio_reader);
    fn folio_reader_page_info(reader: *mut folio_reader, page: i32, json: *mut *mut c_char, error: *mut c_char, capacity: usize) -> i32;
    fn folio_reader_text(reader: *mut folio_reader, page: i32, json: *mut *mut c_char, error: *mut c_char, capacity: usize) -> i32;
    fn folio_reader_outline(reader: *mut folio_reader, json: *mut *mut c_char, error: *mut c_char, capacity: usize) -> i32;
    fn folio_reader_render(reader: *mut folio_reader, page: i32, width: i32, height: i32, rotation: i32, full_width: i32, full_height: i32, x: i32, y: i32, skip_editable: i32, png: *mut *mut u8, length: *mut usize, error: *mut c_char, capacity: usize) -> i32;
    fn folio_reader_annotations(reader: *mut folio_reader, page: i32, items: *mut *mut SourceAnnotation, count: *mut usize, error: *mut c_char, capacity: usize) -> i32;
    fn folio_reader_free(pointer: *mut std::ffi::c_void);
    fn folio_pdf_free_annotations(items: *mut SourceAnnotation, count: usize);
    fn folio_pdf_export(source: *const c_char, output: *const c_char, password: *const c_char, overlays: *const Overlay, overlay_count: usize, removals: *const Removal, removal_count: usize, error: *mut c_char, capacity: usize) -> i32;
    fn folio_pdf_engine_version() -> *const c_char;
}

fn c_string(value: &str) -> Result<CString, String> { CString::new(value).map_err(|_| "El texto contiene caracteres no válidos.".to_string()) }
fn c_path(path: &Path) -> Result<CString, String> { c_string(path.to_str().ok_or("La ruta del PDF no es válida.")?) }
/// MuPDF reports in English for the log; the user gets the outcome.
fn failed(error: &[c_char], message: &str) -> String {
    let detail = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
    eprintln!("Folio native reader: {detail}");
    if detail.contains("password") { "Este PDF necesita una contraseña.".into() } else { message.into() }
}
fn take_json(pointer: *mut c_char) -> Result<Value, String> {
    if pointer.is_null() { return Err("No se pudo leer el PDF.".into()); }
    let text = unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
    unsafe { folio_reader_free(pointer.cast()) };
    serde_json::from_str(&text).map_err(|_| "No se pudo leer el PDF.".into())
}
fn hex(rgb: [f32; 3]) -> String {
    let channel = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", channel(rgb[0]), channel(rgb[1]), channel(rgb[2]))
}
fn optional_text(pointer: *mut c_char) -> String {
    if pointer.is_null() { String::new() } else { unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned() }
}

pub struct Reader { handle: *mut folio_reader, path: PathBuf, password: String, pub metadata: Value, used: Instant }
// MuPDF's context may move between threads; the registry's mutex keeps one user at a time.
unsafe impl Send for Reader {}
impl Drop for Reader { fn drop(&mut self) { unsafe { folio_reader_close(self.handle) } } }

impl Reader {
    pub fn open(path: &Path, password: &str) -> Result<Reader, String> {
        let (file, secret) = (c_path(path)?, c_string(password)?);
        let (mut handle, mut json, mut error) = (std::ptr::null_mut(), std::ptr::null_mut(), [0 as c_char; 2048]);
        if unsafe { folio_reader_open(file.as_ptr(), secret.as_ptr(), &mut handle, &mut json, error.as_mut_ptr(), error.len()) } != 0 {
            return Err(failed(&error, "No se pudo abrir este PDF. Puede estar dañado."));
        }
        let mut reader = Reader { handle, path: path.into(), password: password.into(), metadata: Value::Null, used: Instant::now() };
        reader.metadata = take_json(json)?;
        Ok(reader)
    }
    pub fn locked(&self) -> bool { self.metadata["locked"] == true }
    pub fn pages(&self) -> u32 { self.metadata["numPages"].as_u64().unwrap_or(0) as u32 }
    pub fn can_annotate(&self) -> bool { self.metadata["permissions"]["canAnnotate"] == true }
    fn page_json(&mut self, page: u32, call: unsafe extern "C" fn(*mut folio_reader, i32, *mut *mut c_char, *mut c_char, usize) -> i32) -> Result<Value, String> {
        if page == 0 || page > self.pages() { return Err("La página solicitada no existe.".into()); }
        let (mut json, mut error) = (std::ptr::null_mut(), [0 as c_char; 2048]);
        if unsafe { call(self.handle, page as i32, &mut json, error.as_mut_ptr(), error.len()) } != 0 { return Err(failed(&error, "No se pudo leer esta página.")); }
        take_json(json)
    }
    pub fn page_info(&mut self, page: u32) -> Result<Value, String> {
        let mut info = self.page_json(page, folio_reader_page_info)?;
        info["annotations"] = Value::Array(if self.can_annotate() { self.annotations(page)? } else { Vec::new() });
        Ok(info)
    }
    pub fn text(&mut self, page: u32) -> Result<Value, String> {
        if self.metadata["permissions"]["canCopy"] != true { return Ok(json!({"lines": []})); }
        self.page_json(page, folio_reader_text)
    }
    pub fn outline(&mut self) -> Result<Value, String> {
        let (mut json, mut error) = (std::ptr::null_mut(), [0 as c_char; 2048]);
        if unsafe { folio_reader_outline(self.handle, &mut json, error.as_mut_ptr(), error.len()) } != 0 { return Err(failed(&error, "No se pudo leer el índice del PDF.")); }
        take_json(json)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, page: u32, width: u32, height: u32, rotation: u16, full_width: u32, full_height: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
        if page == 0 || page > self.pages() { return Err("La página solicitada no existe.".into()); }
        let (mut png, mut length, mut error) = (std::ptr::null_mut(), 0usize, [0 as c_char; 2048]);
        let to_i32 = |v: u32| i32::try_from(v).map_err(|_| "La zona de la página no es válida.".to_string());
        // Annotations Folio edits are drawn by its own overlay, as on iOS.
        let status = unsafe { folio_reader_render(self.handle, page as i32, to_i32(width)?, to_i32(height)?, i32::from(rotation), to_i32(full_width)?, to_i32(full_height)?, to_i32(x)?, to_i32(y)?, i32::from(self.can_annotate()), &mut png, &mut length, error.as_mut_ptr(), error.len()) };
        if status != 0 || png.is_null() { return Err(failed(&error, "No se pudo mostrar esta página.")); }
        let bytes = unsafe { std::slice::from_raw_parts(png, length) }.to_vec();
        unsafe { folio_reader_free(png.cast()) };
        Ok(bytes)
    }
    /// The page's editable source annotations, shaped as iOS's PDFKit reader returns them.
    pub fn annotations(&mut self, page: u32) -> Result<Vec<Value>, String> {
        let (mut items, mut count, mut error) = (std::ptr::null_mut(), 0usize, [0 as c_char; 2048]);
        if unsafe { folio_reader_annotations(self.handle, page as i32, &mut items, &mut count, error.as_mut_ptr(), error.len()) } != 0 {
            return Err(failed(&error, "No se pudieron leer las anotaciones de esta página."));
        }
        let slice = if items.is_null() { &[][..] } else { unsafe { std::slice::from_raw_parts(items, count) } };
        let mut result = Vec::new();
        for item in slice {
            // Hidden, invisible and no-view annotations are left in the PDF untouched.
            if item.flags & (1 | 2 | 32) != 0 { continue; }
            let kind = match item.kind { 1 => "highlight", 3 => "ink", _ => "note" };
            let raw: Vec<f64> = item.rect.iter().map(|v| f64::from(*v)).collect();
            let rect = if kind == "note" { vec![raw[0], raw[3], raw[0], raw[3]] } else { raw.clone() };
            let reference = format!("pdfkit:{page}:{}", item.index);
            let mut dto = json!({"id": reference, "nativeSourceRef": reference, "page": page, "kind": kind, "rect": rect, "rawRect": raw,
                "color": hex(item.color), "text": optional_text(item.contents), "author": optional_text(item.author),
                "created": item.modified_seconds as f64 * 1000.0, "opacity": f64::from(item.opacity)});
            let name = optional_text(item.name);
            if !name.is_empty() { dto["originalName"] = Value::String(name); }
            if !item.quads.is_null() && item.quad_count > 0 {
                let quads = unsafe { std::slice::from_raw_parts(item.quads, item.quad_count * 8) };
                dto["quads"] = json!(quads.chunks(8).map(|q| q.iter().map(|v| f64::from(*v)).collect::<Vec<_>>()).collect::<Vec<_>>());
            }
            if item.kind == 3 && !item.path_sizes.is_null() && !item.ink_points.is_null() {
                let sizes = unsafe { std::slice::from_raw_parts(item.path_sizes, item.path_count) };
                let total = sizes.iter().map(|s| *s as usize).sum();
                let points = unsafe { std::slice::from_raw_parts(item.ink_points, total) };
                let mut offset = 0;
                let paths: Vec<Vec<f64>> = sizes.iter().map(|size| { let path = points[offset..offset + *size as usize].iter().map(|v| f64::from(*v)).collect(); offset += *size as usize; path }).collect();
                dto["inkPaths"] = json!(paths);
                dto["strokeWidth"] = json!(f64::from(item.stroke_width));
            }
            result.push(dto);
        }
        unsafe { folio_pdf_free_annotations(items, count) };
        Ok(result)
    }
    fn source(&mut self, reference: &str) -> Result<Option<Value>, String> {
        let Some(page) = reference_page(reference) else { return Ok(None) };
        if page == 0 || page > self.pages() { return Ok(None); }
        Ok(self.annotations(page)?.into_iter().find(|a| a["nativeSourceRef"] == reference))
    }

    /// Writes a copy with Folio's annotations appended to the original's bytes (incremental save).
    pub fn export(&mut self, output: &Path, annotations: &Value, removed: &[String]) -> Result<Value, String> {
        if output == self.path { return Err("No se pudo guardar la copia. El original no cambió.".into()); }
        let overlays: Vec<OverlayRequest> = serde_json::from_value(annotations.clone()).map_err(|_| "Las anotaciones de la copia son inválidas.")?;
        if overlays.is_empty() && removed.is_empty() {
            std::fs::copy(&self.path, output).map_err(|_| "No se pudo guardar la copia. El original no cambió.")?;
            return Ok(json!({"path": output}));
        }
        if !self.can_annotate() { return Err("Este documento no permite modificar anotaciones.".into()); }
        // Unchanged source annotations stay as they are in the original's objects.
        let mut unchanged = std::collections::HashSet::new();
        for overlay in &overlays {
            let Some(reference) = &overlay.native_source_ref else { continue };
            if let Some(source) = self.source(reference)? { if overlay.matches(&source) { unchanged.insert(reference.clone()); } }
        }
        let mut replaced: Vec<String> = removed.to_vec();
        replaced.extend(overlays.iter().filter_map(|o| o.native_source_ref.clone()).filter(|r| !unchanged.contains(r)));
        replaced.sort(); replaced.dedup();
        let mut removals = Vec::new();
        for reference in &replaced {
            let index = reference.rsplit(':').next().and_then(|i| i.parse::<i32>().ok());
            match (reference_page(reference), index, self.source(reference)?) {
                (Some(page), Some(index), Some(_)) if index >= 0 => removals.push(Removal { page: page as i32, index }),
                _ => return Err("Una anotación de origen ya no coincide con el PDF.".into()),
            }
        }
        let invalid = |message: &str| -> String { message.into() };
        let mut strings = Vec::new();
        let mut floats: Vec<Vec<f32>> = Vec::new();
        let mut sizes: Vec<Vec<i32>> = Vec::new();
        let mut items = Vec::new();
        for overlay in &overlays {
            if let Some(reference) = &overlay.native_source_ref { if unchanged.contains(reference) && !removed.contains(reference) { continue; } }
            if !["highlight", "note", "ink"].contains(&overlay.kind.as_str()) || overlay.rect.len() != 4 || !overlay.rect.iter().all(|v| v.is_finite())
                || overlay.page < 1 || overlay.page > i64::from(self.pages()) || !overlay.created.is_finite() || (overlay.created / 1000.0).abs() >= i64::MAX as f64 {
                return Err(invalid("La anotación no tiene una página o posición válida."));
            }
            let mut rect = overlay.rect.clone();
            if overlay.kind == "note" {
                let (mut width, mut height) = (20.0, 20.0);
                if let Some(reference) = &overlay.native_source_ref {
                    if let Some(raw) = self.source(reference)?.and_then(|s| s["rawRect"].as_array().cloned()).filter(|r| r.len() == 4) {
                        let n: Vec<f64> = raw.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
                        width = n[2] - n[0]; height = n[3] - n[1];
                    }
                }
                rect = vec![overlay.rect[0], overlay.rect[1] - height, overlay.rect[0] + width, overlay.rect[1]];
            }
            if rect[2] <= rect[0] || rect[3] <= rect[1] { return Err(invalid("La anotación tiene un tamaño inválido.")); }
            let alpha = overlay.opacity.unwrap_or(if overlay.kind == "highlight" { 0.35 } else { 1.0 }).clamp(0.0, 1.0);
            let rgb = u32::from_str_radix(overlay.color.trim_start_matches('#'), 16).unwrap_or(0xf5d76e);
            let mut item = Overlay {
                page: overlay.page as i32, kind: match overlay.kind.as_str() { "highlight" => 1, "ink" => 3, _ => 2 },
                rect: [rect[0] as f32, rect[1] as f32, rect[2] as f32, rect[3] as f32],
                color: [((rgb >> 16) & 255) as f32 / 255.0, ((rgb >> 8) & 255) as f32 / 255.0, (rgb & 255) as f32 / 255.0],
                opacity: alpha as f32, modified_seconds: (overlay.created / 1000.0) as i64,
                name: std::ptr::null(), contents: std::ptr::null(), author: std::ptr::null(),
                quad_count: 0, quads: std::ptr::null(), stroke_width: 0.0, path_count: 0, path_sizes: std::ptr::null(), ink_points: std::ptr::null(),
            };
            for (field, text) in [(&mut item.name, overlay.original_name.clone().unwrap_or_else(|| overlay.id.clone())), (&mut item.contents, overlay.text.clone()), (&mut item.author, overlay.author.clone().unwrap_or_else(|| "Folio".into()))] {
                let value = c_string(&text)?;
                *field = value.as_ptr();
                strings.push(value);
            }
            if overlay.kind == "highlight" {
                let quads = overlay.quads.clone().unwrap_or_else(|| vec![vec![rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]]]);
                if !quads.iter().all(|q| q.len() == 8 && q.iter().all(|v| v.is_finite())) { return Err(invalid("El resaltado contiene coordenadas inválidas.")); }
                let flat: Vec<f32> = quads.iter().flatten().map(|v| *v as f32).collect();
                item.quad_count = quads.len(); item.quads = flat.as_ptr();
                floats.push(flat);
            }
            if overlay.kind == "ink" {
                let width = overlay.stroke_width.unwrap_or(2.0);
                let paths = overlay.ink_paths.clone().unwrap_or_default();
                if !(width.is_finite() && width > 0.0 && width <= 50.0) || paths.is_empty() || paths.len() > 20000
                    || !paths.iter().all(|p| p.len() >= 4 && p.len() <= 20000 && p.len() % 2 == 0 && p.iter().all(|v| v.is_finite() && (*v as f32).is_finite()))
                    || paths.iter().map(Vec::len).sum::<usize>() > 1_048_576 {
                    return Err(invalid("El dibujo contiene coordenadas o grosor inválidos."));
                }
                let flat: Vec<f32> = paths.iter().flatten().map(|v| *v as f32).collect();
                let lengths: Vec<i32> = paths.iter().map(|p| p.len() as i32).collect();
                item.ink_points = flat.as_ptr(); item.path_sizes = lengths.as_ptr(); item.path_count = paths.len(); item.stroke_width = width as f32;
                floats.push(flat); sizes.push(lengths);
            }
            items.push(item);
        }
        let (source, target, secret) = (c_path(&self.path)?, c_path(output)?, c_string(&self.password)?);
        let mut error = [0 as c_char; 2048];
        // The pointers in `items` refer to `strings`, `floats` and `sizes`, all alive here.
        let status = unsafe { folio_pdf_export(source.as_ptr(), target.as_ptr(), secret.as_ptr(), items.as_ptr(), items.len(), removals.as_ptr(), removals.len(), error.as_mut_ptr(), error.len()) };
        drop((strings, floats, sizes));
        if status != 0 {
            let detail = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
            eprintln!("Folio annotation export failed: {detail}");
            return Err(if detail.starts_with("This PDF requires repair") { "Este PDF está dañado. Folio no puede añadirle anotaciones sin modificar el original.".into() }
                else { "No se pudo guardar la copia. El original no cambió.".into() });
        }
        let version = unsafe { CStr::from_ptr(folio_pdf_engine_version()) }.to_string_lossy();
        Ok(json!({"path": output, "annotationWriter": format!("MuPDF {version}"), "incremental": true}))
    }
}

fn reference_page(reference: &str) -> Option<u32> {
    let parts: Vec<&str> = reference.split(':').collect();
    (parts.len() == 3 && parts[0] == "pdfkit").then(|| parts[1].parse().ok()).flatten().filter(|p| *p > 0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayRequest {
    id: String, page: i64, kind: String, rect: Vec<f64>, color: String, text: String, created: f64,
    author: Option<String>, opacity: Option<f64>, native_source_ref: Option<String>, original_name: Option<String>,
    quads: Option<Vec<Vec<f64>>>, ink_paths: Option<Vec<Vec<f64>>>, stroke_width: Option<f64>,
}
impl OverlayRequest {
    /// Whether this overlay is the source annotation unchanged (the same test as iOS).
    fn matches(&self, source: &Value) -> bool {
        let close = |a: &[f64], b: &[Value]| a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y.as_f64().unwrap_or(f64::NAN)).abs() <= 0.01);
        let lists = |a: &[Vec<f64>], b: Option<&Vec<Value>>| {
            let b = b.cloned().unwrap_or_default();
            a.len() == b.len() && a.iter().zip(&b).all(|(x, y)| y.as_array().is_some_and(|y| close(x, y)))
        };
        let alpha = source["opacity"].as_f64().unwrap_or(1.0);
        if source["kind"] != self.kind.as_str() || source["text"] != self.text.as_str() || source["author"] != self.author.clone().unwrap_or_default().as_str()
            || source["color"].as_str().map(str::to_lowercase) != Some(self.color.to_lowercase())
            || !source["rect"].as_array().is_some_and(|r| close(&self.rect, r)) || (self.opacity.unwrap_or(alpha) - alpha).abs() >= 0.001
            || !lists(self.quads.as_deref().unwrap_or(&[]), source["quads"].as_array()) { return false; }
        if self.kind == "ink" {
            let width = source["strokeWidth"].as_f64().unwrap_or(f64::NAN);
            if (self.stroke_width.unwrap_or(2.0) - width).abs() >= 0.01 || !lists(self.ink_paths.as_deref().unwrap_or(&[]), source["inkPaths"].as_array()) { return false; }
        }
        true
    }
}

/// Open readers by document token. Tabs can stay open without holding an unlimited
/// number of parsers: beyond four, the least recently used is closed and reopened when needed.
struct Registry { readers: HashMap<String, Arc<Mutex<Reader>>>, opened: HashMap<String, (PathBuf, String)> }
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry { readers: HashMap::new(), opened: HashMap::new() }))
}
const BUSY: &str = "El lector de PDF está ocupado.";

/// Opens (or reopens) `token`'s PDF and returns iOS's `native_pdf_open` payload.
pub fn open(token: &str, path: &Path, password: &str, id: &str, revision: &str, size: u64) -> Result<Value, String> {
    let mut reader = Reader::open(path, password)?;
    let mut result = reader.metadata.clone();
    for (key, value) in [("id", json!(id)), ("revision", json!(revision)), ("size", json!(size))] { result[key] = value; }
    if reader.locked() { return Ok(result); }
    if reader.pages() > 0 { let mut first = reader.page_info(1)?; first["page"] = json!(1); result["firstPage"] = first; }
    let mut registry = registry().lock().map_err(|_| BUSY)?;
    registry.opened.insert(token.into(), (path.into(), password.into()));
    registry.readers.insert(token.into(), Arc::new(Mutex::new(reader)));
    if registry.readers.len() > 4 {
        let oldest = registry.readers.iter().filter(|(key, _)| key.as_str() != token)
            .filter_map(|(key, reader)| reader.try_lock().ok().map(|r| (key.clone(), r.used))).min_by_key(|(_, used)| *used).map(|(key, _)| key);
        if let Some(key) = oldest { registry.readers.remove(&key); }
    }
    Ok(result)
}
pub fn with<T>(token: &str, work: impl FnOnce(&mut Reader) -> Result<T, String>) -> Result<T, String> {
    let reader = {
        let mut registry = registry().lock().map_err(|_| BUSY)?;
        match registry.readers.get(token) {
            Some(reader) => reader.clone(),
            None => {
                let (path, password) = registry.opened.get(token).cloned().ok_or("El documento se cerró. Vuelve a abrirlo.")?;
                let reader = Arc::new(Mutex::new(Reader::open(&path, &password)?));
                registry.readers.insert(token.into(), reader.clone());
                reader
            }
        }
    };
    let mut reader = reader.lock().map_err(|_| BUSY)?;
    if reader.locked() { return Err("Este PDF necesita una contraseña.".into()); }
    reader.used = Instant::now();
    work(&mut reader)
}
pub fn close(token: &str) {
    if let Ok(mut registry) = registry().lock() { registry.readers.remove(token); registry.opened.remove(token); }
}
