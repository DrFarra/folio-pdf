fn main() {
    tauri_plugin::Builder::new(&[]).ios_path("ios").build();
    // SwiftPM makes the C module available while compiling Swift. Its static
    // bindings target only exposes the shared header, so Cargo links the
    // matching device or simulator implementation into the final application.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        let target = std::env::var("TARGET").expect("Cargo target");
        let slice = if target.ends_with("-sim") { "ios-arm64-simulator" } else { "ios-arm64" };
        let directory = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest"))
            .join("ios/Frameworks/FolioMuPDF.xcframework").join(slice);
        assert!(directory.join("libFolioMuPDF.a").is_file(), "Compile the matching MuPDF XCFramework with scripts/build-mupdf-ios.mjs first");
        println!("cargo:rustc-link-search=native={}", directory.display());
        println!("cargo:rustc-link-lib=static=FolioMuPDF");
        println!("cargo:rerun-if-changed={}", directory.display());
    }
}
