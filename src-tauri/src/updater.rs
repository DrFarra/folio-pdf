// Desktop updates come from the GitHub releases of the official repository.
// shortcut: integrity rests on HTTPS from github.com, with no signature of our own; switch to tauri-plugin-updater if releases get signing keys.
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const RELEASES: &str = "https://api.github.com/repos/DrFarra/folio-pdf/releases?per_page=20";
const DOWNLOADS: &str = "https://github.com/DrFarra/folio-pdf/releases/download/";

#[derive(Serialize)]
pub struct Update { version: String, url: String }

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder().user_agent(concat!("Folio/", env!("CARGO_PKG_VERSION"))).connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(600))
        .build().map_err(|_| "No se pudo iniciar la conexión segura.".into())
}

fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim_start_matches('v').splitn(3, '.').map(|part| part.parse().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

// The newest published release above `current` that carries a Windows installer.
fn newest(releases: &[Value], current: &str) -> Option<Update> {
    let current = parse(current)?;
    releases.iter().filter(|release| !release["draft"].as_bool().unwrap_or(false)).filter_map(|release| {
        let version = parse(release["tag_name"].as_str()?)?;
        let url = release["assets"].as_array()?.iter().find(|asset| asset["name"].as_str().is_some_and(|name| name.ends_with("_x64-setup.exe")))?["browser_download_url"].as_str()?;
        (version > current && url.starts_with(DOWNLOADS)).then(|| (version, Update { version: format!("{}.{}.{}", version.0, version.1, version.2), url: url.into() }))
    }).max_by_key(|(version, _)| *version).map(|(_, update)| update)
}

#[tauri::command]
pub async fn check_update() -> Result<Option<Update>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let response = http()?.get(RELEASES).header("Accept", "application/vnd.github+json").send().map_err(|_| "No se pudo conectar con GitHub. Revisa tu conexión.".to_string())?;
        if !response.status().is_success() { return Err("GitHub no respondió. Inténtalo más tarde.".into()); }
        let releases: Vec<Value> = response.json().map_err(|_| "GitHub devolvió una respuesta inesperada.".to_string())?;
        Ok(newest(&releases, env!("CARGO_PKG_VERSION")))
    }).await.map_err(|_| "No se pudo buscar actualizaciones.".to_string())?
}

/// Downloads the installer, starts it in passive mode and closes Folio; the installer reopens it.
#[tauri::command]
pub async fn install_update(url: String, app: tauri::AppHandle) -> Result<(), String> {
    // The URL comes from the page: only installers of this repository's releases run.
    let name = url.strip_prefix(DOWNLOADS)
        .filter(|rest| !rest.contains("..") && rest.matches('/').count() == 1 && rest.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c)))
        .and_then(|rest| rest.rsplit('/').next()).filter(|name| name.ends_with("_x64-setup.exe"))
        .ok_or("Enlace de actualización inválido.")?.to_string();
    if !cfg!(target_os = "windows") { return Err("La instalación automática solo está disponible en Windows.".into()); }
    let path = std::env::temp_dir().join(name);
    tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || {
            let mut response = http()?.get(&url).send().map_err(|_| "No se pudo descargar la actualización.".to_string())?;
            if !response.status().is_success() { return Err("No se pudo descargar la actualización.".into()); }
            let mut file = std::fs::File::create(&path).map_err(|_| "No se pudo guardar la actualización.".to_string())?;
            response.copy_to(&mut file).map_err(|_| "La descarga de la actualización se interrumpió.".to_string())?;
            Ok::<_, String>(())
        }
    }).await.map_err(|_| "No se pudo descargar la actualización.".to_string())??;
    // /P shows only the progress bar, /UPDATE keeps shortcuts and /R reopens Folio when it finishes.
    std::process::Command::new(&path).args(["/P", "/UPDATE", "/R"]).spawn().map_err(|_| "No se pudo iniciar el instalador.".to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_the_newest_windows_installer_above_the_current_version() {
        let asset = |v: &str| json!({ "name": format!("Folio_{v}_x64-setup.exe"), "browser_download_url": format!("{DOWNLOADS}v{v}/Folio_{v}_x64-setup.exe") });
        let releases = vec![
            json!({ "tag_name": "v0.9.6", "draft": false, "assets": [asset("0.9.6")] }),
            json!({ "tag_name": "v0.10.0", "draft": false, "assets": [asset("0.10.0")] }),
            json!({ "tag_name": "v0.11.0", "draft": true, "assets": [asset("0.11.0")] }),
            json!({ "tag_name": "v0.12.0", "draft": false, "assets": [] }),
        ];
        assert_eq!(newest(&releases, "0.9.5").map(|u| u.version), Some("0.10.0".into()));
        assert!(newest(&releases, "0.10.0").is_none());
    }
}
