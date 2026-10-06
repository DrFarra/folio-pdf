use reqwest::blocking::Client;
use serde_json::Value;
use std::{sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};

pub const SCOPE: &str = "https://www.googleapis.com/auth/drive";
pub struct Token { pub access: String, pub until: Instant }
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Ends a desktop sign-in that is waiting for the browser.
pub fn cancel() { CANCEL.store(true, Ordering::Relaxed); }

/// Kotlin and Swift reject with text written for the user, such as a cancelled
/// sign-in or missing Google Play services; bridge errors are technical English.
#[cfg(any(target_os="ios",target_os="android"))]
fn rejected(fallback: &str) -> impl FnOnce(tauri::plugin::mobile::PluginInvokeError) -> String + '_ {
    move |error| match error { tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) => response.message.unwrap_or_else(|| fallback.into()), _ => fallback.into() }
}

pub fn token(app: &tauri::AppHandle, http: &Client, interactive: bool) -> Result<Token, String> {
    #[cfg(target_os = "android")]
    let value = {
        use tauri_plugin_folio_android::FolioAndroidExt;
        app.folio_android().call("driveAuthorize", serde_json::json!({"interactive":interactive})).map_err(rejected("Inicia sesión con Google Drive para continuar."))?
    };
    #[cfg(target_os = "ios")]
    let value = {
        use tauri_plugin_folio_ios::FolioIosExt;
        app.folio_ios().call("driveAuthorize", serde_json::json!({"interactive":interactive})).map_err(rejected("Inicia sesión con Google Drive para continuar."))?
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

pub fn disconnect(app: &tauri::AppHandle, http: &Client) -> Result<(), String> {
    #[cfg(target_os="android")]
    { use tauri_plugin_folio_android::FolioAndroidExt; app.folio_android().call("driveDisconnect", serde_json::json!({})).map_err(rejected("No se pudo desconectar Google."))?; }
    #[cfg(target_os="ios")]
    { use tauri_plugin_folio_ios::FolioIosExt; app.folio_ios().call("driveDisconnect", serde_json::json!({})).map_err(rejected("No se pudo desconectar Google."))?; }
    #[cfg(any(target_os="windows",target_os="macos"))]
    {
        // Google keeps a refresh token valid until it is revoked. Offline, it is still forgotten here.
        if let Ok(refresh) = entry()?.get_password() { let _ = http.post("https://oauth2.googleapis.com/revoke").form(&[("token", refresh.as_str())]).send(); }
        match entry()?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => (), Err(_) => return Err("No se pudo quitar la sesión del almacén seguro.".into()) }
    }
    let _ = (app, http);
    Ok(())
}

/// Builds without the desktop OAuth client cannot offer Google Drive.
pub fn available() -> bool {
    #[cfg(not(any(target_os="ios",target_os="android")))]
    return client().is_some();
    #[cfg(any(target_os="ios",target_os="android"))]
    true
}

#[cfg(not(any(target_os="ios",target_os="android")))]
fn client() -> Option<(String, String)> {
    let config: Value = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/google-installed.json"))).ok()?;
    Some((config["installed"]["client_id"].as_str()?.into(), config["installed"]["client_secret"].as_str().unwrap_or("").into()))
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
    let (id, secret) = client().ok_or("Google Drive no está disponible en esta versión de Folio.")?;
    let (id, secret) = (id.as_str(), secret.as_str());
    #[cfg(any(target_os="windows",target_os="macos"))]
    if !interactive {
        if let Ok(refresh) = entry()?.get_password() {
            let r = http.post("https://oauth2.googleapis.com/token").form(&[("client_id",id),("client_secret",secret),("refresh_token",refresh.as_str()),("grant_type","refresh_token")]).send().map_err(|_| "No se pudo conectar con Google. Tu copia local sigue disponible.")?;
            if r.status().is_success() { return r.json().map_err(|_| "Respuesta de Google inválida.".into()); }
        }
        return Err("La sesión de Google venció. Vuelve a conectar Drive.".into());
    }
    if !interactive { return Err("Inicia sesión con Google Drive.".into()); }
    CANCEL.store(false, Ordering::Relaxed);
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "No se pudo iniciar la autorización local.")?;
    listener.set_nonblocking(true).map_err(|_| "No se pudo iniciar la autorización.")?;
    let redirect = format!("http://127.0.0.1:{}/",listener.local_addr().map_err(|_| "Puerto no disponible.")?.port());
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let state = uuid::Uuid::new_v4().to_string();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = tauri::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([("client_id",id),("redirect_uri",&redirect),("response_type","code"),("scope",SCOPE),("access_type","offline"),("prompt","consent select_account"),("state",&state),("code_challenge",&challenge),("code_challenge_method","S256")]);
    tauri::async_runtime::block_on(super::open_external_url(url.to_string()))?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let code = loop {
        if CANCEL.load(Ordering::Relaxed) { return Err("Se canceló la conexión con Google Drive.".into()); }
        if Instant::now() > deadline { return Err("La autorización venció. Vuelve a iniciar sesión.".into()); }
        let (mut stream, _) = match listener.accept() { Ok(v)=>v, Err(e) if e.kind()==std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(100)); continue; }, Err(_)=>return Err("Falló la autorización local.".into()) };
        // Accepted sockets inherit non-blocking mode on Windows and macOS. Read the
        // whole request head: closing with unread bytes would reset the browser's connection.
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let (mut head, mut buf) = (Vec::new(), [0; 4096]);
        while head.len() < 16384 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf) { Ok(n) if n > 0 => head.extend_from_slice(&buf[..n]), _ => break }
        }
        let text=String::from_utf8_lossy(&head);
        let callback = text.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split_whitespace().next()).and_then(|p| tauri::Url::parse(&format!("http://127.0.0.1{p}")).ok());
        let Some(callback)=callback else { continue; };
        let q:std::collections::HashMap<_,_>=callback.query_pairs().into_owned().collect();
        if q.get("state")!=Some(&state) { let _=stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); continue; }
        let code = q.get("code").cloned();
        let page = if code.is_some() { "Listo. Ya puedes volver a Folio." } else { "Se canceló la autorización. Puedes volver a Folio." };
        let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html lang=\"es\"><meta charset=\"utf-8\"><title>Folio</title><p style=\"font:16px system-ui,sans-serif;margin:4em 1em;text-align:center\">{page}</p></html>").as_bytes());
        super::show_main_window(app);
        break code.ok_or("Se canceló la autorización de Google.")?;
    };
    let response = http.post("https://oauth2.googleapis.com/token").form(&[("client_id",id),("client_secret",secret),("redirect_uri",&redirect),("code",&code),("code_verifier",&verifier),("grant_type","authorization_code")]).send().map_err(|_| "No se pudo completar la conexión con Google.")?;
    if !response.status().is_success() { return Err("Google no pudo completar la autorización. Vuelve a intentarlo.".into()); }
    let value:Value=response.json().map_err(|_| "Respuesta de Google inválida.")?;
    #[cfg(any(target_os="windows",target_os="macos"))]
    if let Some(refresh)=value["refresh_token"].as_str() { entry()?.set_password(refresh).map_err(|_| "No se pudo guardar la sesión en el almacén seguro.")?; }
    Ok(value)
}
