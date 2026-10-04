use sha2::{Digest, Sha256};
use std::{fs, io::{self, Read, Write}, path::Path};

pub const MAX_DOCUMENT_BYTES: usize = 100 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;

pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn read_pdf(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|_| "No se puede acceder al archivo.")?;
    if !meta.is_file() || meta.len() > MAX_DOCUMENT_BYTES as u64 {
        return Err("Elige un PDF de hasta 100 MB.".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| "No se pudo leer el archivo.")?
        .take(MAX_DOCUMENT_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| "No se pudo leer el archivo.")?;
    if bytes.len() > MAX_DOCUMENT_BYTES { return Err("El archivo excede 100 MB.".into()); }
    validate_pdf(&bytes)?;
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
