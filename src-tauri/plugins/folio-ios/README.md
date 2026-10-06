# Folio iOS native bridge

Local AGPL-3.0-or-later plugin for UIKit document import/export, sharing, native AirPrint, the status bar in immersive reading and system appearance. Commands are called only from Rust application handlers; the plugin exposes no unrestricted frontend filesystem API.

Import copies provider URLs while security-scoped access is active. Export and sharing accept only existing files inside the application sandbox. Each UIKit operation resolves after completion or cancellation.
