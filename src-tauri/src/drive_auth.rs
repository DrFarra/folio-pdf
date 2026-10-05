use reqwest::blocking::Client;
use serde_json::Value;
use std::time::{Duration, Instant};

pub const SCOPE: &str = "https://www.googleapis.com/auth/drive";
pub struct Token { pub access: String, pub until: Instant }

pub fn token(app: &tauri::AppHandle, http: &Client, interactive: bool) -> Result<Token, String> {
    #[cfg(target_os = "android")]
    let value = {
        use tauri_plugin_folio_android::FolioAndroidExt;
        app.folio_android().call("driveAuthorize", serde_json::json!({"interactive":interactive}))
            .map_err(|_| "Inicia sesión con Google Drive para continuar.".to_string())?
    };
    #[cfg(target_os = "ios")]
    let value = {
        use tauri_plugin_folio_ios::FolioIosExt;
        app.folio_ios().call("driveAuthorize", serde_json::json!({"interactive":interactive}))
            .map_err(|_| "Inicia sesión con Google Drive para continuar.".to_string())?
    };
    #[cfg(not(any(target_os="ios",target_os="android")))]
    let value = desktop_token(app, http, interactive)?;
    let access = value["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("Google no concedió acceso a Drive.")?.to_string();
    if let Some(scopes) = value["scope"].as_str() {
        if !scopes.split_whitespace().any(|s| s == SCOPE) { return Err("Autoriza el acceso a tus archivos de Google Drive para usar esta función.".into()); }
    }
    let seconds = value["expires_in"].as_u64().unwrap_or(3000).saturating_sub(120);
    Ok(Token { access, until: Instant::now() + Duration::from_secs(seconds) })
}

pub fn disconnect(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os="android")]
    { use tauri_plugin_folio_android::FolioAndroidExt; app.folio_android().call("driveDisconnect", serde_json::json!({})).map_err(|_| "No se pudo desconectar Google.".to_string())?; }
    #[cfg(target_os="ios")]
    { use tauri_plugin_folio_ios::FolioIosExt; app.folio_ios().call("driveDisconnect", serde_json::json!({})).map_err(|_| "No se pudo desconectar Google.".to_string())?; }
    #[cfg(any(target_os="windows",target_os="macos"))]
    { match entry()?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => (), Err(_) => return Err("No se pudo quitar la sesión del almacén seguro.".into()) } }
    let _ = app;
    Ok(())
}

#[cfg(any(target_os="windows",target_os="macos"))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.folio.pdf.google-drive", "refresh-token").map_err(|_| "No se pudo abrir el almacén seguro del sistema.".into())
}

#[cfg(not(any(target_os="ios",target_os="android")))]
fn desktop_token(app: &tauri::AppHandle, http: &Client, interactive: bool) -> Result<Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use std::{io::{Read, Write}, net::TcpListener};
    let config: Value = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/google-installed.json"))).map_err(|_| "Configuración de Google inválida.")?;
    let id = config["installed"]["client_id"].as_str().ok_or("Esta compilación no incluye la configuración OAuth de escritorio.")?;
    let secret = config["installed"]["client_secret"].as_str().unwrap_or("");
    #[cfg(any(target_os="windows",target_os="macos"))]
    if !interactive {
        if let Ok(refresh) = entry()?.get_password() {
            let r = http.post("https://oauth2.googleapis.com/token").form(&[("client_id",id),("client_secret",secret),("refresh_token",refresh.as_str()),("grant_type","refresh_token")]).send().map_err(|_| "No se pudo conectar con Google. Tu copia local sigue disponible.")?;
            if r.status().is_success() { return r.json().map_err(|_| "Respuesta de Google inválida.".into()); }
        }
        return Err("La sesión de Google venció. Vuelve a conectar Drive.".into());
    }
    if !interactive { return Err("Inicia sesión con Google Drive.".into()); }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "No se pudo iniciar la autorización local.")?;
    listener.set_nonblocking(true).map_err(|_| "No se pudo iniciar la autorización.")?;
    let redirect = format!("http://127.0.0.1:{}/",listener.local_addr().map_err(|_| "Puerto no disponible.")?.port());
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let state = uuid::Uuid::new_v4().to_string();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = tauri::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([("client_id",id),("redirect_uri",&redirect),("response_type","code"),("scope",SCOPE),("access_type","offline"),("prompt","consent select_account"),("state",&state),("code_challenge",&challenge),("code_challenge_method","S256")]);
    let _ = app;
    tauri::async_runtime::block_on(super::open_external_url(url.to_string()))?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let code = loop {
        if Instant::now() > deadline { return Err("La autorización venció. Vuelve a iniciar sesión.".into()); }
        let (mut stream, _) = match listener.accept() { Ok(v)=>v, Err(e) if e.kind()==std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(100)); continue; }, Err(_)=>return Err("Falló la autorización local.".into()) };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf=[0;8192]; let n=stream.read(&mut buf).unwrap_or(0);
        let text=String::from_utf8_lossy(&buf[..n]);
        let callback = text.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split_whitespace().next()).and_then(|p| tauri::Url::parse(&format!("http://127.0.0.1{p}")).ok());
        let Some(callback)=callback else { continue; };
        let q:std::collections::HashMap<_,_>=callback.query_pairs().into_owned().collect();
        if q.get("state")!=Some(&state) { let _=stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); continue; }
        let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nFolio: puedes cerrar esta ventana y volver a la app.");
        break q.get("code").cloned().ok_or("Se canceló la autorización de Google.")?;
    };
    let response = http.post("https://oauth2.googleapis.com/token").form(&[("client_id",id),("client_secret",secret),("redirect_uri",&redirect),("code",&code),("code_verifier",&verifier),("grant_type","authorization_code")]).send().map_err(|_| "No se pudo completar la conexión con Google.")?;
    if !response.status().is_success() { return Err("Google no pudo completar la autorización. Vuelve a intentarlo.".into()); }
    let value:Value=response.json().map_err(|_| "Respuesta de Google inválida.")?;
    #[cfg(any(target_os="windows",target_os="macos"))]
    if let Some(refresh)=value["refresh_token"].as_str() { entry()?.set_password(refresh).map_err(|_| "No se pudo guardar la sesión en el almacén seguro.")?; }
    Ok(value)
}
