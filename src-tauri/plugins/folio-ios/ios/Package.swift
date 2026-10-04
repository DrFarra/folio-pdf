// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "tauri-plugin-folio-ios",
    platforms: [.iOS(.v17)],
    products: [.library(name: "tauri-plugin-folio-ios", type: .static, targets: ["tauri-plugin-folio-ios"])],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        .package(url: "https://github.com/Brendonovich/swift-rs", exact: "1.0.7")
    ],
    targets: [.target(name: "tauri-plugin-folio-ios", dependencies: [.byName(name: "Tauri"), .product(name: "SwiftRs", package: "swift-rs")], path: "Sources")]
)
