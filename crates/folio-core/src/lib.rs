use sha2::{Digest, Sha256};
use std::{fs, io::{self, Read, Write, Seek, SeekFrom}, path::{Path, PathBuf}, time::SystemTime};

pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024 * 1024;
pub const MAX_RANGE_BYTES: usize = 4 * 1024 * 1024;
/// atomic_write refuses a destination that changed since `expected` with this message.
pub const DESTINATION_CHANGED: &str = "El archivo de destino cambió. Vuelve a elegir dónde guardar.";
// System errors are English on macOS and carry codes on Windows: they never reach the user.
const UNREADABLE: &str = "No se puede abrir este archivo. Comprueba que tienes permiso para leerlo.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSnapshot { pub size: u64, pub modified: Option<SystemTime> }
#[derive(Clone, Debug)]
pub struct PdfFileInfo { pub snapshot: FileSnapshot, pub digest: String }

pub fn file_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let meta = fs::metadata(path).map_err(|e| if e.kind() == io::ErrorKind::NotFound { "No se encontró el archivo. Puede que se haya movido o eliminado." } else { UNREADABLE })?;
    if !meta.is_file() { return Err("Elige un archivo PDF.".into()); }
    Ok(FileSnapshot { size: meta.len(), modified: meta.modified().ok() })
}

/// Source PDFs are parsed by the selected PDF engine. Check only a bounded
/// header here; valid provider files may contain trailing material after EOF.
pub fn inspect_pdf_file(path: &Path) -> Result<PdfFileInfo, String> {
    let snapshot = file_snapshot(path)?;
    let mut file = fs::File::open(path).map_err(|_| UNREADABLE)?;
    let mut header = [0u8; 1024];
    let count = file.read(&mut header).map_err(|_| UNREADABLE)?;
    if !header[..count].windows(5).any(|s| s == b"%PDF-") { return Err("El archivo no es un PDF válido.".into()); }
    let mut hash = Sha256::new(); hash.update(&header[..count]);
    let mut chunk = [0u8; 64 * 1024];
    loop { let count = file.read(&mut chunk).map_err(|_| UNREADABLE)?; if count == 0 { break; } hash.update(&chunk[..count]); }
    if file_snapshot(path)? != snapshot { return Err("El archivo cambió mientras se abría. Vuelve a elegirlo.".into()); }
    Ok(PdfFileInfo { snapshot, digest: format!("{:x}", hash.finalize()) })
}

pub fn read_pdf_range(path: &Path, snapshot: &FileSnapshot, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    if length > MAX_RANGE_BYTES { return Err("La lectura por bloques excede 4 MiB.".into()); }
    if offset > snapshot.size { return Err("La posición de lectura está fuera del PDF.".into()); }
    if file_snapshot(path)? != *snapshot { return Err("El archivo cambió en disco. Vuelve a abrirlo.".into()); }
    let count = (snapshot.size - offset).min(length as u64) as usize;
    let mut file = fs::File::open(path).map_err(|_| UNREADABLE)?;
    file.seek(SeekFrom::Start(offset)).map_err(|_| UNREADABLE)?;
    let mut bytes = vec![0; count]; file.read_exact(&mut bytes).map_err(|_| UNREADABLE)?;
    if file_snapshot(path)? != *snapshot { return Err("El archivo cambió durante la lectura.".into()); }
    Ok(bytes)
}

pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn read_pdf(path: &Path) -> Result<Vec<u8>, String> {
    let meta = file_snapshot(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| "No se pudo leer el archivo.")?
        .read_to_end(&mut bytes).map_err(|_| "No se pudo leer el archivo.")?;
    if !bytes.iter().take(1024).copied().collect::<Vec<_>>().windows(5).any(|s| s == b"%PDF-") { return Err("El archivo no es un PDF válido.".into()); }
    if file_snapshot(path)? != meta { return Err("El archivo cambió durante la lectura.".into()); }
    Ok(bytes)
}

pub fn validate_pdf(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_OUTPUT_BYTES { return Err("El PDF supera 1 GB y no se puede guardar.".into()); }
    if !bytes.iter().take(1024).copied().collect::<Vec<_>>().windows(5).any(|s| s == b"%PDF-") {
        return Err("El PDF generado no es válido. Tus cambios siguen en Folio.".into());
    }
    if !bytes.iter().rev().take(2048).copied().collect::<Vec<_>>().windows(5).any(|s| s == b"FOE%%") {
        return Err("El PDF está incompleto: no se encontró el final del archivo.".into());
    }
    Ok(())
}

/// A copy never replaces the open PDF; a moved or deleted original cannot be the destination.
pub fn protect_original(source: &Path, output: &Path) -> Result<(), String> {
    let same = source == output || (output.exists() && source.exists()
        && same_file::is_same_file(source, output).map_err(|_| "No se pudo comprobar el destino. Elige otra ubicación.")?);
    if same { return Err("Para reemplazar este PDF, usa Guardar. Elige otro nombre para la copia.".into()); }
    Ok(())
}

/// Paths in `folder` for `names`: the file name only, ending in .pdf, and never an
/// existing file or a name used earlier in the list ("Parte.pdf", "Parte (2).pdf"…).
pub fn unique_pdf_paths(folder: &Path, names: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut used = std::collections::HashSet::new();
    names.iter().map(|name| {
        let file = Path::new(name).file_name().and_then(|n| n.to_str()).filter(|n| !n.trim().is_empty()).ok_or("Nombre de archivo inválido.")?;
        let stem = if file.to_ascii_lowercase().ends_with(".pdf") { &file[..file.len() - 4] } else { file };
        let mut n = 1;
        loop {
            let candidate = if n == 1 { format!("{stem}.pdf") } else { format!("{stem} ({n}).pdf") };
            let path = folder.join(&candidate);
            if used.insert(candidate.to_lowercase()) && !path.exists() { return Ok(path); }
            n += 1;
        }
    }).collect()
}

pub fn fingerprint(path: &Path) -> Result<Option<String>, String> {
    match fs::File::open(path) {
        Ok(mut file) => {
            let mut hash = Sha256::new(); let mut chunk = [0u8; 64 * 1024];
            loop {
                let count = file.read(&mut chunk).map_err(|_| "No se pudo comprobar el archivo de destino.")?;
                if count == 0 { break; } hash.update(&chunk[..count]);
            }
            Ok(Some(format!("{:x}", hash.finalize())))
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("No se pudo comprobar el archivo de destino.".into()),
    }
}

fn write_temporary(path: &Path, bytes: &[u8], shared: bool) -> Result<tempfile::NamedTempFile, String> {
    let parent = path.parent().ok_or("El destino no tiene una carpeta válida.")?;
    // A user's file gets the usual 0o666 less umask; app data keeps tempfile's 0o600.
    #[cfg(unix)]
    let builder = { use std::os::unix::fs::PermissionsExt; let mut builder = tempfile::Builder::new(); if shared { builder.permissions(fs::Permissions::from_mode(0o666)); } builder };
    #[cfg(not(unix))]
    let builder = { let _ = shared; tempfile::Builder::new() };
    let mut temporary = builder.tempfile_in(parent).map_err(|_| "No se puede guardar en esta carpeta. Elige otra ubicación.")?;
    temporary.write_all(bytes).map_err(|_| "No se pudo escribir el archivo; el anterior está intacto. Comprueba el espacio disponible.")?;
    temporary.as_file().sync_all().map_err(|_| "No se pudo confirmar la escritura en disco.")?;
    Ok(temporary)
}

fn sync_folder(path: &Path) {
    #[cfg(unix)]
    if let Some(Ok(folder)) = path.parent().map(fs::File::open) { let _ = folder.sync_all(); }
    #[cfg(not(unix))]
    let _ = path;
}

/// A replaced file keeps its permissions and, on macOS, its ACL, Finder tags and
/// other extended attributes.
#[cfg(unix)]
fn keep_metadata(from: &Path, to: &Path) {
    if let Ok(meta) = fs::metadata(from) { let _ = fs::set_permissions(to, meta.permissions()); }
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::{c_char, c_void, CString}, os::unix::ffi::OsStrExt};
        extern "C" { fn copyfile(from: *const c_char, to: *const c_char, state: *mut c_void, flags: u32) -> i32; }
        const COPYFILE_ACL: u32 = 1 << 0;
        const COPYFILE_XATTR: u32 = 1 << 2;
        if let (Ok(from), Ok(to)) = (CString::new(from.as_os_str().as_bytes()), CString::new(to.as_os_str().as_bytes())) {
            unsafe { copyfile(from.as_ptr(), to.as_ptr(), std::ptr::null_mut(), COPYFILE_ACL | COPYFILE_XATTR); }
        }
    }
}

const REPLACE_FAILED: &str = "No se pudo reemplazar el archivo; el anterior se conservó. Ciérralo en otras aplicaciones e inténtalo de nuevo.";

#[cfg(not(windows))]
fn replace(path: &Path, temporary: tempfile::NamedTempFile) -> Result<(), String> {
    temporary.persist(path).map(|_| ()).map_err(|_| REPLACE_FAILED.into())
}
/// ReplaceFileW keeps the replaced file's ACL, attributes, creation time and
/// alternate streams, such as the Mark of the Web, which a rename would drop.
#[cfg(windows)]
fn replace(path: &Path, temporary: tempfile::NamedTempFile) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::PathBuf};
    #[link(name = "kernel32")]
    extern "system" { fn ReplaceFileW(replaced: *const u16, replacement: *const u16, backup: *const u16, flags: u32, exclude: *mut c_void, reserved: *mut c_void) -> i32; }
    const REPLACEFILE_IGNORE_MERGE_ERRORS: u32 = 0x2;
    const REPLACEFILE_IGNORE_ACL_ERRORS: u32 = 0x4;
    let wide = |path: &Path| path.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>();
    let (file, replacement) = temporary.keep().map_err(|_| REPLACE_FAILED)?;
    drop(file);
    // With a backup name, a failed call leaves the original under a known name.
    let mut backup = replacement.clone().into_os_string(); backup.push(".bak");
    let backup = PathBuf::from(backup);
    let replaced = unsafe { ReplaceFileW(wide(path).as_ptr(), wide(&replacement).as_ptr(), wide(&backup).as_ptr(), REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS, std::ptr::null_mut(), std::ptr::null_mut()) } != 0;
    if replaced { let _ = fs::remove_file(&backup); return Ok(()); }
    if !path.exists() && backup.exists() && fs::rename(&backup, path).is_err() {
        let _ = fs::remove_file(&replacement);
        return Err(format!("No se pudo reemplazar el archivo. El anterior está en la misma carpeta como «{}».", backup.file_name().unwrap_or_default().to_string_lossy()));
    }
    let _ = fs::remove_file(&backup);
    // A volume without ReplaceFileW still gets the atomic rename.
    if path.exists() && fs::rename(&replacement, path).is_ok() { return Ok(()); }
    let _ = fs::remove_file(&replacement);
    Err(REPLACE_FAILED.into())
}

/// Write and sync a sibling temporary file before its atomic commit. A destination
/// changed since the save dialog is refused; a newly created destination uses
/// persist_noclobber to prevent a race with another writer.
pub fn atomic_write(path: &Path, bytes: &[u8], expected: Option<&str>) -> Result<(), String> {
    let temporary = write_temporary(path, bytes, true)?;
    #[cfg(unix)]
    if expected.is_some() { keep_metadata(path, temporary.path()); }
    if fingerprint(path)?.as_deref() != expected { return Err(DESTINATION_CHANGED.into()); }
    if expected.is_some() { replace(path, temporary)?; } else { temporary.persist_noclobber(path).map_err(|_| REPLACE_FAILED)?; }
    sync_folder(path);
    Ok(())
}

/// Folio's own data (drafts, sessions, the library and Drive records) has a
/// single writer behind the caller's lock: it skips the hash precondition.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_temporary(path, bytes, false)?.persist(path).map_err(|_| "No se pudo guardar en el almacenamiento de Folio.")?;
    sync_folder(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_parts_never_replace_a_file_or_each_other() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("Libro.pdf"), b"x").unwrap();
        let names = ["Libro.pdf", "libro", "../Cap 1.PDF", "Cap. 2"].map(String::from);
        let paths = unique_pdf_paths(folder.path(), &names).unwrap();
        let files: Vec<_> = paths.iter().map(|p| { assert_eq!(p.parent().unwrap(), folder.path()); p.file_name().unwrap().to_str().unwrap().to_owned() }).collect();
        assert_eq!(files, ["Libro (2).pdf", "libro (3).pdf", "Cap 1.pdf", "Cap. 2.pdf"]);
        assert!(unique_pdf_paths(folder.path(), &["..".into()]).is_err());
    }
    #[test]
    fn source_identity_is_streamed_and_trailing_provider_content_is_allowed() {
        let folder = tempfile::tempdir().unwrap(); let path = folder.path().join("provider.pdf");
        let mut bytes = b"%PDF-1.7\n%%EOF\n".to_vec(); bytes.extend(vec![b' '; 8192]);
        fs::write(&path, &bytes).unwrap();
        let info = inspect_pdf_file(&path).unwrap();
        assert_eq!(info.digest, digest(&bytes)); assert_eq!(info.snapshot.size, bytes.len() as u64);
        assert_eq!(read_pdf(&path).unwrap(), bytes);
    }
    #[test]
    fn range_reads_support_offsets_above_two_gib_without_a_document_buffer() {
        let folder = tempfile::tempdir().unwrap(); let path = folder.path().join("large.pdf");
        let mut file = fs::File::create(&path).unwrap(); file.write_all(b"%PDF-1.7\n").unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            #[link(name = "kernel32")]
            extern "system" { fn DeviceIoControl(handle: *mut std::ffi::c_void, code: u32, input: *mut std::ffi::c_void, input_len: u32, output: *mut std::ffi::c_void, output_len: u32, returned: *mut u32, overlapped: *mut std::ffi::c_void) -> i32; }
            let mut returned = 0;
            let sparse = unsafe { DeviceIoControl(file.as_raw_handle(), 0x000900c4, std::ptr::null_mut(), 0, std::ptr::null_mut(), 0, &mut returned, std::ptr::null_mut()) };
            assert_ne!(sparse, 0, "Windows could not create the sparse range fixture");
        }
        let offset = 2u64 * 1024 * 1024 * 1024 + 17;
        file.seek(SeekFrom::Start(offset)).unwrap(); file.write_all(b"tail\n%%EOF").unwrap(); drop(file);
        let snapshot = file_snapshot(&path).unwrap();
        assert_eq!(read_pdf_range(&path, &snapshot, 0, 5).unwrap(), b"%PDF-");
        assert_eq!(read_pdf_range(&path, &snapshot, offset, 100).unwrap(), b"tail\n%%EOF");
        assert!(read_pdf_range(&path, &snapshot, snapshot.size + 1, 1).is_err());
        assert!(read_pdf_range(&path, &snapshot, 0, MAX_RANGE_BYTES + 1).is_err());
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"changed").unwrap();
        assert!(read_pdf_range(&path, &snapshot, 0, 5).is_err());
    }
    #[test]
    fn output_replaces_only_the_confirmed_snapshot() {
        let folder = tempfile::tempdir().unwrap(); let p = folder.path().join("result.pdf");
        fs::write(&p, b"previous").unwrap(); let expected = fingerprint(&p).unwrap().unwrap();
        atomic_write(&p, b"complete new result", Some(&expected)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"complete new result");
    }
    #[test]
    fn another_writer_is_not_overwritten() {
        let folder = tempfile::tempdir().unwrap(); let p = folder.path().join("result.pdf");
        let snapshot = fingerprint(&p).unwrap(); fs::write(&p, b"another writer").unwrap();
        assert!(atomic_write(&p, b"my result", snapshot.as_deref()).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"another writer");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }
    #[test]
    fn original_and_its_alias_are_protected() {
        let folder = tempfile::tempdir().unwrap(); let original = folder.path().join("original.pdf");
        let alias = folder.path().join("alias.pdf"); fs::write(&original, b"original").unwrap();
        fs::hard_link(&original, &alias).unwrap();
        assert!(protect_original(&original, &original).is_err());
        assert!(protect_original(&original, &alias).is_err());
        assert!(protect_original(&original, &folder.path().join("new.pdf")).is_ok());
        let other = folder.path().join("other.pdf"); fs::write(&other, b"other").unwrap(); fs::remove_file(&original).unwrap();
        assert!(protect_original(&original, &other).is_ok(), "A moved original never blocks another destination");
    }
    #[cfg(unix)]
    #[test]
    fn saved_files_keep_permissions_and_new_files_follow_umask() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap(); let p = folder.path().join("shared.pdf");
        fs::write(&p, b"previous").unwrap(); fs::set_permissions(&p, fs::Permissions::from_mode(0o664)).unwrap();
        atomic_write(&p, b"replaced", fingerprint(&p).unwrap().as_deref()).unwrap();
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o664);
        let created = folder.path().join("new.pdf"); atomic_write(&created, b"new", None).unwrap();
        assert_ne!(fs::metadata(&created).unwrap().permissions().mode() & 0o044, 0, "New files are readable like any other user file");
        let private = folder.path().join("draft.pdf"); write_private(&private, b"draft").unwrap(); write_private(&private, b"draft 2").unwrap();
        assert_eq!(fs::read(&private).unwrap(), b"draft 2"); assert_eq!(fs::metadata(&private).unwrap().permissions().mode() & 0o077, 0);
    }
    #[cfg(windows)]
    #[test]
    fn saved_files_keep_windows_streams_and_attributes() {
        use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
        #[link(name = "kernel32")]
        extern "system" { fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32; }
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        let folder = tempfile::tempdir().unwrap(); let p = folder.path().join("descargado.pdf");
        fs::write(&p, b"previous").unwrap();
        let zone = format!("{}:Zone.Identifier", p.display()); fs::write(&zone, "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        let wide = p.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>();
        assert_ne!(unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN) }, 0);
        atomic_write(&p, b"replaced", fingerprint(&p).unwrap().as_deref()).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"replaced");
        assert_eq!(fs::read_to_string(&zone).unwrap(), "[ZoneTransfer]\r\nZoneId=3\r\n");
        assert_ne!(fs::metadata(&p).unwrap().file_attributes() & FILE_ATTRIBUTE_HIDDEN, 0);
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1, "No temporary or backup file is left behind");
    }
    #[test]
    fn partial_and_invalid_pdf_are_rejected() {
        assert!(validate_pdf(b"%PDF-1.7\nunfinished").is_err());
        assert!(validate_pdf(b"not a PDF\n%%EOF").is_err());
        assert!(validate_pdf(b"%PDF-1.7\ncomplete\n%%EOF\n").is_ok());
    }
}
