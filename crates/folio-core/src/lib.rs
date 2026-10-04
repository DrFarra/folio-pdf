use sha2::{Digest, Sha256};
use std::{fs, io::{self, Read, Write, Seek, SeekFrom}, path::Path, time::SystemTime};

pub const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_RANGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSnapshot { pub size: u64, pub modified: Option<SystemTime> }
#[derive(Clone, Debug)]
pub struct PdfFileInfo { pub snapshot: FileSnapshot, pub digest: String }

pub fn file_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let meta = fs::metadata(path).map_err(|e| format!("No se puede acceder al archivo: {e}"))?;
    if !meta.is_file() { return Err("Elige un archivo PDF.".into()); }
    Ok(FileSnapshot { size: meta.len(), modified: meta.modified().ok() })
}

/// Source PDFs are parsed by the selected PDF engine. Check only a bounded
/// header here; valid provider files may contain trailing material after EOF.
pub fn inspect_pdf_file(path: &Path) -> Result<PdfFileInfo, String> {
    let snapshot = file_snapshot(path)?;
    let mut file = fs::File::open(path).map_err(|e| format!("No se pudo leer el PDF: {e}"))?;
    let mut header = [0u8; 1024];
    let count = file.read(&mut header).map_err(|e| format!("No se pudo comprobar la cabecera: {e}"))?;
    if !header[..count].windows(5).any(|s| s == b"%PDF-") { return Err("El archivo no tiene una cabecera PDF válida.".into()); }
    let mut hash = Sha256::new(); hash.update(&header[..count]);
    let mut chunk = [0u8; 64 * 1024];
    loop { let count = file.read(&mut chunk).map_err(|e| format!("No se pudo identificar el PDF: {e}"))?; if count == 0 { break; } hash.update(&chunk[..count]); }
    if file_snapshot(path)? != snapshot { return Err("El archivo cambió mientras se abría. Vuelve a elegirlo.".into()); }
    Ok(PdfFileInfo { snapshot, digest: format!("{:x}", hash.finalize()) })
}

pub fn read_pdf_range(path: &Path, snapshot: &FileSnapshot, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    if length > MAX_RANGE_BYTES { return Err("La lectura por bloques excede 4 MiB.".into()); }
    if offset > snapshot.size { return Err("La posición de lectura está fuera del PDF.".into()); }
    if file_snapshot(path)? != *snapshot { return Err("El archivo cambió en disco. Vuelve a abrirlo.".into()); }
    let count = (snapshot.size - offset).min(length as u64) as usize;
    let mut file = fs::File::open(path).map_err(|e| format!("No se pudo leer el PDF: {e}"))?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("No se pudo buscar el bloque: {e}"))?;
    let mut bytes = vec![0; count]; file.read_exact(&mut bytes).map_err(|e| format!("No se pudo leer el bloque: {e}"))?;
    if file_snapshot(path)? != *snapshot { return Err("El archivo cambió durante la lectura.".into()); }
    Ok(bytes)
}

pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn read_pdf(path: &Path) -> Result<Vec<u8>, String> {
    let meta = file_snapshot(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| "No se pudo leer el archivo.")?
        .read_to_end(&mut bytes).map_err(|_| "No se pudo leer el archivo.")?;
    if !bytes.iter().take(1024).copied().collect::<Vec<_>>().windows(5).any(|s| s == b"%PDF-") { return Err("El archivo no tiene una cabecera PDF válida.".into()); }
    if file_snapshot(path)? != meta { return Err("El archivo cambió durante la lectura.".into()); }
    Ok(bytes)
}

pub fn validate_pdf(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_OUTPUT_BYTES || !bytes.iter().take(1024).copied().collect::<Vec<_>>().windows(5).any(|s| s == b"%PDF-") {
        return Err("La salida no tiene una cabecera PDF válida o excede el límite de tamaño.".into());
    }
    if !bytes.iter().rev().take(2048).copied().collect::<Vec<_>>().windows(5).any(|s| s == b"FOE%%") {
        return Err("El PDF está incompleto: no se encontró el final del archivo.".into());
    }
    Ok(())
}

pub fn protect_original(source: &Path, output: &Path) -> Result<(), String> {
    if source == output || (output.exists() && same_file::is_same_file(source, output).unwrap_or(true)) {
        return Err("Guarda una copia con otro nombre. Esta versión conserva siempre el original.".into());
    }
    Ok(())
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

/// Write and sync a sibling temporary file before its atomic commit. A destination
/// changed since the save dialog is refused; a newly created destination uses
/// persist_noclobber to prevent a race with another writer.
pub fn atomic_write(path: &Path, bytes: &[u8], expected: Option<&str>) -> Result<(), String> {
    let parent = path.parent().ok_or("El destino no tiene una carpeta válida.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "No se pudo crear el archivo temporal en la carpeta elegida.")?;
    temporary.write_all(bytes).map_err(|_| "No se pudo escribir la copia; el destino está intacto.")?;
    temporary.as_file().sync_all().map_err(|_| "No se pudo confirmar la escritura en disco.")?;
    if fingerprint(path)?.as_deref() != expected { return Err("El archivo de destino cambió. Vuelve a elegir dónde guardar.".into()); }
    let committed = if expected.is_some() { temporary.persist(path) } else { temporary.persist_noclobber(path) };
    committed.map_err(|_| "No se pudo confirmar la copia. El archivo anterior se conservó.")?;
    #[cfg(unix)]
    if let Ok(folder) = fs::File::open(parent) { let _ = folder.sync_all(); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
    }
    #[test]
    fn partial_and_invalid_pdf_are_rejected() {
        assert!(validate_pdf(b"%PDF-1.7\nunfinished").is_err());
        assert!(validate_pdf(b"not a PDF\n%%EOF").is_err());
        assert!(validate_pdf(b"%PDF-1.7\ncomplete\n%%EOF\n").is_ok());
    }
}
