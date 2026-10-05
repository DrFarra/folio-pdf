fn main() {
    // Installed-app credentials are build input, never source-controlled.
    let path = std::env::var_os("FOLIO_GOOGLE_DESKTOP_CREDENTIALS").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|p| std::path::PathBuf::from(p).join("Folio/developer-credentials/folio-desktop-oauth.json")));
    println!("cargo:rerun-if-env-changed=FOLIO_GOOGLE_DESKTOP_CREDENTIALS");
    let mut config = "{}".to_string();
    if let Some(path) = path { println!("cargo:rerun-if-changed={}", path.display()); config = std::fs::read_to_string(path).unwrap_or(config); }
    std::fs::write(std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("google-installed.json"), config).unwrap();
    tauri_build::build();
}
